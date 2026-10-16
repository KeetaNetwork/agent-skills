/**
 * Builds a ControlService from environment configuration. Shared by the
 * Firebase entry point and the standalone server.
 */

import * as KeetaNet from '@keetanetwork/keetanet-client';
import { CREDIT_DECIMALS, assertKeetaAddress, assertModelId, assertPrice, pinnedCredits, ValidationError, type NetworkName } from '@keeta-compute/protocol';
import { Account, accountSigner, checkPaymentBlock, verifyKeetaSignature } from '@keeta-compute/protocol/keeta';
import { ControlService, type ControlConfig, type FallbackConfig, type PaymentVerifier, type SettlementLedger } from './service.ts';
import type { Store } from './store.ts';

export interface EnvConfig {
	/** Seed of the coordinator account that signs tickets. Keep it in Secret Manager. */
	COORDINATOR_SEED: string;
	RELAY_SECRET: string;
	ROUTER_SECRET: string;
	RELAY_URL?: string;
	/** Comma-separated; defaults to "test". Main must be enabled explicitly. */
	NETWORKS?: string;
	ALLOW_SMALL_PROVIDERS?: string;
	/**
	 * Seed of keeta.ai's settlement account: app buyers escrow credits to it,
	 * and it pays providers and refunds buyers (it needs KTA for fees). App
	 * jobs are off without it. Keep it in Secret Manager.
	 */
	SETTLEMENT_SEED?: string;
	/**
	 * Test network only: the credit token to use instead of the pinned one,
	 * for a deployment ahead of `credits:create` landing in credit-pins.ts.
	 * Ignored for the main network, which only ever uses its pin.
	 */
	TEST_CREDIT_TOKEN?: string;
	/** Test network only: the FX account that goes with TEST_CREDIT_TOKEN. */
	TEST_FX_ACCOUNT?: string;
	/** keeta.ai account that receives payments for router jobs served through OpenRouter. */
	FALLBACK_PAY_TO?: string;
	/**
	 * JSON: {"<model id>": {"route": "<openrouter slug>", "price": {"inputPerMillion": "...", "outputPerMillion": "..."}, "contextLength": 8192}}.
	 * Prices are credits per million tokens. Models listed here are served through OpenRouter when no provider can take a router job. Empty turns the fallback off.
	 */
	FALLBACK_MODELS?: string;
}

/** Parse the fallback settings; throws on anything malformed so a bad deploy fails loudly. */
export function fallbackFromEnv(env: EnvConfig): FallbackConfig | undefined {
	if (!env.FALLBACK_MODELS?.trim()) {
		return undefined;
	}
	const payTo = assertKeetaAddress(env.FALLBACK_PAY_TO, 'FALLBACK_PAY_TO');
	const raw = JSON.parse(env.FALLBACK_MODELS) as Record<string, { route?: unknown; price?: unknown; contextLength?: unknown }>;
	const models: FallbackConfig['models'] = {};
	for (const [id, entry] of Object.entries(raw)) {
		const route = entry.route;
		if (typeof route !== 'string' || !/^[A-Za-z0-9._:\/-]{1,128}$/.test(route)) {
			throw new ValidationError(`FALLBACK_MODELS.${id}.route must be an OpenRouter model slug`);
		}
		const contextLength = Number(entry.contextLength);
		if (!Number.isInteger(contextLength) || contextLength < 1024) {
			throw new ValidationError(`FALLBACK_MODELS.${id}.contextLength must be an integer of at least 1024`);
		}
		models[assertModelId(id)] = { route, price: assertPrice(entry.price, `FALLBACK_MODELS.${id}.price`), contextLength };
	}
	return { payTo, models };
}

/** The credit token per enabled network: the pin, or on the test network TEST_CREDIT_TOKEN. */
export function creditsFromEnv(env: EnvConfig, networks: NetworkName[]): ControlConfig['credits'] {
	const credits: ControlConfig['credits'] = {};
	for (const network of networks) {
		const pin = pinnedCredits(network);
		if (network === 'test' && env.TEST_CREDIT_TOKEN?.trim()) {
			const token = assertKeetaAddress(env.TEST_CREDIT_TOKEN.trim(), 'TEST_CREDIT_TOKEN');
			const fx = env.TEST_FX_ACCOUNT?.trim() ? assertKeetaAddress(env.TEST_FX_ACCOUNT.trim(), 'TEST_FX_ACCOUNT') : token === pin?.token ? pin.fx : null;
			credits[network] = { token, decimals: CREDIT_DECIMALS, fx };
		} else if (pin) {
			credits[network] = { token: pin.token, decimals: pin.decimals, fx: pin.fx };
		}
	}
	return credits;
}

const ledgerClients = new Map<NetworkName, InstanceType<typeof KeetaNet.Client>>();

function ledgerClient(network: NetworkName) {
	let client = ledgerClients.get(network);
	if (!client) {
		client = KeetaNet.Client.fromNetwork(network);
		ledgerClients.set(network, client);
	}
	return client;
}

/** Looks up payment blocks on the Keeta ledger. */
export function ledgerPaymentVerifier(): PaymentVerifier {
	return async (args) => {
		try {
			const result = await checkPaymentBlock(ledgerClient(args.network), args);
			if (result.status === 'confirmed') {
				return { status: 'confirmed', amount: result.amount };
			}
			return result.status === 'not-found' ? { status: 'pending' } : { status: 'rejected', reason: result.reason };
		} catch (error) {
			console.warn('payment lookup failed; will retry', (error as Error).message);
			return { status: 'pending' };
		}
	};
}

type UserClient = InstanceType<typeof KeetaNet.UserClient>;

function asAccount(address: string) {
	return Account.fromPublicKeyString(address as Parameters<typeof Account.fromPublicKeyString>[0]);
}

/** The settlement account on the Keeta ledger, signing with SETTLEMENT_SEED. */
export function ledgerSettlement(seed: string): SettlementLedger {
	const account = Account.fromSeed(seed, 0);
	const clients = new Map<NetworkName, UserClient>();
	const client = (network: NetworkName) => {
		let user = clients.get(network);
		if (!user) {
			user = KeetaNet.UserClient.fromNetwork(network, account as Parameters<typeof KeetaNet.UserClient.fromNetwork>[1]);
			clients.set(network, user);
		}
		return user;
	};
	const address = account.publicKeyString.get();
	return {
		account: address,
		async payout({ network, token, jobId, sends }) {
			const user = client(network);
			/* Finish a publish an earlier crash left ambiguous before building a new block. */
			if (await user.pendingBlock()) {
				await user.recover(true);
			}
			const tokenAccount = asAccount(token).assertKeyType(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);
			const builder = user.initBuilder();
			for (const send of sends) {
				builder.send(asAccount(send.to), send.amount, tokenAccount, jobId);
			}
			const result = await user.publishBuilder(builder);
			const blocks = result.from === 'direct' ? result.voteStaple.blocks : result.blocks;
			const own = blocks.find((block) => block.account.publicKeyString.get() === address) ?? blocks[0];
			if (!own) {
				throw new Error('the payout published no blocks');
			}
			return own.hash.toString().toUpperCase();
		},
		async findPayout({ network, token, jobId, since }) {
			/* The settlement account's own chain, newest first, page by page back to `since`. */
			const seen = new Set<string>();
			let startBlock: string | undefined;
			for (let page = 0; page < 100; page++) {
				const blocks = await client(network).chain({ depth: 200, ...(startBlock ? { startBlock } : {}) });
				const fresh = blocks.filter((block) => !seen.has(block.hash.toString()));
				if (fresh.length === 0) {
					return null;
				}
				for (const block of fresh) {
					seen.add(block.hash.toString());
					for (const operation of block.operations) {
						if (operation.type !== KeetaNet.lib.Block.OperationType.SEND) {
							continue;
						}
						const send = operation as InstanceType<typeof KeetaNet.lib.Block.Operation.SEND>;
						if (send.external === jobId && send.token.publicKeyString.get() === token) {
							return block.hash.toString().toUpperCase();
						}
					}
				}
				const oldest = fresh[fresh.length - 1]!;
				if (oldest.date.getTime() < since || !oldest.previous || oldest.previous.toString() === oldest.hash.toString()) {
					return null;
				}
				startBlock = oldest.previous.toString();
			}
			throw new Error('the settlement account history is too long to search; look for the payout by hand');
		}
	};
}

export function serviceFromEnv(store: Store, env: EnvConfig, ledger: { verifyPayment?: PaymentVerifier; settlement?: SettlementLedger } = {}): ControlService {
	if (!env.COORDINATOR_SEED || !env.RELAY_SECRET || !env.ROUTER_SECRET) {
		throw new Error('COORDINATOR_SEED, RELAY_SECRET and ROUTER_SECRET must be set');
	}
	const parsed = (env.NETWORKS ?? 'test')
		.split(',')
		.map((n) => n.trim())
		.filter((n): n is NetworkName => n === 'test' || n === 'main');
	const networks: NetworkName[] = parsed.length ? parsed : ['test'];
	const fallback = fallbackFromEnv(env);
	const settlement = ledger.settlement ?? (env.SETTLEMENT_SEED?.trim() ? ledgerSettlement(env.SETTLEMENT_SEED.trim()) : undefined);
	return new ControlService({
		store,
		coordinator: accountSigner(Account.fromSeed(env.COORDINATOR_SEED, 0)),
		verify: verifyKeetaSignature,
		relaySecret: env.RELAY_SECRET,
		routerSecret: env.ROUTER_SECRET,
		relayUrl: env.RELAY_URL ?? 'https://relay.keeta.ai',
		networks,
		verifyPayment: ledger.verifyPayment ?? ledgerPaymentVerifier(),
		credits: creditsFromEnv(env, networks),
		...(settlement ? { settlement } : {}),
		allowSmallProviders: env.ALLOW_SMALL_PROVIDERS === 'true',
		...(fallback ? { fallback } : {})
	});
}
