/**
 * Run the keeta.ai FX provider for Keeta Compute Credits:
 *
 *   FX_SEED=... [FX_NETWORK=test] [FX_PORT=8787] [FX_PUBLIC_URL=https://fx.keeta.ai] npm start
 *
 * See src/config.ts for every setting, and scripts/publish-metadata.ts for
 * publishing the service so clients can find it.
 */

import { fxConfigFromEnv } from './config.ts';
import { createFxServer, fxAccount, stopFxServer } from './server.ts';

const config = fxConfigFromEnv(process.env);
const server = createFxServer(config);
await server.start();
console.log(`Keeta Compute Credits FX on the ${config.network} network at ${server.url}`);
console.log(`FX account ${fxAccount(config.seed).publicKeyString.get()}; credit token ${config.credits.token}`);
console.log(`swaps ${config.stablecoins.map((s) => s.symbol).join(', ')} with credits; rates: ${config.rateSource}; spread ${config.spreadBps} bps (KUSD and USDC at par)`);

const stop = () => {
	void stopFxServer(server).finally(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
