/**
 * Records shared by the control plane, relay, agent and app. These are the
 * operational records held in the app backend (Firestore); prompts and
 * outputs never appear in them (plan §5.1). Nor do balances: credits,
 * escrows, payouts and refunds live only on the Keeta ledger, and job
 * records point at the blocks that moved them.
 */

import type { NetworkName } from './constants.ts';
import type { HardwareProfile, HardwareTier } from './hardware.ts';
import type { Price } from './pricing.ts';

export type AccessMode = 'public' | 'allowlist';

export interface AccessPolicy {
	mode: AccessMode;
	/** Buyer paying keys allowed when mode is allowlist. */
	allow: string[];
}

export interface RuntimeInfo {
	kind: 'mlx' | 'openai-compatible';
	/** Runtime name and version, e.g. "mlx-lm 0.26.0" or "llama.cpp b6000". */
	build: string;
}

/** One model a provider offers to the network. */
export interface Offer {
	modelId: string;
	/** sha256 over the installed weight files (see @keeta-compute/provider's models). */
	weightsHash: string;
	runtime: RuntimeInfo;
	price: Price;
	access: AccessPolicy;
	contextLength: number;
}

/** 'mac' and 'linux' pay their own operator; a 'linux-helper' pays the master that paired it. */
export type ProviderKind = 'mac' | 'linux' | 'linux-helper';

export interface ProviderRecord {
	/** The node's Keeta public key: its identity and the key that signs receipts. */
	nodeKey: string;
	/** Account every payment for this node settles to (the operator's published key). */
	payTo: string;
	kind: ProviderKind;
	/** For Linux helpers, the master (a Mac or a Linux node with its own wallet) that paired them. */
	masterNodeKey?: string;
	name: string;
	network: NetworkName;
	hardware: HardwareProfile;
	tier: HardwareTier;
	offers: Offer[];
	/** Install-wide access policy, applied when an offer does not override it. */
	access: AccessPolicy;
	status: 'online' | 'paused' | 'offline';
	load: { active: number; capacity: number };
	lastHeartbeat: number;
	registeredAt: number;
	/**
	 * Reputation counters the scheduler weighs; no money. What a provider
	 * earned is on the ledger: the settlement account's payouts to `payTo`.
	 */
	stats: { completed: number; failed: number; tokensOut: number; disputed?: number };
}

/**
 * 'escrow': an app job. The buyer escrows its maximum cost in credits with
 * keeta.ai before the ticket is issued, and the control plane pays the
 * provider from it. 'prepaid': a public router job, paid to the provider
 * directly over x402 before it runs.
 */
export type PaymentMode = 'escrow' | 'prepaid';

/**
 * - `quoted`: an app job waiting for its escrow; no ticket yet.
 * - `scheduled`: ticketed (escrowed, or a router quote).
 * - `completed`: the provider filed its receipt; an app job waits for the relay's delivery record.
 * - `paid`: the provider was paid (app jobs: from the escrow, with the rest refunded).
 * - `failed`: the provider failed or never billed; the escrow is refunded.
 * - `disputed`: the receipt does not match what the relay forwarded (or the relay recorded nothing); the escrow is refunded.
 * - `expired`: never used; an escrow that arrived is refunded.
 */
export type JobStatus = 'quoted' | 'scheduled' | 'completed' | 'failed' | 'paid' | 'expired' | 'disputed';

/** Why an escrowed job was settled the way it was. */
export type SettlementReason = 'delivered' | 'mismatch' | 'no-delivery' | 'failed' | 'no-receipt' | 'expired';

/**
 * How an escrowed app job settles, decided once, and the payout block. No
 * amounts: the payout splits the escrow block's amount (read from the
 * ledger) by the reason, paying the receipt's amount when delivered.
 */
export interface Settlement {
	reason: SettlementReason;
	decidedAt: number;
	/** When the last payout attempt started; another waits until it is stale, then checks the ledger first. */
	attemptAt?: number;
	/** The settlement account's payout block, once published. */
	blockHash?: string;
	sentAt?: number;
	error?: string;
}

export interface JobRecord {
	jobId: string;
	network: NetworkName;
	/** Paying key: the buyer's spend account, or the x402 payer on the router. */
	buyer: string;
	nodeKey: string;
	payTo: string;
	modelId: string;
	/** Credit base units per million tokens. */
	price: Price;
	maxInputTokens: number;
	maxOutputTokens: number;
	paymentMode: PaymentMode;
	/** Token the job is paid in: the credit token for app jobs, the x402 stablecoin for router jobs. */
	asset: string;
	/** Router jobs: what the x402 payment must carry, in base units of `asset`. */
	prepaidAmount?: string;
	status: JobStatus;
	createdAt: number;
	completedAt?: number;
	receipt?: SignedReceipt;
	/** Router jobs: the x402 settlement. */
	payment?: { blockHash: string; paidAt: number; verified: boolean };
	/** For router jobs: the account that paid through x402. */
	routerPayer?: string;
	fallback?: FallbackRoute;
	/** App jobs: the quote holds its provider until then. Its escrow is maxJobCost(price, limits) credits. */
	quoteExpiresAt?: number;
	/** App jobs: the buyer's block escrowing the quote with the settlement account, verified on the ledger. */
	escrow?: { blockHash: string; at: number };
	/** App jobs: when the ticket was issued (on escrow). */
	ticketIssuedAt?: number;
	/** App jobs: how the escrow is split and the payout. */
	settlement?: Settlement;
	/** App jobs: a work-queue marker, set while a decided settlement has no payout block yet. */
	payoutDue?: boolean;
	/** For app jobs: what the relay forwarded to the buyer, which decides whether the receipt is paid. */
	delivery?: { outputHash: string; maxOutputTokens: number; at: number };
	/** For fallback jobs: when the router started the one upstream run this quote allows. */
	claimedAt?: number;
	/**
	 * For app jobs: when the ticket's slot was handed back before a receipt
	 * (by the buyer, or by the sweep once the ticket went unused). The job
	 * stays open until it lapses, so a provider that already streamed can still
	 * file its receipt and be paid from the escrow.
	 */
	handedBackAt?: number;
	error?: string;
}

/** What the provider attests to after running a job (plan §5.5 step 5). */
export interface Receipt {
	v: 1;
	jobId: string;
	network: NetworkName;
	nodeKey: string;
	payTo: string;
	buyer: string;
	modelId: string;
	weightsHash: string;
	runtime: RuntimeInfo;
	inputTokens: number;
	outputTokens: number;
	price: Price;
	/** The priced usage, in credit base units (one credit is one US dollar). */
	amount: string;
	/** The ticket's asset: the credit token for app jobs, the stablecoin paid over x402 for router jobs. */
	asset: string;
	startedAt: number;
	finishedAt: number;
	/** sha256 of the generated text; the text itself is never stored. */
	outputHash: string;
	finishReason: string;
}

export interface SignedReceipt {
	receipt: Receipt;
	/** Hex signature by `receipt.nodeKey` over the canonical receipt. */
	signature: string;
}

/** Authorization the control plane issues for one job on one provider. */
/**
 * A job the public router sends to an outside API (OpenRouter) because no
 * network provider could take it. Paid to keeta.ai's own account, not a
 * provider, and never carries a provider receipt.
 */
export interface FallbackRoute {
	via: 'openrouter';
	/** The upstream model slug, e.g. meta-llama/llama-3.2-3b-instruct. */
	model: string;
}

export interface JobTicket {
	v: 1;
	jobId: string;
	network: NetworkName;
	nodeKey: string;
	modelId: string;
	buyer: string;
	maxInputTokens: number;
	maxOutputTokens: number;
	price: Price;
	asset: string;
	payTo: string;
	paymentMode: PaymentMode;
	/** Router jobs: the x402 amount, in base units of `asset`. */
	prepaidAmount?: string;
	issuedAt: number;
	expiresAt: number;
}

export interface SignedTicket {
	ticket: JobTicket;
	/** Coordinator key signature, checked by the provider. */
	coordinatorSig: string;
	/** HMAC shared between control plane and relay, checked by the relay. */
	relayMac: string;
}

/** What the buyer sends to a provider through the relay. */
export interface JobEnvelope {
	ticket: SignedTicket;
	request: ChatCompletionRequest;
	/** Buyer's signature over jobAuthMessage(); absent for prepaid router jobs. */
	buyerSig?: string;
}

export interface ChatMessage {
	role: 'system' | 'user' | 'assistant' | 'tool' | 'developer';
	content: string | Array<{ type: string; text?: string; [key: string]: unknown }> | null;
	[key: string]: unknown;
}

export interface ChatCompletionRequest {
	model: string;
	messages: ChatMessage[];
	stream?: boolean;
	max_tokens?: number;
	max_completion_tokens?: number;
	temperature?: number;
	top_p?: number;
	stop?: string | string[];
	seed?: number;
	[key: string]: unknown;
}

/** Frames between relay and provider, and relay and buyer. */
export type ProviderFrame =
	| { type: 'chunk'; id: string; data: unknown }
	| { type: 'receipt'; id: string; receipt: SignedReceipt }
	| { type: 'error'; id: string; code: string; message: string }
	| { type: 'pong' };

export type RelayFrame =
	| { type: 'job'; id: string; envelope: JobEnvelope }
	| { type: 'cancel'; id: string }
	| { type: 'ping' };

export interface PairingRecord {
	pairingId: string;
	codeHash: string;
	masterNodeKey: string;
	payTo: string;
	network: NetworkName;
	createdAt: number;
	expiresAt: number;
	status: 'waiting' | 'claimed' | 'approved' | 'rejected' | 'expired';
	claim?: { nodeKey: string; descriptor: HardwareProfile & { name: string }; checkString: string; claimedAt: number };
}

/** Network-wide view of one model for buyers. */
export interface NetworkModel {
	id: string;
	name: string;
	providers: number;
	/** Credit base units per million tokens. */
	lowestPrice: Price;
	contextLength: number;
	license?: string;
	/** Present when the public router can also serve this model through its fallback; its price. */
	fallback?: { price: Price };
}
