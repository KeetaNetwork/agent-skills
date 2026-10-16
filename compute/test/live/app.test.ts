/**
 * Live: the app flow with everything real except the model. A buyer agent
 * (the Mac app's local endpoint) runs jobs through the relay Worker on a
 * Mac provider and on a Linux node driven by the real CLI, pays each receipt
 * with a send on the Keeta test network, and the control plane marks a job
 * paid only once it finds that send on the ledger.
 *
 * The in-process e2e test owns the agent and control logic with a fake
 * ledger and an emulated relay; this file owns what only the network shows.
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spendAccount } from '../../agent/src/keys.ts';
import { Scratch, macAgent, until } from '../support/harness.ts';
import { Funder, NETWORK, announceSkip, skipLive } from './support.ts';
import { fundAppBuyer, watchSettlement } from './payments.ts';
import { MODEL, startStack, type Stack } from './stack.ts';

announceSkip();

const COMPUTE = fileURLToPath(new URL('../..', import.meta.url));
const CLI = join(COMPUTE, 'agent', 'src', 'main.ts');
const LINUX_PASSPHRASE = 'live linux node passphrase';

const scratch = new Scratch();
let funder: Funder;
let stack: Stack;
let buyer: ReturnType<typeof macAgent>;
let endpoint: { url: string; token: string };
const linux = { dir: '', operator: '', nodeKey: '' };

/** Run one CLI command the way an operator types it; resolves to its output. */
function cli(args: string[], options: { keep?: boolean } = {}): { child: ChildProcess; done: Promise<string> } {
	const child = spawn(process.execPath, ['--import', 'tsx', CLI, ...args, '--data-dir', linux.dir], {
		cwd: COMPUTE,
		env: { ...process.env, KEETA_COMPUTE_PASSPHRASE: LINUX_PASSPHRASE },
		stdio: ['ignore', 'pipe', 'pipe']
	});
	let output = '';
	child.stdout!.on('data', (chunk: Buffer) => (output += chunk.toString()));
	child.stderr!.on('data', (chunk: Buffer) => {
		output += chunk.toString();
		if (process.env.KC_TEST_LOG) {
			process.stderr.write(`[cli] ${chunk.toString()}`);
		}
	});
	const done = new Promise<string>((resolve, reject) =>
		child.on('exit', (code, signal) => (code === 0 || (options.keep && signal) ? resolve(output) : reject(new Error(`keeta-compute-agent ${args[0]} exited with ${code ?? signal}:\n${output}`))))
	);
	return { child, done };
}

before(async () => {
	if (skipLive) {
		return;
	}
	funder = await Funder.open();
	stack = await startStack(scratch);

	/* Linux node: init (its own wallet), add the model, turn providing on, run. */
	linux.dir = scratch.dir('linux-node');
	const init = await cli(['init', '--network', NETWORK, '--control', stack.control.url, '--relay', stack.worker.url, '--name', 'live-linux']).done;
	const earns = /Node key (keeta_[a-z0-9]+) now earns for (keeta_[a-z0-9]+)/.exec(init);
	assert.ok(earns, init);
	[, linux.nodeKey, linux.operator] = earns as unknown as [string, string, string];
	const weights = scratch.dir('weights');
	mkdirSync(join(weights, 'shards'));
	writeFileSync(join(weights, 'shards', 'model.safetensors'), 'weights');
	await cli(['models', 'add', '--id', MODEL, '--url', stack.model.baseUrl, '--served-name', stack.model.servedName, '--weights', weights, '--price-in', '1', '--price-out', '4']).done;
	await cli(['provide', '--on']).done;
	const running = cli(['run'], { keep: true });
	scratch.defer(() => running.child.kill('SIGTERM'));
	await until('the Linux node to come online through the relay Worker', async () => (await stack.control.store.getProvider(linux.nodeKey))?.status === 'online', 90_000, 500).catch(async (error: Error) => {
		running.child.kill('SIGTERM');
		throw new Error(`${error.message}\n--- node output ---\n${await running.done.catch((e: Error) => e.message)}`);
	});

	/* Buyer: the Mac app's local endpoint, paying from its budget key. */
	const buyerDir = scratch.dir('mac-buyer');
	buyer = macAgent(buyerDir);
	scratch.defer(() => buyer.app.shutdown());
	await buyer.rpc['agent.initialize']!({ network: NETWORK, controlUrl: stack.control.url, relayUrl: stack.worker.url, nodePublicKey: buyer.nodePublicKey, appVersion: 'live', machineName: 'Live Laptop' });
	const spend = ((await buyer.rpc['wallet.refresh']!({})) as { spend: string }).spend;
	/* The budget key lives in the buyer's data directory; track it so the sweep returns what is left. */
	assert.equal(funder.track(spendAccount(buyerDir, NETWORK)).publicKeyString.get(), spend);
	await fundAppBuyer(funder, spend);
	const status = (await buyer.rpc['buyer.status']!({})) as { endpoint: string; token: string };
	endpoint = { url: status.endpoint, token: status.token };
});

after(async () => {
	await scratch.cleanup();
	await funder?.sweep();
});

async function complete(content: string, options: { stream?: boolean; signal?: AbortSignal } = {}) {
	return fetch(`${endpoint.url}/chat/completions`, {
		method: 'POST',
		headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
		body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content }], max_tokens: 64, ...(options.stream ? { stream: true } : {}) }),
		...(options.signal ? { signal: options.signal } : {})
	});
}

/** Serve one job on `nodeKey` and check it was paid on the ledger to `operator`. */
async function servedAndPaid(nodeKey: string, operator: string) {
	await buyer.rpc['buyer.setPolicy']!({ allowedProviders: [nodeKey] });
	const settled = await watchSettlement(stack, funder, operator);
	const response = await complete('Say hello');
	const body = (await response.json()) as { choices: Array<{ message: { content: string } }> };
	assert.equal(response.status, 200, JSON.stringify(body));
	if (stack.model.fake) {
		assert.equal(body.choices[0]!.message.content, 'Hello from Keeta');
	} else {
		assert.ok(body.choices[0]!.message.content.length > 0);
	}
	const job = await settled(response.headers.get('x-keeta-job')!);
	assert.equal(job.nodeKey, nodeKey);
	assert.equal(job.delivery?.outputHash, job.receipt!.receipt.outputHash, 'the relay recorded the text it forwarded');
}

test('a Mac provider serves the buyer agent through the relay Worker and is paid on the ledger', { skip: skipLive, timeout: 300_000 }, async () => {
	await servedAndPaid(stack.mac.nodeKey, stack.mac.operator);
});

test('a Linux CLI node serves the buyer agent through the relay Worker and is paid to its own operator', { skip: skipLive, timeout: 300_000 }, async () => {
	assert.notEqual(linux.operator, stack.mac.operator);
	assert.equal((await stack.control.store.getProvider(linux.nodeKey))?.kind, 'linux');
	await servedAndPaid(linux.nodeKey, linux.operator);
});

test('a buyer that hangs up mid-answer pays on the ledger for the text the relay attests it forwarded', { skip: skipLive, timeout: 300_000 }, async () => {
	await buyer.rpc['buyer.setPolicy']!({ allowedProviders: [stack.mac.nodeKey] });
	const settled = await watchSettlement(stack, funder, stack.mac.operator);
	const hangUp = new AbortController();
	/* The fake model stalls after each piece when asked to answer slowly; a real one is asked for a long answer. */
	const response = await complete(stack.model.fake ? 'Say hello slowly' : 'Count from one to two hundred in words.', { stream: true, signal: hangUp.signal });
	assert.equal(response.status, 200);
	const jobId = response.headers.get('x-keeta-job')!;
	const reader = response.body!.getReader();
	let seen = '';
	while (!/"content":"[^"]/.test(seen)) {
		const { value, done } = await reader.read();
		assert.ok(!done, 'the stream ended before any text');
		seen += new TextDecoder().decode(value);
	}
	hangUp.abort();

	const job = await settled(jobId, 180_000);
	assert.equal(job.receipt!.receipt.outputHash, job.delivery?.outputHash, 'the bill matches the relay record');
});
