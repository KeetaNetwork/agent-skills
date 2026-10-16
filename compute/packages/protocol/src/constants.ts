/**
 * Network constants. Everything defaults to the Keeta test network; main is
 * only used when an operator explicitly selects it.
 */

export type NetworkName = 'test' | 'main';

export interface NetworkAsset {
	/** Token address on Keeta. */
	address: string;
	symbol: string;
	/** Decimal places, as published by the token. */
	decimals: number;
}

export interface NetworkInfo {
	name: NetworkName;
	/** CAIP-2 identifier used by x402. */
	caip2: string;
	/** The stablecoin prices and payouts are denominated in (USDC at launch). */
	settlementAsset: NetworkAsset;
	explorer: string;
}

/*
 * USDC addresses match the defaults shipped in @x402/keeta 2.28.0
 * (DEFAULT_ASSETS). KTA is read from the client at run time.
 */
export const NETWORKS: Record<NetworkName, NetworkInfo> = {
	test: {
		name: 'test',
		caip2: 'keeta:1413829460',
		settlementAsset: {
			address: 'keeta_apna75yhhvnv4ei7ape55hndk4yepno7a7i2mhtiwahiygixjcnmvswxhnmnk',
			symbol: 'USDC',
			decimals: 6
		},
		explorer: 'https://explorer.test.keeta.com'
	},
	main: {
		name: 'main',
		caip2: 'keeta:21378',
		settlementAsset: {
			address: 'keeta_amnkge74xitii5dsobstldatv3irmyimujfjotftx7plaaaseam4bntb7wnna',
			symbol: 'USDC',
			decimals: 6
		},
		explorer: 'https://explorer.keeta.com'
	}
};

export const DEFAULT_NETWORK: NetworkName = 'test';

/** Port of the buyer endpoint the macOS app exposes to local agents. */
export const LOCAL_API_PORT = 11435;

/** Providers that miss heartbeats for this long are not scheduled. */
export const PROVIDER_STALE_MS = 90_000;

/** Interval at which agents heartbeat to the control plane. */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/** How long a scheduled job's ticket is valid for the buyer to start it. */
export const TICKET_TTL_MS = 60_000;

/** Signed requests outside this window are rejected (replay protection). */
export const REQUEST_SKEW_MS = 120_000;

/** A buyer with a receipt left unpaid longer than this is not scheduled. */
export const UNPAID_GRACE_MS = 10 * 60_000;

/** Pairing codes for Linux helpers expire after this long. */
export const PAIRING_TTL_MS = 10 * 60_000;

/** Prices are quoted per this many tokens. */
export const PRICE_UNIT_TOKENS = 1_000_000n;
