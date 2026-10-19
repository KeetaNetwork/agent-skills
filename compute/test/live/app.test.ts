/**
 * Live: the app flow with everything real except the model. A buyer agent
 * (the Mac app's local endpoint) buys Keeta Compute Credits with test USDC
 * through the FX service, runs jobs through the relay Worker on a Mac
 * provider and on a Linux node driven by the real CLI, and escrows each
 * job's maximum cost with the settlement account on the Keeta test network
 * before its ticket. The relay's delivery record settles each job in one
 * payout block, and the provider cashes its credits out to USDC.
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
import { operatorAccount, spendAccount, unlockWallet } from '@keeta-compute/wallet';
import { toHex } from '@keeta-compute/protocol';
import { Scratch, macAgent, passkeyEntropy, until } from '../support/harness.ts';
import { Funder, NETWORK, USDC, announceSkip, skipLive } from './support.ts';
import { fundAppBuyer, watchSettlement, type AppBuyer } from './payments.ts';
import { MODEL, startStack, type Stack } from './stack.ts';

announceSkip();

const COMPUTE = fileURLToPath(new URL('../..', import.meta.url));
const CLI = join(COMPUTE, 'packages', 'cli', 'src', 'main.ts');
const LINUX_PASSPHRASE = 'live linux node passphrase';

const scratch = new Scratch();
let funder: Funder;
let stack: Stack;
let buyer: ReturnType<typeof macAgent>;
let buyerWallet: AppBuyer;
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
	stack = await startStack(scratch, { credits: { funder } });

	/* Linux node: init (its own wallet), add the model, turn providing on, run. */
	linux.dir = scratch.dir('linux-node');
	const init = await cli(['init', '--network', NETWORK, '--control', stack.control.url, '--relay', stack.worker.url, '--name', 'live-linux']).done;
	const earns = /Node key (keeta_[a-z0-9]+) now earns for (keeta_[a-z0-9]+)/.exec(init);
	assert.ok(earns, init);
	[, linux.nodeKey, linux.operator] = earns as unknown as [string, string, string];
	/* Its earnings land on its own operator wallet; the sweep brings them back. */
	const linuxOperator = funder.track(await operatorAccount(toHex(await unlockWallet(linux.dir, LINUX_PASSPHRASE))));
	assert.equal(linuxOperator.publicKeyString.get(), linux.operator);
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

	/* Buyer: the Mac app's local endpoint, escrowing from its budget key credits its operator bought. */
	const buyerDir = scratch.dir('mac-buyer');
	buyer = macAgent(buyerDir);
	scratch.defer(() => buyer.app.shutdown());
	await buyer.rpc['agent.initialize']!({ network: NETWORK, controlUrl: stack.control.url, relayUrl: stack.worker.url, nodePublicKey: buyer.nodePublicKey, appVersion: 'live', machineName: 'Live Laptop' });
	const entropy = passkeyEntropy();
	const { operator } = (await buyer.rpc['wallet.setOperator']!({ entropy })) as { operator: string };
	const spend = ((await buyer.rpc['wallet.refresh']!({})) as { spend: string }).spend;
	/* Both keys can be rebuilt here; track them so the sweep returns what is left. */
	assert.equal(funder.track(spendAccount(buyerDir, NETWORK)).publicKeyString.get(), spend);
	assert.equal(funder.track(await operatorAccount(entropy)).publicKeyString.get(), operator);
	buyerWallet = { rpc: buyer.rpc, entropy, operator, spend };
	await fundAppBuyer(funder, stack, buyerWallet);
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

/** Serve one job on `nodeKey` and check it was paid out on the ledger to `operator`. */
async function servedAndPaid(nodeKey: string, operator: string) {
	await buyer.rpc['buyer.setPolicy']!({ allowedProviders: [nodeKey] });
	const settled = await watchSettlement(stack, funder, operator, buyerWallet.spend);
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

test('a Mac provider serves the buyer agent through the relay Worker and is paid out of the escrow on the ledger', { skip: skipLive, timeout: 300_000 }, async () => {
	await servedAndPaid(stack.mac.nodeKey, stack.mac.operator);
});

test('a Linux CLI node serves the buyer agent through the relay Worker and is paid to its own operator', { skip: skipLive, timeout: 300_000 }, async () => {
	assert.notEqual(linux.operator, stack.mac.operator);
	assert.equal((await stack.control.store.getProvider(linux.nodeKey))?.kind, 'linux');
	await servedAndPaid(linux.nodeKey, linux.operator);
});

test('a buyer that hangs up mid-answer pays from its escrow for the text the relay attests it forwarded, and gets the rest back', { skip: skipLive, timeout: 300_000 }, async () => {
	await buyer.rpc['buyer.setPolicy']!({ allowedProviders: [stack.mac.nodeKey] });
	const settled = await watchSettlement(stack, funder, stack.mac.operator, buyerWallet.spend);
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

test("the Mac provider's earnings are its credits on the ledger, and it cashes them out to USDC through the FX service", { skip: skipLive, timeout: 300_000 }, async () => {
	const { operator, entropy } = stack.mac;
	const token = stack.credits!.token;
	const earned = await funder.balance(operator, token);
	assert.ok(earned > 0n, 'the earlier jobs paid the Mac operator');
	await stack.mac.rpc['wallet.refresh']!({});
	assert.equal((await stack.mac.rpc['provider.status']!({})).earnedTotal, earned.toString(), 'the app reads earnings from the settlement account\'s payouts');
	funder.track(await operatorAccount(entropy));
	await funder.fundKta([operator]);
	const usdcBefore = await funder.balance(operator, 'usdc');
	const priced = await stack.mac.rpc['wallet.creditQuote']!({ side: 'sell', amount: earned.toString(), stablecoin: USDC.symbol });
	const sold = await stack.mac.rpc['wallet.sellCredits']!({ entropy, amount: earned.toString(), to: USDC.symbol, minReceive: priced.limit });
	assert.equal(sold.received, earned.toString(), 'credits cash out to USDC one to one');
	await until('the USDC to reach the operator', async () => (await funder.balance(operator, 'usdc')) >= usdcBefore + earned, 60_000, 1_000);
	assert.equal(await funder.balance(operator, token), 0n);
});
