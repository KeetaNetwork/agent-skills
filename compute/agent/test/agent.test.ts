import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { jobCost, receiptMessage, type Receipt, type SignedTicket } from '@keeta-compute/protocol';
import { Account, accountSigner, verifyKeetaSignature } from '@keeta-compute/protocol/keeta';
import { Buyer } from '../src/buyer.ts';
import { addHelperModel } from '../src/helper.ts';
import { SerialQueue } from '../src/ledger.ts';
import { fileAccount, operatorAccount } from '../src/keys.ts';
import { hashDirectory } from '../src/models/download.ts';
import { RpcPeer } from '../src/rpc/peer.ts';
import { RPC_ERRORS } from '../src/rpc/types.ts';
import { StateStore } from '../src/state.ts';
import type { ControlClient } from '../src/control-client.ts';

function tempDir(t: { after: (fn: () => void) => void }): string {
	const dir = mkdtempSync(join(tmpdir(), 'kc-agent-'));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

test('state and key files are private to the user', (t) => {
	const dir = tempDir(t);
	const store = new StateStore(dir);
	store.save();
	assert.equal(statSync(join(dir, 'state.json')).mode & 0o777, 0o600);
	const first = fileAccount(dir, 'node');
	assert.equal(statSync(join(dir, 'node.seed')).mode & 0o777, 0o600);
	assert.equal(fileAccount(dir, 'node').publicKeyString.get(), first.publicKeyString.get(), 'the node key is stable');
	assert.notEqual(store.state.buyer.token, store.rotateBuyerToken());
});

test('the operator account depends only on the passkey entropy', async () => {
	const entropy = 'ab'.repeat(32);
	const a = await operatorAccount(entropy);
	const b = await operatorAccount(entropy);
	assert.equal(a.publicKeyString.get(), b.publicKeyString.get());
	assert.notEqual((await operatorAccount('cd'.repeat(32))).publicKeyString.get(), a.publicKeyString.get());
});

test('JSON-RPC peers call each other both ways', async () => {
	const aToB = new PassThrough();
	const bToA = new PassThrough();
	const notes: unknown[] = [];
	const app = new RpcPeer(bToA, aToB, {
		'signer.signDigest': async (params) => ({ signature: `signed:${(params as { digest: string }).digest}` }),
		'event.log': async (params) => void notes.push(params)
	});
	const agent = new RpcPeer(aToB, bToA, {
		'agent.version': async () => '1',
		'agent.fail': async () => {
			throw new Error('nope');
		}
	});
	assert.equal(await app.request('agent.version', {}), '1');
	await assert.rejects(app.request('agent.fail', {}), /nope/);
	await assert.rejects(app.request('agent.missing', {}), (error: { code: number }) => error.code === RPC_ERRORS.methodNotFound);
	assert.deepEqual(await agent.request('signer.signDigest', { digest: 'ff' }), { signature: 'signed:ff' });
	agent.notify('event.log', { level: 'info', message: 'hi' });
	await new Promise((r) => setTimeout(r, 10));
	assert.deepEqual(notes, [{ level: 'info', message: 'hi' }]);
});

test('payments from one account run one at a time', async () => {
	const queue = new SerialQueue();
	const order: string[] = [];
	await Promise.all(
		['a', 'b', 'c'].map((name, i) =>
			queue.run('acct', async () => {
				order.push(`start ${name}`);
				await new Promise((r) => setTimeout(r, 10 - i * 3));
				order.push(`end ${name}`);
			})
		)
	);
	assert.deepEqual(order, ['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
});

test('the buyer refuses receipts that do not match the ticket', async (t) => {
	const node = accountSigner(Account.fromSeed(Account.generateRandomSeed({ asString: true }) as string, 0));
	const buyerAccount = Account.fromSeed(Account.generateRandomSeed({ asString: true }) as string, 0);
	const payTo = accountSigner(Account.fromSeed(Account.generateRandomSeed({ asString: true }) as string, 0)).publicKey;
	const price = { inputPerMillion: '100000', outputPerMillion: '400000' };
	const ticket = {
		ticket: { jobId: 'job_1', nodeKey: node.publicKey, payTo, buyer: buyerAccount.publicKeyString.get(), modelId: 'qwen3-8b', asset: 'keeta_asset', price, maxInputTokens: 100, maxOutputTokens: 100 },
		signature: '',
		relayMac: ''
	} as unknown as SignedTicket;
	const base: Receipt = {
		v: 1,
		jobId: 'job_1',
		network: 'test',
		nodeKey: node.publicKey,
		payTo,
		buyer: buyerAccount.publicKeyString.get(),
		modelId: 'qwen3-8b',
		weightsHash: 'a'.repeat(64),
		runtime: { kind: 'mlx', build: 'test' },
		inputTokens: 50,
		outputTokens: 80,
		price,
		amount: jobCost(price, { inputTokens: 50, outputTokens: 80 }).toString(),
		asset: 'keeta_asset',
		startedAt: 1,
		finishedAt: 2,
		outputHash: 'b'.repeat(64),
		finishReason: 'stop'
	};
	const sign = async (receipt: Receipt) => ({ receipt, signature: await node.sign(receiptMessage(receipt)) });
	const buyer = new Buyer({
		store: new StateStore(tempDir(t)),
		control: {} as ControlClient,
		spend: accountSigner(buyerAccount),
		spendAccount: buyerAccount,
		ledger: { balances: async () => ({ usdc: 0n, kta: 0n }), send: async () => '', requestTestFunds: async () => '' },
		queue: new SerialQueue(),
		verify: verifyKeetaSignature,
		log: () => undefined,
		onJob: () => undefined
	});
	assert.equal(buyer.checkReceipt(ticket, await sign(base), 1000n), null);
	assert.match(buyer.checkReceipt(ticket, await sign({ ...base, payTo: node.publicKey }), 1000n)!, /does not match/);
	assert.match(buyer.checkReceipt(ticket, await sign({ ...base, outputTokens: 101, amount: '41' }), 1000n)!, /token limits/);
	assert.match(buyer.checkReceipt(ticket, await sign({ ...base, amount: '999' }), 1000n)!, /amount/);
	assert.match(buyer.checkReceipt(ticket, { ...(await sign(base)), signature: (await sign({ ...base, inputTokens: 1 })).signature }, 1000n)!, /signature/);
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
