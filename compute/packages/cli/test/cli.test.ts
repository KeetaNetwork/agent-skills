import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from '@keeta-compute/agent';
import { Account } from '@keeta-compute/protocol/keeta';
import { hashDirectory } from '@keeta-compute/provider';
import { addHelperModel, buy, config, parseAccess, provide, run, token, type CliIO } from '../src/index.ts';

function tempDir(t: { after: (fn: () => void) => void }): string {
	const dir = mkdtempSync(join(tmpdir(), 'kc-cli-'));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

test('CLI access flags become an access policy', () => {
	const key = Account.fromSeed(Account.generateRandomSeed({ asString: true }) as string, 0).publicKeyString.get();
	assert.equal(parseAccess(undefined, undefined), undefined);
	assert.deepEqual(parseAccess('public', undefined), { mode: 'public', allow: [] });
	assert.deepEqual(parseAccess(undefined, ` ${key} ,`), { mode: 'allowlist', allow: [key] });
	assert.throws(() => parseAccess('allowlist', 'not-a-key'));
	assert.throws(() => parseAccess('friends', undefined));
});

test('helpers only serve models from a server on the same machine', async (t) => {
	const dir = tempDir(t);
	const weights = join(dir, 'model.gguf');
	writeFileSync(weights, 'weights');
	const args = { dataDir: dir, id: 'qwen3-8b', servedName: 'qwen', weights };
	await assert.rejects(addHelperModel({ ...args, url: 'http://10.0.0.5:8000/v1' }, { out: () => undefined }), /this machine/);
	await addHelperModel({ ...args, url: 'http://127.0.0.1:8000/v1', priceIn: '0.05', priceOut: '0.2' }, { out: () => undefined });
	const [model] = new StateStore(dir).state.models as Array<{ weightsHash: string; offer: { price: { inputPerMillion: string } } }>;
	assert.equal(model!.weightsHash, (await hashDirectory(weights)).weightsHash);
	assert.equal(model!.offer.price.inputPerMillion, '50000');
});

/* A node with nothing else reachable: requests to the control plane or a tokenizer host fail, and are recorded. */
function offlineIO(buyerPort: number, fetched: string[] = []): CliIO {
	return {
		out: () => undefined,
		log: () => undefined,
		passphrase: async () => '',
		recoveryPhrase: async () => '',
		app: {
			buyerPort,
			hardware: { os: 'linux', osVersion: 'test', chip: 'test', memoryBytes: 128 * 1024 ** 3, freeDiskBytes: 1024 ** 4 },
			fetchImpl: (async (url: string | URL) => {
				fetched.push(String(url));
				throw new TypeError('fetch failed');
			}) as typeof fetch,
			ledgerFor: () => ({ balances: async () => ({ kta: 0n, tokens: {} }), send: async () => '', received: async () => [], requestTestFunds: async () => '' }),
			localConditions: async () => ({ onBattery: false, idleSeconds: 1e9 })
		}
	};
}

test('run stops with an error when another program holds the local endpoint port', async (t) => {
	const dir = tempDir(t);
	const squatter = createServer();
	await new Promise<void>((resolve) => squatter.listen(0, '127.0.0.1', resolve));
	t.after(() => squatter.close());
	/* A node that comes up anyway is stopped, so the test fails instead of running on. */
	const started = run({ dataDir: dir }, offlineIO((squatter.address() as AddressInfo).port)).then((app) => app.shutdown());
	await assert.rejects(started, /another program is listening on 127\.0\.0\.1/);
});

test('settings changed by commands beside a running node apply to it at once, and its own saves keep them', async (t) => {
	const dir = tempDir(t);
	const fetched: string[] = [];
	const io = offlineIO(0, fetched);
	const node = await run({ dataDir: dir }, io);
	t.after(() => node.shutdown());
	const { endpoint, token: first } = node.state().buyer!;
	const models = (bearer: string) => fetch(`${endpoint}/models`, { headers: { authorization: `Bearer ${bearer}` } });

	/* `token --rotate` revokes the old token on the running node and the new one works there. */
	let rotated = '';
	await token({ dataDir: dir, rotate: true }, { ...io, out: (line) => (rotated = line) });
	assert.equal((await models(first)).status, 401);
	assert.notEqual((await models(rotated)).status, 401);

	/* `buy --daily-max 0` refuses the next request. */
	await buy({ dataDir: dir, dailyMax: '0' }, io);
	const refused = await fetch(`${endpoint}/chat/completions`, {
		method: 'POST',
		headers: { authorization: `Bearer ${rotated}`, 'content-type': 'application/json' },
		body: JSON.stringify({ model: 'qwen3-8b', messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 })
	});
	assert.equal(refused.status, 402);

	/* `provide --access allowlist` reaches the running provider. */
	const buyerKey = Account.fromSeed(Account.generateRandomSeed({ asString: true }) as string, 0).publicKeyString.get();
	await provide({ dataDir: dir, access: 'allowlist', allow: buyerKey }, io);
	assert.deepEqual(node.state().provider!.policy.access, { mode: 'allowlist', allow: [buyerKey] });

	/* The node's next save keeps every one of them. */
	node.store.recordJob({ jobId: 'job_1', role: 'buyer', modelId: 'qwen3-8b', counterparty: 'keeta_node', inputTokens: 0, outputTokens: 0, amount: '0', status: 'running', at: 1 });
	const saved = new StateStore(dir).state;
	assert.deepEqual([saved.buyer.token, saved.buyer.dailyMax, saved.provider.access.mode], [rotated, '0', 'allowlist']);

	/* `config --control URL` moves the running node to that control plane. */
	await config({ dataDir: dir, controlUrl: 'http://127.0.0.1:9' }, io);
	node.state();
	for (let i = 0; i < 400 && !fetched.includes('http://127.0.0.1:9/v1/config'); i++) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.ok(fetched.includes('http://127.0.0.1:9/v1/config'), 'the node reconnected to the new control plane');
});
