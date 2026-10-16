/**
 * Builds a ControlService from environment configuration. Shared by the
 * Firebase entry point and the standalone server.
 */

import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { NetworkName } from '@keeta-compute/protocol';
import { Account, accountSigner, checkPaymentBlock, verifyKeetaSignature } from '@keeta-compute/protocol/keeta';
import { ControlService, type PaymentVerifier } from './service.ts';
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
}

/** Looks up payment blocks on the Keeta ledger. */
export function ledgerPaymentVerifier(): PaymentVerifier {
	const clients = new Map<NetworkName, InstanceType<typeof KeetaNet.Client>>();
	return async (args) => {
		let client = clients.get(args.network);
		if (!client) {
			client = KeetaNet.Client.fromNetwork(args.network);
			clients.set(args.network, client);
		}
		try {
			const result = await checkPaymentBlock(client, args);
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

export function serviceFromEnv(store: Store, env: EnvConfig, verifyPayment: PaymentVerifier = ledgerPaymentVerifier()): ControlService {
	if (!env.COORDINATOR_SEED || !env.RELAY_SECRET || !env.ROUTER_SECRET) {
		throw new Error('COORDINATOR_SEED, RELAY_SECRET and ROUTER_SECRET must be set');
	}
	const networks = (env.NETWORKS ?? 'test')
		.split(',')
		.map((n) => n.trim())
		.filter((n): n is NetworkName => n === 'test' || n === 'main');
	return new ControlService({
		store,
		coordinator: accountSigner(Account.fromSeed(env.COORDINATOR_SEED, 0)),
		verify: verifyKeetaSignature,
		relaySecret: env.RELAY_SECRET,
		routerSecret: env.ROUTER_SECRET,
		relayUrl: env.RELAY_URL ?? 'https://relay.keeta.ai',
		networks: networks.length ? networks : ['test'],
		verifyPayment,
		allowSmallProviders: env.ALLOW_SMALL_PROVIDERS === 'true'
	});
}
