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
import { convert, parseRate, staticRates, TEST_USD_RATES } from '../src/rates.ts';
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
