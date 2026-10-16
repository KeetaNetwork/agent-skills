import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { jobCost, maxJobCost, receiptMessage, type Receipt, type SignedTicket } from '@keeta-compute/protocol';
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
		ledger: { balances: async () => ({ kta: 0n, tokens: {} }), send: async () => '', received: async () => [], requestTestFunds: async () => '' },
		queue: new SerialQueue(),
		verify: verifyKeetaSignature,
		log: () => undefined,
		onJob: () => undefined
	});
	const delivery = { outputHash: 'b'.repeat(64), maxOutputTokens: 100 };
	assert.equal(buyer.checkReceipt(ticket, await sign(base), delivery), null);
	assert.equal(buyer.checkReceipt(ticket, await sign({ ...base, outputHash: 'c'.repeat(64) }), null), null, 'without the delivery, only the ticket terms are checked');
	assert.match(buyer.checkReceipt(ticket, await sign({ ...base, payTo: node.publicKey }), delivery)!, /does not match/);
	assert.match(buyer.checkReceipt(ticket, await sign({ ...base, asset: 'keeta_other' }), delivery)!, /does not match/, 'billed in another token than the escrow');
	assert.match(buyer.checkReceipt(ticket, await sign({ ...base, outputTokens: 101, amount: '41' }), delivery)!, /token limits/);
	assert.match(buyer.checkReceipt(ticket, await sign({ ...base, amount: '999' }), delivery)!, /amount/);
	assert.match(buyer.checkReceipt(ticket, { ...(await sign(base)), signature: (await sign({ ...base, inputTokens: 1 })).signature }, delivery)!, /signature/);
	assert.match(buyer.checkReceipt(ticket, await sign(base), { ...delivery, outputHash: 'c'.repeat(64) })!, /text received/);
	assert.match(buyer.checkReceipt(ticket, await sign(base), { ...delivery, maxOutputTokens: 79 })!, /more output tokens/, 'a short answer cannot bill the full cap');
});

test('the buyer escrows a job once, and a follow-up never hands back a job whose escrow it is still confirming', async (t) => {
	const spendAccount = Account.fromSeed(Account.generateRandomSeed({ asString: true }) as string, 0);
	const spend = accountSigner(spendAccount);
	const price = { inputPerMillion: '100000', outputPerMillion: '400000' };
	const sends: Array<{ to: string; amount: bigint; asset: string; reference?: string }> = [];
	const posts: string[] = [];
	let confirmed = false;
	let quoted: { jobId: string; maxCost: bigint; limits: { maxInputTokens: number; maxOutputTokens: number } } | null = null;
	/* The control plane's side: a quote priced from the request, and the escrow pending until `confirmed`. */
	const control = {
		post: async (_signer: unknown, path: string, body: Record<string, number>) => {
			posts.push(path);
			if (path === '/v1/jobs') {
				const limits = { maxInputTokens: body.maxInputTokens!, maxOutputTokens: body.maxOutputTokens! };
				quoted = { jobId: 'job_1', maxCost: maxJobCost(price, limits), limits };
				const job = { jobId: 'job_1', asset: 'keeta_credits', price, ...limits };
				return { job, quote: { jobId: 'job_1', network: 'test', maxCost: quoted.maxCost.toString(), token: 'keeta_credits', decimals: 6, settlement: 'keeta_settlement', expiresAt: Date.now() + 60_000 } };
			}
			if (path === '/v1/jobs/job_1/escrow') {
				const ticket = { jobId: 'job_1', modelId: 'qwen3-8b', payTo: 'keeta_provider', nodeKey: 'keeta_node', price, ...quoted!.limits };
				return confirmed ? { ticket: { ticket, coordinatorSig: '', relayMac: '' } } : { pending: true };
			}
			return {};
		},
		get: async () => ({ jobs: [] })
	} as unknown as ControlClient;
	const store = new StateStore(tempDir(t));
	const buyer = new Buyer({
		store,
		control,
		spend,
		spendAccount,
		ledger: {
			balances: async () => ({ kta: 0n, tokens: {} }),
			send: async (_from, to, amount, asset, reference) => {
				sends.push({ to, amount, asset, ...(reference ? { reference } : {}) });
				return 'B'.repeat(64);
			},
			received: async () => [],
			requestTestFunds: async () => ''
		},
		queue: new SerialQueue(),
		verify: verifyKeetaSignature,
		log: () => undefined,
		onJob: () => undefined,
		/* The provider is unreachable, so the job is handed back after its escrow. */
		fetchImpl: (async () => new Response('', { status: 502 })) as typeof fetch,
		escrowRetryMs: [0, 100, 100, 100]
	});
	await buyer.listen(0);
	t.after(() => buyer.close());

	const response = fetch(`${buyer.endpoint}/chat/completions`, {
		method: 'POST',
		headers: { authorization: `Bearer ${store.state.buyer.token}`, 'content-type': 'application/json' },
		body: JSON.stringify({ model: 'qwen3-8b', messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 })
	});
	while (!posts.includes('/v1/jobs/job_1/escrow')) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	/* The escrow is on the ledger now; the wallet timer and the app follow up while the request waits to report it again. */
	confirmed = true;
	const followUps = [buyer.followUp(), buyer.followUp()];
	assert.equal(followUps[0], followUps[1], 'overlapping follow-ups share one run');
	assert.deepEqual(await followUps[0], { reported: 0, settled: 0 }, 'the request in flight reports its own escrow');
	assert.equal(posts.filter((p) => p.endsWith('/cancel')).length, 0, 'a follow-up does not hand back a job that is about to run');

	assert.equal((await response).status, 502);
	assert.deepEqual(sends, [{ to: 'keeta_settlement', amount: quoted!.maxCost, asset: 'keeta_credits', reference: 'job_1' }], 'one escrow send, of the quoted maximum, referencing the job');
	assert.equal(posts.filter((p) => p.endsWith('/cancel')).length, 1, 'handed back once, by the request itself');
	assert.deepEqual(store.state.escrows, [], 'the confirmed escrow is no longer pending');
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
