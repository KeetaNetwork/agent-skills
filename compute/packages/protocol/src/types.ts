/**
 * Records shared by the control plane, relay, agent and app. These are the
 * operational records held in the app backend (Firestore); prompts and
 * outputs never appear in them (plan §5.1).
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
	/** sha256 over the installed weight files (see agent/src/models). */
	weightsHash: string;
	runtime: RuntimeInfo;
	price: Price;
	access: AccessPolicy;
	contextLength: number;
}

export type ProviderKind = 'mac' | 'linux-helper';

export interface ProviderRecord {
	/** The node's Keeta public key: its identity and the key that signs receipts. */
	nodeKey: string;
	/** Account every payment for this node settles to (the operator's published key). */
	payTo: string;
	kind: ProviderKind;
	/** For Linux helpers, the macOS master that paired them. */
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
	stats: { completed: number; failed: number; tokensOut: number; earned: string };
}

export type PaymentMode = 'postpay' | 'prepaid';

export type JobStatus = 'scheduled' | 'completed' | 'failed' | 'paid' | 'expired';

export interface JobRecord {
	jobId: string;
	network: NetworkName;
	/** Paying key: the buyer's spend account, or the x402 payer on the router. */
	buyer: string;
	nodeKey: string;
	payTo: string;
	modelId: string;
	price: Price;
	maxInputTokens: number;
	maxOutputTokens: number;
	paymentMode: PaymentMode;
	prepaidAmount?: string;
	status: JobStatus;
	createdAt: number;
	completedAt?: number;
	receipt?: SignedReceipt;
	amountDue?: string;
	payment?: { blockHash: string; paidAt: number; verified: boolean };
	/** For router jobs: the account that paid through x402. */
	routerPayer?: string;
	fallback?: FallbackRoute;
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
	/** Base units owed (postpay) or consumed (prepaid). */
	amount: string;
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
	prepaidAmount?: string;
	/** Set when the router serves this job through an outside API instead of a provider. */
	fallback?: FallbackRoute;
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
	lowestPrice: Price;
	contextLength: number;
	license?: string;
	/** Present when the public router can also serve this model through its fallback; its price. */
	fallback?: { price: Price };
}
