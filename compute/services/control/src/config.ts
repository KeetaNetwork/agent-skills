/**
 * Builds a ControlService from environment configuration. Shared by the
 * Firebase entry point and the standalone server.
 */

import * as KeetaNet from '@keetanetwork/keetanet-client';
import { assertKeetaAddress, assertModelId, assertPrice, ValidationError, type NetworkName } from '@keeta-compute/protocol';
import { Account, accountSigner, checkPaymentBlock, verifyKeetaSignature } from '@keeta-compute/protocol/keeta';
import { ControlService, type BalanceReader, type FallbackConfig, type PaymentVerifier } from './service.ts';
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
	/** Pay-later buyers must hold funds for their open jobs. On unless set to "false" (local development). */
	REQUIRE_BUYER_BALANCE?: string;
	/** keeta.ai account that receives payments for router jobs served through OpenRouter. */
	FALLBACK_PAY_TO?: string;
	/**
	 * JSON: {"<model id>": {"route": "<openrouter slug>", "price": {"inputPerMillion": "...", "outputPerMillion": "..."}, "contextLength": 8192}}.
	 * Models listed here are served through OpenRouter when no provider can take a router job. Empty turns the fallback off.
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
				return 'confirmed';
			}
			return result.status === 'not-found' ? 'pending' : 'rejected';
		} catch (error) {
			console.warn('payment lookup failed; will retry', (error as Error).message);
			return 'pending';
		}
	};
}

/** Reads buyer balances from the Keeta ledger. */
export function ledgerBalanceReader(): BalanceReader {
	return (args) => ledgerClient(args.network).getBalance(args.account, args.asset);
}

export function serviceFromEnv(store: Store, env: EnvConfig, ledger: { verifyPayment?: PaymentVerifier; balanceOf?: BalanceReader } = {}): ControlService {
	if (!env.COORDINATOR_SEED || !env.RELAY_SECRET || !env.ROUTER_SECRET) {
		throw new Error('COORDINATOR_SEED, RELAY_SECRET and ROUTER_SECRET must be set');
	}
	const networks = (env.NETWORKS ?? 'test')
		.split(',')
		.map((n) => n.trim())
		.filter((n): n is NetworkName => n === 'test' || n === 'main');
	const fallback = fallbackFromEnv(env);
	return new ControlService({
		store,
		coordinator: accountSigner(Account.fromSeed(env.COORDINATOR_SEED, 0)),
		verify: verifyKeetaSignature,
		relaySecret: env.RELAY_SECRET,
		routerSecret: env.ROUTER_SECRET,
		relayUrl: env.RELAY_URL ?? 'https://relay.keeta.ai',
		networks: networks.length ? networks : ['test'],
		verifyPayment: ledger.verifyPayment ?? ledgerPaymentVerifier(),
		...(env.REQUIRE_BUYER_BALANCE === 'false' ? {} : { balanceOf: ledger.balanceOf ?? ledgerBalanceReader() }),
		allowSmallProviders: env.ALLOW_SMALL_PROVIDERS === 'true',
		...(fallback ? { fallback } : {})
	});
}
