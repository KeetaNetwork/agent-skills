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
 * Rates read from an HTTPS endpoint answering `{"EUR": "1.08", ...}` (US
 * dollars per unit), refreshed every `refreshMs`. Quotes stop once the last
 * good read is older than `maxAgeMs`, rather than trade at a stale price.
 */
export function httpRates(url: string, options: { refreshMs?: number; maxAgeMs?: number; fetchImpl?: typeof fetch; now?: () => number } = {}): RateSource & { refresh(): Promise<void>; stop(): void } {
	const now = options.now ?? Date.now;
	const maxAgeMs = options.maxAgeMs ?? 5 * 60_000;
	let table: RateSource | null = null;
	let readAt = 0;
	const refresh = async () => {
		const response = await (options.fetchImpl ?? fetch)(url, { headers: { accept: 'application/json' } });
		if (!response.ok) {
			throw new Error(`the rate source answered ${response.status}`);
		}
		const body = (await response.json()) as Record<string, unknown>;
		table = staticRates(Object.fromEntries(Object.entries(body).filter((entry): entry is [string, string] => typeof entry[1] === 'string')));
		readAt = now();
	};
	const tick = () => void refresh().catch((error: Error) => console.warn(`rate refresh failed: ${error.message}`));
	const timer = setInterval(tick, options.refreshMs ?? 60_000);
	timer.unref?.();
	tick();
	return {
		refresh,
		stop: () => clearInterval(timer),
		usdPer(currency) {
			if (!table || now() - readAt > maxAgeMs) {
				throw new Error('rates are stale; not quoting until the rate source answers again');
			}
			return table.usdPer(currency);
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
