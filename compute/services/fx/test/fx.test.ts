/**
 * The FX provider offline: its prices, its settings, and the anchor FX
 * server answering estimates and signed quotes over HTTP. Swaps themselves
 * need the ledger; the live suite covers them.
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import * as KeetaAnchor from '@keetanetwork/anchor';
import { NETWORKS, availableAssets } from '@keeta-compute/protocol';
import { fxConfigFromEnv } from '../src/config.ts';
import { convert, httpRates, parseRate, staticRates, TEST_USD_RATES } from '../src/rates.ts';
import { createFxServer, fxAccount, quoteAmount, stopFxServer } from '../src/server.ts';

const SEED = 'ab'.repeat(32);
/* Any real token address works as the credit token here: the test network's base token. */
const CREDIT_TOKEN = KeetaNet.lib.Account.generateBaseAddresses(BigInt(NETWORKS.test.caip2.split(':')[1]!)).baseToken.publicKeyString.get();
const USDC = availableAssets('test').find((a) => a.symbol === 'USDC')!;

test('prices: dollars at par both ways; other currencies at their rate with the spread, rounded for the provider', () => {
	const usd = { rate: parseRate('1'), spreadBps: 0, stablecoinDecimals: 6, creditDecimals: 6 };
	for (const affinity of ['from', 'to'] as const) {
		for (const direction of ['buy', 'sell'] as const) {
			assert.equal(convert({ ...usd, direction, affinity, amount: 1_234_567n }), 1_234_567n, `${direction} ${affinity}`);
		}
	}
	const eur = { rate: parseRate('1.08'), spreadBps: 50, stablecoinDecimals: 6, creditDecimals: 6 };
	const cases: Array<[string, Parameters<typeof convert>[0], bigint]> = [
		/* 100 EUR in: 108 credits less 0.5%. */
		['buy, exact EUR in', { ...eur, direction: 'buy', affinity: 'from', amount: 100_000_000n }, 107_460_000n],
		/* 108 credits out: 100 EUR plus 0.5%. */
		['buy, exact credits out', { ...eur, direction: 'buy', affinity: 'to', amount: 108_000_000n }, 100_500_000n],
		/* 108 credits in: 100 EUR less 0.5%. */
		['sell, exact credits in', { ...eur, direction: 'sell', affinity: 'from', amount: 108_000_000n }, 99_500_000n],
		/* 100 EUR out: 108 credits plus 0.5%. */
		['sell, exact EUR out', { ...eur, direction: 'sell', affinity: 'to', amount: 100_000_000n }, 108_540_000n]
	];
	for (const [name, conversion, expected] of cases) {
		assert.equal(convert(conversion), expected, name);
	}
	/* Rounding: a yen token with 0 decimals; one credit buys ~149 yen, and a fraction rounds against the user. */
	const jpy = { rate: parseRate('0.0067'), spreadBps: 0, stablecoinDecimals: 0, creditDecimals: 6 };
	assert.equal(convert({ ...jpy, direction: 'sell', affinity: 'from', amount: 1_000_000n }), 149n, 'down when paying out');
	assert.equal(convert({ ...jpy, direction: 'buy', affinity: 'to', amount: 1_000_000n }), 150n, 'up when taking in');
	assert.throws(() => convert({ ...usd, direction: 'buy', affinity: 'from', amount: 0n }), /more than zero/);
	assert.throws(() => parseRate('-1'), /positive decimal/);
});

test('settings: the main network needs live rates and its own pins; the test network runs on fixed rates', () => {
	assert.throws(() => fxConfigFromEnv({ FX_SEED: SEED, FX_NETWORK: 'main' }), /FX_RATE_SOURCE/);
	assert.throws(() => fxConfigFromEnv({ FX_SEED: SEED, FX_NETWORK: 'main', FX_RATE_SOURCE: 'https://rates.example' }), /not pinned for the main network/);
	assert.throws(() => fxConfigFromEnv({ FX_SEED: SEED, FX_NETWORK: 'main', FX_RATE_SOURCE: 'https://rates.example', TEST_CREDIT_TOKEN: CREDIT_TOKEN }), /not pinned for the main network/, 'the test override never applies to main');
	assert.throws(() => fxConfigFromEnv({ FX_SEED: 'nope' }), /FX_SEED/);
	const config = fxConfigFromEnv({ FX_SEED: SEED, TEST_CREDIT_TOKEN: CREDIT_TOKEN, FX_SPREAD_BPS: '25' });
	assert.equal(config.network, 'test');
	assert.equal(config.credits.token, CREDIT_TOKEN);
	assert.equal(config.spreadBps, 25);
	assert.equal(config.rateSource, 'fixed test rates');
	assert.deepEqual(
		config.stablecoins.map((s) => s.symbol),
		availableAssets('test').map((a) => a.symbol)
	);
});

test('pairs: only stablecoin to credits and back', () => {
	const config = { credits: { token: CREDIT_TOKEN, decimals: 6 }, stablecoins: [{ symbol: 'KEUR', currency: 'EUR', address: USDC.address, decimals: 6 }], rates: staticRates(TEST_USD_RATES), spreadBps: 50 };
	assert.equal(quoteAmount(config, { from: USDC.address, to: CREDIT_TOKEN, amount: '100000000', affinity: 'from' }), 107_460_000n);
	assert.throws(() => quoteAmount(config, { from: USDC.address, to: USDC.address, amount: '1', affinity: 'from' }), /with Keeta Compute Credits only/);
});

test('live rates: a feed tick outside its range or far from the last rate is never quoted', async () => {
	let feed: Record<string, unknown> = {};
	let clock = 1_800_000_000_000;
	const warn = console.warn;
	console.warn = () => undefined;
	const open = (first: Record<string, unknown>) => {
		feed = first;
		const rates = httpRates('https://rates.test', { refreshMs: 3_600_000, now: () => clock, fetchImpl: async () => Response.json(feed) });
		return { rates, read: async (next: Record<string, unknown>) => ((feed = next), rates.refresh()) };
	};
	const settle = () => new Promise((resolve) => setImmediate(resolve));
	const quotes = (rates: { usdPer(currency: string): { num: bigint; den: bigint } }, currency: string) => {
		try {
			const rate = rates.usdPer(currency);
			return Number(rate.num) / Number(rate.den);
		} catch {
			return null;
		}
	};
	try {
		/* The first rate needs two reads that agree; a spike on the first read is not quoted. */
		const { rates, read } = open({ EUR: '1.5', JPY: '0.0067', CHF: '1.1' });
		await settle();
		assert.equal(quotes(rates, 'JPY'), null, 'one read is not enough');
		await read({ EUR: '1.08', JPY: '0.0067', CHF: '1.1' });
		assert.equal(quotes(rates, 'JPY'), 0.0067);
		assert.equal(quotes(rates, 'EUR'), null, 'the first two EUR reads disagree');
		assert.equal(quotes(rates, 'CHF'), null, 'a currency with no range is never quoted');
		await read({ EUR: '1.08', JPY: '0.0067' });
		assert.equal(quotes(rates, 'EUR'), 1.08);

		/* A unit inversion or a misplaced decimal point is outside the range: ignored, the last good rate stands until it is stale. */
		await read({ EUR: '10.8', JPY: '149' });
		assert.equal(quotes(rates, 'JPY'), 0.0067);
		assert.equal(quotes(rates, 'EUR'), 1.08);
		await read({ EUR: 'abc', JPY: 0.0067 });
		assert.equal(quotes(rates, 'EUR'), 1.08, 'unreadable values change nothing');

		/* A jump inside the range pauses the currency at once, until the feed comes back near the last rate. */
		await read({ EUR: '1.2', JPY: '0.0068' });
		assert.equal(quotes(rates, 'EUR'), null);
		assert.equal(quotes(rates, 'JPY'), 0.0068, 'a small move is followed');
		await read({ EUR: '1.2', JPY: '0.0068' });
		assert.equal(quotes(rates, 'EUR'), null, 'the jump holding is not enough');
		await read({ EUR: '1.085', JPY: '0.0068' });
		assert.equal(quotes(rates, 'EUR'), 1.085);

		/* Stale rates stop quoting. */
		clock += 5 * 60_000 + 1;
		assert.equal(quotes(rates, 'EUR'), null);
		rates.stop();
	} finally {
		console.warn = warn;
	}
});

let server: ReturnType<typeof createFxServer>;

before(async () => {
	/* Offline, the server's ledger client fails to refresh its representatives in the background; keep that out of the output. */
	KeetaAnchor.KeetaNet.Client.DefaultLogger = { log: () => undefined, warn: () => undefined, error: () => undefined };
	server = createFxServer({ ...fxConfigFromEnv({ FX_SEED: SEED, TEST_CREDIT_TOKEN: CREDIT_TOKEN }), port: 0 });
	await server.start();
});

after(async () => {
	if (server) {
		await stopFxServer(server);
	}
});

async function post(path: string, request: Record<string, string>) {
	const response = await fetch(new URL(path, server.url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ request }) });
	/* Amounts come back as hex strings. */
	return (await response.json()) as { ok: boolean; estimate?: { convertedAmount: string }; quote?: { convertedAmount: string; account: string; signed?: unknown }; error?: string };
}

test('the anchor FX server estimates and signs quotes from these prices', async () => {
	const buy = { from: USDC.address, to: CREDIT_TOKEN, amount: '2500000', affinity: 'to' };
	const estimate = await post('/api/getEstimate', buy);
	assert.equal(estimate.ok, true, estimate.error);
	assert.equal(BigInt(estimate.estimate!.convertedAmount), 2_500_000n, 'USDC buys credits one to one');

	const quote = await post('/api/getQuote', { from: CREDIT_TOKEN, to: USDC.address, amount: '1000000', affinity: 'from' });
	assert.equal(quote.ok, true, quote.error);
	assert.equal(BigInt(quote.quote!.convertedAmount), 1_000_000n, 'credits cash out to USDC one to one');
	assert.equal(quote.quote!.account, fxAccount(SEED).publicKeyString.get(), 'the FX account fills the swap');
	assert.ok(quote.quote!.signed, 'the quote is signed');

	const refused = await post('/api/getEstimate', { from: USDC.address, to: USDC.address, amount: '1', affinity: 'from' });
	assert.equal(refused.ok, false);

	const metadata = await server.serviceMetadata();
	assert.deepEqual(metadata.from, [
		{ currencyCodes: [USDC.address], to: [CREDIT_TOKEN] },
		{ currencyCodes: [CREDIT_TOKEN], to: [USDC.address] }
	]);
	assert.ok(metadata.operations.createExchange, 'swaps are offered, not only estimates');
});
