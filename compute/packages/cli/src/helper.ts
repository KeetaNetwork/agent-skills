/**
 * Linux helper satellites (plan §5.7): a headless provider that pairs by code
 * with a master (a Mac, or a Linux node with its own wallet; see cli.ts),
 * serves models from a local OpenAI-compatible server (vLLM, llama.cpp,
 * SGLang), and pays the master operator's wallet. Its node key lives in a
 * 0600 file and never holds funds. A machine that should keep its own
 * earnings runs the full CLI (`keeta-compute-agent init`) instead.
 */

import { hostname } from 'node:os';
import { resolve } from 'node:path';
import {
	CREDIT_DECIMALS,
	CREDIT_SYMBOL,
	assertModelId,
	formatAmount,
	normalizePairingCode,
	pairingCodeHash,
	parseAmount,
	type PairingRecord,
	type Price,
	type Log
} from '@keeta-compute/protocol';
import { accountSigner, verifyKeetaSignature } from '@keeta-compute/protocol/keeta';
import { StateStore } from '@keeta-compute/agent';
import { ControlClient } from '@keeta-compute/protocol/client';
import { ModelManager, Provider, detectHardware, hashDirectory } from '@keeta-compute/provider';
import { waitForServer } from '@keeta-compute/runtime-openai';
import { fileAccount } from '@keeta-compute/wallet';

export interface HelperIO {
	out: (line: string) => void;
	fetchImpl?: typeof fetch;
	sleep?: (ms: number) => Promise<void>;
	WebSocketImpl?: typeof WebSocket;
}

const defaultSleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

function helperStore(dataDir: string): StateStore {
	return new StateStore(dataDir);
}

export async function pairHelper(
	args: { dataDir: string; code: string; controlUrl?: string; name?: string; pollMs?: number },
	io: HelperIO
): Promise<PairingRecord> {
	const store = helperStore(args.dataDir);
	if (args.controlUrl) {
		store.update((s) => (s.controlUrl = args.controlUrl!.replace(/\/$/, '')));
	}
	const node = accountSigner(fileAccount(args.dataDir, 'node'));
	const control = new ControlClient(store.state.controlUrl, io.fetchImpl);
	const hardware = await detectHardware(args.dataDir);
	const name = (args.name ?? hostname()).slice(0, 80);
	const code = normalizePairingCode(args.code);
	const claim = await control.post<{ pairingId: string; checkString: string; expiresAt: number }>(node, '/v1/pairing/claim', {
		codeHash: await pairingCodeHash(code),
		descriptor: { ...hardware, name }
	});
	io.out(`Paired with code. On the master (your Mac or Linux node), confirm this check string matches: ${claim.checkString}`);
	io.out('Waiting for approval on the master...');
	const sleep = io.sleep ?? defaultSleep;
	for (;;) {
		const pairing = await control.get<PairingRecord>(node, `/v1/pairing/${encodeURIComponent(claim.pairingId)}`);
		if (pairing.status === 'approved') {
			store.update((s) => {
				s.network = pairing.network;
				s.machineName = name;
				s.helper = { masterNodeKey: pairing.masterNodeKey, payTo: pairing.payTo, pairedAt: Date.now() };
				s.provider = { ...s.provider, enabled: true, pauseOnBattery: false, schedule: { mode: 'always' } };
			});
			io.out(`Approved. Earnings go to ${pairing.payTo} on the ${pairing.network} network.`);
			return pairing;
		}
		if (pairing.status === 'rejected' || pairing.status === 'expired') {
			throw new Error(`pairing was ${pairing.status}`);
		}
		await sleep(args.pollMs ?? 2000);
	}
}

export async function addHelperModel(
	args: { dataDir: string; id: string; url: string; servedName: string; weights: string; priceIn?: string; priceOut?: string; context?: number; name?: string },
	io: HelperIO
): Promise<void> {
	const store = helperStore(args.dataDir);
	const modelId = assertModelId(args.id);
	const baseUrl = args.url.replace(/\/$/, '');
	if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/.test(baseUrl)) {
		throw new Error('the model server must listen on this machine (127.0.0.1 or localhost)');
	}
	const decimals = CREDIT_DECIMALS;
	const price: Price = {
		inputPerMillion: parseAmount(args.priceIn ?? '0.10', decimals).toString(),
		outputPerMillion: parseAmount(args.priceOut ?? '0.40', decimals).toString()
	};
	io.out(`Hashing weights in ${args.weights}...`);
	const { weightsHash, sizeBytes } = await hashDirectory(resolve(args.weights));
	const models = new ModelManager(store, args.dataDir, null, () => undefined);
	models.addExternal({
		modelId,
		name: args.name ?? modelId,
		backend: { baseUrl, servedName: args.servedName },
		weightsHash,
		sizeBytes,
		path: resolve(args.weights),
		contextLength: args.context ?? 8192,
		price
	});
	io.out(`Added ${modelId} (${weightsHash.slice(0, 12)}), offered at ${formatAmount(BigInt(price.inputPerMillion), decimals)} in / ${formatAmount(BigInt(price.outputPerMillion), decimals)} out ${CREDIT_SYMBOL} per million tokens.`);
}

export function helperStatus(dataDir: string): Record<string, unknown> {
	const store = helperStore(dataDir);
	const node = fileAccount(dataDir, 'node');
	const s = store.state;
	return {
		nodeKey: node.publicKeyString.get(),
		network: s.network,
		controlUrl: s.controlUrl,
		paired: s.helper ?? null,
		models: s.models.map((m) => ({ modelId: m.modelId, offered: m.offer.offered, price: m.offer.price })),
		/* What these jobs earned is paid to the master's operator account; its wallet shows it. */
		jobsCompleted: s.jobs.filter((j) => j.role === 'provider' && (j.status === 'completed' || j.status === 'paid')).length
	};
}

/** Run the helper until stopped. Returns the provider so callers can stop it. */
export async function runHelper(args: { dataDir: string }, io: HelperIO, log: Log): Promise<Provider> {
	const store = helperStore(args.dataDir);
	if (!store.state.helper) {
		throw new Error('this helper is not paired yet; run `keeta-compute-agent helper pair <CODE>` first');
	}
	const hardware = await detectHardware(args.dataDir);
	const node = accountSigner(fileAccount(args.dataDir, 'node'));
	const models = new ModelManager(store, args.dataDir, null, () => undefined);
	for (const model of models.models) {
		if (model.backend) {
			await waitForServer(model.backend.baseUrl, 5000).catch(() => log('warn', `${model.modelId}: nothing answered at ${model.backend!.baseUrl} yet`));
		}
	}
	const provider = new Provider({
		store,
		control: new ControlClient(store.state.controlUrl, io.fetchImpl),
		node,
		verify: verifyKeetaSignature,
		models,
		runtime: null,
		kind: 'linux-helper',
		hardware: () => hardware,
		registration: () => ({}),
		log,
		onJob: (job) => log('info', `job ${job.jobId} ${job.status} ${job.outputTokens} tokens`),
		onChange: () => undefined,
		...(io.WebSocketImpl ? { WebSocketImpl: io.WebSocketImpl } : {})
	});
	provider.start();
	return provider;
}
