/**
 * Network constants. Everything defaults to the Keeta test network; main is
 * only used when an operator explicitly selects it.
 */

export type NetworkName = 'test' | 'main';

export interface NetworkInfo {
	name: NetworkName;
	/** CAIP-2 identifier used by x402. */
	caip2: string;
	explorer: string;
}

/*
 * What each network settles in lives in assets.ts (the stablecoins) and
 * credits.ts (the credit token app jobs are prepaid in). KTA is read from the
 * client at run time.
 */
export const NETWORKS: Record<NetworkName, NetworkInfo> = {
	test: { name: 'test', caip2: 'keeta:1413829460', explorer: 'https://explorer.test.keeta.com' },
	main: { name: 'main', caip2: 'keeta:21378', explorer: 'https://explorer.keeta.com' }
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

/**
 * A router job is prepaid with x402: the node accepts it and holds a slot,
 * and runs it only once the router has settled the payment. An accepted job
 * not started within this long is dropped, and its slot freed.
 */
export const PREPAID_START_TIMEOUT_MS = 30_000;

/** How long an app job's quote stands while the buyer escrows credits for it. It holds no provider slot. */
export const QUOTE_TTL_MS = 60_000;

/**
 * An app ticket holds a slot on its provider, so it must be used promptly:
 * brought to the relay within this long of being issued, and not hung up on
 * within this long of arriving before any text comes back. Otherwise the
 * provider keeps the no-show fee (NO_SHOW_FEE) from the escrow.
 */
export const NO_SHOW_WINDOW_MS = 10_000;

/**
 * The longest a node runs one job. It then stops the model and bills the
 * text already sent (finish reason `length`), so every job ends, with its
 * receipt and the relay's record, well before SETTLE_LAPSE_MS.
 */
export const MAX_JOB_MS = 10 * 60_000;

/**
 * An escrowed app job, or a paid router job, still missing its receipt or the
 * relay's delivery record this long after its ticket was issued is settled
 * without them: the buyer is refunded in full, less the no-show fee when it
 * owes one. It covers the ticket's TTL, a router job's start wait, a job
 * running MAX_JOB_MS, and the relay's retries of its record.
 */
export const SETTLE_LAPSE_MS = 15 * 60_000;

/** Signed requests outside this window are rejected (replay protection). */
export const REQUEST_SKEW_MS = 120_000;

/** Pairing codes for Linux helpers expire after this long. */
export const PAIRING_TTL_MS = 10 * 60_000;

/** Prices are quoted per this many tokens. */
export const PRICE_UNIT_TOKENS = 1_000_000n;
