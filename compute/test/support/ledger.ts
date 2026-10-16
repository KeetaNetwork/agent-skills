/**
 * An in-memory Keeta ledger for the offline tests: token balances, and
 * blocks of sends with their external references. It implements the agent's
 * Ledger, checks escrow blocks the way checkPaymentBlock reads them, holds
 * keeta.ai's settlement account (one payout block per job, found again by
 * its reference), and fills swaps for the FX provider at the prices the FX
 * service quotes. Fees are not modelled: every account has KTA.
 *
 * The live suite (test/live) runs the same flows on the Keeta test network.
 */

import { findAsset, randomId, toHex, type NetworkName } from '@keeta-compute/protocol';
import { Account } from '@keeta-compute/protocol/keeta';
import { pickQuote, type Balances, type CreditExchange, type Ledger } from '@keeta-compute/wallet';
import type { PaymentVerifier, SettlementLedger } from '../../services/control/src/service.ts';

export interface LedgerSend {
	block: string;
	from: string;
	to: string;
	amount: bigint;
	/** Token address, or 'kta'. */
	token: string;
	reference?: string;
	at: number;
}

type KeetaAccount = Parameters<Ledger['send']>[0];

/** A fresh token address, as `credits:create` would make for Keeta Compute Credits. */
export function newTokenAddress(): string {
	const issuer = Account.fromSeed(Account.generateRandomSeed({ asString: true }), 0);
	return issuer.generateIdentifier(Account.AccountKeyAlgorithm.TOKEN, undefined, 0).publicKeyString.get();
}

export class FakeLedger implements Ledger {
	readonly sends: LedgerSend[] = [];
	private readonly held = new Map<string, bigint>();

	constructor(private readonly network: NetworkName = 'test') {}

	/** Issue `amount` of a token to an account (a faucet, or `credits:create` minting to the FX account). */
	mint(account: string, token: string, amount: bigint): void {
		this.held.set(`${account}:${token}`, this.balanceOf(account, token) + amount);
	}

	balanceOf(account: string, token: string): bigint {
		return this.held.get(`${account}:${this.tokenOf(token)}`) ?? 0n;
	}

	private tokenOf(asset: string): string {
		if (asset === 'kta' || asset.startsWith('keeta_')) {
			return asset;
		}
		const pinned = findAsset(this.network, asset)?.address;
		if (!pinned) {
			throw new Error(`unknown asset ${asset}`);
		}
		return pinned;
	}

	/** Publish one block of sends: all of them, or none when any sender lacks the tokens. */
	publish(sends: Array<{ from: string; to: string; amount: bigint; token: string; reference?: string }>): string {
		const needs = new Map<string, bigint>();
		for (const send of sends) {
			if (send.amount <= 0n) {
				throw new Error('a send must move more than zero');
			}
			const token = this.tokenOf(send.token);
			if (token !== 'kta') {
				const key = `${send.from}:${token}`;
				needs.set(key, (needs.get(key) ?? 0n) + send.amount);
			}
		}
		for (const [key, amount] of needs) {
			if ((this.held.get(key) ?? 0n) < amount) {
				throw new Error(`insufficient balance: ${key.split(':')[0]} holds ${this.held.get(key) ?? 0n}, sends ${amount}`);
			}
		}
		const block = toHex(crypto.getRandomValues(new Uint8Array(32))).toUpperCase();
		for (const send of sends) {
			const token = this.tokenOf(send.token);
			if (token !== 'kta') {
				this.held.set(`${send.from}:${token}`, (this.held.get(`${send.from}:${token}`) ?? 0n) - send.amount);
				this.held.set(`${send.to}:${token}`, (this.held.get(`${send.to}:${token}`) ?? 0n) + send.amount);
			}
			this.sends.push({ block, from: send.from, to: send.to, amount: send.amount, token, ...(send.reference ? { reference: send.reference } : {}), at: Date.now() });
		}
		return block;
	}

	/** The sends referencing a job, from one account. */
	sendsFor(jobId: string, from: string): LedgerSend[] {
		return this.sends.filter((s) => s.reference === jobId && s.from === from);
	}

	/* ------------------------------------------------- the agent's Ledger */

	async balances(account: KeetaAccount, tokens: string[]): Promise<Balances> {
		const address = account.publicKeyString.get();
		return { kta: 10n ** 18n, tokens: Object.fromEntries(tokens.map((token) => [token, this.balanceOf(address, token)])) };
	}

	async send(from: KeetaAccount, to: string, amount: bigint, asset: string, reference?: string): Promise<string> {
		return this.publish([{ from: from.publicKeyString.get(), to, amount, token: asset, ...(reference ? { reference } : {}) }]);
	}

	async received(account: string, from: string, token: string): Promise<Array<{ amount: bigint; at: number; reference?: string }>> {
		return this.sends
			.filter((s) => s.to === account && s.from === from && s.token === token)
			.reverse()
			.map((s) => ({ amount: s.amount, at: s.at, ...(s.reference ? { reference: s.reference } : {}) }));
	}

	async requestTestFunds(): Promise<string> {
		return 'ok';
	}

	/* ----------------------------------------------------- keeta.ai's side */

	/** The control plane's escrow check, reading blocks here: signer, recipient, token and reference, summed. */
	verifier(): PaymentVerifier {
		return async (args) => {
			const block = this.sends.filter((s) => s.block === args.blockHash.toUpperCase());
			if (block.length === 0) {
				return { status: 'pending' };
			}
			if (block[0]!.from !== args.from) {
				return { status: 'rejected', reason: 'block was not signed by the buyer account' };
			}
			const amount = block.filter((s) => s.to === args.to && s.token === args.asset && s.reference === args.reference).reduce((sum, s) => sum + s.amount, 0n);
			return amount >= args.minAmount ? { status: 'confirmed', amount } : { status: 'rejected', reason: `paid ${amount}, due ${args.minAmount}` };
		};
	}

	/** keeta.ai's settlement account: one block per payout, each send referencing the job. */
	settlement(account: string): SettlementLedger {
		return {
			account,
			payout: async ({ token, jobId, sends }) => this.publish(sends.map((send) => ({ from: account, to: send.to, amount: send.amount, token, reference: jobId }))),
			findPayout: async ({ token, jobId }) => this.sends.find((s) => s.from === account && s.token === token && s.reference === jobId)?.block ?? null
		};
	}

	/**
	 * The keeta.ai FX provider filling swaps from its account here, priced by
	 * `quote` (the FX service's quoteAmount): the user's tokens go to the FX
	 * account and the other side comes back, in one block.
	 */
	exchange(fx: string, quote: (request: { from: string; to: string; amount: bigint; affinity: 'from' | 'to' }) => bigint): CreditExchange {
		return {
			estimate: async (request) => quote(request),
			swap: async (account, request) => {
				/* The same check AnchorCreditExchange makes on the signed quote: nothing moves past the confirmed limit. */
				const other = pickQuote([{ quote: { convertedAmount: quote(request) } }], request).quote.convertedAmount;
				const [sent, received] = request.affinity === 'to' ? [other, request.amount] : [request.amount, other];
				const user = account.publicKeyString.get();
				const blockHash = this.publish([
					{ from: user, to: fx, amount: sent, token: request.from },
					{ from: fx, to: user, amount: received, token: request.to }
				]);
				return { exchangeId: randomId('fx'), blockHash, sent, received };
			}
		};
	}
}
