/**
 * Wallet operations on the Keeta ledger, behind an interface so the rest of
 * the agent can be tested without a network.
 */

import * as KeetaNet from '@keetanetwork/keetanet-client';
import { NETWORKS, type NetworkName } from '@keeta-compute/protocol';

type Account = InstanceType<typeof KeetaNet.lib.Account>;

export interface Balances {
	usdc: bigint;
	kta: bigint;
}

export interface Ledger {
	balances(account: Account): Promise<Balances>;
	/** Publish a send; resolves to the block hash. Calls from one account must be serialized by the caller. */
	send(from: Account, to: string, amount: bigint, asset: 'usdc' | 'kta', reference?: string): Promise<string>;
	/** Ask the test faucet for KTA (test network only). */
	requestTestFunds(address: string): Promise<string>;
}

export class KeetaLedger implements Ledger {
	constructor(private readonly network: NetworkName) {}

	private client(account: Account) {
		return KeetaNet.UserClient.fromNetwork(this.network, account as Parameters<typeof KeetaNet.UserClient.fromNetwork>[1]);
	}

	private token(client: InstanceType<typeof KeetaNet.UserClient>, asset: 'usdc' | 'kta') {
		if (asset === 'kta') {
			return client.baseToken;
		}
		return KeetaNet.lib.Account.fromPublicKeyString(NETWORKS[this.network].settlementAsset.address as Parameters<typeof KeetaNet.lib.Account.fromPublicKeyString>[0]).assertKeyType(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);
	}

	async balances(account: Account): Promise<Balances> {
		/* Reading another account's balances (the operator, by public key) needs no signer. */
		const client = account.hasPrivateKey ? this.client(account) : KeetaNet.UserClient.fromNetwork(this.network, null, { account });
		try {
			const [usdc, kta] = await Promise.all([client.balance(this.token(client, 'usdc')), client.balance(client.baseToken)]);
			return { usdc, kta };
		} finally {
			await client.destroy();
		}
	}

	async send(from: Account, to: string, amount: bigint, asset: 'usdc' | 'kta', reference?: string): Promise<string> {
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
		return 'Requested 10 test KTA for network fees. Test USDC comes from the Circle test faucet bridged to Keeta.';
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
