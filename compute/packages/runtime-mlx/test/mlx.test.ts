import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MLX_LM_VERSION, MLX_REQUIREMENTS_LOCK, MlxRuntime } from '../src/index.ts';

function tempDir(t: { after: (fn: () => void) => void }): string {
	const dir = mkdtempSync(join(tmpdir(), 'kc-mlx-'));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

test('the requirements lock pins mlx-lm at MLX_LM_VERSION, and every requirement carries a hash', () => {
	const requirements = MLX_REQUIREMENTS_LOCK.split('\n').filter((line) => /^[a-z0-9]/i.test(line));
	assert.ok(requirements.length > 5);
	assert.ok(requirements.includes(`mlx-lm==${MLX_LM_VERSION} \\`), `mlx-lm ${MLX_LM_VERSION} is in the lock`);
	for (const requirement of requirements) {
		assert.match(requirement, /^[A-Za-z0-9_.-]+(\[[^\]]+\])?==[^ ]+ \\$/, `${requirement} is pinned to one version`);
	}
	const entries = MLX_REQUIREMENTS_LOCK.split(/\n(?=[A-Za-z0-9])/);
	for (const entry of entries.filter((e) => e.trim())) {
		assert.match(entry, /--hash=sha256:[0-9a-f]{64}/, `${entry.split(' ')[0]} has a hash`);
	}
});

test('the runtime installs only on Apple Silicon Macs', { skip: process.platform === 'darwin' && process.arch === 'arm64' ? 'this is an Apple Silicon Mac' : false }, async (t) => {
	const runtime = new MlxRuntime(tempDir(t), () => undefined);
	assert.equal(runtime.isInstalled(), false);
	await assert.rejects(runtime.ensureInstalled(() => undefined), /Apple Silicon/);
});

test('a model server starts on 127.0.0.1 from the private environment, is reused while running, and stops', async (t) => {
	const dir = tempDir(t);
	const runtime = new MlxRuntime(dir, () => undefined);
	/* A stand-in for the venv's python: answers /v1/models on the --port it is given, as mlx_lm.server does. */
	mkdirSync(join(dir, 'runtime', 'venv', 'bin'), { recursive: true });
	writeFileSync(
		runtime.python,
		`#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.join(' ').indexOf('-m mlx_lm.server --model') !== 0 || args[args.indexOf('--host') + 1] !== '127.0.0.1') process.exit(2);
require('node:http').createServer((req, res) => res.end(JSON.stringify({ data: [{ id: args[args.indexOf('--model') + 1] }] }))).listen(Number(args[args.indexOf('--port') + 1]), '127.0.0.1');
`
	);
	chmodSync(runtime.python, 0o755);
	assert.equal(runtime.isInstalled(), true);
	t.after(() => runtime.stopAll());

	const backend = await runtime.start('qwen3-8b', '/models/qwen3-8b');
	assert.match(backend.baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
	assert.equal(backend.servedName, '/models/qwen3-8b');
	const models = (await (await fetch(`${backend.baseUrl}/models`)).json()) as { data: Array<{ id: string }> };
	assert.equal(models.data[0]!.id, '/models/qwen3-8b');
	assert.deepEqual(await runtime.start('qwen3-8b', '/models/qwen3-8b'), backend, 'a running server is reused');
	assert.equal(runtime.isRunning('qwen3-8b'), true);
	runtime.stop('qwen3-8b');
	assert.equal(runtime.isRunning('qwen3-8b'), false);
});
