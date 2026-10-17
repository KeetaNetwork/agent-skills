import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
	/* A stand-in for the venv's python: answers /v1/models on a port it binds itself (port 0), and reports that port on fd 3. */
	mkdirSync(join(dir, 'runtime', 'venv', 'bin'), { recursive: true });
	writeFileSync(
		runtime.python,
		`#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] !== '-c' || !args[1].includes('from mlx_lm.server import main') || args[args.indexOf('--host') + 1] !== '127.0.0.1' || args[args.indexOf('--port') + 1] !== '0') process.exit(2);
const server = require('node:http').createServer((req, res) => res.end(JSON.stringify({ data: [{ id: args[args.indexOf('--model') + 1] }] })));
server.listen(0, '127.0.0.1', () => require('node:fs').writeSync(3, server.address().port + '\\n'));
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

test('the model server binds a port of its own, so no other local account can take it first, and reports it on a private pipe', { skip: spawnSync('python3', ['--version']).status === 0 ? false : 'no python3' }, async (t) => {
	const dir = tempDir(t);
	const runtime = new MlxRuntime(dir, () => undefined);
	/* The venv's python, with mlx_lm.server standing in for the real one: it binds the way mlx-lm 0.32 does, and only on port 0. */
	const fake = join(dir, 'fake', 'mlx_lm');
	mkdirSync(fake, { recursive: true });
	writeFileSync(join(fake, '__init__.py'), '');
	writeFileSync(
		join(fake, 'server.py'),
		`import argparse, json, socket, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
def main():
    parser = argparse.ArgumentParser()
    for name in ('--model', '--host', '--port'):
        parser.add_argument(name)
    args = parser.parse_args()
    if args.port != '0' or args.model == '/models/broken':
        sys.exit(1)
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.end_headers()
            self.wfile.write(json.dumps({'data': [{'id': args.model}]}).encode())
        def log_message(self, *args):
            pass
    infos = socket.getaddrinfo(args.host, int(args.port), type=socket.SOCK_STREAM, flags=socket.AI_PASSIVE)
    ThreadingHTTPServer.address_family, _, _, _, address = next(iter(infos))
    ThreadingHTTPServer(address, Handler).serve_forever()
`
	);
	mkdirSync(join(dir, 'runtime', 'venv', 'bin'), { recursive: true });
	writeFileSync(runtime.python, `#!/bin/sh\nPYTHONPATH='${join(dir, 'fake')}' exec python3 "$@"\n`);
	chmodSync(runtime.python, 0o755);
	t.after(() => runtime.stopAll());

	const backend = await runtime.start('qwen3-8b', '/models/qwen3-8b');
	const models = (await (await fetch(`${backend.baseUrl}/models`)).json()) as { data: Array<{ id: string }> };
	assert.equal(models.data[0]!.id, '/models/qwen3-8b', 'the backend is the server the runtime started, on the port it bound');
	await assert.rejects(runtime.start('broken', '/models/broken'), /exited before it was listening/);
	assert.equal(runtime.isRunning('broken'), false);
});
