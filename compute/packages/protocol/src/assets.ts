/**
 * The stablecoins people pay with. Keeta's own stablecoins lead: KUSD, KEUR,
 * KJPY, KMXN, KCAD, KAED and KGBP, issued on Keeta by Bivo as `$K` tokens.
 * USDC works too.
 *
 * In the app, stablecoins buy Keeta Compute Credits through the keeta.ai FX
 * provider and credits pay per request (credits.ts). The public router takes
 * a stablecoin directly per request over x402: KUSD once it is pinned,
 * otherwise USDC, at one credit to the dollar.
 */

import { ASSET_PINS, type AssetPin } from './asset-pins.ts';
import type { NetworkName } from './constants.ts';

export interface AssetDefinition {
	/** Ticker, unique per network: KUSD, KEUR, …, USDC. */
	symbol: string;
	/** ISO 4217 code of the currency the token tracks. */
	currency: string;
	name: string;
	issuer: string;
	/** Code the anchor resolver lists the token under (`$KUSD`), for pinning. */
	resolverCode?: string;
}

/** Lead order: the default first, USDC last. */
export const ASSET_DEFINITIONS: readonly AssetDefinition[] = [
	{ symbol: 'KUSD', currency: 'USD', name: 'Keeta US Dollar', issuer: 'Bivo', resolverCode: '$KUSD' },
	{ symbol: 'KEUR', currency: 'EUR', name: 'Keeta Euro', issuer: 'Bivo', resolverCode: '$KEUR' },
	{ symbol: 'KJPY', currency: 'JPY', name: 'Keeta Japanese Yen', issuer: 'Bivo', resolverCode: '$KJPY' },
	{ symbol: 'KMXN', currency: 'MXN', name: 'Keeta Mexican Peso', issuer: 'Bivo', resolverCode: '$KMXN' },
	{ symbol: 'KCAD', currency: 'CAD', name: 'Keeta Canadian Dollar', issuer: 'Bivo', resolverCode: '$KCAD' },
	{ symbol: 'KAED', currency: 'AED', name: 'Keeta UAE Dirham', issuer: 'Bivo', resolverCode: '$KAED' },
	{ symbol: 'KGBP', currency: 'GBP', name: 'Keeta British Pound', issuer: 'Bivo', resolverCode: '$KGBP' },
	{ symbol: 'USDC', currency: 'USD', name: 'USD Coin', issuer: 'Circle' }
];

export const KEETA_STABLECOINS: readonly string[] = ASSET_DEFINITIONS.filter((a) => a.symbol !== 'USDC').map((a) => a.symbol);

/** The stablecoin the apps suggest first and the router asks for, when it is available. */
export const DEFAULT_ASSET_SYMBOL = 'KUSD';

/*
 * USDC addresses match the defaults shipped in @x402/keeta 2.28.0
 * (DEFAULT_ASSETS).
 */
const USDC_PINS: Record<NetworkName, AssetPin> = {
	test: { address: 'keeta_apna75yhhvnv4ei7ape55hndk4yepno7a7i2mhtiwahiygixjcnmvswxhnmnk', decimals: 6 },
	main: { address: 'keeta_amnkge74xitii5dsobstldatv3irmyimujfjotftx7plaaaseam4bntb7wnna', decimals: 6 }
};

/** A stablecoin usable on one network. */
export interface NetworkAsset {
	/** Token address on Keeta. */
	address: string;
	symbol: string;
	/** Decimal places, as published by the token. */
	decimals: number;
	currency: string;
	name: string;
}

/** One row of a network's stablecoin list, available or not. */
export interface AssetListing extends AssetDefinition {
	address: string | null;
	decimals: number | null;
	/** False until the token is pinned in asset-pins.ts. */
	available: boolean;
}

function pinFor(network: NetworkName, symbol: string): AssetPin | undefined {
	return symbol === 'USDC' ? USDC_PINS[network] : ASSET_PINS[network][symbol];
}

/** Every stablecoin of a network in lead order, with whether it can be used yet. */
export function assetListing(network: NetworkName): AssetListing[] {
	return ASSET_DEFINITIONS.map((definition) => {
		const pin = pinFor(network, definition.symbol);
		return { ...definition, address: pin?.address ?? null, decimals: pin?.decimals ?? null, available: Boolean(pin) };
	});
}

/** The stablecoins usable on a network, in lead order. */
export function availableAssets(network: NetworkName): NetworkAsset[] {
	return assetListing(network).flatMap((a) => (a.available ? [{ address: a.address!, symbol: a.symbol, decimals: a.decimals!, currency: a.currency, name: a.name }] : []));
}

/** An available stablecoin by symbol (any case) or token address. */
export function findAsset(network: NetworkName, symbolOrAddress: string): NetworkAsset | undefined {
	const key = symbolOrAddress.trim();
	return availableAssets(network).find((a) => a.address === key || a.symbol === key.toUpperCase());
}

/** KUSD when it is available, otherwise USDC. */
export function defaultAsset(network: NetworkName): NetworkAsset {
	return findAsset(network, DEFAULT_ASSET_SYMBOL) ?? findAsset(network, 'USDC')!;
}

/** The network's USDC. */
export function usdcAsset(network: NetworkName): NetworkAsset {
	return findAsset(network, 'USDC')!;
}

/**
 * Rescale an amount between two decimal precisions of the same currency,
 * rounding up so a non-zero price never becomes zero.
 */
export function rescaleAmount(amount: bigint, fromDecimals: number, toDecimals: number): bigint {
	if (toDecimals >= fromDecimals) {
		return amount * 10n ** BigInt(toDecimals - fromDecimals);
	}
	const divisor = 10n ** BigInt(fromDecimals - toDecimals);
	return (amount + divisor - 1n) / divisor;
}
