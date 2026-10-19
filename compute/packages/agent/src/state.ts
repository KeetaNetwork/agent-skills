/**
 * Persistent agent state: one JSON file in the data directory, written
 * atomically. Holds policies, installed models, the operator link proof,
 * job history, today's spend for the local limits, and escrows still to be
 * reported. Balances and earnings are read from the ledger, never kept
 * here. Never holds the passkey PRF output.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync, type Stats } from 'node:fs';
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

/** Which save of the file this is: every save writes a new file and renames it into place. */
function versionOf(stats: Stats): string {
	return `${stats.ino}:${stats.size}:${stats.mtimeMs}`;
}

export class StateStore {
	readonly file: string;
	/** Called after the file was read again because another process saved it. */
	onReload: (() => void) | null = null;
	private current: AgentStateFile;
	/** The version of the file this process last read or saved. */
	private seen: string | null = null;

	constructor(readonly dataDir: string) {
		mkdirSync(dataDir, { recursive: true, mode: 0o700 });
		this.file = join(dataDir, 'state.json');
		this.current = existsSync(this.file) ? this.read() : defaultState();
	}

	/**
	 * The saved state. A running node shares the file with one-shot CLI
	 * commands (`token --rotate`, `provide`, `buy`, `models offer`): when one
	 * of them saved it since this process last read or saved it, it is read
	 * again, so the node applies the change at once and its own saves keep it.
	 */
	get state(): AgentStateFile {
		let reloaded = false;
		try {
			if (versionOf(statSync(this.file)) !== this.seen) {
				this.current = this.read();
				reloaded = true;
			}
		} catch {
			/* Missing or unreadable: keep this process's copy, which its next save writes. */
		}
		if (reloaded) {
			this.onReload?.();
		}
		return this.current;
	}

	private read(): AgentStateFile {
		const version = versionOf(statSync(this.file));
		const state = { ...defaultState(), ...(JSON.parse(readFileSync(this.file, 'utf8')) as Partial<AgentStateFile>) };
		/* Older files carried pay-later receipts and a stored earnings tally; credits are escrowed and earnings read from the ledger now. */
		for (const key of ['unpaid', 'awaitingReceipts', 'earnedByDay', 'earnedTotal']) {
			delete (state as unknown as Record<string, unknown>)[key];
		}
		this.seen = version;
		return state;
	}

	save(): void {
		/* A temporary file of this process's own, so processes saving at once never rename each other's. */
		const tmp = `${this.file}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify(this.current, null, 2), { mode: 0o600 });
		this.seen = versionOf(statSync(tmp));
		renameSync(tmp, this.file);
	}

	/** Apply a change to the latest saved state and save it, so it never undoes another process's change. */
	update(mutate: (state: AgentStateFile) => void): AgentStateFile {
		mutate(this.state);
		this.save();
		return this.current;
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
