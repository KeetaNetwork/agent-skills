/**
 * Persistent agent state: one JSON file in the data directory, written
 * atomically. Holds policies, installed models, the operator link proof,
 * job history, today's spend for the local limits, and escrows still to be
 * reported. Balances and earnings are read from the ledger, never kept
 * here. Never holds the passkey PRF output.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PendingEscrow } from '@keeta-compute/buyer';
import { utcDay, type NetworkName } from '@keeta-compute/protocol';
import type { BuyerPolicy, InstalledModel, JobSummary, ProviderPolicy } from '@keeta-compute/protocol/rpc';

export interface OperatorLink {
	payTo: string;
	network: NetworkName;
	issuedAt: number;
	signature: string;
}

export interface HelperConfig {
	masterNodeKey: string;
	payTo: string;
	pairedAt: number;
}

export interface AgentStateFile {
	version: 1;
	network: NetworkName;
	controlUrl: string;
	relayUrl: string;
	machineName: string;
	operatorLinks: Partial<Record<NetworkName, OperatorLink>>;
	provider: ProviderPolicy;
	buyer: BuyerPolicy & { token: string };
	models: InstalledModel[];
	jobs: JobSummary[];
	escrows: PendingEscrow[];
	/** Credits providers billed this Mac per UTC day, for the local daily limit only. */
	spentByDay: Record<string, string>;
	tokensByDay: Record<string, number>;
	helper?: HelperConfig;
}

function randomToken(): string {
	const bytes = new Uint8Array(24);
	crypto.getRandomValues(bytes);
	return `kc_${Buffer.from(bytes).toString('base64url')}`;
}

export function defaultState(): AgentStateFile {
	return {
		version: 1,
		network: 'test',
		controlUrl: 'https://control.keeta.ai',
		relayUrl: 'https://relay.keeta.ai',
		machineName: 'Mac',
		operatorLinks: {},
		provider: {
			enabled: false,
			schedule: { mode: 'always', startHour: 22, endHour: 8, idleMinutes: 10 },
			pauseOnBattery: true,
			maxConcurrentJobs: 1,
			access: { mode: 'public', allow: [] }
		},
		buyer: {
			token: randomToken(),
			perRequestMax: '250000', // 0.25 credits
			dailyMax: '5000000', // 5 credits
			allowedModels: [],
			allowedProviders: [],
			maxPrice: { inputPerMillion: '2000000', outputPerMillion: '6000000' }
		},
		models: [],
		jobs: [],
		escrows: [],
		spentByDay: {},
		tokensByDay: {}
	};
}

export class StateStore {
	readonly file: string;
	state: AgentStateFile;

	constructor(readonly dataDir: string) {
		mkdirSync(dataDir, { recursive: true, mode: 0o700 });
		this.file = join(dataDir, 'state.json');
		this.state = existsSync(this.file) ? { ...defaultState(), ...(JSON.parse(readFileSync(this.file, 'utf8')) as Partial<AgentStateFile>) } : defaultState();
		/* Older files carried pay-later receipts and a stored earnings tally; credits are escrowed and earnings read from the ledger now. */
		for (const key of ['unpaid', 'awaitingReceipts', 'earnedByDay', 'earnedTotal']) {
			delete (this.state as unknown as Record<string, unknown>)[key];
		}
	}

	save(): void {
		const tmp = `${this.file}.tmp`;
		writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
		renameSync(tmp, this.file);
	}

	update(mutate: (state: AgentStateFile) => void): AgentStateFile {
		mutate(this.state);
		this.save();
		return this.state;
	}

	rotateBuyerToken(): string {
		return this.update((s) => (s.buyer.token = randomToken())).buyer.token;
	}

	recordJob(job: JobSummary): void {
		this.update((s) => {
			const index = s.jobs.findIndex((j) => j.jobId === job.jobId && j.role === job.role);
			if (index >= 0) {
				s.jobs[index] = job;
			} else {
				s.jobs.unshift(job);
				s.jobs.length = Math.min(s.jobs.length, 500);
			}
		});
	}

	addToDay(field: 'spentByDay', amount: bigint, now = Date.now()): void {
		this.update((s) => {
			const day = utcDay(now);
			s[field][day] = (BigInt(s[field][day] ?? '0') + amount).toString();
			const keep = Object.keys(s[field]).sort().slice(-31);
			s[field] = Object.fromEntries(keep.map((k) => [k, s[field][k]!]));
		});
	}
}
