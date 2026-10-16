/**
 * The keeta.ai FX provider for Keeta Compute Credits, as a Keeta anchor FX
 * service (KeetaNetFXAnchorHTTPServer). It swaps each available stablecoin
 * with credits in both directions: buyers turn stablecoins into credits,
 * providers cash credits out. Swaps are atomic on the ledger: the user's
 * block sends one side and receives the other from the FX account, which
 * holds the credit supply and the stablecoins it has taken in.
 *
 * Clients find it through the anchor resolver rooted at the FX account,
 * whose account metadata (published by scripts/publish-metadata.ts) lists
 * this service. Nothing here keeps balances: the ledger does.
 */

import * as KeetaAnchor from '@keetanetwork/anchor';
import { KeetaNetFXAnchorHTTPServer } from '@keetanetwork/anchor/services/fx/server.js';
import type { NetworkName } from '@keeta-compute/protocol';
import { PARITY_SYMBOLS, convert, type RateSource } from './rates.ts';

/* The anchor SDK carries its own keetanet-client; the server takes its accounts and clients. */
const KeetaNet = KeetaAnchor.KeetaNet;
type KeyPairAccount = ReturnType<typeof KeetaNet.lib.Account.fromSeed>;
type TokenAddress = NonNullable<KeetaNetFXAnchorHTTPServer['fx']['from']>[number]['to'][number];

export interface FxStablecoin {
	symbol: string;
	/** ISO 4217 code it tracks. */
	currency: string;
	address: string;
	decimals: number;
}

export interface FxConfig {
	network: NetworkName;
	/** Seed of the FX account: it holds the liquidity, signs the swaps and quotes, and publishes the metadata. */
	seed: string;
	credits: { token: string; decimals: number };
	stablecoins: FxStablecoin[];
	rates: RateSource;
	/** Basis points either way on stablecoins that are not US dollars. */
	spreadBps: number;
	port?: number;
	/** The public https URL the service is reached at; published in the metadata. */
	url?: string;
}

/** Which stablecoin a swap involves and which way it goes, or null for a pair this provider does not trade. */
export function pairFor(config: Pick<FxConfig, 'credits' | 'stablecoins'>, from: string, to: string): { stablecoin: FxStablecoin; direction: 'buy' | 'sell' } | null {
	const find = (address: string) => config.stablecoins.find((s) => s.address === address);
	if (to === config.credits.token) {
		const stablecoin = find(from);
		return stablecoin ? { stablecoin, direction: 'buy' } : null;
	}
	if (from === config.credits.token) {
		const stablecoin = find(to);
		return stablecoin ? { stablecoin, direction: 'sell' } : null;
	}
	return null;
}

/** The converted amount for a request, in base units (see rates.ts convert). */
export function quoteAmount(config: Pick<FxConfig, 'credits' | 'stablecoins' | 'rates' | 'spreadBps'>, request: { from: string; to: string; amount: string | bigint; affinity: 'from' | 'to' }): bigint {
	const pair = pairFor(config, request.from, request.to);
	if (!pair) {
		throw new Error('this FX provider swaps the listed stablecoins with Keeta Compute Credits only');
	}
	const parity = PARITY_SYMBOLS.has(pair.stablecoin.symbol);
	return convert({
		direction: pair.direction,
		affinity: request.affinity,
		amount: BigInt(request.amount),
		rate: parity ? { num: 1n, den: 1n } : config.rates.usdPer(pair.stablecoin.currency),
		spreadBps: parity ? 0 : config.spreadBps,
		stablecoinDecimals: pair.stablecoin.decimals,
		creditDecimals: config.credits.decimals
	});
}

export function fxAccount(seed: string): KeyPairAccount {
	return KeetaNet.lib.Account.fromSeed(seed, 0);
}

/** Build the anchor FX server; call `start()` on it to listen. */
export function createFxServer(config: FxConfig): KeetaNetFXAnchorHTTPServer {
	if (config.stablecoins.length === 0) {
		throw new Error(`no stablecoin is available on the ${config.network} network to swap with credits`);
	}
	const account = fxAccount(config.seed);
	const client = KeetaNet.UserClient.fromNetwork(config.network, account);
	const stablecoins = config.stablecoins.map((s) => s.address as TokenAddress);
	const credits = config.credits.token as TokenAddress;
	return new KeetaNetFXAnchorHTTPServer({
		client,
		accounts: new KeetaNet.lib.Account.Set([account]),
		signer: account,
		quoteSigner: account,
		metadataSigner: account,
		...(config.port !== undefined ? { port: config.port } : {}),
		...(config.url ? { url: config.url } : {}),
		homepage: '<!doctype html><title>Keeta Compute Credits FX</title><p>Swaps Keeta stablecoins and USDC with Keeta Compute Credits.</p>',
		fx: {
			from: [
				{ currencyCodes: stablecoins, to: [credits] },
				{ currencyCodes: [credits], to: stablecoins }
			],
			getConversionRateAndFee: async (request) => ({
				account,
				convertedAmount: quoteAmount(config, request),
				/* The spread is in the rate; no separate fee. */
				cost: { amount: 0n, token: KeetaNet.lib.Account.fromPublicKeyString(request.from).assertKeyType(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN) }
			})
		}
	});
}

/** Stop listening and release the server's ledger client (it refreshes representatives in the background). */
export async function stopFxServer(server: KeetaNetFXAnchorHTTPServer): Promise<void> {
	await server.stop();
	const client = server.client;
	await ('destroy' in client ? client.destroy() : client.client.destroy()).catch(() => undefined);
}
