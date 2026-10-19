/**
 * What the buyer reads and writes of a node's saved state: its policy, the
 * escrows still to be reported, its jobs and today's spend. The agent's
 * StateStore implements it. Balances are never kept here; they are read
 * from the ledger.
 */

import type { NetworkName } from '@keeta-compute/protocol';
import type { BuyerPolicy, JobSummary } from '@keeta-compute/protocol/rpc';

/**
 * An escrow sent to the settlement account whose block the control plane
 * has not confirmed yet (the report failed, or the app quit in between).
 * Reported again until it is: the control plane then issues the ticket or,
 * past the quote, refunds the escrow.
 */
export interface PendingEscrow {
	jobId: string;
	network: NetworkName;
	blockHash: string;
	at: number;
}

export interface BuyerState {
	network: NetworkName;
	relayUrl: string;
	/** The policy, and the bearer token local tools present to the endpoint. */
	buyer: BuyerPolicy & { token: string };
	escrows: PendingEscrow[];
	jobs: JobSummary[];
	/** Credits providers billed per UTC day, for the local daily limit only. */
	spentByDay: Record<string, string>;
}

export interface BuyerStore {
	readonly state: BuyerState;
	/** Apply a change to the state and save it. */
	update(mutate: (state: BuyerState) => void): unknown;
	/** Add to a day's spend (UTC day of `now`). */
	addToDay(field: 'spentByDay', amount: bigint, now?: number): void;
}
