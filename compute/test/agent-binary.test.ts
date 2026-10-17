/**
 * The compiled keeta-compute-agent in app mode, driven over its stdin and
 * stdout the way the macOS app drives it: agent.state, then agent.initialize
 * (answering the agent's signer.signDigest calls with a P-256 key, as the
 * Secure Enclave does), then agent.shutdown, after which it must exit 0.
 *
 * The other suites run the agent's TypeScript under Node; this one runs what
 * bun compiled, so a runtime gap (bun before 1.3.14 had no SHA3-256 HMAC, and
 * the app's first call never answered) fails here and not in the app. CI
 * builds the binary with the bun pinned in package.json:
 *
 *   npm run build:linux-x64 -w @keeta-compute/cli
 *   KEETA_COMPUTE_AGENT_BINARY=packages/cli/dist/linux-x64/keeta-compute-agent npm run test:agent-binary
 *
 * Nothing leaves this machine: the control plane and relay point at a closed local port.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { p256 } from '@noble/curves/p256';
import { RpcPeer } from '@keeta-compute/agent';
import { fromHex, toHex } from '@keeta-compute/protocol';
import type { AgentState } from '@keeta-compute/protocol/rpc';
import { Scratch } from './support/harness.ts';

const binary = process.env.KEETA_COMPUTE_AGENT_BINARY;

test('the compiled agent answers the app over stdio', { skip: binary ? false : 'set KEETA_COMPUTE_AGENT_BINARY to a compiled keeta-compute-agent' }, async () => {
	const scratch = new Scratch();
	const dataDir = scratch.dir('agent-binary');
	const enclaveKey = p256.utils.randomPrivateKey();
	const child = spawn(resolve(binary!), ['app', '--data-dir', dataDir], { stdio: ['pipe', 'pipe', 'pipe'] });
	const stderr: string[] = [];
	child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk.toString()));
	const exited = once(child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>;
	const signed: string[] = [];
	const app = new RpcPeer(child.stdout, child.stdin, {
		'signer.signDigest': async (params) => {
			const { digest } = params as { digest: string };
			signed.push(digest);
			return { signature: toHex(p256.sign(fromHex(digest), enclaveKey, { prehash: false, lowS: true }).toCompactRawBytes()) };
		}
	});
	try {
		const before = await app.request<AgentState>('agent.state', {}, 20_000);
		assert.equal(before.nodeKey, null);

		const state = await app.request<AgentState>(
			'agent.initialize',
			{
				network: 'test',
				controlUrl: 'http://127.0.0.1:9',
				relayUrl: 'http://127.0.0.1:9',
				nodePublicKey: toHex(p256.getPublicKey(enclaveKey, true)),
				appVersion: 'binary-test',
				machineName: 'binary-test'
			},
			20_000
		);
		assert.match(state.nodeKey ?? '', /^keeta_/);
		assert.equal(state.network, 'test');

		assert.deepEqual(await app.request('agent.shutdown', {}, 5_000), { ok: true });
		const [code, signal] = await exited;
		assert.deepEqual({ code, signal }, { code: 0, signal: null });
	} catch (error) {
		child.kill('SIGKILL');
		throw new Error(`${(error as Error).message}\nagent stderr:\n${stderr.join('')}`);
	} finally {
		await scratch.cleanup();
	}
});
