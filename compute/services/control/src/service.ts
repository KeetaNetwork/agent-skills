/**
 * Control-plane business logic: registry, scheduling, credit escrow and
 * settlement, receipts, pairing. Transport-independent; see http.ts for
 * routing.
 *
 * The store keeps no accounting. Credits, escrows, payouts and refunds are
 * read from and written to the Keeta ledger; a job record holds routing
 * state and the hashes of the escrow and payout blocks.
 */

import {
	CATALOG,
	CREDIT_DECIMALS,
	CREDIT_NAME,
	CREDIT_SYMBOL,
	HEARTBEAT_INTERVAL_MS,
	MIN_PROVIDER_MEMORY_BYTES,
	NO_SHOW_FEE,
	NO_SHOW_WINDOW_MS,
	PAIRING_TTL_MS,
	PROVIDER_STALE_MS,
	QUOTE_TTL_MS,
	SETTLE_LAPSE_MS,
	TICKET_TTL_MS,
	ValidationError,
	assertAccess,
	assertKeetaAddress,
	assertModelId,
	assertOffer,
	assertPrice,
	assetListing,
	defaultAsset,
	escrowAmount,
	findAsset,
	findCatalogModel,
	hardwareTier,
	jobCost,
	MAX_ALLOWLISTED,
	maxJobCost,
	networkFee,
	operatorLinkMessage,
	pairingApprovalMessage,
	pairingCheckString,
	providerRelayToken,
	providerShare,
	randomId,
	receiptMessage,
	rescaleAmount,
	samePolicy,
	ticketMac,
	ticketMessage,
	type AccessPolicy,
	type EscrowQuote,
	type HardwareProfile,
	type JobRecord,
	type JobStatus,
	type JobTicket,
	type NetworkCredits,
	type NetworkModel,
	type NetworkName,
	type Offer,
	type PairingRecord,
	type Price,
	type ProviderKind,
	type ProviderRecord,
	type Settlement,
	type SettlementReason,
	type SignedReceipt,
	type SignedTicket,
	type Signer,
	type Verifier
} from '@keeta-compute/protocol';
import { encodedBlockHash } from '@keeta-compute/protocol/keeta';
import { ConflictError, NotFoundError, type Store, type StoredProvider } from './store.ts';

/**
 * How long settlement waits for the relay's delivery record after the
 * provider's receipt lands (the relay retries the record; the receipt can
 * arrive first). Past it, a receipt with no record refunds the escrow.
 */
const DELIVERY_GRACE_MS = 60_000;

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

/** Every provider that could take the job would cost more than the buyer's ceiling (`maxCost`). */
export class CostCeilingError extends PaymentRequiredError {
	readonly code = 'over_max_cost';
}

export class TooManyRequestsError extends Error {
	readonly status = 429;
	constructor(
		message: string,
		readonly retryAfterSeconds?: number
	) {
		super(message);
	}
}

/** The escrow for a quote arrived after the quote expired; it is refunded. */
export class QuoteExpiredError extends ConflictError {
	readonly code = 'quote_expired';
}

/** When the escrow arrived, no provider that fits the job had a free slot; it is refunded. */
export class NoProviderError extends ConflictError {
	readonly code = 'no_provider';
}

/** The error an expired job records when its escrow found no free provider. */
const NO_PROVIDER = 'every provider that fits this job filled up before its escrow arrived';

export interface FallbackConfig {
	/** keeta.ai's own account; fallback payments go here, since no provider serves the job. */
	payTo: string;
	/** Network model id → upstream model slug, the price buyers pay (credits per million tokens), and the context it supports. */
	models: Record<string, { route: string; price: Price; contextLength: number }>;
}

export type EscrowCheck = { status: 'confirmed'; amount: bigint } | { status: 'pending' } | { status: 'rejected'; reason?: string };

/**
 * Finds a block on the ledger: a send from `from` to `to` of `asset`, at
 * least `minAmount` in total, with `reference` as the external reference.
 * `amount` is what the block sent to `to` with that reference: sends with
 * another reference count for nothing, so one block cannot escrow two jobs.
 */
export type PaymentVerifier = (args: { network: NetworkName; blockHash: string; from: string; to: string; asset: string; minAmount: bigint; reference: string }) => Promise<EscrowCheck>;

/** keeta.ai's settlement account on the ledger: app buyers escrow credits to it, and it pays providers and refunds buyers. */
export interface SettlementLedger {
	/** The settlement account's address. */
	account: string;
	/** Publish one block making every send, each with the job id as its reference; resolves to the block hash. */
	payout(args: { network: NetworkName; token: string; jobId: string; sends: Array<{ to: string; amount: bigint }> }): Promise<string>;
	/**
	 * The settlement account's own history: the hash of a block it published
	 * with a send of `token` referencing the job, looking back to `since`
	 * (no payout predates the job's escrow), or null.
	 */
	findPayout(args: { network: NetworkName; token: string; jobId: string; since: number }): Promise<string | null>;
}

/** The credit token on one network (from the pins, or a test-network override). */
export interface CreditTokenConfig {
	token: string;
	decimals: number;
	/** The FX account that sells and buys credits, when known. */
	fx: string | null;
}

export type CreditBalanceReader = (args: { network: NetworkName; account: string; token: string }) => Promise<bigint>;

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
	/** Credits per network. App jobs are refused on a network without them, or without `settlement`. */
	credits: Partial<Record<NetworkName, CreditTokenConfig>>;
	settlement?: SettlementLedger;
	/**
	 * Reads a buyer's credit balance from the ledger. When set, a quote needs
	 * the buyer to hold the job's maximum cost, so keys with no credits cannot
	 * hold providers' slots with quotes they never escrow.
	 */
	creditBalanceOf?: CreditBalanceReader;
	now?: () => number;
	/** Outside API the public router uses when no provider can take a job. Off when unset. */
	fallback?: FallbackConfig;
	/** Testnet escape hatch so small Macs can provide during development. */
	allowSmallProviders?: boolean;
}

const RELAY_TOKEN_TTL_MS = 10 * 60_000;
const MAX_INPUT_TOKENS = 262_144;
/** Quotes one buyer may have waiting for escrow at once. */
const MAX_OPEN_QUOTES = 4;
/** Jobs one buyer may have in flight at once: its quotes waiting for escrow and its tickets not yet run. */
const MAX_IN_FLIGHT = 8;
/** Providers a quote request may name to use (allowedProviders, kept on the job) or to skip (excludeProviders). */
const MAX_PROVIDER_LIST = 100;
/** A signed receipt as the job record keeps it, in bytes of JSON; a real one is under 2 KB. */
const MAX_RECEIPT_BYTES = 8_192;
const PUBLIC_ACCESS: AccessPolicy = { mode: 'public', allow: [] };
/** A payout attempt that has not recorded its block this long after it started may be retried (after checking the ledger). */
const PAYOUT_RETRY_MS = 5 * 60_000;

export class ControlService {
	private readonly store: Store;
	private readonly now: () => number;
	/** Payouts from the settlement account, one at a time in this process: one account cannot publish two blocks at once. */
	private payouts: Promise<unknown> = Promise.resolve();

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
			/** Per network: the credit token app jobs are escrowed in, or null where app jobs are off. */
			credits: Object.fromEntries(this.config.networks.map((n) => [n, this.credits(n)])),
			/** Per network: the stablecoins that buy credits, in lead order, and which are available yet. */
			assets: Object.fromEntries(this.config.networks.map((n) => [n, assetListing(n)]))
		};
	}

	/** Credits on a network as clients see them, or null when app jobs are off there. */
	credits(network: NetworkName): NetworkCredits | null {
		const credit = this.config.credits[network];
		const settlement = this.config.settlement;
		if (!credit || !settlement) {
			return null;
		}
		return { token: credit.token, decimals: credit.decimals, symbol: CREDIT_SYMBOL, name: CREDIT_NAME, settlement: settlement.account, fx: credit.fx };
	}

	private requireCredits(network: NetworkName): NetworkCredits {
		const credits = this.credits(network);
		if (!credits) {
			throw new ForbiddenError(`app jobs are paid in Keeta Compute Credits, which are not available on the ${network} network yet`);
		}
		return credits;
	}

	catalog() {
		return CATALOG;
	}

	/* ---------------------------------------------------------------- providers */

	async registerProvider(nodeKey: string, body: Record<string, unknown>) {
		const network = this.assertNetwork(body.network);
		const kind = body.kind as ProviderKind;
		if (kind !== 'mac' && kind !== 'linux' && kind !== 'linux-helper') {
			throw new ValidationError('kind must be mac, linux or linux-helper');
		}
		const hardware = assertHardware(body.hardware);
		const name = typeof body.name === 'string' ? body.name.slice(0, 80) : kind === 'mac' ? 'Mac' : 'Linux';
		const existing = await this.store.getProvider(nodeKey);

		let payTo: string;
		let masterNodeKey: string | undefined;
		if (existing?.kind === 'linux-helper' && kind !== 'linux-helper') {
			/* A paired helper stays bound to its master (its wallet and allowlist) until the master revokes it. */
			throw new ForbiddenError('this node is paired as a helper; its master must revoke it before it can register on its own');
		}
		if (kind === 'mac' || kind === 'linux') {
			/* Full nodes (the macOS app, the Linux CLI) pay their own operator, proven by its signature. */
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
				throw new ForbiddenError('Linux helpers are registered by pairing with a Mac or a Linux node that has its own wallet');
			}
			payTo = existing.payTo;
			masterNodeKey = existing.masterNodeKey;
		}

		const now = this.now();
		/* Offers and status were checked against the network they were heartbeated on (pinnedOfferOk, isEligible); a node that moves starts paused with none. */
		const carried = existing?.network === network ? existing : undefined;
		const record: StoredProvider = {
			nodeKey,
			payTo,
			kind,
			...(masterNodeKey ? { masterNodeKey } : {}),
			name,
			network,
			hardware,
			tier: hardwareTier(hardware),
			offers: carried?.offers ?? [],
			offeredModels: carried?.offeredModels ?? [],
			access: existing?.access ?? { mode: 'public', allow: [] },
			status: carried?.status ?? 'paused',
			load: existing?.load ?? { active: 0, capacity: 1 },
			lastHeartbeat: existing?.lastHeartbeat ?? 0,
			registeredAt: existing?.registeredAt ?? now,
			stats: existing ? reputation(existing.stats) : { completed: 0, failed: 0, tokensOut: 0 }
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
		if (Array.isArray(body.offers) && body.offers.length > 64) {
			throw new ValidationError('too many offers');
		}
		const offers = Array.isArray(body.offers) ? body.offers.map((offer, i) => assertOffer(offer, i)) : [];
		const sent = body.access ? assertAccess(body.access) : undefined;
		/* A public policy admits anyone, so a list kept with it (the app keeps it for later) is not stored. */
		const access = sent?.mode === 'public' ? PUBLIC_ACCESS : sent;
		const load = body.load as { active?: unknown; capacity?: unknown } | undefined;
		const reported = Number.isInteger(load?.active) ? Math.max(0, Number(load?.active)) : 0;
		const capacity = Number.isInteger(load?.capacity) ? Math.min(64, Math.max(1, Number(load?.capacity))) : 1;
		const now = this.now();
		/* Count every ticket still holding one of this node's slots, however many newer jobs it has, so a heartbeat never frees them. */
		const ticketed = (await this.store.listScheduledByNode(nodeKey, now - TICKET_TTL_MS)).filter((j) => holdsSlotAt(j, now)).length;
		const active = Math.max(reported, ticketed);

		const record = await this.store.updateProvider(nodeKey, (current) => {
			const eligible = this.isEligible(current);
			/* A helper's access is its master's; the scheduler reads it from there. */
			const own = current.kind !== 'linux-helper';
			const policy = access && own ? access : current.access;
			/*
			 * The scheduler reads a public offer as the node's policy, so an offer
			 * repeating that policy (a node sends it with every offer that sets no
			 * list of its own) is stored as public, and each list is stored once.
			 */
			const pinned = offers
				.filter((offer) => pinnedOfferOk(offer, current.network))
				.map((offer) => (offer.access.mode === 'public' || samePolicy(offer.access, policy) ? { ...offer, access: PUBLIC_ACCESS } : offer));
			const listed = pinned.reduce((sum, offer) => sum + offer.access.allow.length, own && policy.mode === 'allowlist' ? policy.allow.length : 0);
			if (listed > MAX_ALLOWLISTED) {
				throw new ValidationError(`a node's allowlists may hold at most ${MAX_ALLOWLISTED} addresses in total: its own list and the lists its models set for themselves`);
			}
			return {
				...current,
				status: eligible ? status : 'paused',
				offers: pinned,
				offeredModels: [...new Set(pinned.map((o) => o.modelId))],
				...(access && own ? { access } : {}),
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
			coordinatorKey: this.config.coordinator.publicKey,
			/** The token app tickets on this node's network are paid in. */
			creditToken: this.credits(record.network)?.token ?? null
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

	/** Models with live providers; with `includeFallback`, also every model the router's fallback serves. */
	async networkModels(network: NetworkName, includeFallback = false): Promise<NetworkModel[]> {
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
		for (const [modelId, route] of Object.entries(includeFallback ? (this.config.fallback?.models ?? {}) : {})) {
			const catalog = findCatalogModel(modelId);
			const entry = byModel.get(modelId) ?? {
				id: modelId,
				name: catalog?.name ?? modelId,
				providers: 0,
				lowestPrice: route.price,
				contextLength: route.contextLength,
				...(catalog ? { license: catalog.license.name } : {})
			};
			byModel.set(modelId, { ...entry, fallback: { price: route.price } });
		}
		return [...byModel.values()].sort((a, b) => b.providers - a.providers || a.id.localeCompare(b.id));
	}

	/**
	 * Pick a provider for a job (plan §5.5 step 3). Public providers take any
	 * buyer; allowlisted offers only take listed paying keys, and the node
	 * re-checks before running anything.
	 */
	private async schedule(args: {
		network: NetworkName;
		buyer: string;
		modelId: string;
		maxInputTokens: number;
		maxOutputTokens: number;
		maxPrice?: Price;
		/** The most the buyer will pay for the job, in credit base units: offers whose escrow would be higher are skipped. */
		maxCost?: bigint;
		allowedProviders?: string[];
		excludeProviders?: string[];
		publicOnly: boolean;
	}): Promise<{ provider: StoredProvider; offer: Offer }> {
		const now = this.now();
		const live = (await this.store.listLiveProviders(args.network, now - PROVIDER_STALE_MS, args.modelId)).filter(
			(provider) => provider.status === 'online' && provider.load.active < provider.load.capacity
		);
		/* Helpers serve under their master's current access policy, so the master's allowlist covers its whole fleet. */
		const masters = new Map<string, StoredProvider | null>();
		for (const key of new Set(live.flatMap((p) => (p.kind === 'linux-helper' && p.masterNodeKey ? [p.masterNodeKey] : [])))) {
			masters.set(key, await this.store.getProvider(key));
		}
		const allows = (policy: AccessPolicy) => policy.mode !== 'allowlist' || (!args.publicOnly && policy.allow.includes(args.buyer));
		const candidates = live
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
				/* A helper's own record keeps only a copy of its master's policy from pairing time; the master's current one applies. */
				const master = provider.kind === 'linux-helper' ? (provider.masterNodeKey ? masters.get(provider.masterNodeKey) : null) : undefined;
				if (master === null) {
					return [];
				}
				const nodeAccess = master ? master.access : provider.access;
				const access: AccessPolicy = offer.access.mode === 'allowlist' ? offer.access : nodeAccess;
				/* The master's list covers its whole fleet, models with lists of their own included. */
				if (!allows(access) || (master && !allows(master.access))) {
					return [];
				}
				if (args.maxPrice && (BigInt(offer.price.inputPerMillion) > BigInt(args.maxPrice.inputPerMillion) || BigInt(offer.price.outputPerMillion) > BigInt(args.maxPrice.outputPerMillion))) {
					return [];
				}
				return [{ provider, offer }];
			});
		const affordable = args.maxCost === undefined ? candidates : candidates.filter(({ offer }) => escrowAmount(offer.price, args) <= args.maxCost!);
		if (affordable.length === 0) {
			if (candidates.length > 0) {
				throw new CostCeilingError(`every provider for ${args.modelId} would charge more than ${args.maxCost} credit base units for this job; lower max_tokens or raise the limit`);
			}
			throw new UnavailableError(`no provider is available for ${args.modelId} right now`);
		}
		return pickCandidate(affordable);
	}

	private async signTicket(job: JobRecord): Promise<SignedTicket> {
		const issuedAt = job.ticketIssuedAt ?? job.createdAt;
		const ticket: JobTicket = {
			v: 1,
			jobId: job.jobId,
			network: job.network,
			nodeKey: job.nodeKey,
			modelId: job.modelId,
			buyer: job.buyer,
			maxInputTokens: job.maxInputTokens,
			maxOutputTokens: job.maxOutputTokens,
			price: job.price,
			asset: job.asset,
			payTo: job.payTo,
			paymentMode: job.paymentMode,
			...(job.prepaidAmount ? { prepaidAmount: job.prepaidAmount } : {}),
			...(job.paymentTo ? { paymentTo: job.paymentTo } : {}),
			issuedAt,
			expiresAt: issuedAt + TICKET_TTL_MS
		};
		return {
			ticket,
			coordinatorSig: await this.config.coordinator.sign(ticketMessage(ticket)),
			relayMac: await ticketMac(this.config.relaySecret, ticket)
		};
	}

	private releaseSlot(nodeKey: string) {
		return this.store.updateProvider(nodeKey, (record) => ({ ...record, load: { ...record.load, active: Math.max(0, record.load.active - 1) } }));
	}

	/* -------------------------------------------------------------- app jobs */

	/**
	 * An app job (plan §6.3): pick a provider and quote the job's escrow in
	 * credits. The quote holds no slot: the buyer escrows it with the
	 * settlement account and reports the block (submitEscrow), and the ticket
	 * takes a slot once the ledger shows it. Holding a provider always has
	 * credits behind it, and a ticket that never reaches the relay pays the
	 * provider NO_SHOW_FEE.
	 */
	async createJob(buyer: string, body: Record<string, unknown>) {
		const network = this.assertNetwork(body.network);
		const credits = this.requireCredits(network);
		const modelId = assertModelId(body.model);
		const maxInputTokens = assertTokenCount(body.maxInputTokens, 'maxInputTokens', MAX_INPUT_TOKENS);
		const maxOutputTokens = assertTokenCount(body.maxOutputTokens, 'maxOutputTokens', 32_768);
		const maxPrice = body.maxPrice ? assertPrice(body.maxPrice, 'maxPrice') : undefined;
		const allowedProviders = assertProviderList(body.allowedProviders, 'allowedProviders');
		const excludeProviders = assertProviderList(body.excludeProviders, 'excludeProviders');
		const { provider, offer } = await this.schedule({
			network,
			buyer,
			modelId,
			maxInputTokens,
			maxOutputTokens,
			...(maxPrice ? { maxPrice } : {}),
			...(body.maxCost !== undefined ? { maxCost: assertBaseUnits(body.maxCost, 'maxCost') } : {}),
			...(allowedProviders ? { allowedProviders } : {}),
			...(excludeProviders ? { excludeProviders } : {}),
			publicOnly: false
		});
		const limits = { maxInputTokens, maxOutputTokens };
		const needed = escrowAmount(offer.price, limits);
		let held: bigint | undefined;
		if (this.config.creditBalanceOf) {
			held = await this.config.creditBalanceOf({ network, account: buyer, token: credits.token }).catch((error: Error) => {
				console.warn('credit balance lookup failed', error.message);
				throw new UnavailableError('could not read your credit balance from the ledger; try again');
			});
			if (held < needed) {
				throw new PaymentRequiredError(`this job can cost up to ${needed} credit base units and the account holds ${held}; buy credits first`);
			}
		}
		const now = this.now();
		const job: JobRecord = {
			jobId: randomId('job', 12),
			network,
			buyer,
			nodeKey: provider.nodeKey,
			payTo: provider.payTo,
			modelId,
			price: offer.price,
			...limits,
			paymentMode: 'escrow',
			asset: credits.token,
			quoteExpiresAt: now + QUOTE_TTL_MS,
			...(maxPrice ? { maxPrice } : {}),
			...(allowedProviders ? { allowedProviders } : {}),
			status: 'quoted',
			createdAt: now
		};
		/*
		 * Atomic per buyer, so parallel requests cannot pass the caps, and
		 * quotes waiting for escrow must fit in the balance together: one
		 * balance cannot back several quotes.
		 */
		await this.store.putJobIf(job, now - QUOTE_TTL_MS - TICKET_TTL_MS, (openQuotes, recent) => {
			const waiting = openQuotes.filter((j) => (j.quoteExpiresAt ?? 0) > now);
			if (waiting.length >= MAX_OPEN_QUOTES) {
				throw new TooManyRequestsError(`at most ${MAX_OPEN_QUOTES} quotes may wait for escrow at once; escrow or cancel one first`);
			}
			const ticketed = recent.filter((j) => holdsSlotAt(j, now));
			if (waiting.length + ticketed.length >= MAX_IN_FLIGHT) {
				throw new TooManyRequestsError(`at most ${MAX_IN_FLIGHT} jobs may be in flight at once; wait for one to finish`);
			}
			const committed = waiting.reduce((sum, j) => sum + escrowAmount(j.price, j), 0n);
			if (held !== undefined && committed + needed > held) {
				throw new PaymentRequiredError(`your quotes waiting for escrow can cost up to ${committed} credit base units, this one up to ${needed} more, and the account holds ${held}; escrow or cancel a quote, or buy credits`);
			}
		});
		return { job: redactJob(job), quote: quoteFor(job, credits), relayUrl: this.config.relayUrl };
	}

	/**
	 * The buyer reports the block escrowing a quoted job. Once the ledger shows
	 * that block, signed by the buyer, sending the quote's escrow amount in
	 * credits to the settlement account with the job id as its reference, the
	 * ticket is issued and takes a provider slot (placeTicket). Only the
	 * block's hash is stored. The same block can be reported again and
	 * returns the ticket again; an escrow that arrives after its quote
	 * expired, or finds no provider with a free slot, is refunded.
	 */
	async submitEscrow(buyer: string, jobId: string, body: Record<string, unknown>) {
		const blockHash = assertBlockHash(body.blockHash);
		const job = await this.store.getJob(jobId);
		if (!job) {
			throw new NotFoundError('job not found');
		}
		if (job.buyer !== buyer || job.paymentMode !== 'escrow') {
			throw new ForbiddenError('job belongs to another buyer');
		}
		if (job.escrow) {
			return this.escrowResult(job, blockHash);
		}
		if (job.status !== 'quoted' && job.status !== 'expired') {
			throw new ConflictError(`job is ${job.status}`);
		}
		const credits = this.requireCredits(job.network);
		const check = await this.config.verifyPayment({
			network: job.network,
			blockHash,
			from: buyer,
			to: credits.settlement,
			asset: job.asset,
			minAmount: escrowAmount(job.price, job),
			reference: jobId
		});
		if (check.status === 'rejected') {
			throw new PaymentRequiredError(`that block does not escrow this job${check.reason ? `: ${check.reason}` : ''}`);
		}
		if (check.status === 'pending') {
			return { job: redactJob(job), pending: true };
		}
		const now = this.now();
		const live = (current: JobRecord) => current.status === 'quoted' && now <= (current.quoteExpiresAt ?? 0);
		const placed = live(job) ? await this.placeTicket(job, now) : null;
		let unused: string | null = null;
		const updated = await this.store.updateJob(jobId, (current) => {
			unused = null; /* a store may retry this update */
			if (current.escrow) {
				unused = placed?.nodeKey ?? null;
				return current;
			}
			const escrow = { blockHash, at: now };
			if (live(current) && placed) {
				return { ...current, ...placed, escrow, status: 'scheduled', ticketIssuedAt: now };
			}
			unused = placed?.nodeKey ?? null;
			return { ...current, escrow, status: 'expired', completedAt: now, error: live(current) ? NO_PROVIDER : 'the escrow arrived after the quote expired' };
		});
		if (unused) {
			await this.releaseSlot(unused);
		}
		if (updated.status === 'expired') {
			this.settleInBackground(jobId);
		}
		return this.escrowResult(updated, blockHash);
	}

	private async escrowResult(job: JobRecord, blockHash: string) {
		if (job.escrow?.blockHash !== blockHash) {
			throw new ConflictError('this job is already escrowed by another block');
		}
		if (job.status === 'scheduled') {
			return { job: redactJob(job), ticket: await this.signTicket(job), relayUrl: this.config.relayUrl };
		}
		if (job.status === 'expired' && !job.ticketIssuedAt) {
			if (job.error === NO_PROVIDER) {
				throw new NoProviderError(`${NO_PROVIDER}; the escrow is refunded, so ask again`);
			}
			throw new QuoteExpiredError('the quote expired before its escrow arrived; the escrow is refunded');
		}
		throw new ConflictError(`job is already ${job.status}`);
	}

	/**
	 * Take a slot for a ticket: on the quoted provider or, when it filled up
	 * or went offline since the quote (quotes hold no slots), on another that
	 * fits the same request and whose escrow is no larger. Null when none has
	 * a free slot.
	 */
	private async placeTicket(job: JobRecord, now: number): Promise<Pick<JobRecord, 'nodeKey' | 'payTo' | 'price'> | null> {
		if (await this.takeSlot(job.nodeKey, now)) {
			return { nodeKey: job.nodeKey, payTo: job.payTo, price: job.price };
		}
		const tried = [job.nodeKey];
		for (let attempt = 0; attempt < 3; attempt++) {
			const next = await this.schedule({
				network: job.network,
				buyer: job.buyer,
				modelId: job.modelId,
				maxInputTokens: job.maxInputTokens,
				maxOutputTokens: job.maxOutputTokens,
				...(job.maxPrice ? { maxPrice: job.maxPrice } : {}),
				...(job.allowedProviders ? { allowedProviders: job.allowedProviders } : {}),
				maxCost: escrowAmount(job.price, job),
				excludeProviders: tried,
				publicOnly: false
			}).catch((error: unknown) => {
				if (error instanceof UnavailableError || error instanceof CostCeilingError) {
					return null;
				}
				throw error;
			});
			if (!next) {
				return null;
			}
			if (await this.takeSlot(next.provider.nodeKey, now)) {
				return { nodeKey: next.provider.nodeKey, payTo: next.provider.payTo, price: next.offer.price };
			}
			tried.push(next.provider.nodeKey);
		}
		return null;
	}

	/** Take one of a provider's slots, if it is online with one free. */
	private async takeSlot(nodeKey: string, now: number): Promise<boolean> {
		const taken = await this.store.updateProvider(nodeKey, (record) =>
			record.status === 'online' && record.lastHeartbeat >= now - PROVIDER_STALE_MS && record.load.active < record.load.capacity ? { ...record, load: { ...record.load, active: record.load.active + 1 } } : null
		);
		return taken !== null;
	}

	/* ---------------------------------------------------------------- router */

	/**
	 * Public router (x402): the buyer prepays the job's most possible cost
	 * before it runs, in KUSD where it is pinned and otherwise USDC, at one
	 * credit to the dollar. The payment goes to keeta.ai's settlement account,
	 * which pays the provider what its receipt bills, less the network fee,
	 * and returns the rest to the payer (payoutSends). Without a settlement
	 * account the payment goes to the provider directly.
	 */
	async routerQuote(body: Record<string, unknown>) {
		const network = this.assertNetwork(body.network);
		const modelId = assertModelId(body.model);
		const maxInputTokens = assertTokenCount(body.maxInputTokens, 'maxInputTokens', MAX_INPUT_TOKENS);
		const maxOutputTokens = assertTokenCount(body.maxOutputTokens, 'maxOutputTokens', 32_768);
		const excludeProviders = assertProviderList(body.excludeProviders, 'excludeProviders');
		const limits = { maxInputTokens, maxOutputTokens };
		const asset = defaultAsset(network);
		const prepaid = (price: Price) => rescaleAmount(maxJobCost(price, limits), CREDIT_DECIMALS, asset.decimals).toString();
		const quoted = async (job: JobRecord) => {
			await this.store.putJob(job);
			return { job: redactJob(job), ticket: await this.signTicket(job), relayUrl: this.config.relayUrl, asset: { symbol: asset.symbol, address: asset.address, decimals: asset.decimals } };
		};
		try {
			/* Router quotes reach unpaid callers in a 402, so they hold no slot; the provider's heartbeat counts jobs that actually run. */
			const { provider, offer } = await this.schedule({
				network,
				buyer: this.config.coordinator.publicKey,
				modelId,
				...limits,
				...(excludeProviders ? { excludeProviders } : {}),
				publicOnly: true
			});
			return await quoted({
				jobId: randomId('job', 12),
				network,
				buyer: this.config.coordinator.publicKey,
				nodeKey: provider.nodeKey,
				payTo: provider.payTo,
				modelId,
				price: offer.price,
				...limits,
				paymentMode: 'prepaid',
				asset: asset.address,
				prepaidAmount: prepaid(offer.price),
				...(this.config.settlement ? { paymentTo: this.config.settlement.account } : {}),
				status: 'scheduled',
				createdAt: this.now()
			});
		} catch (error) {
			/* No provider can take it: serve through the fallback API when one is configured for this model. */
			const route = this.config.fallback?.models[modelId];
			if (!(error instanceof UnavailableError) || !route || maxInputTokens + maxOutputTokens > route.contextLength) {
				throw error;
			}
			return quoted({
				jobId: randomId('job', 12),
				network,
				buyer: this.config.coordinator.publicKey,
				nodeKey: this.config.coordinator.publicKey,
				payTo: this.config.fallback!.payTo,
				modelId,
				price: route.price,
				...limits,
				paymentMode: 'prepaid',
				asset: asset.address,
				prepaidAmount: prepaid(route.price),
				fallback: { via: 'openrouter', model: route.route },
				status: 'scheduled',
				createdAt: this.now()
			});
		}
	}

	/**
	 * The router reports the x402 payment: the payer's signed block, whose
	 * hash the job keeps, and the settlement's transaction (the vote staple),
	 * kept only when the block is missing. Nothing is paid on the router's
	 * word: a payout to the provider (or back to the payer) reads the block
	 * from the ledger first (routerPayoutSends).
	 */
	async routerSettled(jobId: string, body: Record<string, unknown>) {
		const payer = assertKeetaAddress(body.payer, 'payer');
		const raw = typeof body.transaction === 'string' ? body.transaction.slice(0, 200) : '';
		const block = typeof body.block === 'string' && body.block.length <= 16_384 ? encodedBlockHash(body.block) : null;
		const transaction = block ?? (/^[0-9A-Fa-f]{64}$/.test(raw) ? raw.toUpperCase() : raw);
		let receiptCounts = null as SignedReceipt | null;
		const job = await this.store.updateJob(jobId, (current) => {
			receiptCounts = null; /* a store may retry this update */
			if (current.paymentMode !== 'prepaid') {
				throw new ConflictError('not a router job');
			}
			if (current.payment) {
				return current;
			}
			const now = this.now();
			const payment = { blockHash: transaction, paidAt: now, verified: true };
			/* A fallback job has no provider receipt to wait for: payment completes it. */
			if (current.fallback) {
				return { ...current, payment, routerPayer: payer, status: 'paid', completedAt: now };
			}
			/* The provider's receipt can land first; the job is paid now, and the receipt counts for the provider now. */
			if (current.status === 'completed') {
				receiptCounts = current.receipt ?? null;
				return { ...current, payment, routerPayer: payer, status: 'paid', ...prepaidSettlement(current, 'delivered', now) };
			}
			/* Paid for a job that already failed or lapsed: it all goes back. */
			if (current.status === 'failed' || current.status === 'expired') {
				return { ...current, payment, routerPayer: payer, status: 'failed', ...prepaidSettlement(current, 'failed', now) };
			}
			return { ...current, payment, routerPayer: payer };
		});
		if (receiptCounts) {
			const { outputTokens } = receiptCounts.receipt;
			await this.store.updateProvider(job.nodeKey, (record) => ({ ...record, stats: { ...record.stats, completed: record.stats.completed + 1, tokensOut: record.stats.tokensOut + outputTokens } }));
		}
		if (job.payoutDue) {
			this.settleInBackground(jobId);
		}
		return redactJob(job);
	}

	/** The router claims a fallback job once, before running it upstream; a second claim of the same quote is refused. */
	async routerClaim(jobId: string) {
		const job = await this.store.updateJob(jobId, (current) => {
			if (current.paymentMode !== 'prepaid' || !current.fallback) {
				throw new NotFoundError('not a fallback job');
			}
			if (current.status !== 'scheduled' || current.claimedAt) {
				throw new ConflictError('this quote was already used');
			}
			return { ...current, claimedAt: this.now() };
		});
		return { fallback: job.fallback };
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
		/* The job record keeps the receipt through settlement, so it holds only the signed fields and the signature, and stays small. */
		const stored: SignedReceipt = { receipt: signed.receipt, signature: signed.signature };
		if (new TextEncoder().encode(JSON.stringify(stored)).length > MAX_RECEIPT_BYTES) {
			throw new ValidationError(`a signed receipt may be at most ${MAX_RECEIPT_BYTES} bytes`);
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
		let heldSlot = false;
		const updated = await this.store.updateJob(jobId, (current) => {
			if (current.status !== 'scheduled') {
				throw new ConflictError(`job is already ${current.status}`);
			}
			heldSlot = holdsSlot(current);
			if (current.paymentMode === 'prepaid' && current.payment) {
				return { ...current, status: 'paid', completedAt: now, receipt: stored, ...prepaidSettlement(current, 'delivered', now) };
			}
			return { ...current, status: 'completed', completedAt: now, receipt: stored };
		});
		/*
		 * A router job counts once its payment is reported (routerSettled counts
		 * it when the receipt came first), so receipts on quotes nobody paid
		 * count for nothing. An app job counts now; settlement records disputes.
		 */
		const counts = updated.paymentMode === 'escrow' || updated.status === 'paid';
		await this.store.updateProvider(nodeKey, (record) => ({
			...record,
			load: { ...record.load, active: Math.max(0, record.load.active - (heldSlot ? 1 : 0)) },
			stats: counts ? { ...record.stats, completed: record.stats.completed + 1, tokensOut: record.stats.tokensOut + receipt.outputTokens } : record.stats
		}));
		if (updated.paymentMode === 'escrow' || updated.payoutDue) {
			this.settleInBackground(jobId);
		}
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
		let heldSlot = false;
		const updated = await this.store.updateJob(jobId, (current) => {
			if (current.status !== 'scheduled') {
				throw new ConflictError(`job is already ${current.status}`);
			}
			heldSlot = holdsSlot(current);
			const now = this.now();
			/* A router job paid to the settlement account: the payment goes back to the payer. */
			const refund = current.paymentMode === 'prepaid' && current.payment ? prepaidSettlement(current, 'failed', now) : {};
			return { ...current, status: 'failed', completedAt: now, error: reason, ...refund };
		});
		await this.store.updateProvider(nodeKey, (record) => ({
			...record,
			load: { ...record.load, active: Math.max(0, record.load.active - (heldSlot ? 1 : 0)) },
			stats: { ...record.stats, failed: record.stats.failed + 1 }
		}));
		if (updated.paymentMode === 'escrow' || updated.payoutDue) {
			this.settleInBackground(jobId);
		}
		return { job: redactJob(updated) };
	}

	/**
	 * The buyer gives back a quote or ticket it will not use (spend limit, no
	 * credits, relay unreachable, a broken stream). A quote just expires, and
	 * an escrow reported for it afterwards is refunded in full. A ticket frees
	 * its provider but stays open until it settles, so a provider that already
	 * streamed is still paid for what the relay forwarded, and the rest comes
	 * back to the buyer (less the no-show fee if it never reached the relay).
	 */
	async cancelJob(buyer: string, jobId: string) {
		const job = await this.store.getJob(jobId);
		if (!job) {
			throw new NotFoundError('job not found');
		}
		if (job.buyer !== buyer || job.paymentMode !== 'escrow') {
			throw new ForbiddenError('job belongs to another buyer');
		}
		/* Cancelling a quote twice, or one that already expired, is harmless. */
		if (job.status === 'quoted' || (job.status === 'expired' && !job.ticketIssuedAt)) {
			const updated = await this.store.updateJob(jobId, (current) =>
				current.status !== 'quoted' || current.escrow ? current : { ...current, status: 'expired', completedAt: this.now(), error: 'cancelled by the buyer' }
			);
			return { job: redactJob(updated) };
		}
		if (job.status !== 'scheduled') {
			throw new ConflictError(`job is already ${job.status}`);
		}
		return { job: redactJob(await this.handBack(jobId, 'cancelled by the buyer')) };
	}

	/**
	 * Hand a scheduled app job back: free the provider's slot now, but keep the
	 * job open until it settles. A provider may already be streaming it, so
	 * its receipt is still taken and paid from the escrow when it matches the
	 * relay's delivery record.
	 */
	private async handBack(jobId: string, reason: string): Promise<JobRecord> {
		let freed = false;
		const updated = await this.store.updateJob(jobId, (current) => {
			freed = false; /* a store may retry this update */
			if (current.status !== 'scheduled') {
				throw new ConflictError(`job is already ${current.status}`);
			}
			if (current.handedBackAt) {
				return current;
			}
			freed = holdsSlot(current);
			return { ...current, handedBackAt: this.now(), error: reason };
		});
		if (freed) {
			await this.releaseSlot(updated.nodeKey);
		}
		return updated;
	}

	/**
	 * The relay records what it forwarded to the buyer of an app job, when the
	 * buyer brought the ticket and, if it hung up before any text, when; the
	 * first record stands.
	 */
	async recordDelivery(jobId: string, body: Record<string, unknown>) {
		const outputHash = typeof body.outputHash === 'string' && /^[0-9a-f]{64}$/.test(body.outputHash) ? body.outputHash : null;
		const maxOutputTokens = Number.isInteger(body.maxOutputTokens) && (body.maxOutputTokens as number) >= 0 ? (body.maxOutputTokens as number) : null;
		if (!outputHash || maxOutputTokens === null) {
			throw new ValidationError('outputHash and maxOutputTokens are required');
		}
		const time = (field: string) => {
			const value = body[field];
			if (value === undefined) {
				return {};
			}
			if (!Number.isSafeInteger(value) || (value as number) < 0) {
				throw new ValidationError(`${field} must be a time in milliseconds`);
			}
			return { [field]: value as number };
		};
		const timing = { ...time('presentedAt'), ...time('abandonedAt') };
		const job = await this.store.updateJob(jobId, (current) => {
			if (current.paymentMode !== 'escrow' || current.delivery) {
				return current;
			}
			return { ...current, delivery: { outputHash, maxOutputTokens, at: this.now(), ...timing } };
		});
		/* The receipt may already be here; settle without holding up the relay, which passes the receipt on after this. */
		if (job.receipt && !job.settlement) {
			this.settleInBackground(jobId);
		}
		return { recorded: job.delivery?.outputHash === outputHash };
	}

	/**
	 * The relay could not forward an app job because its provider was not
	 * connected when the buyer brought the ticket. The buyer showed up, so the
	 * ticket owes no no-show fee; it settles with the rest at the lapse.
	 */
	async recordProviderOffline(jobId: string) {
		const job = await this.store.updateJob(jobId, (current) => (current.paymentMode !== 'escrow' || current.providerOfflineAt ? current : { ...current, providerOfflineAt: this.now() }));
		return { recorded: job.providerOfflineAt !== undefined };
	}

	/* -------------------------------------------------------------- settlement */

	/** Run a settlement step after the ones already queued in this process. */
	private serially<T>(task: () => Promise<T>): Promise<T> {
		const run = this.payouts.then(task, task);
		this.payouts = run.catch(() => undefined);
		return run;
	}

	/** Settle an escrowed job without making the caller wait; the sweep retries anything that fails. */
	private settleInBackground(jobId: string): void {
		void this.serially(() => this.settle(jobId)).catch((error: Error) => console.warn(`settling ${jobId} failed; the sweep retries`, error.message));
	}

	/** Decide how an escrowed job settles, once (decideSettlement), then pay it out. */
	private async settle(jobId: string): Promise<JobRecord> {
		const now = this.now();
		let decided = null as Settlement | null;
		const job = await this.store.updateJob(jobId, (current) => {
			decided = null; /* a store may retry this update */
			if (current.paymentMode !== 'escrow' || !current.escrow || current.settlement) {
				return current;
			}
			const outcome = decideSettlement(current, now);
			if (!outcome) {
				return current;
			}
			decided = { reason: outcome.reason, decidedAt: now, ...(outcome.noShow ? { noShow: true } : {}) };
			return { ...current, status: outcome.status, completedAt: current.completedAt ?? now, settlement: decided, payoutDue: true };
		});
		if (decided?.reason === 'mismatch' || decided?.reason === 'no-delivery') {
			/* The receipt is not backed by what the relay forwarded: a strike against the provider only. */
			await this.store.updateProvider(job.nodeKey, (record) => ({ ...record, stats: { ...record.stats, disputed: (record.stats.disputed ?? 0) + 1 } }));
		} else if (decided?.reason === 'no-receipt') {
			await this.store.updateProvider(job.nodeKey, (record) => ({ ...record, stats: { ...record.stats, failed: record.stats.failed + 1 } }));
		}
		return job.payoutDue ? this.payout(job) : job;
	}

	/**
	 * Pay a decided settlement in one block from the settlement account: the
	 * provider's share to its payTo and the rest of the escrow back to the
	 * buyer, each send referencing the job. The ledger is the source of truth
	 * for both: the escrowed amount is read from the escrow block, and before
	 * publishing, the settlement account's history is searched for a payout
	 * already referencing the job (an earlier attempt, here or in another
	 * process, may have published one and failed to record it). The claimed
	 * attempt only keeps two processes from racing.
	 */
	private async payout(job: JobRecord): Promise<JobRecord> {
		const ledger = this.config.settlement;
		if (!ledger || !job.settlement || job.settlement.blockHash) {
			return job;
		}
		const now = this.now();
		let claimedNow = false;
		const claimed = await this.store.updateJob(job.jobId, (current) => {
			claimedNow = false;
			const s = current.settlement;
			if (!s || s.blockHash || (s.attemptAt !== undefined && now - s.attemptAt < PAYOUT_RETRY_MS)) {
				return current;
			}
			claimedNow = true;
			return { ...current, settlement: { ...s, attemptAt: now } };
		});
		if (!claimedNow) {
			return claimed;
		}
		const where = { network: claimed.network, token: claimed.asset, jobId: claimed.jobId };
		let blockHash: string;
		try {
			const earlier = await ledger.findPayout({ ...where, since: claimed.escrow?.at ?? claimed.payment?.paidAt ?? claimed.createdAt });
			blockHash = earlier ?? (await ledger.payout({ ...where, sends: await this.payoutSends(claimed) }));
		} catch (error) {
			const message = (error as Error).message.slice(0, 300);
			console.warn(`payout for ${claimed.jobId} failed; the sweep retries`, message);
			return this.store.updateJob(claimed.jobId, (current) => (current.settlement && !current.settlement.blockHash ? { ...current, settlement: { ...current.settlement, error: message } } : current));
		}
		return this.store.updateJob(claimed.jobId, (current) => {
			if (!current.settlement || current.settlement.blockHash) {
				return current;
			}
			const { error: _error, ...settlement } = current.settlement;
			const { payoutDue: _due, ...rest } = current;
			return { ...rest, settlement: { ...settlement, blockHash, sentAt: this.now() } };
		});
	}

	/**
	 * The payout's sends, from the ledger: the escrow block's amount for this
	 * job, split by the settlement. Delivered: the buyer pays the receipt's
	 * amount and gets the rest back; anything else: all of it back to the
	 * buyer. A ticket not used promptly (`noShow`) adds NO_SHOW_FEE to what
	 * the buyer pays, which never exceeds the escrow. The provider receives
	 * what the buyer pays less the network fee on the billed part, and the
	 * fee stays in the settlement account.
	 */
	private async payoutSends(job: JobRecord): Promise<Array<{ to: string; amount: bigint }>> {
		if (job.paymentMode === 'prepaid') {
			return this.routerPayoutSends(job);
		}
		const check = await this.config.verifyPayment({
			network: job.network,
			blockHash: job.escrow!.blockHash,
			from: job.buyer,
			to: this.config.settlement!.account,
			asset: job.asset,
			minAmount: 0n,
			reference: job.jobId
		});
		if (check.status !== 'confirmed') {
			throw new Error(`the escrow block cannot be read from the ledger right now (${check.status})`);
		}
		const escrowed = check.amount;
		const billed = job.settlement!.reason === 'delivered' ? BigInt(job.receipt!.receipt.amount) : 0n;
		const owed = billed + (job.settlement!.noShow ? NO_SHOW_FEE : 0n);
		const paid = owed < escrowed ? owed : escrowed;
		const fee = networkFee(billed < paid ? billed : paid);
		return [
			{ to: job.payTo, amount: paid - fee },
			{ to: job.buyer, amount: escrowed - paid }
		].filter((send) => send.amount > 0n);
	}

	/**
	 * A router job's payout, from the ledger: the x402 payment block must send
	 * at least the quoted amount from the payer to the settlement account,
	 * referencing the job. Delivered: the provider gets the receipt's amount
	 * in the payment's stablecoin, less the network fee, and the payer the
	 * rest; anything else: all of it back to the payer.
	 */
	private async routerPayoutSends(job: JobRecord): Promise<Array<{ to: string; amount: bigint }>> {
		const asset = findAsset(job.network, job.asset);
		if (!asset || !job.payment || !job.routerPayer) {
			throw new Error('the router payment cannot be paid out: its stablecoin or payment is unknown');
		}
		const check = await this.config.verifyPayment({
			network: job.network,
			blockHash: job.payment.blockHash,
			from: job.routerPayer,
			to: this.config.settlement!.account,
			asset: job.asset,
			minAmount: BigInt(job.prepaidAmount ?? '0'),
			reference: job.jobId
		});
		if (check.status !== 'confirmed') {
			throw new Error(`the router payment block cannot be read from the ledger right now (${check.status})`);
		}
		const received = check.amount;
		const billed = job.settlement!.reason === 'delivered' ? rescaleAmount(BigInt(job.receipt!.receipt.amount), CREDIT_DECIMALS, asset.decimals) : 0n;
		const paid = billed < received ? billed : received;
		return [
			{ to: job.payTo, amount: providerShare(paid) },
			{ to: job.routerPayer, amount: received - paid }
		].filter((send) => send.amount > 0n);
	}

	async buyerJobs(buyer: string) {
		const jobs = await this.store.listJobsByBuyer(buyer, 100);
		return { jobs: jobs.map(redactJob) };
	}

	/**
	 * Housekeeping, run on a schedule: expire quotes nobody escrowed, free
	 * providers from app tickets that went unused, settle escrowed jobs at
	 * their lapse, retry payouts, and then expire router quotes nobody paid.
	 */
	async sweep() {
		const now = this.now();
		let expired = 0;
		let settled = 0;
		let paidOut = 0;
		/* A job that fails here (a write the store refuses, a ledger call) is logged and left for the next run, so it never stops the jobs after it. */
		const each = async (jobs: JobRecord[], step: (job: JobRecord) => Promise<void>) => {
			for (const job of jobs) {
				await step(job).catch((error: Error) => console.warn(`sweeping ${job.jobId} failed; the next run retries`, error.message));
			}
		};
		await each(await this.store.listJobsByStatus('quoted', 'escrow', now - QUOTE_TTL_MS, 200), async (job) => {
			const updated = await this.store.updateJob(job.jobId, (current) =>
				current.status !== 'quoted' || current.escrow || (current.quoteExpiresAt ?? 0) > now ? current : { ...current, status: 'expired', completedAt: now }
			);
			expired += updated.status === 'expired' ? 1 : 0;
		});
		/* App jobs are listed apart from router jobs, so no number of router quotes (anyone can ask for one) holds up a refund. */
		const ticketLapse = now - TICKET_TTL_MS - 5 * 60_000;
		await each(await this.store.listJobsByStatus('scheduled', 'escrow', ticketLapse, 200), async (job) => {
			/* An app ticket that drew no receipt frees its provider; the job stays open until it settles at the lapse. */
			if (!job.handedBackAt && (job.ticketIssuedAt ?? job.createdAt) < ticketLapse) {
				await this.handBack(job.jobId, 'the ticket went unused').catch(() => undefined);
			}
			settled += (await this.serially(() => this.settle(job.jobId))).settlement ? 1 : 0;
		});
		/* Receipts the relay has not recorded a delivery for within the grace period. */
		await each(await this.store.listJobsByStatus('completed', 'escrow', now - DELIVERY_GRACE_MS, 200), async (job) => {
			if (!job.settlement) {
				settled += (await this.serially(() => this.settle(job.jobId))).settlement ? 1 : 0;
			}
		});
		await each(await this.store.listPayoutsDue(200), async (job) => {
			paidOut += (await this.serially(() => this.payout(job))).settlement?.blockHash ? 1 : 0;
		});
		/*
		 * Router jobs last: tickets that drew no receipt (mostly quotes nobody
		 * paid), and receipts no payment was reported for (a reported payment
		 * makes the job paid). Their tickets expired long ago.
		 */
		for (const status of ['scheduled', 'completed'] as const) {
			await each(await this.store.listJobsByStatus(status, 'prepaid', ticketLapse, 200), async (job) => {
				const updated = await this.store.updateJob(job.jobId, (current) => {
					if (current.status !== status) {
						return current;
					}
					/* Paid to the settlement account but never billed: the payment goes back to the payer, once a job could no longer be running (MAX_JOB_MS). */
					if (current.payment && current.paymentTo && !current.settlement) {
						if ((current.ticketIssuedAt ?? current.createdAt) > now - SETTLE_LAPSE_MS) {
							return current;
						}
						return { ...current, status: 'failed', completedAt: current.completedAt ?? now, ...prepaidSettlement(current, 'no-receipt', now) };
					}
					return { ...current, status: 'expired' };
				});
				expired += updated.status === 'expired' ? 1 : 0;
				if (updated.payoutDue) {
					paidOut += (await this.serially(() => this.payout(updated))).settlement?.blockHash ? 1 : 0;
				}
			});
		}
		return { expired, settled, paidOut };
	}

	/* ----------------------------------------------------------------- pairing */

	async createPairing(masterNodeKey: string, body: Record<string, unknown>) {
		const codeHash = typeof body.codeHash === 'string' && /^[0-9a-f]{64}$/.test(body.codeHash) ? body.codeHash : null;
		if (!codeHash) {
			throw new ValidationError('codeHash must be a sha256 hex digest');
		}
		const master = await this.store.getProvider(masterNodeKey);
		/* Any node with its own operator wallet can be a master; a helper cannot pair helpers of its own. */
		if (!master || (master.kind !== 'mac' && master.kind !== 'linux')) {
			throw new ForbiddenError('only a registered Mac or Linux node with its own wallet can pair helpers');
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
		await this.assertNotHelperOfAnother(helperNodeKey, pairing.masterNodeKey);
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
			throw new ForbiddenError('only the node that created the code can approve it');
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
		/* Again here: another master may have approved this node since it claimed the code. */
		await this.assertNotHelperOfAnother(claim.nodeKey, masterNodeKey);
		await this.store.updatePairing(pairingId, (current) => ({ ...current, status: 'approved' }));
		const master = await this.store.getProvider(masterNodeKey);
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
			/* For display; scheduling always reads the master's current policy. */
			access: master?.access ?? { mode: 'allowlist', allow: [] },
			status: 'paused',
			load: { active: 0, capacity: 1 },
			lastHeartbeat: 0,
			registeredAt: now,
			stats: { completed: 0, failed: 0, tokensOut: 0 }
		});
		return { approved: true };
	}

	async rejectPairing(masterNodeKey: string, pairingId: string) {
		const pairing = await this.pairingStatus(masterNodeKey, pairingId);
		if (pairing.masterNodeKey !== masterNodeKey) {
			throw new ForbiddenError('only the node that created the code can reject it');
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

	/** A paired helper stays bound to its master (its wallet and allowlist) until the master revokes it, so it cannot pair with another. */
	private async assertNotHelperOfAnother(nodeKey: string, masterNodeKey: string): Promise<void> {
		const existing = await this.store.getProvider(nodeKey);
		if (existing?.kind === 'linux-helper' && existing.masterNodeKey !== masterNodeKey) {
			throw new ForbiddenError('this node is paired as a helper of another node; its master must revoke it before it can pair again');
		}
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

function quoteFor(job: JobRecord, credits: NetworkCredits): EscrowQuote {
	return {
		jobId: job.jobId,
		network: job.network,
		maxCost: escrowAmount(job.price, job).toString(),
		token: credits.token,
		decimals: credits.decimals,
		settlement: credits.settlement,
		expiresAt: job.quoteExpiresAt!
	};
}

function priceTotal(price: Price): bigint {
	return BigInt(price.inputPerMillion) + BigInt(price.outputPerMillion);
}

function assertBaseUnits(value: unknown, field: string): bigint {
	if (typeof value !== 'string' || !/^\d{1,30}$/.test(value)) {
		throw new ValidationError(`${field} must be a whole number of base units, as a string`);
	}
	return BigInt(value);
}

/** A list of provider keys or payout addresses from a quote request, without repeats; undefined when it names none. */
function assertProviderList(value: unknown, field: string): string[] | undefined {
	if (!Array.isArray(value) || value.length === 0) {
		return undefined;
	}
	if (value.length > MAX_PROVIDER_LIST) {
		throw new ValidationError(`${field} may name at most ${MAX_PROVIDER_LIST} providers`);
	}
	return [...new Set(value.map((key, i) => assertKeetaAddress(key, `${field}[${i}]`)))];
}

function assertTokenCount(value: unknown, field: string, max: number): number {
	if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > max) {
		throw new ValidationError(`${field} must be an integer between 1 and ${max}`);
	}
	return value as number;
}

/**
 * Most memory or free disk a machine may report (1 PiB). A master's app shows
 * its helpers' hardware, so every number must stay one it can decode and
 * format. Some network filesystems report more free space than this, so disk
 * is clamped rather than refused.
 */
const MAX_HARDWARE_BYTES = 2 ** 50;

function assertHardware(value: unknown): HardwareProfile {
	const hw = value as HardwareProfile;
	if (!hw || typeof hw !== 'object' || (hw.os !== 'macos' && hw.os !== 'linux')) {
		throw new ValidationError('hardware.os must be macos or linux');
	}
	if (!Number.isFinite(hw.memoryBytes) || hw.memoryBytes <= 0 || !Number.isFinite(hw.freeDiskBytes)) {
		throw new ValidationError('hardware memory and disk are required');
	}
	if (hw.memoryBytes > MAX_HARDWARE_BYTES) {
		throw new ValidationError(`hardware.memoryBytes must be at most ${MAX_HARDWARE_BYTES}`);
	}
	return {
		os: hw.os,
		osVersion: String(hw.osVersion ?? '').slice(0, 40),
		chip: String(hw.chip ?? '').slice(0, 120),
		memoryBytes: Math.floor(hw.memoryBytes),
		freeDiskBytes: Math.min(MAX_HARDWARE_BYTES, Math.max(0, Math.floor(hw.freeDiskBytes))),
		...(Number.isSafeInteger(hw.gpuCores) ? { gpuCores: hw.gpuCores } : {}),
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
	if (receipt.asset !== job.asset) {
		return 'receipt asset is not the asset the job is paid in';
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
	if (expected > maxJobCost(job.price, job)) {
		return 'receipt exceeds the job\'s maximum cost';
	}
	return null;
}

/** The scheduler's counters, dropping anything else an older record carried (such as a stored earnings total). */
function reputation(stats: ProviderRecord['stats']): ProviderRecord['stats'] {
	return { completed: stats.completed, failed: stats.failed, tokensOut: stats.tokensOut, ...(stats.disputed ? { disputed: stats.disputed } : {}) };
}

function publicProvider(record: StoredProvider): ProviderRecord {
	const { offeredModels: _offered, ...rest } = record;
	return rest;
}

/**
 * The settlement of a router job paid to the settlement account, marked for
 * payout; nothing for one paid to its provider directly (or not yet paid).
 */
function prepaidSettlement(job: JobRecord, reason: SettlementReason, now: number): Pick<JobRecord, 'settlement' | 'payoutDue'> | Record<string, never> {
	if (!job.paymentTo || job.settlement) {
		return {};
	}
	return { settlement: { reason, decidedAt: now }, payoutDue: true };
}

/** Whether the relay's delivery record covers exactly the text the job's receipt bills. */
function deliveryMatches(job: JobRecord): boolean {
	const billed = job.receipt?.receipt;
	return Boolean(job.delivery && billed && billed.outputHash === job.delivery.outputHash && billed.outputTokens <= job.delivery.maxOutputTokens);
}

/** Whether an app job holds a slot in its provider's load: from its ticket (issued on escrow) until its receipt, failure, handback or expiry. */
function holdsSlot(job: JobRecord): boolean {
	return job.paymentMode === 'escrow' && job.status === 'scheduled' && !job.handedBackAt;
}

/** Whether a job holds its slot at `now`: a ticket until it can no longer start. */
function holdsSlotAt(job: JobRecord, now: number): boolean {
	return holdsSlot(job) && (job.ticketIssuedAt ?? job.createdAt) > now - TICKET_TTL_MS;
}

/**
 * How an escrowed job settles, or null while it should wait. The relay's
 * delivery record decides: a receipt billing exactly the text the relay
 * forwarded is paid, the rest of the escrow refunded. A mismatch, a provider
 * failure, a receipt whose record has not come DELIVERY_GRACE_MS after it,
 * a record (or the relay finding the provider offline) with no receipt at
 * the lapse, or an escrow that never got a ticket refunds the buyer in full.
 *
 * A ticket holds its provider's slot, so one not used promptly owes the
 * provider NO_SHOW_FEE: one the relay never saw (a no-show), one the buyer
 * hung up on before any text came back (also a no-show), and one brought to
 * the relay late (the fee on top of what the job billed).
 */
function decideSettlement(job: JobRecord, now: number): { status: JobStatus; reason: SettlementReason; noShow?: boolean } | null {
	const refund = (status: JobStatus, reason: SettlementReason) => ({ status, reason });
	const noShow = { status: 'expired', reason: 'no-show', noShow: true } as const;
	if (job.status === 'expired') {
		return refund('expired', 'expired');
	}
	if (job.status === 'failed') {
		return refund('failed', 'failed');
	}
	const billed = job.receipt?.receipt;
	const issued = job.ticketIssuedAt ?? job.createdAt;
	const delivery = job.delivery;
	if (billed && delivery) {
		const late = delivery.presentedAt !== undefined && delivery.presentedAt > issued + NO_SHOW_WINDOW_MS;
		return deliveryMatches(job) ? { status: 'paid', reason: 'delivered', ...(late ? { noShow: true } : {}) } : refund('disputed', 'mismatch');
	}
	if (billed) {
		/* The receipt can land before the relay's record, which the relay retries: wait for it, for a bounded time. */
		return now < (job.completedAt ?? now) + DELIVERY_GRACE_MS ? null : refund('disputed', 'no-delivery');
	}
	if (now < issued + SETTLE_LAPSE_MS) {
		return null;
	}
	if (job.providerOfflineAt) {
		return refund('failed', 'no-receipt');
	}
	if (!delivery) {
		return noShow;
	}
	/* Hanging up before the provider sent anything, and soon after arriving, is the buyer's choice; waiting longer is the provider stalling. */
	const quit = delivery.abandonedAt !== undefined && delivery.presentedAt !== undefined && delivery.abandonedAt - delivery.presentedAt < NO_SHOW_WINDOW_MS;
	return quit ? noShow : refund('failed', 'no-receipt');
}

function assertBlockHash(value: unknown): string {
	if (typeof value !== 'string' || !/^[0-9A-Fa-f]{64}$/.test(value)) {
		throw new ValidationError('blockHash must be a 64-character hex block hash');
	}
	return value.toUpperCase();
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
