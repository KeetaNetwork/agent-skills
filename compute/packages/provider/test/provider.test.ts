import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CATALOG, defaultAsset, type HardwareProfile, type JobEnvelope, type ProviderFrame } from '@keeta-compute/protocol';
import type { ControlClient } from '@keeta-compute/protocol/client';
import type { MlxRuntime } from '@keeta-compute/runtime-mlx';
import { PromptCounter, promptTokenLimit, type PromptCount } from '@keeta-compute/tokens';
import { byteTokenizerFiles } from '@keeta-compute/tokens/testing';
import { ModelManager, Provider, downloadRepo, hashDirectory, weightsHashFrom, type ProviderState, type ProviderStore } from '../src/index.ts';

function tempDir(t: { after: (fn: () => void) => void }): string {
	const dir = mkdtempSync(join(tmpdir(), 'kc-provider-'));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

/** The provider's saved state, kept in memory: the agent's StateStore keeps the same fields in a file. */
function memoryStore(network: ProviderState['network'] = 'test'): ProviderStore & { state: ProviderState } {
	const state: ProviderState = {
		network,
		machineName: 'Studio',
		provider: { enabled: false, schedule: { mode: 'always', startHour: 22, endHour: 8, idleMinutes: 10 }, pauseOnBattery: true, maxConcurrentJobs: 1, access: { mode: 'public', allow: [] } },
		models: [],
		jobs: [],
		tokensByDay: {}
	};
	return { state, update: (mutate) => mutate(state) };
}

const sha = (text: string) => Buffer.from(text).toString('hex').padEnd(64, '0').slice(0, 64);

test('a weights hash covers every file name and content, in any order, and skips partial downloads', async (t) => {
	const dir = tempDir(t);
	mkdirSync(join(dir, 'sub'));
	writeFileSync(join(dir, 'config.json'), '{}');
	writeFileSync(join(dir, 'sub', 'model.safetensors'), 'weights');
	const first = await hashDirectory(dir);
	assert.equal(first.sizeBytes, 9);
	writeFileSync(join(dir, 'model.safetensors.partial'), 'half');
	assert.deepEqual(await hashDirectory(dir), first, 'a .partial file is not part of the model');
	writeFileSync(join(dir, 'sub', 'model.safetensors'), 'weighs');
	assert.notEqual((await hashDirectory(dir)).weightsHash, first.weightsHash, 'changed contents change the hash');
	assert.equal(weightsHashFrom([['b', sha('2')], ['a', sha('1')]]), weightsHashFrom([['a', sha('1')], ['b', sha('2')]]));
	assert.notEqual(weightsHashFrom([['a', sha('1')]]), weightsHashFrom([['c', sha('1')]]), 'a renamed file changes the hash');
});

test('an install leaves the model directory holding exactly the files its weights hash covers', async (t) => {
	const dir = tempDir(t);
	const repo: Record<string, string> = { 'config.json': '{}', 'model-00001-of-00002.safetensors': 'first half', 'model-00002-of-00002.safetensors': 'second half' };
	const fetched: string[] = [];
	const fetchImpl = (async (url: string) => {
		if (url.includes('/api/models/')) {
			const lfs = (text: string) => ({ lfs: { oid: createHash('sha256').update(text).digest('hex'), size: text.length } });
			return Response.json(Object.entries(repo).map(([path, text]) => ({ type: 'file', path, size: text.length, ...(path.endsWith('.safetensors') ? lfs(text) : {}) })));
		}
		const path = decodeURIComponent(url.split('/resolve/main/')[1]!);
		fetched.push(path);
		return new Response(repo[path]);
	}) as typeof fetch;
	/* An interrupted install of another revision, laid out in three shards, and a finished shard of this one. */
	mkdirSync(join(dir, 'sub'));
	writeFileSync(join(dir, 'model-00001-of-00003.safetensors'), 'stale');
	writeFileSync(join(dir, 'model-00003-of-00003.safetensors'), 'stale');
	writeFileSync(join(dir, 'model-00002-of-00002.safetensors.partial'), 'sec');
	writeFileSync(join(dir, 'sub', 'extra.json'), '{}');
	writeFileSync(join(dir, 'model-00001-of-00002.safetensors'), 'first half');

	const { weightsHash } = await downloadRepo('owner/model', 'main', dir, { signal: new AbortController().signal, onProgress: () => undefined, fetchImpl });
	assert.deepEqual(fetched.sort(), ['config.json', 'model-00002-of-00002.safetensors'], 'a finished shard is not downloaded again');
	assert.deepEqual(readdirSync(dir, { recursive: true }).sort(), ['config.json', 'model-00001-of-00002.safetensors', 'model-00002-of-00002.safetensors', 'sub']);
	assert.equal((await hashDirectory(dir)).weightsHash, weightsHash);
});

test('the model manager keeps installed models and offers in the saved state', (t) => {
	const dir = tempDir(t);
	const store = memoryStore();
	const models = new ModelManager(store, dir, null, () => undefined);
	const price = { inputPerMillion: '50000', outputPerMillion: '200000' };
	models.addExternal({ modelId: 'my-model', name: 'Mine', backend: { baseUrl: 'http://127.0.0.1:8000/v1', servedName: 'mine' }, weightsHash: 'a'.repeat(64), sizeBytes: 1, path: '/dev/null', contextLength: 4096, price });
	assert.deepEqual(store.state.models.map((m) => [m.modelId, m.custom, m.offer.offered]), [['my-model', true, true]]);
	const custom = models.list(null).find((entry) => entry.model.id === 'my-model');
	assert.equal(custom?.model.runtime, 'openai-compatible', 'a model on a local server is listed as one');
	models.setOffer('my-model', false);
	assert.equal(store.state.models[0]!.offer.offered, false);
	assert.equal(models.remove('my-model'), true);
	assert.deepEqual(store.state.models, []);
	assert.throws(() => models.setOffer('my-model', true), /not installed/);
});

test('the main network refuses catalog models whose weights are not pinned', { skip: CATALOG.every((m) => m.weightsHash) ? 'every catalog model is pinned' : false }, (t) => {
	const unpinned = CATALOG.find((m) => !m.weightsHash)!;
	const models = new ModelManager(memoryStore('main'), tempDir(t), null, () => undefined);
	assert.throws(() => models.install(unpinned, null), /no pinned weights hash/);
});

test('idle-only sharing stops advertising and taking jobs once the operator is back, and lets a running job finish', async () => {
	const store = memoryStore();
	const model = CATALOG.find((m) => m.id === 'llama-3.2-3b-instruct')!;
	store.state.provider = { ...store.state.provider, enabled: true, schedule: { mode: 'idle', idleMinutes: 10 } };
	store.state.models = [{ modelId: model.id, name: model.name, path: '/models/llama', weightsHash: 'a'.repeat(64), sizeBytes: 1, installedAt: 0, custom: false, offer: { offered: true, price: model.suggestedPrice, access: null } }];
	let idleSeconds = 3600;
	const heartbeats: Array<{ status: string }> = [];
	const control = {
		get: async () => ({ coordinatorKey: 'keeta_coordinator' }),
		post: async (_signer: unknown, path: string, body: { status: string }) => {
			if (path === '/v1/providers/heartbeat') {
				heartbeats.push(body);
			}
			return { eligible: true, status: body.status, relayUrl: 'ws://127.0.0.1:1', relayToken: 'token', relayTokenExpiresAt: Date.now() + 60_000 };
		}
	} as unknown as ControlClient;
	const stopped: string[] = [];
	const runtime = { start: async () => ({ baseUrl: 'http://127.0.0.1:1/v1', servedName: model.id }), stop: (modelId: string) => stopped.push(modelId), runtimeBuild: async () => 'test' } as unknown as MlxRuntime;
	/* A relay socket that never opens: this test is about what the heartbeat advertises. */
	class Socket {
		readyState = 0;
		addEventListener() {}
		close() {}
	}
	const hardware: HardwareProfile = { os: 'macos', osVersion: '15.4', chip: 'Apple M4 Max', memoryBytes: 64 * 2 ** 30, freeDiskBytes: 500 * 2 ** 30 };
	const provider = new Provider({
		store,
		control,
		node: { publicKey: 'keeta_node', sign: async () => 'signature' },
		verify: () => true,
		models: new ModelManager(store, '/models', null, () => undefined),
		runtime,
		kind: 'mac',
		hardware: () => hardware,
		registration: () => ({}),
		log: () => undefined,
		onJob: () => undefined,
		onChange: () => undefined,
		WebSocketImpl: Socket as unknown as typeof WebSocket,
		localConditions: async () => ({ onBattery: false, idleSeconds })
	});
	const internals = provider as unknown as { beat(): Promise<void>; active: Map<string, AbortController> };

	await internals.beat();
	assert.equal(heartbeats.at(-1)!.status, 'online', 'the Mac is idle, so it is offered');

	/* A job is running when the operator comes back. */
	const running = new AbortController();
	internals.active.set('job_running', running);
	idleSeconds = 5;
	await internals.beat();
	assert.equal(heartbeats.at(-1)!.status, 'paused', 'the running job does not keep the Mac advertised');
	assert.equal(provider.status.state, 'outside-schedule', 'so new tickets are refused');
	assert.equal(running.signal.aborted, false, 'the running job is not stopped');
	assert.deepEqual(stopped, [], 'and its model server stays up');

	internals.active.delete('job_running');
	await internals.beat();
	assert.deepEqual(stopped, [model.id], 'the model server stops once the job is done');
});

test('a router job is accepted and holds its slot, and runs only once the router starts it after settling the payment', async (t) => {
	/* An OpenAI-compatible model server that counts the requests it is asked to run. */
	let runs = 0;
	const server = createServer((req, res) => {
		runs++;
		req.resume();
		res.writeHead(200, { 'content-type': 'text/event-stream' });
		res.write(`data: ${JSON.stringify({ id: 'c1', created: 1, choices: [{ index: 0, delta: { content: 'Hi' }, finish_reason: 'stop' }] })}\n\n`);
		res.end(`data: ${JSON.stringify({ id: 'c1', created: 1, choices: [], usage: { prompt_tokens: 4, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`);
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	t.after(() => server.close());
	const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;

	const store = memoryStore();
	store.state.provider = { ...store.state.provider, enabled: true };
	const models = new ModelManager(store, tempDir(t), null, () => undefined);
	const price = { inputPerMillion: '50000', outputPerMillion: '200000' };
	models.addExternal({ modelId: 'my-model', name: 'Mine', backend: { baseUrl, servedName: 'mine' }, weightsHash: 'a'.repeat(64), sizeBytes: 1, path: '/dev/null', contextLength: 4096, price });
	const control = {
		get: async () => ({ coordinatorKey: 'keeta_coordinator' }),
		post: async () => ({ eligible: true, status: 'online', relayUrl: 'ws://127.0.0.1:1', relayToken: 'token', relayTokenExpiresAt: Date.now() + 60_000 })
	} as unknown as ControlClient;
	const sent: ProviderFrame[] = [];
	/* An open relay socket that records what the provider sends. */
	class Socket {
		readyState = 1;
		addEventListener() {}
		close() {}
		send(raw: string) {
			sent.push(JSON.parse(raw) as ProviderFrame);
		}
	}
	const node = { publicKey: 'keeta_node', sign: async () => 'signature' };
	const provider = new Provider({
		store,
		control,
		node,
		verify: () => true,
		models,
		runtime: null,
		kind: 'linux',
		hardware: () => ({ os: 'linux', osVersion: '6.8', chip: 'x86_64', memoryBytes: 64 * 2 ** 30, freeDiskBytes: 500 * 2 ** 30 }),
		registration: () => ({}),
		log: () => undefined,
		onJob: () => undefined,
		onChange: () => undefined,
		WebSocketImpl: Socket as unknown as typeof WebSocket,
		localConditions: async () => ({ onBattery: false, idleSeconds: 1e9 })
	});
	const internals = provider as unknown as { beat(): Promise<void>; onFrame(raw: string): Promise<void>; active: Map<string, AbortController> };
	await internals.beat();
	assert.equal(provider.status.state, 'online');

	const envelope = (jobId: string): JobEnvelope => ({
		ticket: {
			ticket: { v: 1, jobId, network: 'test', nodeKey: node.publicKey, modelId: 'my-model', buyer: 'keeta_coordinator', maxInputTokens: 1000, maxOutputTokens: 16, price, asset: defaultAsset('test').address, payTo: 'keeta_operator', paymentMode: 'prepaid', prepaidAmount: '1', issuedAt: Date.now(), expiresAt: Date.now() + 60_000 },
			coordinatorSig: 'signature',
			relayMac: 'mac'
		},
		request: { model: 'my-model', messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 }
	});
	const framesFor = (id: string) => sent.filter((f) => 'id' in f && f.id === id).map((f) => f.type);
	const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

	const job = internals.onFrame(JSON.stringify({ type: 'job', id: 'run_1', envelope: envelope('job_1') }));
	await settle();
	assert.deepEqual(framesFor('run_1'), ['accepted'], 'accepted, and nothing else yet');
	assert.equal(runs, 0, 'the model has not been asked to run');
	assert.equal(internals.active.size, 1, 'the job holds its slot while the payment settles');
	await internals.onFrame(JSON.stringify({ type: 'start', id: 'run_1' }));
	await job;
	assert.equal(runs, 1);
	assert.deepEqual(framesFor('run_1'), ['accepted', 'chunk', 'chunk', 'receipt']);

	/* A payment that never settles: the router cancels, and the slot is freed with nothing run. */
	const cancelled = internals.onFrame(JSON.stringify({ type: 'job', id: 'run_2', envelope: envelope('job_2') }));
	await settle();
	await internals.onFrame(JSON.stringify({ type: 'cancel', id: 'run_2' }));
	await cancelled;
	assert.deepEqual(framesFor('run_2'), ['accepted']);
	assert.equal(runs, 1);
	assert.equal(internals.active.size, 0);
});

test('a prompt far larger than its ticket, or a job with no free slot, is refused before the prompt is counted', async (t) => {
	const store = memoryStore();
	store.state.provider = { ...store.state.provider, enabled: true };
	const models = new ModelManager(store, tempDir(t), null, () => undefined);
	const price = { inputPerMillion: '50000', outputPerMillion: '200000' };
	models.addExternal({ modelId: 'my-model', name: 'Mine', backend: { baseUrl: 'http://127.0.0.1:1/v1', servedName: 'mine' }, weightsHash: 'a'.repeat(64), sizeBytes: 1, path: '/dev/null', contextLength: 262_144, price });
	const control = {
		get: async () => ({ coordinatorKey: 'keeta_coordinator' }),
		post: async () => ({ eligible: true, status: 'online', relayUrl: 'ws://127.0.0.1:1', relayToken: 'token', relayTokenExpiresAt: Date.now() + 60_000 })
	} as unknown as ControlClient;
	class Socket {
		readyState = 1;
		addEventListener() {}
		close() {}
		send() {}
	}
	/* A pinned tokenizer renders and encodes the whole prompt, in time set by its size; record each prompt it is given. */
	const tokenizer = new PromptCounter(byteTokenizerFiles());
	let counted = 0;
	const countPrompt: PromptCount = async (_modelId, request) => {
		counted++;
		return tokenizer.count(request);
	};
	const node = { publicKey: 'keeta_node', sign: async () => 'signature' };
	const provider = new Provider({
		store,
		control,
		node,
		verify: () => true,
		models,
		runtime: null,
		kind: 'linux',
		hardware: () => ({ os: 'linux', osVersion: '6.8', chip: 'x86_64', memoryBytes: 64 * 2 ** 30, freeDiskBytes: 500 * 2 ** 30 }),
		registration: () => ({}),
		log: () => undefined,
		onJob: () => undefined,
		onChange: () => undefined,
		WebSocketImpl: Socket as unknown as typeof WebSocket,
		localConditions: async () => ({ onBattery: false, idleSeconds: 1e9 }),
		countPrompt
	});
	const internals = provider as unknown as { beat(): Promise<void>; active: Map<string, AbortController> };
	await internals.beat();
	assert.equal(provider.status.state, 'online');

	const envelope = (content: string, maxInputTokens: number): JobEnvelope => ({
		ticket: {
			ticket: { v: 1, jobId: 'job_1', network: 'test', nodeKey: node.publicKey, modelId: 'my-model', buyer: 'keeta_coordinator', maxInputTokens, maxOutputTokens: 16, price, asset: defaultAsset('test').address, payTo: 'keeta_operator', paymentMode: 'prepaid', prepaidAmount: '1', issuedAt: Date.now(), expiresAt: Date.now() + 60_000 },
			coordinatorSig: 'signature',
			relayMac: 'mac'
		},
		request: { model: 'my-model', messages: [{ role: 'user', content }], max_tokens: 16 }
	});
	const tooLarge = { code: 'invalid_request', error: 'the prompt is larger than the ticket allows' };

	/* A one-token ticket carrying a megabyte of prompt: refused without rendering or encoding it. */
	assert.deepEqual(await provider.checkJob(envelope('x'.repeat(2 ** 20), 1)), tooLarge);
	assert.equal(counted, 0);

	/* Honest tickets are counted and checked exactly, from a short prompt to one of a hundred thousand tokens in a dense script. */
	for (const content of ['hello', '漢字'.repeat(20_000)]) {
		const exact = tokenizer.count(envelope(content, 0).request)!;
		const fits = await provider.checkJob(envelope(content, promptTokenLimit(exact)));
		assert.ok(!('error' in fits) && fits.promptTokens === exact);
		assert.deepEqual(await provider.checkJob(envelope(content, exact - 1)), tooLarge, 'a ticket below the count is still refused once counted');
	}
	assert.equal(counted, 4);

	/* No free slot: refused before anything is counted. */
	internals.active.set('run_other', new AbortController());
	assert.deepEqual(await provider.checkJob(envelope('hello', 1_000)), { code: 'busy', error: 'provider is not taking jobs right now' });
	assert.equal(counted, 4);
});
