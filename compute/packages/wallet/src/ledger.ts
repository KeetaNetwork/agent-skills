/**
 * Wallet operations on the Keeta ledger, behind an interface so the rest of
 * the agent can be tested without a network.
 */

import * as KeetaNet from '@keetanetwork/keetanet-client';
import { findAsset, type NetworkName } from '@keeta-compute/protocol';

type Account = InstanceType<typeof KeetaNet.lib.Account>;

export interface Balances {
	/** KTA, which pays network fees. */
	kta: bigint;
	/** Each requested token, by token address. */
	tokens: Record<string, bigint>;
}

export interface Ledger {
	/** KTA and each of `tokens` (token addresses) held by `account`. */
	balances(account: Account, tokens: string[]): Promise<Balances>;
	/**
	 * Publish a send; resolves to the block hash. `asset` is 'kta', a token
	 * address, or the symbol of a pinned stablecoin (KUSD, USDC, …). Calls from
	 * one account must be serialized by the caller.
	 */
	send(from: Account, to: string, amount: bigint, asset: string, reference?: string): Promise<string>;
	/**
	 * Sends of `token` from `from` to `account` on the ledger, newest first:
	 * what the settlement account paid an operator, which is what that
	 * operator earned from app jobs.
	 */
	received(account: string, from: string, token: string): Promise<Array<{ amount: bigint; at: number; reference?: string }>>;
	/** Ask the test faucet for KTA (test network only). */
	requestTestFunds(address: string): Promise<string>;
}

export class KeetaLedger implements Ledger {
	constructor(private readonly network: NetworkName) {}

	private client(account: Account) {
		return KeetaNet.UserClient.fromNetwork(this.network, account as Parameters<typeof KeetaNet.UserClient.fromNetwork>[1]);
	}

	private token(client: InstanceType<typeof KeetaNet.UserClient>, asset: string) {
		if (asset === 'kta') {
			return client.baseToken;
		}
		const address = asset.startsWith('keeta_') ? asset : findAsset(this.network, asset)?.address;
		if (!address) {
			throw new Error(`${asset} is not a token available on the ${this.network} network`);
		}
		return KeetaNet.lib.Account.fromPublicKeyString(address as Parameters<typeof KeetaNet.lib.Account.fromPublicKeyString>[0]).assertKeyType(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);
	}

	async balances(account: Account, tokens: string[]): Promise<Balances> {
		/* Reading another account's balances (the operator, by public key) needs no signer. */
		const client = account.hasPrivateKey ? this.client(account) : KeetaNet.UserClient.fromNetwork(this.network, null, { account });
		try {
			const [kta, ...amounts] = await Promise.all([client.balance(client.baseToken), ...tokens.map((token) => client.balance(this.token(client, token)))]);
			return { kta: kta!, tokens: Object.fromEntries(tokens.map((token, i) => [token, amounts[i]!])) };
		} finally {
			await client.destroy();
		}
	}

	async send(from: Account, to: string, amount: bigint, asset: string, reference?: string): Promise<string> {
		const recipient = KeetaNet.lib.Account.fromPublicKeyString(to as Parameters<typeof KeetaNet.lib.Account.fromPublicKeyString>[0]);
		if (recipient.isToken()) {
			throw new Error('recipient is a token address, not an account');
		}
		const client = this.client(from);
		try {
			/* Finish any publish an earlier crash left ambiguous before sending again. */
			if (await client.pendingBlock()) {
				await client.recover(true);
			}
			const result = await client.send(recipient, amount, this.token(client, asset), reference);
			const blocks = result.from === 'direct' ? result.voteStaple.blocks : result.blocks;
			const own = blocks.find((block) => block.account.publicKeyString.get() === from.publicKeyString.get()) ?? blocks[0];
			if (!own) {
				throw new Error('send returned no blocks');
			}
			return own.hash.toString();
		} finally {
			await client.destroy();
		}
	}

	async received(account: string, from: string, token: string): Promise<Array<{ amount: bigint; at: number; reference?: string }>> {
		const target = KeetaNet.lib.Account.fromPublicKeyString(account as Parameters<typeof KeetaNet.lib.Account.fromPublicKeyString>[0]);
		const client = KeetaNet.UserClient.fromNetwork(this.network, null, { account: target });
		const found: Array<{ amount: bigint; at: number; reference?: string }> = [];
		try {
			/* The account's history, page by page: every vote staple that touched it, newest first. */
			let startBlocksHash: string | undefined;
			const seen = new Set<string>();
			for (let page = 0; page < 20; page++) {
				const history = (await client.history({ depth: 100, ...(startBlocksHash ? { startBlocksHash } : {}) })).filter(({ voteStaple }) => !seen.has(voteStaple.blocksHash.toString()));
				if (history.length === 0) {
					break;
				}
				for (const { voteStaple } of history) {
					seen.add(voteStaple.blocksHash.toString());
					for (const block of voteStaple.blocks) {
						if (block.account.publicKeyString.get() !== from) {
							continue;
						}
						for (const operation of block.operations) {
							if (operation.type !== KeetaNet.lib.Block.OperationType.SEND) {
								continue;
							}
							const send = operation as InstanceType<typeof KeetaNet.lib.Block.Operation.SEND>;
							if (send.to.publicKeyString.get() === account && send.token.publicKeyString.get() === token) {
								found.push({ amount: send.amount, at: block.date.getTime(), ...(send.external ? { reference: send.external } : {}) });
							}
						}
					}
				}
				startBlocksHash = history[history.length - 1]!.voteStaple.blocksHash.toString();
			}
			return found;
		} finally {
			await client.destroy();
		}
	}

	async requestTestFunds(address: string): Promise<string> {
		if (this.network !== 'test') {
			throw new Error('test funds exist only on the test network');
		}
		const response = await fetch('https://faucet.test.keeta.com/', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: `address=${encodeURIComponent(address)}&amount=10`
		});
		if (!response.ok) {
			throw new Error(`the faucet answered ${response.status}`);
		}
		return 'Requested 10 test KTA for network fees. Test stablecoins come from their issuers (test USDC from the Circle faucet, bridged to Keeta); swap them for credits in the wallet.';
	}
}

/** Serializes calls per key: one account cannot have two payments in flight (plan §6.3). */
export class SerialQueue {
	private tails = new Map<string, Promise<unknown>>();

	run<T>(key: string, task: () => Promise<T>): Promise<T> {
		const previous = this.tails.get(key) ?? Promise.resolve();
		const next = previous.then(task, task);
		this.tails.set(
			key,
			next.catch(() => undefined)
		);
		return next;
	}
}
