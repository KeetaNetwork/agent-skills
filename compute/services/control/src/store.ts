/**
 * Persistence for the control plane. Firestore in production
 * (firestore-store.ts); an in-memory store for local runs and tests.
 */

import type { JobRecord, JobStatus, NetworkName, PairingRecord, ProviderRecord } from '@keeta-compute/protocol';

/** Stored provider record, with the derived field Firestore queries on. */
export interface StoredProvider extends ProviderRecord {
	offeredModels: string[];
}

export interface Store {
	getProvider(nodeKey: string): Promise<StoredProvider | null>;
	putProvider(record: StoredProvider): Promise<void>;
	/** Apply `update` atomically; returns the new record, or null if missing. */
	updateProvider(nodeKey: string, update: (record: StoredProvider) => StoredProvider | null): Promise<StoredProvider | null>;
	deleteProvider(nodeKey: string): Promise<void>;
	/** Providers on a network that heartbeated since `since`, optionally offering a model. */
	listLiveProviders(network: NetworkName, since: number, modelId?: string): Promise<StoredProvider[]>;
	listHelpers(masterNodeKey: string): Promise<StoredProvider[]>;

	getJob(jobId: string): Promise<JobRecord | null>;
	putJob(job: JobRecord): Promise<void>;
	/**
	 * Write a job only if `admit` accepts it, given the buyer's open postpay jobs.
	 * Atomic per buyer: concurrent calls for one buyer see each other's jobs.
	 * `admit` throws to refuse.
	 */
	putJobIf(job: JobRecord, admit: (openPostpay: JobRecord[]) => void): Promise<void>;
	/** Atomic read-modify-write. `update` may throw to abort. */
	updateJob(jobId: string, update: (job: JobRecord) => JobRecord): Promise<JobRecord>;
	listJobsByBuyer(buyer: string, limit: number): Promise<JobRecord[]>;
	listJobsByNode(nodeKey: string, limit: number): Promise<JobRecord[]>;
	/** Completed (receipted) postpay jobs still unpaid, completed before `before`. */
	listUnpaid(buyer: string, before: number): Promise<JobRecord[]>;
	/** Postpay jobs the buyer still owes for: scheduled (not yet receipted) or completed and unpaid. */
	listOpenPostpay(buyer: string): Promise<JobRecord[]>;
	listJobsByStatus(status: JobStatus, createdBefore: number, limit: number): Promise<JobRecord[]>;

	getPairing(pairingId: string): Promise<PairingRecord | null>;
	findPairingByCodeHash(codeHash: string): Promise<PairingRecord | null>;
	putPairing(record: PairingRecord): Promise<void>;
	updatePairing(pairingId: string, update: (record: PairingRecord) => PairingRecord): Promise<PairingRecord>;

	/** Record a request nonce; false if it was already used (replay). */
	claimNonce(key: string, nonce: string, expiresAt: number): Promise<boolean>;
}

export class NotFoundError extends Error {
	readonly status = 404;
}

export class ConflictError extends Error {
	readonly status = 409;
}

const clone = <T>(value: T): T => structuredClone(value);

export class MemoryStore implements Store {
	readonly providers = new Map<string, StoredProvider>();
	readonly jobs = new Map<string, JobRecord>();
	readonly pairings = new Map<string, PairingRecord>();
	readonly nonces = new Map<string, number>();

	async getProvider(nodeKey: string) {
		const record = this.providers.get(nodeKey);
		return record ? clone(record) : null;
	}

	async putProvider(record: StoredProvider) {
		this.providers.set(record.nodeKey, clone(record));
	}

	async updateProvider(nodeKey: string, update: (record: StoredProvider) => StoredProvider | null) {
		const current = this.providers.get(nodeKey);
		if (!current) {
			return null;
		}
		const next = update(clone(current));
		if (next) {
			this.providers.set(nodeKey, clone(next));
		}
		return next;
	}

	async deleteProvider(nodeKey: string) {
		this.providers.delete(nodeKey);
	}

	async listLiveProviders(network: NetworkName, since: number, modelId?: string) {
		return [...this.providers.values()]
			.filter((p) => p.network === network && p.lastHeartbeat >= since && (!modelId || p.offeredModels.includes(modelId)))
			.map(clone);
	}

	async listHelpers(masterNodeKey: string) {
		return [...this.providers.values()].filter((p) => p.masterNodeKey === masterNodeKey).map(clone);
	}

	async getJob(jobId: string) {
		const job = this.jobs.get(jobId);
		return job ? clone(job) : null;
	}

	async putJob(job: JobRecord) {
		this.jobs.set(job.jobId, clone(job));
	}

	async putJobIf(job: JobRecord, admit: (openPostpay: JobRecord[]) => void) {
		/* No await between the check and the write, so this is atomic in one process. */
		admit(this.openPostpay(job.buyer));
		this.jobs.set(job.jobId, clone(job));
	}

	private openPostpay(buyer: string) {
		return [...this.jobs.values()].filter((j) => j.buyer === buyer && j.paymentMode === 'postpay' && (j.status === 'scheduled' || j.status === 'completed')).map(clone);
	}

	async updateJob(jobId: string, update: (job: JobRecord) => JobRecord) {
		const current = this.jobs.get(jobId);
		if (!current) {
			throw new NotFoundError('job not found');
		}
		const next = update(clone(current));
		this.jobs.set(jobId, clone(next));
		return clone(next);
	}

	async listJobsByBuyer(buyer: string, limit: number) {
		return [...this.jobs.values()].filter((j) => j.buyer === buyer).sort((a, b) => b.createdAt - a.createdAt).slice(0, limit).map(clone);
	}

	async listJobsByNode(nodeKey: string, limit: number) {
		return [...this.jobs.values()].filter((j) => j.nodeKey === nodeKey).sort((a, b) => b.createdAt - a.createdAt).slice(0, limit).map(clone);
	}

	async listUnpaid(buyer: string, before: number) {
		return [...this.jobs.values()]
			.filter((j) => j.buyer === buyer && j.status === 'completed' && j.paymentMode === 'postpay' && (j.completedAt ?? 0) < before)
			.map(clone);
	}

	async listOpenPostpay(buyer: string) {
		return this.openPostpay(buyer);
	}

	async listJobsByStatus(status: JobStatus, createdBefore: number, limit: number) {
		return [...this.jobs.values()].filter((j) => j.status === status && j.createdAt < createdBefore).slice(0, limit).map(clone);
	}

	async getPairing(pairingId: string) {
		const record = this.pairings.get(pairingId);
		return record ? clone(record) : null;
	}

	async findPairingByCodeHash(codeHash: string) {
		const record = [...this.pairings.values()].find((p) => p.codeHash === codeHash);
		return record ? clone(record) : null;
	}

	async putPairing(record: PairingRecord) {
		this.pairings.set(record.pairingId, clone(record));
	}

	async updatePairing(pairingId: string, update: (record: PairingRecord) => PairingRecord) {
		const current = this.pairings.get(pairingId);
		if (!current) {
			throw new NotFoundError('pairing not found');
		}
		const next = update(clone(current));
		this.pairings.set(pairingId, clone(next));
		return clone(next);
	}

	async claimNonce(key: string, nonce: string, expiresAt: number) {
		const id = `${key}:${nonce}`;
		const now = Date.now();
		for (const [entry, expiry] of this.nonces) {
			if (expiry < now) {
				this.nonces.delete(entry);
			}
		}
		if (this.nonces.has(id)) {
			return false;
		}
		this.nonces.set(id, expiresAt);
		return true;
	}
}
