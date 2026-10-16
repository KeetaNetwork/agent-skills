/**
 * Persistent agent state: one JSON file in the data directory, written
 * atomically. Holds policies, installed models, the operator link proof,
 * job history and unpaid receipts. Never holds the passkey PRF output.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NetworkName, SignedReceipt } from '@keeta-compute/protocol';
import type { BuyerPolicy, InstalledModel, JobSummary, ProviderPolicy } from './rpc/types.ts';

export interface OperatorLink {
	payTo: string;
	network: NetworkName;
	issuedAt: number;
	signature: string;
}

export interface UnpaidReceipt {
	jobId: string;
	network: NetworkName;
	payTo: string;
	amount: string;
	asset: string;
	receipt: SignedReceipt;
	attempts: number;
	lastError?: string;
	/** Set once a payment block was published; reported to the control plane. */
	blockHash?: string;
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
	unpaid: UnpaidReceipt[];
	spentByDay: Record<string, string>;
	earnedByDay: Record<string, string>;
	tokensByDay: Record<string, number>;
	earnedTotal: string;
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
			perRequestMax: '250000', // 0.25 USDC
			dailyMax: '5000000', // 5 USDC
			allowedModels: [],
			allowedProviders: [],
			maxPrice: { inputPerMillion: '2000000', outputPerMillion: '6000000' }
		},
		models: [],
		jobs: [],
		unpaid: [],
		spentByDay: {},
		earnedByDay: {},
		tokensByDay: {},
		earnedTotal: '0'
	};
}

export function today(now = Date.now()): string {
	return new Date(now).toISOString().slice(0, 10);
}

export class StateStore {
	readonly file: string;
	state: AgentStateFile;

	constructor(readonly dataDir: string) {
		mkdirSync(dataDir, { recursive: true, mode: 0o700 });
		this.file = join(dataDir, 'state.json');
		this.state = existsSync(this.file) ? { ...defaultState(), ...(JSON.parse(readFileSync(this.file, 'utf8')) as Partial<AgentStateFile>) } : defaultState();
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

	addToDay(field: 'spentByDay' | 'earnedByDay', amount: bigint, now = Date.now()): void {
		this.update((s) => {
			const day = today(now);
			s[field][day] = (BigInt(s[field][day] ?? '0') + amount).toString();
			const keep = Object.keys(s[field]).sort().slice(-31);
			s[field] = Object.fromEntries(keep.map((k) => [k, s[field][k]!]));
		});
	}
}

/** A secret file readable only by this user (0600). */
export function readOrCreateSecret(path: string, create: () => string): string {
	if (existsSync(path)) {
		return readFileSync(path, 'utf8').trim();
	}
	const value = create();
	writeFileSync(path, `${value}\n`, { mode: 0o600 });
	chmodSync(path, 0o600);
	return value;
}
