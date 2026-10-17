/**
 * Prices for swapping stablecoins and Keeta Compute Credits. One credit is
 * one US dollar, so a stablecoin's price is what one unit of its currency
 * is worth in US dollars. KUSD and USDC are dollars: they trade one to one,
 * with no spread. Every other stablecoin trades at its rate with a spread
 * either way, rounding in the FX provider's favour.
 */

/** A rate as an exact fraction: US dollars per unit of a currency. */
export interface Rate {
	num: bigint;
	den: bigint;
}

/**
 * Test-network rates, US dollars per unit. Fixed so test swaps are
 * predictable; they are not market prices. The main network needs a live
 * rate source (FX_RATE_SOURCE) and refuses to start without one.
 */
export const TEST_USD_RATES: Readonly<Record<string, string>> = {
	USD: '1',
	EUR: '1.08',
	JPY: '0.0067',
	MXN: '0.055',
	CAD: '0.73',
	AED: '0.2723',
	GBP: '1.27'
};

/** Stablecoins that are US dollars and swap with credits one to one, without a spread. */
export const PARITY_SYMBOLS: ReadonlySet<string> = new Set(['KUSD', 'USDC']);

/** The default spread on non-dollar stablecoins, in basis points either way. */
export const DEFAULT_SPREAD_BPS = 50;

const BPS = 10_000n;

/** Parse a positive decimal string such as "0.0067" into an exact fraction. */
export function parseRate(text: string): Rate {
	const match = /^(\d{1,12})(?:\.(\d{1,12}))?$/.exec(text.trim());
	if (!match) {
		throw new Error(`rate "${text}" must be a positive decimal number`);
	}
	const fraction = match[2] ?? '';
	const num = BigInt(`${match[1]}${fraction}`);
	if (num === 0n) {
		throw new Error(`rate "${text}" must be more than zero`);
	}
	return { num, den: 10n ** BigInt(fraction.length) };
}

/** Where the provider reads its rates; `usdPer` throws when it has no usable rate for a currency. */
export interface RateSource {
	usdPer(currency: string): Rate;
}

/** A fixed table of rates (the test network's defaults, or an operator's override). */
export function staticRates(table: Readonly<Record<string, string>>): RateSource {
	const parsed = new Map(Object.entries(table).map(([currency, rate]) => [currency.toUpperCase(), parseRate(rate)]));
	return {
		usdPer(currency) {
			const rate = parsed.get(currency.toUpperCase());
			if (!rate) {
				throw new Error(`no rate for ${currency}`);
			}
			return rate;
		}
	};
}

/**
 * The range a live rate must fall in before it is quoted, US dollars per
 * unit: about a third either side of the test rates. A read outside it (a
 * unit inversion, a misplaced decimal point) is never quoted, however well
 * formed. A currency that genuinely leaves its range stops quoting until
 * this table is updated; a currency with no range is never quoted live.
 */
export const USD_RATE_BANDS: Readonly<Record<string, readonly [min: string, max: string]>> = {
	USD: ['0.98', '1.02'],
	EUR: ['0.72', '1.62'],
	JPY: ['0.0045', '0.01'],
	MXN: ['0.037', '0.083'],
	CAD: ['0.49', '1.1'],
	AED: ['0.18', '0.41'],
	GBP: ['0.85', '1.9']
};

/** How far a live rate may move from the last one quoted, in basis points per read. */
export const DEFAULT_MAX_MOVE_BPS = 200;

/** a < b, for exact fractions. */
const below = (a: Rate, b: Rate) => a.num * b.den < b.num * a.den;

/** Whether `next` is within `bps` basis points of `last`. */
function within(last: Rate, next: Rate, bps: number): boolean {
	const diff = next.num * last.den - last.num * next.den;
	return (diff < 0n ? -diff : diff) * BPS <= BigInt(bps) * last.num * next.den;
}

/**
 * Rates read from an HTTPS endpoint answering `{"EUR": "1.08", ...}` (US
 * dollars per unit), refreshed every `refreshMs`. The feed is checked, not
 * trusted: a currency is quoted only at a rate inside its fixed range
 * (USD_RATE_BANDS) that is also within `maxMoveBps` of the last rate quoted.
 * The first rate needs two reads that agree. A read that jumps further
 * pauses that currency until the feed comes back near the last rate, or an
 * operator who has checked the source restarts the service. Quotes also
 * stop once a currency's last good read is older than `maxAgeMs`, rather
 * than trade at a stale price.
 */
export function httpRates(
	url: string,
	options: { refreshMs?: number; maxAgeMs?: number; maxMoveBps?: number; bands?: Readonly<Record<string, readonly [string, string]>>; fetchImpl?: typeof fetch; now?: () => number } = {}
): RateSource & { refresh(): Promise<void>; stop(): void } {
	const now = options.now ?? Date.now;
	const maxAgeMs = options.maxAgeMs ?? 5 * 60_000;
	const maxMoveBps = options.maxMoveBps ?? DEFAULT_MAX_MOVE_BPS;
	const bands = new Map(Object.entries(options.bands ?? USD_RATE_BANDS).map(([currency, [min, max]]) => [currency.toUpperCase(), { min: parseRate(min), max: parseRate(max) }]));
	/* Per currency: the rate quoted and when it was read; a first read waiting for a second; a jump that paused it. */
	const quoted = new Map<string, { rate: Rate; readAt: number; paused: boolean }>();
	const pending = new Map<string, Rate>();
	const accept = (currency: string, text: string) => {
		const band = bands.get(currency);
		if (!band) {
			return;
		}
		let rate: Rate;
		try {
			rate = parseRate(text);
		} catch (error) {
			console.warn(`rate for ${currency} ignored: ${(error as Error).message}`);
			return;
		}
		if (below(rate, band.min) || below(band.max, rate)) {
			console.warn(`rate for ${currency} ignored: ${text} is outside its range`);
			return;
		}
		const last = quoted.get(currency);
		if (last) {
			if (within(last.rate, rate, maxMoveBps)) {
				quoted.set(currency, { rate, readAt: now(), paused: false });
			} else {
				console.warn(`rate for ${currency} jumped to ${text}; ${currency} stops quoting until the source comes back near the last rate or the service is restarted`);
				last.paused = true;
			}
			return;
		}
		const first = pending.get(currency);
		if (first && within(first, rate, maxMoveBps)) {
			pending.delete(currency);
			quoted.set(currency, { rate, readAt: now(), paused: false });
		} else {
			pending.set(currency, rate);
		}
	};
	const refresh = async () => {
		const response = await (options.fetchImpl ?? fetch)(url, { headers: { accept: 'application/json' } });
		if (!response.ok) {
			throw new Error(`the rate source answered ${response.status}`);
		}
		const body = (await response.json()) as Record<string, unknown>;
		/* One read per currency per answer: "EUR" and "eur" are different JSON keys, and reading both would step the rate twice, or confirm a first rate, from one answer. */
		const reads = new Map<string, string | null>();
		for (const [key, value] of Object.entries(body)) {
			if (typeof value === 'string') {
				const currency = key.toUpperCase();
				reads.set(currency, reads.has(currency) ? null : value);
			}
		}
		for (const [currency, value] of reads) {
			if (value === null) {
				console.warn(`rate for ${currency} ignored: the source gave it more than once`);
			} else {
				accept(currency, value);
			}
		}
	};
	const tick = () => void refresh().catch((error: Error) => console.warn(`rate refresh failed: ${error.message}`));
	const timer = setInterval(tick, options.refreshMs ?? 60_000);
	timer.unref?.();
	tick();
	return {
		refresh,
		stop: () => clearInterval(timer),
		usdPer(currency) {
			const entry = quoted.get(currency.toUpperCase());
			if (!entry || entry.paused || now() - entry.readAt > maxAgeMs) {
				throw new Error(`no current rate for ${currency}; not quoting it until the rate source answers with a usable one`);
			}
			return entry.rate;
		}
	};
}

export interface Conversion {
	/** 'buy': stablecoin in, credits out. 'sell': credits in, stablecoin out. */
	direction: 'buy' | 'sell';
	/** 'from': `amount` is what goes in; 'to': `amount` is what comes out (the anchor SDK's affinity). */
	affinity: 'from' | 'to';
	amount: bigint;
	/** US dollars per unit of the stablecoin's currency. */
	rate: Rate;
	spreadBps: number;
	stablecoinDecimals: number;
	creditDecimals: number;
}

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/**
 * The other side of a swap, in base units: what comes out for an exact
 * amount in (rounded down), or what must go in for an exact amount out
 * (rounded up), with the spread taken either way.
 */
export function convert(c: Conversion): bigint {
	if (c.amount <= 0n) {
		throw new Error('amount must be more than zero');
	}
	if (!Number.isInteger(c.spreadBps) || c.spreadBps < 0 || c.spreadBps >= 10_000) {
		throw new Error('spread must be whole basis points below 10000');
	}
	const spread = BigInt(c.spreadBps);
	const stable = 10n ** BigInt(c.stablecoinDecimals);
	const credit = 10n ** BigInt(c.creditDecimals);
	const { num, den } = c.rate;
	/* credits = stablecoin × rate, in base units: s × num × 10^dc / (den × 10^ds). */
	const stableIn = c.direction === 'buy';
	if (c.affinity === 'from') {
		/* What comes out of an exact amount in: less the spread, rounded down. */
		return stableIn
			? (c.amount * num * credit * (BPS - spread)) / (den * stable * BPS)
			: (c.amount * den * stable * (BPS - spread)) / (num * credit * BPS);
	}
	/* What must go in for an exact amount out: plus the spread, rounded up. */
	return stableIn
		? ceilDiv(c.amount * den * stable * (BPS + spread), num * credit * BPS)
		: ceilDiv(c.amount * num * credit * (BPS + spread), den * stable * BPS);
}
