import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CATALOG, type HardwareProfile } from '@keeta-compute/protocol';
import type { ControlClient } from '@keeta-compute/protocol/client';
import type { MlxRuntime } from '@keeta-compute/runtime-mlx';
import { ModelManager, Provider, hashDirectory, weightsHashFrom, type ProviderState, type ProviderStore } from '../src/index.ts';

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
