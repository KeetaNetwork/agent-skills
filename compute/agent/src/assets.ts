/**
 * What the wallet holds and moves: Keeta Compute Credits (which pay for
 * requests), the Keeta stablecoins and USDC (which buy credits), and KTA
 * (network fees). Credits come from the control plane's /v1/config; the
 * stablecoins from the pins in the protocol package.
 */

import { CREDIT_DECIMALS, CREDIT_SYMBOL, availableAssets, type NetworkCredits, type NetworkName } from '@keeta-compute/protocol';

/** KTA, the network fee token, has 18 decimals (the RPC contract does not report it). */
export const KTA_DECIMALS = 18;

export interface WalletAsset {
	/** 'credits', 'kta', or a stablecoin symbol (KUSD, …, USDC). */
	key: string;
	/** Token address, or 'kta' for the network's base token. */
	address: string;
	symbol: string;
	decimals: number;
}

/**
 * An asset by the name a person types or the app sends: credits, kta, or a
 * stablecoin symbol in any case. Throws with a reason when it cannot be used.
 */
export function resolveWalletAsset(network: NetworkName, credits: NetworkCredits | null, name: string | undefined): WalletAsset {
	const key = (name ?? CREDIT_SYMBOL).trim();
	if (key.toLowerCase() === CREDIT_SYMBOL) {
		if (!credits) {
			throw new Error(`Keeta Compute Credits are not available on the ${network} network yet`);
		}
		return { key: CREDIT_SYMBOL, address: credits.token, symbol: CREDIT_SYMBOL, decimals: credits.decimals };
	}
	if (key.toLowerCase() === 'kta') {
		return { key: 'kta', address: 'kta', symbol: 'KTA', decimals: KTA_DECIMALS };
	}
	const stablecoin = availableAssets(network).find((a) => a.symbol === key.toUpperCase());
	if (!stablecoin) {
		throw new Error(`${key} is not available on the ${network} network; use credits, kta or one of ${availableAssets(network).map((a) => a.symbol).join(', ')}`);
	}
	return { key: stablecoin.symbol, address: stablecoin.address, symbol: stablecoin.symbol, decimals: stablecoin.decimals };
}

/** A stablecoin that buys credits or that credits are sold for. */
export function resolveStablecoin(network: NetworkName, name: string | undefined): WalletAsset {
	const asset = resolveWalletAsset(network, null, name ?? availableAssets(network)[0]?.symbol ?? 'USDC');
	if (asset.key === 'kta') {
		throw new Error('credits are bought and sold with a stablecoin, not KTA');
	}
	return asset;
}

/** The credit token's display info, also when credits do not exist on the network yet. */
export function creditAsset(credits: NetworkCredits | null): { address: string; symbol: string; decimals: number } {
	return { address: credits?.token ?? '', symbol: CREDIT_SYMBOL, decimals: credits?.decimals ?? CREDIT_DECIMALS };
}
