/**
 * Shared set-up for the live suite: the pre-funded test-network account,
 * fresh accounts topped up from it, and the sweep that returns what is left.
 *
 * Only the Keeta test network is used. The funding account is the fixed
 * test-network account below, unless KEETA_TESTNET_SEED (hex seed) or
 * KEETA_TESTNET_PASSPHRASE (24 words) names another. It must hold test USDC
 * and some KTA; see compute/README.md. Keeta Compute Credits are created
 * fresh for each run (credits.ts) and bought with that USDC.
 */

import * as KeetaNet from '@keetanetwork/keetanet-client';
import { NETWORKS, formatAmount, usdcAsset } from '@keeta-compute/protocol';
import { Account } from '@keeta-compute/protocol/keeta';
import { SerialQueue } from '@keeta-compute/wallet';
import { until } from '../support/harness.ts';

export type KeetaAccount = InstanceType<typeof Account>;
type UserClient = InstanceType<typeof KeetaNet.UserClient>;

export const NETWORK = 'test' as const;
export const USDC = usdcAsset('test');
const TEST_NETWORK_ID = BigInt(NETWORKS.test.caip2.split(':')[1]!);
const FAUCET_URL = 'https://faucet.test.keeta.com/';

/** The least test USDC the funding account must hold for one run (0.10 USDC); a run spends well under a cent. */
export const MIN_FUNDING_USDC = 100_000n;

const configuredNetwork = process.env.KEETA_LIVE_NETWORK ?? 'test';
if (configuredNetwork !== 'test') {
	throw new Error(`KEETA_LIVE_NETWORK is "${configuredNetwork}": the live suite runs only on the Keeta test network and never touches main-network funds`);
}

/**
 * The suite's own test-network funding account, keeta_aabpcmdf36xopdmazjtbjlhh4zoyfg7pscd2avvcs3fcflpcica5wqeh375fmci.
 * This seed is public on purpose so anyone can fund and run the suite: it only
 * ever holds test-network coins. The same seed gives the same address on the
 * main network, so never send it real funds; the suite refuses to run there.
 */
const PUBLIC_TESTNET_SEED = 'A3804FE8F609371B7C9C2AC2923D3056386218129E013F319A8CB73308469629';

/** Why the live tests are skipped, or false when they can run. KEETA_LIVE_SKIP=1 skips them. */
export const skipLive: string | false = process.env.KEETA_LIVE_SKIP === '1' ? 'KEETA_LIVE_SKIP is set' : false;

let announced = false;
export function announceSkip(): void {
	if (skipLive && !announced) {
		announced = true;
		console.log(`skipping: ${skipLive}`);
	}
}

/** LIVE_MODEL_URL (+ LIVE_MODEL_NAME) points the suite at a real OpenAI-compatible server instead of the fake one. */
export const liveModel = process.env.LIVE_MODEL_URL ? { baseUrl: process.env.LIVE_MODEL_URL.replace(/\/$/, ''), servedName: process.env.LIVE_MODEL_NAME ?? 'model' } : null;

/** The funding account's seed: KEETA_TESTNET_SEED, KEETA_TESTNET_PASSPHRASE, or the public test-network seed above. */
export async function fundingSeed(): Promise<string | ArrayBuffer> {
	const seed = process.env.KEETA_TESTNET_SEED?.trim();
	if (seed) {
		if (!/^[0-9a-fA-F]{64}$/.test(seed)) {
			throw new Error('KEETA_TESTNET_SEED must be a 64-character hex seed');
		}
		return seed;
	}
	const phrase = process.env.KEETA_TESTNET_PASSPHRASE?.trim();
	return phrase ? Account.seedFromPassphrase(phrase) : PUBLIC_TESTNET_SEED;
}

export function freshAccount(): KeetaAccount {
	return Account.fromSeed(Account.generateRandomSeed({ asString: true }) as string, 0);
}

/** Decimal places of a token from its on-chain metadata (base64 JSON, sometimes deflated). */
async function decimalsOf(client: UserClient, token: string): Promise<number | null> {
	try {
		const { info } = await client.client.getAccountInfo(token);
		const raw = KeetaNet.lib.Utils.Helper.bufferToArrayBuffer(Buffer.from(info.metadata as string, 'base64'));
		let json: ArrayBuffer;
		try {
			json = KeetaNet.lib.Utils.Buffer.ZlibInflate(raw);
		} catch {
			json = raw;
		}
		const { decimalPlaces } = JSON.parse(Buffer.from(json).toString('utf-8')) as { decimalPlaces?: unknown };
		return Number.isInteger(decimalPlaces) ? (decimalPlaces as number) : null;
	} catch {
		return null;
	}
}

/**
 * The funding account. Tops up fresh accounts (USDC by send; KTA from the
 * faucet first, then by send if the faucet is slow) and sweeps them back.
 */
export class Funder {
	private readonly queue = new SerialQueue();
	private readonly tracked = new Map<string, KeetaAccount>();
	/** The stablecoins sent out, which the sweep brings back: test USDC, and any other the funding account holds (KUSD once pinned). */
	private readonly funded = new Set<string>([USDC.address]);

	private constructor(
		readonly account: KeetaAccount,
		private readonly client: UserClient,
		readonly kta: string,
		/** One KTA in base units. */
		readonly ktaUnit: bigint
	) {}

	get address(): string {
		return this.account.publicKeyString.get();
	}

	static async open(): Promise<Funder> {
		const account = Account.fromSeed(await fundingSeed(), 0);
		const client = KeetaNet.UserClient.fromNetwork(NETWORK, account as Parameters<typeof KeetaNet.UserClient.fromNetwork>[1]);
		if (client.network !== TEST_NETWORK_ID) {
			await client.destroy();
			throw new Error(`the client is on network ${client.network}, not the Keeta test network (${TEST_NETWORK_ID}); refusing to move funds`);
		}
		const kta = client.baseToken.publicKeyString.get();
		const decimals = await decimalsOf(client, kta);
		if (decimals === null) {
			console.log('KTA decimals not readable from token metadata; assuming 18');
		}
		const funder = new Funder(account, client, kta, 10n ** BigInt(decimals ?? 18));
		const [usdc, ktaBalance] = await Promise.all([funder.balance(funder.address, 'usdc'), funder.balance(funder.address, 'kta')]);
		console.log(`funding account ${funder.address} on the test network: ${formatAmount(usdc, USDC.decimals)} USDC, ${formatAmount(ktaBalance, decimals ?? 18)} KTA`);
		console.log(`explorer: ${NETWORKS.test.explorer}/account/${funder.address}`);
		if (usdc < MIN_FUNDING_USDC) {
			await client.destroy();
			throw new Error(
				`the funding account ${funder.address} holds ${formatAmount(usdc, USDC.decimals)} test USDC; it needs at least ${formatAmount(MIN_FUNDING_USDC, USDC.decimals)}. ` +
					`Get test USDC from Circle's faucet and bridge it to Keeta (see compute/README.md), token ${USDC.address}.`
			);
		}
		return funder;
	}

	private tokenOf(asset: 'usdc' | 'kta' | (string & {})): string {
		return asset === 'usdc' ? USDC.address : asset === 'kta' ? this.kta : asset;
	}

	/** An account's balance of USDC, KTA or a token address, read with the funding account's client (the code under test is not involved). */
	balance(address: string, asset: 'usdc' | 'kta' | (string & {})): Promise<bigint> {
		return this.client.client.getBalance(address, this.tokenOf(asset));
	}

	/** Remember an account so `sweep` returns what it holds. */
	track(account: KeetaAccount): KeetaAccount {
		this.tracked.set(account.publicKeyString.get(), account);
		return account;
	}

	/** Run `fn` with the funding account's client, in turn with its sends (one account cannot publish two at once). */
	withClient<T>(fn: (client: UserClient) => Promise<T>): Promise<T> {
		return this.queue.run('funder', () => fn(this.client));
	}

	/** Send from the funding account; sends are serialized because one account cannot publish two at once. */
	send(to: string, amount: bigint, asset: 'usdc' | 'kta' | (string & {}), reference?: string): Promise<void> {
		return this.queue.run('funder', async () => {
			await this.client.send(to, amount, this.tokenOf(asset), reference);
		});
	}

	/** Send a token the funding account holds (test USDC, or a stablecoin it was given) and wait for it to land. */
	async fund(to: string, asset: 'usdc' | (string & {}), amount: bigint): Promise<void> {
		this.funded.add(this.tokenOf(asset));
		const before = await this.balance(to, asset);
		await this.send(to, amount, asset, 'keeta-compute live test');
		await until(`${to} to receive ${asset}`, async () => (await this.balance(to, asset)) >= before + amount, 60_000, 1_000);
	}

	fundUsdc(to: string, amount: bigint): Promise<void> {
		return this.fund(to, 'usdc', amount);
	}

	/** Give each address at least `amount` KTA for network fees: the faucet first, the funding account if it is slow. */
	async fundKta(addresses: string[], amount = this.ktaUnit, faucetWaitMs = 45_000): Promise<void> {
		await Promise.all(
			addresses.map((address) =>
				fetch(FAUCET_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `address=${encodeURIComponent(address)}&amount=10` }).catch(() => null)
			)
		);
		const deadline = Date.now() + faucetWaitMs;
		let short = addresses;
		while (short.length && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 3_000));
			const balances = await Promise.all(short.map((address) => this.balance(address, 'kta')));
			short = short.filter((_, i) => balances[i]! < amount);
		}
		if (short.length) {
			console.log(`the faucet was slow for ${short.length} account(s); sending KTA from the funding account`);
		}
		for (const address of short) {
			await this.send(address, amount, 'kta', 'keeta-compute live test fees');
		}
		for (const address of short) {
			await until(`${address} to receive KTA`, async () => (await this.balance(address, 'kta')) >= amount, 60_000, 1_000);
		}
	}

	/** Best effort: return the stablecoins and KTA left on tracked accounts to the funding account, then close. Credits made for the run stay where they are. */
	async sweep(): Promise<void> {
		for (const account of this.tracked.values()) {
			const address = account.publicKeyString.get();
			const client = KeetaNet.UserClient.fromNetwork(NETWORK, account as Parameters<typeof KeetaNet.UserClient.fromNetwork>[1]);
			try {
				for (const token of this.funded) {
					const held = await client.balance(token);
					if (held > 0n && (await client.balance(client.baseToken)) > 0n) {
						await client.send(this.address, held, token, 'keeta-compute live test sweep').catch((error: Error) => console.log(`could not sweep ${token} from ${address}: ${error.message}`));
					}
				}
				const kta = await client.balance(client.baseToken);
				/* Leave a little for the fee of this last send. */
				const margin = this.ktaUnit / 100n;
				if (kta > margin) {
					await client.send(this.address, kta - margin, client.baseToken, 'keeta-compute live test sweep').catch((error: Error) => console.log(`could not sweep KTA from ${address}: ${error.message}`));
				}
			} catch (error) {
				console.log(`sweep of ${address} failed: ${(error as Error).message}`);
			} finally {
				await client.destroy().catch(() => undefined);
			}
		}
		this.tracked.clear();
		await this.client.destroy().catch(() => undefined);
	}
}
