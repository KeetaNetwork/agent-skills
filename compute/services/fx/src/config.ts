/**
 * The FX provider's settings from the environment. The main network is
 * refused until it has a credit token pin, pinned stablecoins and a live
 * rate source; the test network runs on the fixed test rates.
 */

import { CREDIT_DECIMALS, assertKeetaAddress, availableAssets, pinnedCredits, type NetworkName } from '@keeta-compute/protocol';
import { DEFAULT_SPREAD_BPS, TEST_USD_RATES, httpRates, staticRates, type RateSource } from './rates.ts';
import type { FxConfig } from './server.ts';

export interface FxEnv {
	/** Seed of the FX account (hex). Keep it in a secret store. */
	FX_SEED?: string;
	/** test (default) or main. */
	FX_NETWORK?: string;
	FX_PORT?: string;
	/** The public https URL of this service, published in the FX account's metadata. */
	FX_PUBLIC_URL?: string;
	/** Basis points either way on stablecoins that are not US dollars; default 50. */
	FX_SPREAD_BPS?: string;
	/** HTTPS endpoint answering {"EUR": "1.08", ...} in US dollars per unit. Required on the main network. */
	FX_RATE_SOURCE?: string;
	/** Test network only: JSON {"EUR": "1.08", ...} replacing the fixed test rates. */
	FX_TEST_RATES?: string;
	/** Test network only: a credit token to use before `credits:create` wrote the pin. */
	TEST_CREDIT_TOKEN?: string;
}

export function fxConfigFromEnv(env: FxEnv): FxConfig & { rateSource: string } {
	const seed = env.FX_SEED?.trim();
	if (!seed || !/^[0-9a-fA-F]{64}$/.test(seed)) {
		throw new Error('FX_SEED must be the FX account seed, 64 hex characters');
	}
	const network = (env.FX_NETWORK?.trim() || 'test') as NetworkName;
	if (network !== 'test' && network !== 'main') {
		throw new Error('FX_NETWORK must be test or main');
	}
	if (network === 'main' && !env.FX_RATE_SOURCE?.trim()) {
		throw new Error('the main network needs live rates: set FX_RATE_SOURCE to an https endpoint answering {"EUR": "1.08", ...} in US dollars per unit');
	}
	const pin = pinnedCredits(network);
	const override = network === 'test' && env.TEST_CREDIT_TOKEN?.trim() ? assertKeetaAddress(env.TEST_CREDIT_TOKEN.trim(), 'TEST_CREDIT_TOKEN') : null;
	const credits = override ? { token: override, decimals: CREDIT_DECIMALS } : pin ? { token: pin.token, decimals: pin.decimals } : null;
	if (!credits) {
		throw new Error(`Keeta Compute Credits are not pinned for the ${network} network; run \`npm run credits:create\` (test network) first`);
	}
	const stablecoins = availableAssets(network).map(({ symbol, currency, address, decimals }) => ({ symbol, currency, address, decimals }));
	if (stablecoins.length === 0) {
		throw new Error(`no stablecoin is pinned for the ${network} network; run \`npm run assets:pin\` first`);
	}
	let rates: RateSource;
	let rateSource: string;
	if (env.FX_RATE_SOURCE?.trim()) {
		const url = env.FX_RATE_SOURCE.trim();
		if (!url.startsWith('https://')) {
			throw new Error('FX_RATE_SOURCE must be an https URL');
		}
		rates = httpRates(url);
		rateSource = url;
	} else {
		rates = staticRates(env.FX_TEST_RATES?.trim() ? (JSON.parse(env.FX_TEST_RATES) as Record<string, string>) : TEST_USD_RATES);
		rateSource = env.FX_TEST_RATES?.trim() ? 'FX_TEST_RATES' : 'fixed test rates';
	}
	const spreadBps = env.FX_SPREAD_BPS?.trim() ? Number(env.FX_SPREAD_BPS) : DEFAULT_SPREAD_BPS;
	if (!Number.isInteger(spreadBps) || spreadBps < 0 || spreadBps > 1_000) {
		throw new Error('FX_SPREAD_BPS must be whole basis points from 0 to 1000');
	}
	const port = env.FX_PORT?.trim() ? Number(env.FX_PORT) : 8787;
	if (!Number.isInteger(port) || port < 0 || port > 65_535) {
		throw new Error('FX_PORT must be a port number');
	}
	const url = env.FX_PUBLIC_URL?.trim();
	if (network === 'main' && !url?.startsWith('https://')) {
		throw new Error('the main network needs FX_PUBLIC_URL, the https URL clients reach this service at');
	}
	return { network, seed, credits, stablecoins, rates, rateSource, spreadBps, port, ...(url ? { url } : {}) };
}
