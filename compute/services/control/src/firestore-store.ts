/**
 * Firestore implementation of the control-plane store.
 *
 * Collections: providers/{nodeKey}, jobs/{jobId}, pairings/{pairingId},
 * nonces/{sha(key:nonce)} (with a TTL policy on `expiresAt`).
 */

import type { Firestore } from 'firebase-admin/firestore';
import type { JobRecord, JobStatus, NetworkName, PairingRecord } from '@keeta-compute/protocol';
import { sha256Hex } from '@keeta-compute/protocol';
import { NotFoundError, type Store, type StoredProvider } from './store.ts';

export class FirestoreStore implements Store {
	constructor(private readonly db: Firestore) {}

	private providers() {
		return this.db.collection('providers');
	}

	private jobs() {
		return this.db.collection('jobs');
	}

	private pairings() {
		return this.db.collection('pairings');
	}

	async getProvider(nodeKey: string) {
		const snap = await this.providers().doc(nodeKey).get();
		return snap.exists ? (snap.data() as StoredProvider) : null;
	}

	async putProvider(record: StoredProvider) {
		await this.providers().doc(record.nodeKey).set(record);
	}

	async updateProvider(nodeKey: string, update: (record: StoredProvider) => StoredProvider | null) {
		const ref = this.providers().doc(nodeKey);
		return this.db.runTransaction(async (tx) => {
			const snap = await tx.get(ref);
			if (!snap.exists) {
				return null;
			}
			const next = update(snap.data() as StoredProvider);
			if (next) {
				tx.set(ref, next);
			}
			return next;
		});
	}

	async deleteProvider(nodeKey: string) {
		await this.providers().doc(nodeKey).delete();
	}

	async listLiveProviders(network: NetworkName, since: number, modelId?: string) {
		let query = this.providers().where('network', '==', network);
		if (modelId) {
			query = query.where('offeredModels', 'array-contains', modelId);
		}
		const snap = await query.where('lastHeartbeat', '>=', since).orderBy('lastHeartbeat', 'desc').limit(500).get();
		return snap.docs.map((doc) => doc.data() as StoredProvider);
	}

	async listHelpers(masterNodeKey: string) {
		const snap = await this.providers().where('masterNodeKey', '==', masterNodeKey).orderBy('registeredAt', 'desc').limit(100).get();
		return snap.docs.map((doc) => doc.data() as StoredProvider);
	}

	async getJob(jobId: string) {
		const snap = await this.jobs().doc(jobId).get();
		return snap.exists ? (snap.data() as JobRecord) : null;
	}

	async putJob(job: JobRecord) {
		await this.jobs().doc(job.jobId).set(stripUndefined(job));
	}

	async putJobIf(job: JobRecord, admit: (openQuotes: JobRecord[]) => void) {
		/* Every admission for a buyer reads and writes its lock document, so Firestore serializes them. */
		const lock = this.db.collection('buyerLocks').doc(job.buyer);
		await this.db.runTransaction(async (tx) => {
			await tx.get(lock);
			const open = await tx.get(this.jobs().where('buyer', '==', job.buyer).where('status', '==', 'quoted'));
			admit(open.docs.map((doc) => doc.data() as JobRecord));
			tx.set(this.jobs().doc(job.jobId), stripUndefined(job));
			tx.set(lock, { lastJobAt: job.createdAt });
		});
	}

	async updateJob(jobId: string, update: (job: JobRecord) => JobRecord) {
		const ref = this.jobs().doc(jobId);
		return this.db.runTransaction(async (tx) => {
			const snap = await tx.get(ref);
			if (!snap.exists) {
				throw new NotFoundError('job not found');
			}
			const next = update(snap.data() as JobRecord);
			tx.set(ref, stripUndefined(next));
			return next;
		});
	}

	async listJobsByBuyer(buyer: string, limit: number) {
		const snap = await this.jobs().where('buyer', '==', buyer).orderBy('createdAt', 'desc').limit(limit).get();
		return snap.docs.map((doc) => doc.data() as JobRecord);
	}

	async listJobsByNode(nodeKey: string, limit: number) {
		const snap = await this.jobs().where('nodeKey', '==', nodeKey).orderBy('createdAt', 'desc').limit(limit).get();
		return snap.docs.map((doc) => doc.data() as JobRecord);
	}

	async listJobsByStatus(status: JobStatus, createdBefore: number, limit: number) {
		const snap = await this.jobs().where('status', '==', status).where('createdAt', '<', createdBefore).orderBy('createdAt', 'asc').limit(limit).get();
		return snap.docs.map((doc) => doc.data() as JobRecord);
	}

	async listPayoutsDue(limit: number) {
		/* payoutDue is written only while true and removed once the payout is recorded. */
		const snap = await this.jobs().where('payoutDue', '==', true).limit(limit).get();
		return snap.docs.map((doc) => doc.data() as JobRecord);
	}

	async getPairing(pairingId: string) {
		const snap = await this.pairings().doc(pairingId).get();
		return snap.exists ? (snap.data() as PairingRecord) : null;
	}

	async findPairingByCodeHash(codeHash: string) {
		const snap = await this.pairings().where('codeHash', '==', codeHash).limit(1).get();
		const doc = snap.docs[0];
		return doc ? (doc.data() as PairingRecord) : null;
	}

	async putPairing(record: PairingRecord) {
		await this.pairings().doc(record.pairingId).set(stripUndefined(record));
	}

	async updatePairing(pairingId: string, update: (record: PairingRecord) => PairingRecord) {
		const ref = this.pairings().doc(pairingId);
		return this.db.runTransaction(async (tx) => {
			const snap = await tx.get(ref);
			if (!snap.exists) {
				throw new NotFoundError('pairing not found');
			}
			const next = update(snap.data() as PairingRecord);
			tx.set(ref, stripUndefined(next));
			return next;
		});
	}

	async claimNonce(key: string, nonce: string, expiresAt: number) {
		const id = await sha256Hex(`${key}:${nonce}`);
		try {
			await this.db.collection('nonces').doc(id).create({ expiresAt: new Date(expiresAt) });
			return true;
		} catch (error) {
			if ((error as { code?: number }).code === 6) {
				return false; // ALREADY_EXISTS
			}
			throw error;
		}
	}
}

function stripUndefined<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}
