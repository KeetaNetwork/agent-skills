/**
 * The whole system for the live suite: the control plane on the real ledger,
 * the real relay Worker under `wrangler dev` with the real facilitator, and a
 * Mac-style provider connected to it over a WebSocket. With `credits`, also
 * this run's Keeta Compute Credits, the FX service selling them and the
 * settlement account app jobs escrow with (credits.ts). Only the model is a
 * fake, unless LIVE_MODEL_URL points at a real server.
 */

import { Account } from '@keeta-compute/protocol/keeta';
import type { Price } from '@keeta-compute/protocol';
import { startServer } from '../../services/control/src/server.ts';
import type { ModelManager } from '../../agent/src/models/manager.ts';
import { Scratch, fakeModelServer, freePort, listen, macAgent, passkeyEntropy, until } from '../support/harness.ts';
import { startWorker, type RunningWorker } from '../support/worker.ts';
import { startCredits, type LiveCredits } from './credits.ts';
import { NETWORK, liveModel, type Funder } from './support.ts';

export const MODEL = 'llama-3.2-3b';
/** 1 credit in and 4 credits out per million tokens, in credit base units (a credit is a US dollar). */
export const PRICE: Price = { inputPerMillion: '1000000', outputPerMillion: '4000000' };
export const FACILITATOR_URL = process.env.LIVE_FACILITATOR_URL ?? 'https://facilitator.x402.keeta.com';

export interface Stack {
	control: Awaited<ReturnType<typeof startServer>>;
	worker: RunningWorker;
	model: { baseUrl: string; servedName: string; fake: boolean };
	mac: ReturnType<typeof macAgent> & { operator: string; nodeKey: string; entropy: string };
	/** Present when started with `credits`. */
	credits: LiveCredits | null;
}

export async function startStack(scratch: Scratch, options: { credits?: { funder: Funder } } = {}): Promise<Stack> {
	let model: Stack['model'];
	if (liveModel) {
		model = { ...liveModel, fake: false };
	} else {
		const server = fakeModelServer();
		model = { baseUrl: `${await listen(server)}/v1`, servedName: 'fake', fake: true };
		scratch.defer(() => server.close());
	}

	const secrets = { RELAY_SECRET: `live-relay-${crypto.randomUUID()}`, ROUTER_SECRET: `live-router-${crypto.randomUUID()}` };
	const controlPort = await freePort();
	const worker = await startWorker({ CONTROL_URL: `http://127.0.0.1:${controlPort}`, NETWORK: 'test', FACILITATOR_URL, ...secrets }, scratch.dir('wrangler'));
	scratch.defer(() => worker.stop());

	const credits = options.credits ? await startCredits(options.credits.funder, scratch) : null;
	const control = await startServer({
		port: controlPort,
		/* The escrow verifier and the settlement account are the production ones from config.ts. */
		env: { COORDINATOR_SEED: Account.generateRandomSeed({ asString: true }) as string, RELAY_URL: worker.url, ALLOW_SMALL_PROVIDERS: 'true', ...secrets, ...(credits?.env ?? {}) }
	});
	scratch.defer(() => {
		control.server.close();
		control.server.closeAllConnections();
	});

	const mac = macAgent(scratch.dir('mac-provider'));
	scratch.defer(() => mac.app.shutdown());
	await mac.rpc['agent.initialize']!({ network: NETWORK, controlUrl: control.url, relayUrl: worker.url, nodePublicKey: mac.nodePublicKey, appVersion: 'live', machineName: 'Live Studio' });
	(mac.app as unknown as { models: ModelManager }).models.addExternal({
		modelId: MODEL,
		name: 'Llama 3.2 3B',
		backend: { baseUrl: model.baseUrl, servedName: model.servedName },
		weightsHash: 'a'.repeat(64),
		sizeBytes: 1,
		path: '/dev/null',
		contextLength: 8192,
		price: PRICE
	});
	await mac.rpc['provider.setPolicy']!({ enabled: true });
	const entropy = passkeyEntropy();
	const { operator } = (await mac.rpc['wallet.setOperator']!({ entropy })) as { operator: string };
	await until('the Mac provider to connect to the relay Worker', async () => (await mac.rpc['provider.status']!({})).state === 'online', 60_000, 250).catch((error: Error) => {
		throw new Error(`${error.message}\n--- wrangler output ---\n${worker.output()}`);
	});
	const nodeKey = (await mac.rpc['agent.state']!({})).nodeKey as string;

	return {
		control,
		worker,
		model,
		mac: { ...mac, operator, nodeKey, entropy },
		credits
	};
}
