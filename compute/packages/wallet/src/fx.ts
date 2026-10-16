/**
 * Buying and selling Keeta Compute Credits through the keeta.ai FX provider
 * (services/fx), with the Keeta anchor SDK: the provider is found through
 * the anchor resolver rooted at the FX account the control plane publishes,
 * quoted, and swapped atomically on the ledger. Behind an interface so the
 * rest of the agent can be tested without a network.
 */

import * as KeetaAnchor from '@keetanetwork/anchor';
import type * as KeetaNet from '@keetanetwork/keetanet-client';
import type { NetworkName } from '@keeta-compute/protocol';

type Account = InstanceType<typeof KeetaNet.lib.Account>;

export interface SwapRequest {
	/** The FX account that roots the resolver lookup (control plane /v1/config `credits.fx`). */
	fx: string;
	/** Token addresses. */
	from: string;
	to: string;
	/** 'to': receive exactly `amount` of `to` (buying credits); 'from': spend exactly `amount` of `from` (selling them). */
	affinity: 'from' | 'to';
	amount: bigint;
}

export interface SwapResult {
	exchangeId: string;
	/** The swap's block on the ledger. */
	blockHash: string;
	/** Base units of `from` given and of `to` received. */
	sent: bigint;
	received: bigint;
}

export interface CreditExchange {
	/** The other side of a swap: what `from` costs for an exact `to`, or what an exact `from` brings in `to`. */
	estimate(request: SwapRequest): Promise<bigint>;
	/** Swap on `account`'s own balances; resolves once the exchange completed on the ledger. */
	swap(account: Account, request: SwapRequest): Promise<SwapResult>;
}

const STATUS_POLL_MS = 1_000;
const STATUS_TIMEOUT_MS = 120_000;

export class AnchorCreditExchange implements CreditExchange {
	constructor(private readonly network: NetworkName) {}

	private client(account: Account | null, fx: string) {
		const KeetaNetAnchor = KeetaAnchor.KeetaNet;
		/* The anchor SDK carries its own keetanet-client; its Account accepts ours (same key types). */
		const user = account
			? KeetaNetAnchor.UserClient.fromNetwork(this.network, account as never)
			: KeetaNetAnchor.UserClient.fromNetwork(this.network, null, { account: KeetaNetAnchor.lib.Account.fromPublicKeyString(fx as never) });
		const root = KeetaNetAnchor.lib.Account.fromPublicKeyString(fx as never);
		/* A test-network FX provider may be served over plain http (a local or staging deployment); on main it must be https. */
		const exchange = new KeetaAnchor.FX.Client(user, { root, metadataConfig: { allowInsecureProtocols: this.network === 'test' }, ...(account ? { signer: account as never, account: account as never } : {}) } as never);
		return { user, exchange };
	}

	private conversion(request: SwapRequest) {
		return { from: request.from as never, to: request.to as never, amount: request.amount, affinity: request.affinity };
	}

	async estimate(request: SwapRequest): Promise<bigint> {
		const { user, exchange } = this.client(null, request.fx);
		try {
			const estimates = await exchange.getEstimates(this.conversion(request));
			const best = estimates?.[0];
			if (!best) {
				throw new Error('the keeta.ai FX provider does not trade this pair');
			}
			return best.estimate.convertedAmount;
		} finally {
			await user.destroy().catch(() => undefined);
		}
	}

	async swap(account: Account, request: SwapRequest): Promise<SwapResult> {
		const { user, exchange } = this.client(account, request.fx);
		try {
			const quotes = await exchange.getQuotes(this.conversion(request));
			/* Buying an exact amount: the cheapest quote; selling an exact amount: the one paying most. */
			const quote = (quotes ?? []).sort((a, b) => (request.affinity === 'to' ? Number(a.quote.convertedAmount - b.quote.convertedAmount) : Number(b.quote.convertedAmount - a.quote.convertedAmount)))[0];
			if (!quote) {
				throw new Error('the keeta.ai FX provider does not trade this pair');
			}
			const created = await quote.createExchange();
			const deadline = Date.now() + STATUS_TIMEOUT_MS;
			for (let status = created.exchange; ; status = await created.getExchangeStatus()) {
				if (status.status === 'completed') {
					const other = quote.quote.convertedAmount;
					return {
						exchangeId: status.exchangeID,
						blockHash: status.blockhash,
						sent: request.affinity === 'to' ? other : request.amount,
						received: request.affinity === 'to' ? request.amount : other
					};
				}
				if (status.status === 'failed') {
					throw new Error(`the exchange ${status.exchangeID} failed; nothing was swapped`);
				}
				if (Date.now() > deadline) {
					throw new Error(`the exchange ${status.exchangeID} is still pending; check the wallet before trying again`);
				}
				await new Promise((resolve) => setTimeout(resolve, STATUS_POLL_MS));
			}
		} finally {
			await user.destroy().catch(() => undefined);
		}
	}
}
