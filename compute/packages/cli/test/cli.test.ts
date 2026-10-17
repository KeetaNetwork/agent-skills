import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from '@keeta-compute/agent';
import { Account } from '@keeta-compute/protocol/keeta';
import { hashDirectory } from '@keeta-compute/provider';
import { addHelperModel, parseAccess, run, type CliIO } from '../src/index.ts';

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

test('run stops with an error when another program holds the local endpoint port', async (t) => {
	const dir = tempDir(t);
	const squatter = createServer();
	await new Promise<void>((resolve) => squatter.listen(0, '127.0.0.1', resolve));
	t.after(() => squatter.close());
	const io: CliIO = {
		out: () => undefined,
		log: () => undefined,
		passphrase: async () => '',
		recoveryPhrase: async () => '',
		app: {
			buyerPort: (squatter.address() as AddressInfo).port,
			hardware: { os: 'linux', osVersion: 'test', chip: 'test', memoryBytes: 128 * 1024 ** 3, freeDiskBytes: 1024 ** 4 },
			/* Nothing else is reachable; the node only gets as far as opening its endpoint. */
			fetchImpl: (async () => {
				throw new TypeError('fetch failed');
			}) as typeof fetch,
			ledgerFor: () => ({ balances: async () => ({ kta: 0n, tokens: {} }), send: async () => '', received: async () => [], requestTestFunds: async () => '' }),
			localConditions: async () => ({ onBattery: false, idleSeconds: 1e9 })
		}
	};
	/* A node that comes up anyway is stopped, so the test fails instead of running on. */
	const started = run({ dataDir: dir }, io).then((app) => app.shutdown());
	await assert.rejects(started, /another program is listening on 127\.0\.0\.1/);
});
