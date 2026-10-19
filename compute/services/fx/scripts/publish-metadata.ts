/**
 * Publish the FX service in the FX account's metadata so clients find it
 * through the anchor resolver rooted at the FX account:
 *
 *   FX_SEED=... FX_PUBLIC_URL=https://fx.keeta.ai [FX_NETWORK=test] npm run fx:publish
 *
 * Takes the same settings as the service (src/config.ts). Run it again
 * whenever the URL or the traded stablecoins change. The FX account needs
 * KTA for the fee.
 */

import * as KeetaNet from '@keetanetwork/keetanet-client';
import { Account } from '@keeta-compute/protocol/keeta';
import { fxConfigFromEnv } from '../src/config.ts';
import { FX_SERVICE_ID, publishFxMetadata } from '../src/ledger.ts';
import { createFxServer, stopFxServer } from '../src/server.ts';

if (!process.env.FX_PUBLIC_URL?.trim()) {
	throw new Error('set FX_PUBLIC_URL to the URL clients reach the FX service at');
}
const config = fxConfigFromEnv(process.env);
const server = createFxServer(config);
const account = Account.fromSeed(config.seed, 0);
const client = KeetaNet.UserClient.fromNetwork(config.network, account as Parameters<typeof KeetaNet.UserClient.fromNetwork>[1]);
try {
	const service = await server.serviceMetadata();
	const block = await publishFxMetadata(client, service);
	console.log(`Published FX service "${FX_SERVICE_ID}" at ${config.url} in the metadata of ${account.publicKeyString.get()} (block ${block}).`);
} finally {
	await client.destroy();
	await stopFxServer(server).catch(() => undefined);
}
