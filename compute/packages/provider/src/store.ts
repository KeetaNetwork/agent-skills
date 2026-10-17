/**
 * What the provider and the model manager read and write of a node's saved
 * state. The agent's StateStore implements it; anything that keeps these
 * fields and saves them on update will do.
 */

import type { NetworkName } from '@keeta-compute/protocol';
import type { InstalledModel, JobSummary, ProviderPolicy } from '@keeta-compute/protocol/rpc';

export interface ProviderState {
	network: NetworkName;
	machineName: string;
	provider: ProviderPolicy;
	models: InstalledModel[];
	/** Recent jobs, newest first; the provider shows its own (the agent records them through onJob). */
	jobs: JobSummary[];
	/** Output tokens served per UTC day. */
	tokensByDay: Record<string, number>;
}

export interface ProviderStore {
	readonly state: ProviderState;
	/** Apply a change to the state and save it. */
	update(mutate: (state: ProviderState) => void): unknown;
}
