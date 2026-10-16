/**
 * Control-plane business logic: registry, scheduling, receipts, payments,
 * pairing. Transport-independent; see http.ts for routing.
 */

import {
	CATALOG,
	HEARTBEAT_INTERVAL_MS,
	MIN_PROVIDER_MEMORY_BYTES,
	NETWORKS,
	PAIRING_TTL_MS,
	PROVIDER_STALE_MS,
	TICKET_TTL_MS,
	UNPAID_GRACE_MS,
	ValidationError,
	assertAccess,
	assertKeetaAddress,
	assertModelId,
	assertOffer,
	assertPrice,
	findCatalogModel,
	hardwareTier,
	jobCost,
	maxJobCost,
	operatorLinkMessage,
	pairingApprovalMessage,
	pairingCheckString,
	providerRelayToken,
	randomId,
	receiptMessage,
	ticketMac,
	ticketMessage,
	type AccessPolicy,
	type HardwareProfile,
	type JobRecord,
	type JobTicket,
	type NetworkModel,
	type NetworkName,
	type Offer,
	type PairingRecord,
	type Price,
	type ProviderKind,
	type ProviderRecord,
	type SignedReceipt,
	type SignedTicket,
	type Signer,
	type Verifier
} from '@keeta-compute/protocol';
import { ConflictError, NotFoundError, type Store, type StoredProvider } from './store.ts';

export class AuthError extends Error {
	readonly status = 401;
}

export class ForbiddenError extends Error {
	readonly status = 403;
}

export class UnavailableError extends Error {
	readonly status = 503;
	constructor(message: string, readonly retryAfterSeconds = 5) {
		super(message);
	}
}

export class PaymentRequiredError extends Error {
	readonly status = 402;
}

export type PaymentVerifier = (args: { network: NetworkName; blockHash: string; from: string; to: string; asset: string; minAmount: bigint; reference: string }) => Promise<'confirmed' | 'pending' | 'rejected'>;

/** Reads an account's on-ledger balance of `asset`, in base units. Throws if the ledger can't be reached. */
export type BalanceReader = (args: { network: NetworkName; account: string; asset: string }) => Promise<bigint>;

export interface ControlConfig {
	store: Store;
	/** Keeta account that signs job tickets. Providers pin its public key. */
	coordinator: Signer;
	verify: Verifier;
	relaySecret: string;
	/** Shared secret the public router uses for quotes and settlement notices. */
	routerSecret: string;
	relayUrl: string;
	networks: NetworkName[];
	verifyPayment: PaymentVerifier;
	/**
	 * When set, pay-later buyers must hold enough of the settlement asset to
	 * cover every job they still owe for plus the new job's maximum cost, so a
	 * fresh key with no funds can't run jobs it never pays for.
	 */
	balanceOf?: BalanceReader;
	now?: () => number;
	/** Testnet escape hatch so small Macs can provide during development. */
	allowSmallProviders?: boolean;
}

const RELAY_TOKEN_TTL_MS = 10 * 60_000;
const MAX_INPUT_TOKENS = 262_144;

export class ControlService {
	private readonly store: Store;
	private readonly now: () => number;

	constructor(private readonly config: ControlConfig) {
		this.store = config.store;
		this.now = config.now ?? Date.now;
	}

	private assertNetwork(value: unknown): NetworkName {
		if (value !== 'test' && value !== 'main') {
			throw new ValidationError('network must be test or main');
		}
		if (!this.config.networks.includes(value)) {
			throw new ForbiddenError(`network ${value} is not enabled on this control plane`);
		}
		return value;
	}

	publicConfig() {
		return {
			coordinatorKey: this.config.coordinator.publicKey,
			relayUrl: this.config.relayUrl,
			networks: this.config.networks,
			heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
			assets: Object.fromEntries(this.config.networks.map((n) => [n, NETWORKS[n].settlementAsset]))
		};
	}

	catalog() {
		return CATALOG;
	}

	/* ---------------------------------------------------------------- providers */

	async registerProvider(nodeKey: string, body: Record<string, unknown>) {
		const network = this.assertNetwork(body.network);
		const kind = body.kind as ProviderKind;
		if (kind !== 'mac' && kind !== 'linux-helper') {
			throw new ValidationError('kind must be mac or linux-helper');
		}
		const hardware = assertHardware(body.hardware);
		const name = typeof body.name === 'string' ? body.name.slice(0, 80) : 'Mac';
		const existing = await this.store.getProvider(nodeKey);

		let payTo: string;
		let masterNodeKey: string | undefined;
		if (kind === 'mac') {
			payTo = assertKeetaAddress(body.payTo, 'payTo');
			const link = body.link as { issuedAt?: number; signature?: string } | undefined;
			if (!link || typeof link.issuedAt !== 'number' || typeof link.signature !== 'string') {
				throw new ValidationError('link proof is required');
			}
			const message = operatorLinkMessage({ nodeKey, payTo, network, issuedAt: link.issuedAt });
			if (!this.config.verify(payTo, message, link.signature)) {
				throw new AuthError('operator link signature does not verify for payTo');
			}
		} else {
			/* Helpers register only through an approved pairing (see approvePairing). */
			if (!existing || existing.kind !== 'linux-helper' || !existing.masterNodeKey) {
				throw new ForbiddenError('Linux helpers are registered by pairing with a Mac');
			}
			payTo = existing.payTo;
			masterNodeKey = existing.masterNodeKey;
		}

		const now = this.now();
		const record: StoredProvider = {
			nodeKey,
			payTo,
			kind,
			...(masterNodeKey ? { masterNodeKey } : {}),
			name,
			network,
			hardware,
			tier: hardwareTier(hardware),
			offers: existing?.offers ?? [],
			offeredModels: existing?.offeredModels ?? [],
			access: existing?.access ?? { mode: 'public', allow: [] },
			status: existing?.status ?? 'paused',
			load: existing?.load ?? { active: 0, capacity: 1 },
			lastHeartbeat: existing?.lastHeartbeat ?? 0,
			registeredAt: existing?.registeredAt ?? now,
			stats: existing?.stats ?? { completed: 0, failed: 0, tokensOut: 0, earned: '0' }
		};
		await this.store.putProvider(record);
		return { provider: publicProvider(record), eligible: this.isEligible(record) };
	}

	private isEligible(record: Pick<ProviderRecord, 'hardware' | 'network'>): boolean {
		if (record.hardware.memoryBytes >= MIN_PROVIDER_MEMORY_BYTES) {
			return true;
		}
		return Boolean(this.config.allowSmallProviders) && record.network === 'test';
	}

	async heartbeat(nodeKey: string, body: Record<string, unknown>) {
		const status = body.status === 'online' ? 'online' : 'paused';
		const offers = Array.isArray(body.offers) ? body.offers.map((offer, i) => assertOffer(offer, i)) : [];
		if (offers.length > 64) {
			throw new ValidationError('too many offers');
		}
		const access = body.access ? assertAccess(body.access) : undefined;
		const load = body.load as { active?: unknown; capacity?: unknown } | undefined;
		const reported = Number.isInteger(load?.active) ? Math.max(0, Number(load?.active)) : 0;
		const capacity = Number.isInteger(load?.capacity) ? Math.min(64, Math.max(1, Number(load?.capacity))) : 1;
		const now = this.now();
		/* Count jobs ticketed to this node that have not started yet, so a heartbeat never frees their slots. */
		const ticketed = (await this.store.listJobsByNode(nodeKey, 100)).filter((j) => j.status === 'scheduled' && j.paymentMode === 'postpay' && j.createdAt > now - TICKET_TTL_MS).length;
		const active = Math.max(reported, ticketed);

		const record = await this.store.updateProvider(nodeKey, (current) => {
			const eligible = this.isEligible(current);
			const pinned = offers.filter((offer) => pinnedOfferOk(offer, current.network));
			return {
				...current,
				status: eligible ? status : 'paused',
				offers: pinned,
				offeredModels: [...new Set(pinned.map((o) => o.modelId))],
				...(access ? { access } : {}),
				load: { active, capacity },
				lastHeartbeat: now
			};
		});
		if (!record) {
			throw new NotFoundError('provider is not registered');
		}
		const relayTokenExpiresAt = now + RELAY_TOKEN_TTL_MS;
		return {
			status: record.status,
			eligible: this.isEligible(record),
			relayUrl: this.config.relayUrl,
			relayToken: await providerRelayToken(this.config.relaySecret, nodeKey, relayTokenExpiresAt),
			relayTokenExpiresAt,
			coordinatorKey: this.config.coordinator.publicKey
		};
	}

	async providerSelf(nodeKey: string) {
		const record = await this.store.getProvider(nodeKey);
		if (!record) {
			throw new NotFoundError('provider is not registered');
		}
		const jobs = await this.store.listJobsByNode(nodeKey, 50);
		return { provider: publicProvider(record), eligible: this.isEligible(record), jobs: jobs.map(redactJob) };
	}

	/* -------------------------------------------------------------- scheduling */

	async networkModels(network: NetworkName): Promise<NetworkModel[]> {
		this.assertNetwork(network);
		const providers = await this.store.listLiveProviders(network, this.now() - PROVIDER_STALE_MS);
		const byModel = new Map<string, NetworkModel>();
		for (const provider of providers) {
			if (provider.status !== 'online') {
				continue;
			}
			for (const offer of provider.offers) {
				const catalog = findCatalogModel(offer.modelId);
				const entry = byModel.get(offer.modelId) ?? {
					id: offer.modelId,
					name: catalog?.name ?? offer.modelId,
					providers: 0,
					lowestPrice: offer.price,
					contextLength: offer.contextLength,
					...(catalog ? { license: catalog.license.name } : {})
				};
				entry.providers += 1;
				if (priceTotal(offer.price) < priceTotal(entry.lowestPrice)) {
					entry.lowestPrice = offer.price;
				}
				entry.contextLength = Math.max(entry.contextLength, offer.contextLength);
				byModel.set(offer.modelId, entry);
			}
		}
		return [...byModel.values()].sort((a, b) => b.providers - a.providers || a.id.localeCompare(b.id));
	}

	/**
	 * Pick a provider for a job and issue its ticket (plan §5.5 step 3).
	 * Public providers take any buyer; allowlisted offers only take listed
	 * paying keys, and the node re-checks before running anything.
	 */
	private async schedule(args: {
		network: NetworkName;
		buyer: string;
		modelId: string;
		maxInputTokens: number;
		maxOutputTokens: number;
		maxPrice?: Price;
		allowedProviders?: string[];
		excludeProviders?: string[];
		paymentMode: JobRecord['paymentMode'];
		publicOnly: boolean;
		/** Most the job may cost; offers whose maximum cost is higher are skipped. */
		budget?: bigint;
	}): Promise<{ job: JobRecord; ticket: SignedTicket; provider: StoredProvider }> {
		const now = this.now();
		let overBudget = 0;
		const candidates = (await this.store.listLiveProviders(args.network, now - PROVIDER_STALE_MS, args.modelId))
			.filter((provider) => provider.status === 'online' && provider.load.active < provider.load.capacity)
			.filter((provider) => !args.excludeProviders?.includes(provider.nodeKey))
			.filter((provider) => !args.allowedProviders?.length || args.allowedProviders.includes(provider.nodeKey) || args.allowedProviders.includes(provider.payTo))
			.flatMap((provider) => {
				const offer = provider.offers.find((o) => o.modelId === args.modelId);
				if (!offer) {
					return [];
				}
				if (args.maxInputTokens + args.maxOutputTokens > offer.contextLength) {
					return [];
				}
				const access: AccessPolicy = offer.access.mode === 'allowlist' ? offer.access : provider.access;
				if (access.mode === 'allowlist' && (args.publicOnly || !access.allow.includes(args.buyer))) {
					return [];
				}
				if (args.maxPrice && (BigInt(offer.price.inputPerMillion) > BigInt(args.maxPrice.inputPerMillion) || BigInt(offer.price.outputPerMillion) > BigInt(args.maxPrice.outputPerMillion))) {
					return [];
				}
				if (args.budget !== undefined && maxJobCost(offer.price, args) > args.budget) {
					overBudget++;
					return [];
				}
				return [{ provider, offer }];
			});

		if (candidates.length === 0) {
			if (overBudget > 0) {
				throw new PaymentRequiredError(`the buyer account does not hold enough ${NETWORKS[args.network].settlementAsset.symbol} to cover this job's maximum cost`);
			}
			throw new UnavailableError(`no provider is available for ${args.modelId} right now`);
		}

		const chosen = pickCandidate(candidates);
		const jobId = randomId('job', 12);
		const job: JobRecord = {
			jobId,
			network: args.network,
			buyer: args.buyer,
			nodeKey: chosen.provider.nodeKey,
			payTo: chosen.provider.payTo,
			modelId: args.modelId,
			price: chosen.offer.price,
			maxInputTokens: args.maxInputTokens,
			maxOutputTokens: args.maxOutputTokens,
			paymentMode: args.paymentMode,
			...(args.paymentMode === 'prepaid'
				? { prepaidAmount: maxJobCost(chosen.offer.price, { maxInputTokens: args.maxInputTokens, maxOutputTokens: args.maxOutputTokens }).toString() }
				: {}),
			status: 'scheduled',
			createdAt: now
		};
		const ticket: JobTicket = {
			v: 1,
			jobId,
			network: args.network,
			nodeKey: job.nodeKey,
			modelId: job.modelId,
			buyer: job.buyer,
			maxInputTokens: job.maxInputTokens,
			maxOutputTokens: job.maxOutputTokens,
			price: job.price,
			asset: NETWORKS[args.network].settlementAsset.address,
			payTo: job.payTo,
			paymentMode: job.paymentMode,
			...(job.prepaidAmount ? { prepaidAmount: job.prepaidAmount } : {}),
			issuedAt: now,
			expiresAt: now + TICKET_TTL_MS
		};
		const signed: SignedTicket = {
			ticket,
			coordinatorSig: await this.config.coordinator.sign(ticketMessage(ticket)),
			relayMac: await ticketMac(this.config.relaySecret, ticket)
		};
		await this.store.putJob(job);
		/*
		 * Postpay tickets hold a slot until they finish, fail or expire. Router quotes are
		 * handed to unpaid callers in a 402, so they hold nothing: a provider's own
		 * heartbeat count covers prepaid jobs once they actually run.
		 */
		if (job.paymentMode === 'postpay') {
			await this.store.updateProvider(chosen.provider.nodeKey, (record) => ({ ...record, load: { ...record.load, active: record.load.active + 1 } }));
		}
		return { job, ticket: signed, provider: chosen.provider };
	}

	async createJob(buyer: string, body: Record<string, unknown>) {
		const network = this.assertNetwork(body.network);
		const modelId = assertModelId(body.model);
		const maxInputTokens = assertTokenCount(body.maxInputTokens, 'maxInputTokens', MAX_INPUT_TOKENS);
		const maxOutputTokens = assertTokenCount(body.maxOutputTokens, 'maxOutputTokens', 32_768);
		const unpaid = await this.store.listUnpaid(buyer, this.now() - UNPAID_GRACE_MS);
		if (unpaid.length > 0) {
			throw new PaymentRequiredError(`${unpaid.length} completed job(s) are unpaid; settle them before starting new ones`);
		}
		const budget = await this.buyerBudget(network, buyer);
		const result = await this.schedule({
			network,
			buyer,
			modelId,
			maxInputTokens,
			maxOutputTokens,
			...(body.maxPrice ? { maxPrice: assertPrice(body.maxPrice, 'maxPrice') } : {}),
			...(Array.isArray(body.allowedProviders) ? { allowedProviders: body.allowedProviders.map((k, i) => assertKeetaAddress(k, `allowedProviders[${i}]`)) } : {}),
			...(Array.isArray(body.excludeProviders) ? { excludeProviders: body.excludeProviders.map((k, i) => assertKeetaAddress(k, `excludeProviders[${i}]`)) } : {}),
			paymentMode: 'postpay',
			publicOnly: false,
			...(budget !== null ? { budget } : {})
		});
		return { job: redactJob(result.job), ticket: result.ticket, relayUrl: this.config.relayUrl };
	}

	/** What a pay-later buyer can still commit: its ledger balance less what it already owes. Null when not enforced. */
	private async buyerBudget(network: NetworkName, buyer: string): Promise<bigint | null> {
		if (!this.config.balanceOf) {
			return null;
		}
		const [balance, open] = await Promise.all([
			this.config.balanceOf({ network, account: buyer, asset: NETWORKS[network].settlementAsset.address }).catch((error: Error) => {
				console.warn('balance lookup failed', error.message);
				throw new UnavailableError('could not read the buyer balance from the ledger; try again');
			}),
			this.store.listOpenPostpay(buyer)
		]);
		const owed = open.reduce((sum, job) => sum + (job.status === 'completed' && job.amountDue ? BigInt(job.amountDue) : maxJobCost(job.price, job)), 0n);
		return balance - owed;
	}

	/** Public router (x402): the buyer prepays the provider directly before the job runs. */
	async routerQuote(body: Record<string, unknown>) {
		const network = this.assertNetwork(body.network);
		const result = await this.schedule({
			network,
			buyer: this.config.coordinator.publicKey,
			modelId: assertModelId(body.model),
			maxInputTokens: assertTokenCount(body.maxInputTokens, 'maxInputTokens', MAX_INPUT_TOKENS),
			maxOutputTokens: assertTokenCount(body.maxOutputTokens, 'maxOutputTokens', 32_768),
			...(Array.isArray(body.excludeProviders) ? { excludeProviders: body.excludeProviders.map((k, i) => assertKeetaAddress(k, `excludeProviders[${i}]`)) } : {}),
			paymentMode: 'prepaid',
			publicOnly: true
		});
		return { job: redactJob(result.job), ticket: result.ticket, relayUrl: this.config.relayUrl };
	}

	async routerSettled(jobId: string, body: Record<string, unknown>) {
		const payer = assertKeetaAddress(body.payer, 'payer');
		const transaction = typeof body.transaction === 'string' ? body.transaction.slice(0, 200) : '';
		return redactJob(
			await this.store.updateJob(jobId, (job) => {
				if (job.paymentMode !== 'prepaid') {
					throw new ConflictError('not a router job');
				}
				return { ...job, payment: { blockHash: transaction, paidAt: this.now(), verified: true }, routerPayer: payer };
			})
		);
	}

	async routerJob(jobId: string) {
		const job = await this.store.getJob(jobId);
		if (!job || job.paymentMode !== 'prepaid') {
			throw new NotFoundError('job not found');
		}
		return redactJob(job);
	}

	/* ---------------------------------------------------------------- receipts */

	async submitReceipt(nodeKey: string, jobId: string, body: Record<string, unknown>) {
		const signed = body.receipt as SignedReceipt | undefined;
		if (!signed || typeof signed !== 'object' || typeof signed.signature !== 'string' || !signed.receipt) {
			throw new ValidationError('receipt is required');
		}
		const job = await this.store.getJob(jobId);
		if (!job) {
			throw new NotFoundError('job not found');
		}
		if (job.nodeKey !== nodeKey) {
			throw new ForbiddenError('job was not assigned to this node');
		}
		const receipt = signed.receipt;
		const problems = validateReceipt(job, receipt);
		if (problems) {
			throw new ValidationError(problems);
		}
		if (!this.config.verify(nodeKey, receiptMessage(receipt), signed.signature)) {
			throw new AuthError('receipt signature does not verify');
		}
		const now = this.now();
		const updated = await this.store.updateJob(jobId, (current) => {
			if (current.status !== 'scheduled') {
				throw new ConflictError(`job is already ${current.status}`);
			}
			const prepaidSettled = current.paymentMode === 'prepaid' && current.payment;
			return {
				...current,
				status: prepaidSettled ? 'paid' : 'completed',
				completedAt: now,
				receipt: signed,
				amountDue: receipt.amount
			};
		});
		await this.store.updateProvider(nodeKey, (record) => ({
			...record,
			load: { ...record.load, active: Math.max(0, record.load.active - (job.paymentMode === 'postpay' ? 1 : 0)) },
			stats: {
				...record.stats,
				completed: record.stats.completed + 1,
				tokensOut: record.stats.tokensOut + receipt.outputTokens,
				earned: updated.status === 'paid' ? (BigInt(record.stats.earned) + BigInt(receipt.amount)).toString() : record.stats.earned
			}
		}));
		return { job: redactJob(updated) };
	}

	async failJob(nodeKey: string, jobId: string, body: Record<string, unknown>) {
		const reason = typeof body.error === 'string' ? body.error.slice(0, 300) : 'failed';
		const job = await this.store.getJob(jobId);
		if (!job) {
			throw new NotFoundError('job not found');
		}
		if (job.nodeKey !== nodeKey) {
			throw new ForbiddenError('job was not assigned to this node');
		}
		const updated = await this.store.updateJob(jobId, (current) => {
			if (current.status !== 'scheduled') {
				throw new ConflictError(`job is already ${current.status}`);
			}
			return { ...current, status: 'failed', completedAt: this.now(), error: reason };
		});
		await this.store.updateProvider(nodeKey, (record) => ({
			...record,
			load: { ...record.load, active: Math.max(0, record.load.active - (job.paymentMode === 'postpay' ? 1 : 0)) },
			stats: { ...record.stats, failed: record.stats.failed + 1 }
		}));
		return { job: redactJob(updated) };
	}

	/** Buyer gives back a ticket it will not use (spend limit, relay unreachable), freeing the provider's slot. */
	async cancelJob(buyer: string, jobId: string) {
		const job = await this.store.getJob(jobId);
		if (!job) {
			throw new NotFoundError('job not found');
		}
		if (job.buyer !== buyer) {
			throw new ForbiddenError('job belongs to another buyer');
		}
		const updated = await this.store.updateJob(jobId, (current) => {
			if (current.status !== 'scheduled') {
				throw new ConflictError(`job is already ${current.status}`);
			}
			return { ...current, status: 'failed', completedAt: this.now(), error: 'cancelled by the buyer' };
		});
		await this.store.updateProvider(job.nodeKey, (record) => ({ ...record, load: { ...record.load, active: Math.max(0, record.load.active - 1) } }));
		return { job: redactJob(updated) };
	}

	/** Buyer reports the payment block for a receipted postpay job. */
	async submitPayment(buyer: string, jobId: string, body: Record<string, unknown>) {
		const blockHash = typeof body.blockHash === 'string' && /^[0-9A-Fa-f]{64}$/.test(body.blockHash) ? body.blockHash.toUpperCase() : null;
		if (!blockHash) {
			throw new ValidationError('blockHash must be a 64-character hex block hash');
		}
		let job = await this.store.getJob(jobId);
		if (!job) {
			throw new NotFoundError('job not found');
		}
		if (job.buyer !== buyer) {
			throw new ForbiddenError('job belongs to another buyer');
		}
		/* The buyer can pay before the provider's own receipt upload lands; it holds the same signed receipt. */
		if (job.status === 'scheduled' && body.receipt) {
			try {
				await this.submitReceipt(job.nodeKey, jobId, { receipt: body.receipt });
			} catch (error) {
				if (!(error instanceof ConflictError)) {
					throw error;
				}
			}
			job = (await this.store.getJob(jobId))!;
		}
		if (job.status !== 'completed' || !job.amountDue) {
			throw new ConflictError(`job is ${job.status}`);
		}
		const result = await this.config.verifyPayment({
			network: job.network,
			blockHash,
			from: job.buyer,
			to: job.payTo,
			asset: NETWORKS[job.network].settlementAsset.address,
			minAmount: BigInt(job.amountDue),
			reference: job.jobId
		});
		if (result === 'rejected') {
			throw new PaymentRequiredError('that block does not pay this job');
		}
		const updated = await this.store.updateJob(jobId, (current) => ({
			...current,
			status: result === 'confirmed' ? 'paid' : current.status,
			payment: { blockHash, paidAt: this.now(), verified: result === 'confirmed' }
		}));
		if (result === 'confirmed') {
			await this.creditEarnings(updated);
		}
		return { job: redactJob(updated) };
	}

	private async creditEarnings(job: JobRecord) {
		if (!job.amountDue) {
			return;
		}
		await this.store.updateProvider(job.nodeKey, (record) => ({
			...record,
			stats: { ...record.stats, earned: (BigInt(record.stats.earned) + BigInt(job.amountDue!)).toString() }
		}));
	}

	async buyerJobs(buyer: string) {
		const jobs = await this.store.listJobsByBuyer(buyer, 100);
		return { jobs: jobs.map(redactJob) };
	}

	/**
	 * Housekeeping, run on a schedule: expire tickets nobody used, re-check
	 * payments the ledger had not confirmed yet, expire pairings.
	 */
	async sweep() {
		const now = this.now();
		let expired = 0;
		let confirmed = 0;
		for (const job of await this.store.listJobsByStatus('scheduled', now - TICKET_TTL_MS - 5 * 60_000, 200)) {
			await this.store.updateJob(job.jobId, (current) => (current.status === 'scheduled' ? { ...current, status: 'expired' } : current));
			if (job.paymentMode === 'postpay') {
				await this.store.updateProvider(job.nodeKey, (record) => ({ ...record, load: { ...record.load, active: Math.max(0, record.load.active - 1) } }));
			}
			expired++;
		}
		for (const job of await this.store.listJobsByStatus('completed', now, 200)) {
			if (!job.payment || job.payment.verified || !job.amountDue) {
				continue;
			}
			const result = await this.config.verifyPayment({
				network: job.network,
				blockHash: job.payment.blockHash,
				from: job.buyer,
				to: job.payTo,
				asset: NETWORKS[job.network].settlementAsset.address,
				minAmount: BigInt(job.amountDue),
				reference: job.jobId
			});
			if (result === 'confirmed') {
				const updated = await this.store.updateJob(job.jobId, (current) => ({ ...current, status: 'paid', payment: { ...current.payment!, verified: true } }));
				await this.creditEarnings(updated);
				confirmed++;
			} else if (result === 'rejected') {
				await this.store.updateJob(job.jobId, (current) => {
					const { payment: _payment, ...rest } = current;
					return rest;
				});
			}
		}
		return { expired, confirmed };
	}

	/* ----------------------------------------------------------------- pairing */

	async createPairing(masterNodeKey: string, body: Record<string, unknown>) {
		const codeHash = typeof body.codeHash === 'string' && /^[0-9a-f]{64}$/.test(body.codeHash) ? body.codeHash : null;
		if (!codeHash) {
			throw new ValidationError('codeHash must be a sha256 hex digest');
		}
		const master = await this.store.getProvider(masterNodeKey);
		if (!master || master.kind !== 'mac') {
			throw new ForbiddenError('only a registered Mac can pair helpers');
		}
		if (await this.store.findPairingByCodeHash(codeHash)) {
			throw new ConflictError('code already used');
		}
		const now = this.now();
		const record: PairingRecord = {
			pairingId: randomId('pair', 12),
			codeHash,
			masterNodeKey,
			payTo: master.payTo,
			network: master.network,
			createdAt: now,
			expiresAt: now + PAIRING_TTL_MS,
			status: 'waiting'
		};
		await this.store.putPairing(record);
		return { pairingId: record.pairingId, expiresAt: record.expiresAt };
	}

	async claimPairing(helperNodeKey: string, body: Record<string, unknown>) {
		const codeHash = typeof body.codeHash === 'string' ? body.codeHash : '';
		const descriptor = assertHardware(body.descriptor);
		const name = typeof (body.descriptor as { name?: unknown }).name === 'string' ? String((body.descriptor as { name: string }).name).slice(0, 80) : 'Linux helper';
		const pairing = await this.store.findPairingByCodeHash(codeHash);
		if (!pairing || pairing.status !== 'waiting' || pairing.expiresAt < this.now()) {
			throw new NotFoundError('pairing code is invalid, used, or expired');
		}
		const checkString = await pairingCheckString(helperNodeKey);
		const updated = await this.store.updatePairing(pairing.pairingId, (current) => {
			if (current.status !== 'waiting') {
				throw new ConflictError('pairing code was already used');
			}
			return { ...current, status: 'claimed', claim: { nodeKey: helperNodeKey, descriptor: { ...descriptor, name }, checkString, claimedAt: this.now() } };
		});
		return { pairingId: updated.pairingId, checkString, expiresAt: updated.expiresAt };
	}

	async pairingStatus(callerNodeKey: string, pairingId: string) {
		const pairing = await this.store.getPairing(pairingId);
		if (!pairing || (pairing.masterNodeKey !== callerNodeKey && pairing.claim?.nodeKey !== callerNodeKey)) {
			throw new NotFoundError('pairing not found');
		}
		if (pairing.expiresAt < this.now() && (pairing.status === 'waiting' || pairing.status === 'claimed')) {
			return { ...pairing, status: 'expired' as const };
		}
		return pairing;
	}

	async approvePairing(masterNodeKey: string, pairingId: string, body: Record<string, unknown>) {
		const pairing = await this.pairingStatus(masterNodeKey, pairingId);
		if (pairing.masterNodeKey !== masterNodeKey) {
			throw new ForbiddenError('only the Mac that created the code can approve it');
		}
		if (pairing.status !== 'claimed' || !pairing.claim) {
			throw new ConflictError(`pairing is ${pairing.status}`);
		}
		const claim = pairing.claim;
		const approval = typeof body.approvalSig === 'string' ? body.approvalSig : '';
		const message = pairingApprovalMessage({ pairingId, helperNodeKey: claim.nodeKey, masterNodeKey, payTo: pairing.payTo });
		if (!this.config.verify(masterNodeKey, message, approval)) {
			throw new AuthError('approval signature does not verify');
		}
		await this.store.updatePairing(pairingId, (current) => ({ ...current, status: 'approved' }));
		const { name, ...hardware } = claim.descriptor;
		const now = this.now();
		await this.store.putProvider({
			nodeKey: claim.nodeKey,
			payTo: pairing.payTo,
			kind: 'linux-helper',
			masterNodeKey,
			name,
			network: pairing.network,
			hardware,
			tier: hardwareTier(hardware),
			offers: [],
			offeredModels: [],
			access: { mode: 'public', allow: [] },
			status: 'paused',
			load: { active: 0, capacity: 1 },
			lastHeartbeat: 0,
			registeredAt: now,
			stats: { completed: 0, failed: 0, tokensOut: 0, earned: '0' }
		});
		return { approved: true };
	}

	async rejectPairing(masterNodeKey: string, pairingId: string) {
		const pairing = await this.pairingStatus(masterNodeKey, pairingId);
		if (pairing.masterNodeKey !== masterNodeKey) {
			throw new ForbiddenError('only the Mac that created the code can reject it');
		}
		await this.store.updatePairing(pairingId, (current) => ({ ...current, status: 'rejected' }));
		return { rejected: true };
	}

	async fleet(masterNodeKey: string) {
		const helpers = await this.store.listHelpers(masterNodeKey);
		const now = this.now();
		return {
			helpers: helpers.map((helper) => ({
				...publicProvider(helper),
				status: helper.lastHeartbeat >= now - PROVIDER_STALE_MS ? helper.status : 'offline'
			}))
		};
	}

	async revokeHelper(masterNodeKey: string, helperNodeKey: string) {
		const helper = await this.store.getProvider(helperNodeKey);
		if (!helper || helper.masterNodeKey !== masterNodeKey) {
			throw new NotFoundError('helper not found');
		}
		await this.store.deleteProvider(helperNodeKey);
		return { revoked: true };
	}
}

function pickCandidate<T extends { provider: StoredProvider; offer: Offer }>(candidates: T[]): T {
	/*
	 * Score: cheaper is better, idle is better, reliable is better. A little
	 * randomness spreads load between equally good providers.
	 */
	const scored = candidates.map((candidate) => {
		const { stats, load } = candidate.provider;
		const reliability = (stats.completed + 1) / (stats.completed + stats.failed + 2);
		const utilization = load.active / Math.max(1, load.capacity);
		const cost = Number(priceTotal(candidate.offer.price));
		const score = reliability * (1 - 0.5 * utilization) * (1 / (1 + cost / 1_000_000)) * (0.9 + Math.random() * 0.2);
		return { candidate, score };
	});
	scored.sort((a, b) => b.score - a.score);
	return scored[0]!.candidate;
}

function priceTotal(price: Price): bigint {
	return BigInt(price.inputPerMillion) + BigInt(price.outputPerMillion);
}

function assertTokenCount(value: unknown, field: string, max: number): number {
	if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > max) {
		throw new ValidationError(`${field} must be an integer between 1 and ${max}`);
	}
	return value as number;
}

function assertHardware(value: unknown): HardwareProfile {
	const hw = value as HardwareProfile;
	if (!hw || typeof hw !== 'object' || (hw.os !== 'macos' && hw.os !== 'linux')) {
		throw new ValidationError('hardware.os must be macos or linux');
	}
	if (!Number.isFinite(hw.memoryBytes) || hw.memoryBytes <= 0 || !Number.isFinite(hw.freeDiskBytes)) {
		throw new ValidationError('hardware memory and disk are required');
	}
	return {
		os: hw.os,
		osVersion: String(hw.osVersion ?? '').slice(0, 40),
		chip: String(hw.chip ?? '').slice(0, 120),
		memoryBytes: Math.floor(hw.memoryBytes),
		freeDiskBytes: Math.floor(hw.freeDiskBytes),
		...(Number.isInteger(hw.gpuCores) ? { gpuCores: hw.gpuCores } : {}),
		...(typeof hw.machineModel === 'string' ? { machineModel: hw.machineModel.slice(0, 60) } : {}),
		...(typeof hw.rdmaCapable === 'boolean' ? { rdmaCapable: hw.rdmaCapable } : {})
	};
}

function validateReceipt(job: JobRecord, receipt: SignedReceipt['receipt']): string | null {
	if (!receipt || receipt.v !== 1) {
		return 'unsupported receipt version';
	}
	const mismatched = (['jobId', 'network', 'nodeKey', 'payTo', 'buyer', 'modelId'] as const).find((field) => receipt[field] !== job[field]);
	if (mismatched) {
		return `receipt ${mismatched} does not match the job`;
	}
	if (receipt.price.inputPerMillion !== job.price.inputPerMillion || receipt.price.outputPerMillion !== job.price.outputPerMillion) {
		return 'receipt price does not match the job';
	}
	if (receipt.asset !== NETWORKS[job.network].settlementAsset.address) {
		return 'receipt asset is not the settlement asset';
	}
	if (!Number.isInteger(receipt.inputTokens) || !Number.isInteger(receipt.outputTokens) || receipt.inputTokens < 0 || receipt.outputTokens < 0) {
		return 'token counts must be non-negative integers';
	}
	if (receipt.outputTokens > job.maxOutputTokens || receipt.inputTokens > job.maxInputTokens) {
		return 'receipt exceeds the job token limits';
	}
	const expected = jobCost(job.price, { inputTokens: receipt.inputTokens, outputTokens: receipt.outputTokens });
	if (receipt.amount !== expected.toString()) {
		return `receipt amount ${receipt.amount} does not equal the priced usage ${expected}`;
	}
	if (job.paymentMode === 'prepaid' && expected > BigInt(job.prepaidAmount ?? '0')) {
		return 'receipt exceeds the prepaid amount';
	}
	return null;
}

function publicProvider(record: StoredProvider): ProviderRecord {
	const { offeredModels: _offered, ...rest } = record;
	return rest;
}

function redactJob(job: JobRecord): JobRecord {
	return job;
}

/** A catalog offer must carry the pinned weights hash; on main, catalog models must be pinned. */
function pinnedOfferOk(offer: Offer, network: NetworkName): boolean {
	const model = findCatalogModel(offer.modelId);
	if (!model) {
		return true;
	}
	if (model.weightsHash) {
		return offer.weightsHash === model.weightsHash;
	}
	return network !== 'main';
}
