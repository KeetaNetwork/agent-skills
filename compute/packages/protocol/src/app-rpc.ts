/**
 * The contract between the macOS app (Swift) and the bundled agent.
 *
 * Transport: JSON-RPC 2.0, one JSON object per line, over the agent's stdin
 * (app → agent) and stdout (agent → app). The agent logs to stderr only.
 * Both sides may send requests: the app calls the methods in `AppToAgent`,
 * and the agent calls `signer.signDigest` on the app because the node key
 * lives in the Secure Enclave. Notifications (no `id`) carry events.
 *
 * Amounts are always strings of integer base units. Prices, limits, costs
 * and earnings are in Keeta Compute Credits (one credit is one US dollar,
 * 6 decimals); stablecoin amounts are in that stablecoin's own decimals.
 * Addresses are Keeta public key strings (keeta_…).
 */

import type { CatalogModel, Compatibility, HardwareProfile, HardwareTier, NetworkModel, NetworkName, PairingRecord, Price, AccessPolicy } from './index.ts';

export interface AssetBalance {
	/** Keeta Compute Credits, which pay for requests. */
	credits: string;
	/** KTA, which pays network fees. */
	kta: string;
	/** Each available stablecoin by symbol (KUSD, …, USDC), in its own base units. */
	stablecoins: Record<string, string>;
}

/** A stablecoin that buys credits and that credits cash out to. */
export interface StablecoinInfo {
	symbol: string;
	name: string;
	/** ISO 4217 code it tracks. */
	currency: string;
	address: string;
	decimals: number;
}

export interface WalletState {
	/** Passkey-backed operator account: identity, payout address, main balance. */
	operator: string | null;
	/** Local key used to pay for inference on behalf of agents on this Mac ("agent budget"). */
	spend: string;
	balances: { operator: AssetBalance | null; spend: AssetBalance } | null;
	/** Keeta Compute Credits: what prices, limits, costs and earnings are in. */
	asset: { address: string; symbol: string; decimals: number };
	/** False until credits exist on this network; buying inference needs them. */
	creditsAvailable: boolean;
	/** Stablecoins available on this network, in lead order (KUSD first, USDC last). */
	stablecoins: StablecoinInfo[];
	explorer: string;
	/** Last balance read error, e.g. network unreachable. */
	error?: string;
}

/** What `wallet.send`, `wallet.fundBudget` and `wallet.drainBudget` move: credits, KTA, or a stablecoin by symbol. */
export type WalletAssetName = 'credits' | 'kta' | (string & {});

export interface ProviderPolicy {
	enabled: boolean;
	schedule: { mode: 'always' | 'idle' | 'hours'; startHour?: number; endHour?: number; idleMinutes?: number };
	pauseOnBattery: boolean;
	maxConcurrentJobs: number;
	/** Install-wide default; each offer may override. */
	access: AccessPolicy;
}

export interface BuyerPolicy {
	/** Largest amount a single request may cost (its escrow), credit base units. */
	perRequestMax: string;
	/** Largest total providers may bill per UTC day, credit base units. */
	dailyMax: string;
	/** Empty means any model. */
	allowedModels: string[];
	/** Empty means any provider. */
	allowedProviders: string[];
	/** Highest price the app will accept, credit base units per million tokens. */
	maxPrice: Price;
}

export interface InstalledModel {
	modelId: string;
	name: string;
	path: string;
	weightsHash: string;
	sizeBytes: number;
	installedAt: number;
	custom: boolean;
	offer: { offered: boolean; price: Price; access: AccessPolicy | null };
}

export interface CatalogEntry {
	model: CatalogModel;
	compatibility: Compatibility;
	installed: InstalledModel | null;
}

export type InstallPhase = 'queued' | 'runtime' | 'downloading' | 'verifying' | 'done' | 'failed';

export interface InstallProgress {
	modelId: string;
	phase: InstallPhase;
	bytesDone: number;
	bytesTotal: number;
	message?: string;
}

export interface JobSummary {
	jobId: string;
	role: 'provider' | 'buyer';
	modelId: string;
	counterparty: string;
	inputTokens: number;
	outputTokens: number;
	/** Credit base units billed. */
	amount: string;
	/** 'completed': receipt in; 'paid': settled from the escrow on the ledger; 'failed': refunded or not run (`amount` is the no-show fee when the ticket never reached the relay). */
	status: 'running' | 'completed' | 'paid' | 'failed';
	at: number;
	helper?: string;
	error?: string;
}

export interface ProviderStatus {
	policy: ProviderPolicy;
	/** Why the node is not taking jobs right now, if it isn't. */
	state: 'online' | 'paused' | 'outside-schedule' | 'on-battery' | 'no-offers' | 'not-eligible' | 'connecting' | 'offline';
	activeJobs: number;
	/**
	 * Credits the settlement account paid the operator, read from the ledger
	 * (UTC today, and in all the history read). Router jobs pay the operator
	 * in stablecoins directly, which shows in the wallet balance instead.
	 */
	earnedToday: string;
	earnedTotal: string;
	tokensServedToday: number;
	recentJobs: JobSummary[];
}

export interface BuyerStatus {
	endpoint: string;
	token: string;
	policy: BuyerPolicy;
	/** Credits charged today (what providers billed; escrow refunds are not counted). */
	spentToday: string;
	recentJobs: JobSummary[];
}

export interface FleetHelper {
	nodeKey: string;
	name: string;
	hardware: HardwareProfile;
	tier: HardwareTier;
	status: 'online' | 'paused' | 'offline';
	offers: string[];
	/** Jobs this helper completed; what they earned is paid to the master's operator account. */
	completed: number;
	lastHeartbeat: number;
}

export interface AgentState {
	version: string;
	network: NetworkName;
	nodeKey: string | null;
	onboarded: boolean;
	controlReachable: boolean;
	hardware: HardwareProfile | null;
	tier: HardwareTier | null;
	wallet: WalletState | null;
	provider: ProviderStatus | null;
	buyer: BuyerStatus | null;
}

export interface AppToAgent {
	/** First call after launch. `nodePublicKey` is the Secure Enclave key, 33-byte compressed P-256, hex. */
	'agent.initialize': {
		params: { network: NetworkName; controlUrl: string; relayUrl: string; nodePublicKey: string; appVersion: string; machineName: string };
		result: AgentState;
	};
	'agent.state': { params: Record<string, never>; result: AgentState };
	'agent.setNetwork': { params: { network: NetworkName }; result: AgentState };

	/** Called once after the passkey is created or found; `entropy` is the 32-byte PRF output (hex) and is not kept. */
	'wallet.setOperator': { params: { entropy: string }; result: { operator: string } };
	'wallet.refresh': { params: Record<string, never>; result: WalletState };
	/** Send from the operator account; each call needs a fresh passkey assertion. */
	'wallet.send': { params: { entropy: string; to: string; amount: string; asset: WalletAssetName; memo?: string }; result: { blockHash: string } };
	/** Move funds from the operator account into the agent budget. */
	'wallet.fundBudget': { params: { entropy: string; amount: string; asset: WalletAssetName }; result: { blockHash: string } };
	/** Move funds from the agent budget back to the operator account (no passkey needed). */
	'wallet.drainBudget': { params: { amount: string; asset: WalletAssetName }; result: { blockHash: string } };
	/**
	 * What a swap would cost or bring, without making it. `side` 'buy': the
	 * stablecoin needed for `amount` credits; 'sell': the stablecoin `amount`
	 * credits bring. `limit` is what the operator confirms along with it: the
	 * most a buy may cost, or the least a sale may bring (the estimate moved
	 * by 0.5%). Show both, and pass `limit` to buyCredits or sellCredits.
	 */
	'wallet.creditQuote': { params: { side: 'buy' | 'sell'; amount: string; stablecoin: string }; result: { amount: string; limit: string } };
	/**
	 * Buy exactly `amount` credits with a stablecoin from the operator account
	 * through the keeta.ai FX provider, paying at most `maxPay` (the confirmed
	 * creditQuote `limit`), then (unless `toBudget` is false) move them into
	 * the agent budget, where requests are paid from. A quote above `maxPay`
	 * is refused before anything is signed.
	 */
	'wallet.buyCredits': {
		params: { entropy: string; amount: string; with: string; maxPay: string; toBudget?: boolean };
		result: { exchangeId: string; blockHash: string; paid: string; credits: string; budgetBlockHash?: string };
	};
	/**
	 * Cash out: sell exactly `amount` credits from the operator account for a
	 * stablecoin, receiving at least `minReceive` (the confirmed creditQuote
	 * `limit`). A quote below it is refused before anything is signed.
	 */
	'wallet.sellCredits': {
		params: { entropy: string; amount: string; to: string; minReceive: string };
		result: { exchangeId: string; blockHash: string; credits: string; received: string };
	};
	'wallet.requestTestFunds': { params: Record<string, never>; result: { requested: boolean; message: string } };

	'hardware.profile': { params: Record<string, never>; result: { hardware: HardwareProfile; tier: HardwareTier; canProvide: boolean; reason?: string } };

	'models.list': { params: Record<string, never>; result: CatalogEntry[] };
	'models.install': { params: { modelId: string }; result: { started: boolean } };
	'models.installCustom': { params: { repo: string; name: string; contextLength?: number }; result: { started: boolean; modelId: string } };
	'models.cancelInstall': { params: { modelId: string }; result: { cancelled: boolean } };
	'models.remove': { params: { modelId: string }; result: { removed: boolean } };
	'models.setOffer': { params: { modelId: string; offered: boolean; price?: Price; access?: AccessPolicy | null }; result: InstalledModel };

	'provider.status': { params: Record<string, never>; result: ProviderStatus };
	'provider.setPolicy': { params: Partial<ProviderPolicy>; result: ProviderStatus };

	'buyer.status': { params: Record<string, never>; result: BuyerStatus };
	'buyer.setPolicy': { params: Partial<BuyerPolicy>; result: BuyerStatus };
	'buyer.rotateToken': { params: Record<string, never>; result: BuyerStatus };
	'buyer.networkModels': { params: Record<string, never>; result: NetworkModel[] };
	/** Report escrows not confirmed yet and read how recent jobs settled (refunds and payouts are on the ledger). */
	'buyer.settle': { params: Record<string, never>; result: { reported: number; settled: number } };

	'fleet.createPairing': { params: Record<string, never>; result: { pairingId: string; code: string; expiresAt: number } };
	'fleet.pairingStatus': { params: { pairingId: string }; result: PairingRecord };
	'fleet.approve': { params: { pairingId: string }; result: { approved: boolean } };
	'fleet.reject': { params: { pairingId: string }; result: { rejected: boolean } };
	'fleet.list': { params: Record<string, never>; result: FleetHelper[] };
	'fleet.revoke': { params: { nodeKey: string }; result: { revoked: boolean } };

	'agent.shutdown': { params: Record<string, never>; result: { ok: true } };
}

export interface AgentToApp {
	/** Sign a 32-byte digest with the Secure Enclave node key. Return raw r||s (64 bytes, hex) with low S. */
	'signer.signDigest': { params: { digest: string }; result: { signature: string } };
}

export interface AgentNotifications {
	'event.state': AgentState;
	'event.installProgress': InstallProgress;
	'event.job': JobSummary;
	'event.log': { level: 'debug' | 'info' | 'warn' | 'error'; message: string };
}

export const RPC_ERRORS = {
	parse: -32700,
	invalidRequest: -32600,
	methodNotFound: -32601,
	invalidParams: -32602,
	internal: -32603,
	notInitialized: -32001,
	noOperator: -32002,
	policyDenied: -32003,
	insufficientFunds: -32004,
	network: -32005,
	notEligible: -32006
} as const;
