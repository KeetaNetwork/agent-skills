import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	NETWORKS,
	UNPAID_GRACE_MS,
	generatePairingCode,
	jobCost,
	maxJobCost,
	operatorLinkMessage,
	pairingApprovalMessage,
	pairingCodeHash,
	receiptMessage,
	signRequest,
	ticketMac,
	ticketMessage,
	type HardwareProfile,
	type Offer,
	type Receipt,
	type Signer
} from '@keeta-compute/protocol';
import { Account, accountSigner, verifyKeetaSignature } from '@keeta-compute/protocol/keeta';
import { createApi, type ApiRequest } from '../src/http.ts';
import { ControlService, type BalanceReader, type PaymentVerifier } from '../src/service.ts';
import { MemoryStore } from '../src/store.ts';

const GB = 1024 ** 3;
const newSigner = (): Signer => accountSigner(Account.fromSeed(Account.generateRandomSeed({ asString: true }), 0));
const hardware = (gb: number, os: 'macos' | 'linux' = 'macos'): HardwareProfile => ({ os, osVersion: '15.4', chip: 'Apple M4 Max', memoryBytes: gb * GB, freeDiskBytes: 500 * GB });

function harness(options: { verifyPayment?: PaymentVerifier; balanceOf?: BalanceReader } = {}) {
	let clock = 1_800_000_000_000;
	const store = new MemoryStore();
	const coordinator = newSigner();
	const service = new ControlService({
		store,
		coordinator,
		verify: verifyKeetaSignature,
		relaySecret: 'relay-secret',
		routerSecret: 'router-secret',
		relayUrl: 'http://relay.local',
		networks: ['test'],
		verifyPayment: options.verifyPayment ?? (async () => 'confirmed'),
		...(options.balanceOf ? { balanceOf: options.balanceOf } : {}),
		now: () => clock
	});
	const handle = createApi(service, { store, verify: verifyKeetaSignature, routerSecret: 'router-secret', now: () => clock });

	async function call(signer: Signer | null, method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}) {
		const rawBody = body === undefined ? '' : JSON.stringify(body);
		const [pathname, search] = path.split('?');
		const headers = signer ? await signRequest(signer, method, pathname!, rawBody, clock) : {};
		const req: ApiRequest = { method, path: pathname!, query: new URLSearchParams(search ?? ''), headers: { ...headers, ...extraHeaders }, rawBody };
		return handle(req);
	}

	return { store, coordinator, service, call, advance: (ms: number) => (clock += ms), now: () => clock };
}

const offer = (modelId: string, overrides: Partial<Offer> = {}): Offer => ({
	modelId,
	weightsHash: 'c'.repeat(64),
	runtime: { kind: 'mlx', build: 'mlx-lm 0.26.0' },
	price: { inputPerMillion: '100000', outputPerMillion: '400000' },
	access: { mode: 'public', allow: [] },
	contextLength: 32768,
	...overrides
});

async function registerMac(h: ReturnType<typeof harness>, memoryGB = 64) {
	const node = newSigner();
	const operator = newSigner();
	const issuedAt = h.now();
	const link = await operator.sign(operatorLinkMessage({ nodeKey: node.publicKey, payTo: operator.publicKey, network: 'test', issuedAt }));
	const res = await h.call(node, 'POST', '/v1/providers/register', { network: 'test', kind: 'mac', name: 'Studio', hardware: hardware(memoryGB), payTo: operator.publicKey, link: { issuedAt, signature: link } });
	assert.equal(res.status, 200, JSON.stringify(res.body));
	return { node, operator };
}

test('provider registration requires a valid operator link', async () => {
	const h = harness();
	const node = newSigner();
	const operator = newSigner();
	const bad = await h.call(node, 'POST', '/v1/providers/register', { network: 'test', kind: 'mac', hardware: hardware(64), payTo: operator.publicKey, link: { issuedAt: 1, signature: '00' } });
	assert.equal(bad.status, 401);
	const mainNet = await h.call(node, 'POST', '/v1/providers/register', { network: 'main', kind: 'mac', hardware: hardware(64), payTo: operator.publicKey, link: { issuedAt: 1, signature: '00' } });
	assert.equal(mainNet.status, 403);
	await registerMac(h);
});

test('signed requests reject replays, stale clocks and tampering', async () => {
	const h = harness();
	const { node } = await registerMac(h);
	const body = JSON.stringify({ status: 'online', offers: [] });
	const headers = await signRequest(node, 'POST', '/v1/providers/heartbeat', body, h.now());
	const first = await h.call(null, 'POST', '/v1/providers/heartbeat', JSON.parse(body), headers);
	assert.equal(first.status, 200);
	const replay = await h.call(null, 'POST', '/v1/providers/heartbeat', JSON.parse(body), headers);
	assert.equal(replay.status, 401);
	const stale = await signRequest(node, 'POST', '/v1/providers/heartbeat', body, h.now() - 10 * 60_000);
	assert.equal((await h.call(null, 'POST', '/v1/providers/heartbeat', JSON.parse(body), stale)).status, 401);
	const fresh = await signRequest(node, 'POST', '/v1/providers/heartbeat', body, h.now());
	assert.equal((await h.call(null, 'POST', '/v1/providers/heartbeat', { status: 'paused', offers: [] }, fresh)).status, 401);
});

test('full postpay job: schedule, ticket, receipt, payment, earnings', async () => {
	const h = harness();
	const { node, operator } = await registerMac(h);
	const hb = await h.call(node, 'POST', '/v1/providers/heartbeat', { status: 'online', offers: [offer('qwen3-8b')], load: { active: 0, capacity: 2 } });
	assert.equal(hb.status, 200);
	assert.ok((hb.body as { relayToken: string }).relayToken);

	const models = await h.call(null, 'GET', '/v1/models?network=test');
	assert.deepEqual((models.body as { models: { id: string }[] }).models.map((m) => m.id), ['qwen3-8b']);

	const buyer = newSigner();
	const created = await h.call(buyer, 'POST', '/v1/jobs', { network: 'test', model: 'qwen3-8b', maxInputTokens: 200, maxOutputTokens: 100 });
	assert.equal(created.status, 200, JSON.stringify(created.body));
	const { job, ticket } = created.body as { job: { jobId: string }; ticket: { ticket: Parameters<typeof ticketMessage>[0]; coordinatorSig: string; relayMac: string } };
	assert.equal(ticket.ticket.payTo, operator.publicKey);
	assert.ok(verifyKeetaSignature(h.coordinator.publicKey, ticketMessage(ticket.ticket), ticket.coordinatorSig));
	assert.equal(ticket.relayMac, await ticketMac('relay-secret', ticket.ticket));

	const receipt: Receipt = {
		v: 1,
		jobId: job.jobId,
		network: 'test',
		nodeKey: node.publicKey,
		payTo: operator.publicKey,
		buyer: buyer.publicKey,
		modelId: 'qwen3-8b',
		weightsHash: 'c'.repeat(64),
		runtime: { kind: 'mlx', build: 'mlx-lm 0.26.0' },
		inputTokens: 150,
		outputTokens: 80,
		price: ticket.ticket.price,
		amount: jobCost(ticket.ticket.price, { inputTokens: 150, outputTokens: 80 }).toString(),
		asset: NETWORKS.test.settlementAsset.address,
		startedAt: h.now(),
		finishedAt: h.now(),
		outputHash: 'd'.repeat(64),
		finishReason: 'stop'
	};
	const wrongAmount = await h.call(node, 'POST', `/v1/jobs/${job.jobId}/receipt`, { receipt: { receipt: { ...receipt, amount: '999999' }, signature: await node.sign(receiptMessage({ ...receipt, amount: '999999' })) } });
	assert.equal(wrongAmount.status, 400);
	const forged = await h.call(node, 'POST', `/v1/jobs/${job.jobId}/receipt`, { receipt: { receipt, signature: await buyer.sign(receiptMessage(receipt)) } });
	assert.equal(forged.status, 401);
	const accepted = await h.call(node, 'POST', `/v1/jobs/${job.jobId}/receipt`, { receipt: { receipt, signature: await node.sign(receiptMessage(receipt)) } });
	assert.equal(accepted.status, 200, JSON.stringify(accepted.body));

	const other = newSigner();
	assert.equal((await h.call(other, 'POST', `/v1/jobs/${job.jobId}/payment`, { blockHash: 'A'.repeat(64) })).status, 403);
	const paid = await h.call(buyer, 'POST', `/v1/jobs/${job.jobId}/payment`, { blockHash: 'A'.repeat(64) });
	assert.equal(paid.status, 200, JSON.stringify(paid.body));
	assert.equal((paid.body as { job: { status: string } }).job.status, 'paid');
	const me = await h.call(node, 'GET', '/v1/providers/me');
	const stats = (me.body as { provider: { stats: { earned: string; completed: number }; load: { active: number } } }).provider;
	assert.equal(stats.stats.earned, receipt.amount);
	assert.equal(stats.stats.completed, 1);
	assert.equal(stats.load.active, 0);
});

test('unpaid receipts block a buyer after the grace period', async () => {
	const h = harness();
	const { node, operator } = await registerMac(h);
	await h.call(node, 'POST', '/v1/providers/heartbeat', { status: 'online', offers: [offer('qwen3-8b')], load: { active: 0, capacity: 4 } });
	const buyer = newSigner();
	const created = await h.call(buyer, 'POST', '/v1/jobs', { network: 'test', model: 'qwen3-8b', maxInputTokens: 10, maxOutputTokens: 10 });
	const { ticket } = created.body as { ticket: { ticket: { jobId: string; price: Offer['price'] } } };
	const receipt: Receipt = {
		v: 1, jobId: ticket.ticket.jobId, network: 'test', nodeKey: node.publicKey, payTo: operator.publicKey, buyer: buyer.publicKey, modelId: 'qwen3-8b',
		weightsHash: 'c'.repeat(64), runtime: { kind: 'mlx', build: 'x' }, inputTokens: 5, outputTokens: 5, price: ticket.ticket.price,
		amount: jobCost(ticket.ticket.price, { inputTokens: 5, outputTokens: 5 }).toString(), asset: NETWORKS.test.settlementAsset.address,
		startedAt: 0, finishedAt: 0, outputHash: 'e'.repeat(64), finishReason: 'stop'
	};
	await h.call(node, 'POST', `/v1/jobs/${receipt.jobId}/receipt`, { receipt: { receipt, signature: await node.sign(receiptMessage(receipt)) } });
	h.advance(UNPAID_GRACE_MS + 1000);
	await h.call(node, 'POST', '/v1/providers/heartbeat', { status: 'online', offers: [offer('qwen3-8b')], load: { active: 0, capacity: 4 } });
	const blocked = await h.call(buyer, 'POST', '/v1/jobs', { network: 'test', model: 'qwen3-8b', maxInputTokens: 10, maxOutputTokens: 10 });
	assert.equal(blocked.status, 402);
});

test('pay-later buyers need ledger funds for every job they still owe for', async () => {
	const balances = new Map<string, bigint>();
	let ledgerUp = true;
	const h = harness({
		balanceOf: async ({ account, asset }) => {
			assert.equal(asset, NETWORKS.test.settlementAsset.address);
			if (!ledgerUp) {
				throw new Error('ledger down');
			}
			return balances.get(account) ?? 0n;
		}
	});
	const { node } = await registerMac(h);
	await h.call(node, 'POST', '/v1/providers/heartbeat', { status: 'online', offers: [offer('qwen3-8b')], load: { active: 0, capacity: 4 } });
	const limits = { maxInputTokens: 1000, maxOutputTokens: 1000 };
	const cost = maxJobCost(offer('qwen3-8b').price, limits);
	const job = { network: 'test', model: 'qwen3-8b', ...limits };

	const fresh = newSigner();
	const unfunded = await h.call(fresh, 'POST', '/v1/jobs', job);
	assert.equal(unfunded.status, 402, 'a new key with no funds gets nothing');

	const buyer = newSigner();
	balances.set(buyer.publicKey, cost * 2n);
	assert.equal((await h.call(buyer, 'POST', '/v1/jobs', job)).status, 200);
	assert.equal((await h.call(buyer, 'POST', '/v1/jobs', job)).status, 200);
	assert.equal((await h.call(buyer, 'POST', '/v1/jobs', job)).status, 402, 'open jobs count against the balance');

	const racer = newSigner();
	balances.set(racer.publicKey, cost);
	const raced = await Promise.all([1, 2, 3].map(() => h.call(racer, 'POST', '/v1/jobs', job)));
	assert.deepEqual(raced.map((r) => r.status).sort(), [200, 402, 402], 'parallel requests cannot spend one balance twice');

	ledgerUp = false;
	balances.set(buyer.publicKey, cost * 10n);
	assert.equal((await h.call(buyer, 'POST', '/v1/jobs', job)).status, 503, 'fails closed when the ledger is unreachable');
	ledgerUp = true;
	assert.equal((await h.call(buyer, 'POST', '/v1/jobs', job)).status, 200);
});

test('allowlisted offers only serve listed buyers and never router traffic', async () => {
	const h = harness();
	const friend = newSigner();
	const stranger = newSigner();
	const { node } = await registerMac(h);
	await h.call(node, 'POST', '/v1/providers/heartbeat', { status: 'online', offers: [offer('qwen3-14b', { access: { mode: 'allowlist', allow: [friend.publicKey] } })], load: { active: 0, capacity: 4 } });
	assert.equal((await h.call(stranger, 'POST', '/v1/jobs', { network: 'test', model: 'qwen3-14b', maxInputTokens: 10, maxOutputTokens: 10 })).status, 503);
	assert.equal((await h.call(friend, 'POST', '/v1/jobs', { network: 'test', model: 'qwen3-14b', maxInputTokens: 10, maxOutputTokens: 10 })).status, 200);
	const quote = await h.call(null, 'POST', '/v1/router/quote', { network: 'test', model: 'qwen3-14b', maxInputTokens: 10, maxOutputTokens: 10 }, { 'x-router-secret': 'router-secret' });
	assert.equal(quote.status, 503);
});

test('scheduler respects max price, context length, capacity and staleness', async () => {
	const h = harness();
	const { node } = await registerMac(h);
	await h.call(node, 'POST', '/v1/providers/heartbeat', { status: 'online', offers: [offer('qwen3-8b', { contextLength: 1000 })], load: { active: 0, capacity: 1 } });
	const buyer = newSigner();
	const cheap = { inputPerMillion: '1', outputPerMillion: '1' };
	assert.equal((await h.call(buyer, 'POST', '/v1/jobs', { network: 'test', model: 'qwen3-8b', maxInputTokens: 10, maxOutputTokens: 10, maxPrice: cheap })).status, 503);
	assert.equal((await h.call(buyer, 'POST', '/v1/jobs', { network: 'test', model: 'qwen3-8b', maxInputTokens: 900, maxOutputTokens: 200 })).status, 503);
	assert.equal((await h.call(buyer, 'POST', '/v1/jobs', { network: 'test', model: 'qwen3-8b', maxInputTokens: 10, maxOutputTokens: 10 })).status, 200);
	assert.equal((await h.call(buyer, 'POST', '/v1/jobs', { network: 'test', model: 'qwen3-8b', maxInputTokens: 10, maxOutputTokens: 10 })).status, 503, 'capacity 1 is used');
	h.advance(5 * 60_000);
	await h.call(node, 'POST', '/v1/providers/heartbeat', { status: 'online', offers: [offer('qwen3-8b')], load: { active: 0, capacity: 1 } });
	h.advance(5 * 60_000);
	assert.equal((await h.call(buyer, 'POST', '/v1/jobs', { network: 'test', model: 'qwen3-8b', maxInputTokens: 10, maxOutputTokens: 10 })).status, 503, 'stale provider');
});

test('a heartbeat keeps ticketed slots held, and a buyer cancel or provider fail frees them', async () => {
	const h = harness();
	const { node } = await registerMac(h);
	const beat = () => h.call(node, 'POST', '/v1/providers/heartbeat', { status: 'online', offers: [offer('qwen3-8b')], load: { active: 0, capacity: 1 } });
	await beat();
	const buyer = newSigner();
	const job = () => h.call(buyer, 'POST', '/v1/jobs', { network: 'test', model: 'qwen3-8b', maxInputTokens: 10, maxOutputTokens: 10 });
	const first = await job();
	assert.equal(first.status, 200);
	await beat();
	assert.equal((await job()).status, 503, 'the ticketed job still holds the only slot after a heartbeat');
	const jobId = (first.body as { job: { jobId: string } }).job.jobId;
	assert.equal((await h.call(newSigner(), 'POST', `/v1/jobs/${jobId}/cancel`, {})).status, 403, 'only the buyer can cancel');
	assert.equal((await h.call(buyer, 'POST', `/v1/jobs/${jobId}/cancel`, {})).status, 200);
	assert.equal((await h.call(buyer, 'POST', `/v1/jobs/${jobId}/cancel`, {})).status, 409);
	const second = await job();
	assert.equal(second.status, 200, 'the cancelled slot is free again');
	const secondId = (second.body as { job: { jobId: string } }).job.jobId;
	assert.equal((await h.call(node, 'POST', `/v1/jobs/${secondId}/fail`, { error: 'busy' })).status, 200);
	assert.equal((await job()).status, 200, 'a job the provider rejected frees its slot');
});

test('machines under 32 GB register but are never scheduled', async () => {
	const h = harness();
	const { node } = await registerMac(h, 16);
	const hb = await h.call(node, 'POST', '/v1/providers/heartbeat', { status: 'online', offers: [offer('llama-3.2-3b-instruct')] });
	assert.equal((hb.body as { eligible: boolean; status: string }).eligible, false);
	assert.equal((hb.body as { status: string }).status, 'paused');
});

test('router quotes are prepaid to the provider and settle', async () => {
	const h = harness();
	const { node, operator } = await registerMac(h);
	await h.call(node, 'POST', '/v1/providers/heartbeat', { status: 'online', offers: [offer('qwen3-8b')], load: { active: 0, capacity: 2 } });
	assert.equal((await h.call(null, 'POST', '/v1/router/quote', { network: 'test', model: 'qwen3-8b', maxInputTokens: 10, maxOutputTokens: 10 })).status, 401);
	const quote = await h.call(null, 'POST', '/v1/router/quote', { network: 'test', model: 'qwen3-8b', maxInputTokens: 1000, maxOutputTokens: 1000 }, { 'x-router-secret': 'router-secret' });
	assert.equal(quote.status, 200);
	const { job } = quote.body as { job: { jobId: string; payTo: string; prepaidAmount: string } };
	assert.equal(job.payTo, operator.publicKey);
	assert.equal(job.prepaidAmount, '500');
	const payer = newSigner();
	const settled = await h.call(null, 'POST', `/v1/router/jobs/${job.jobId}/settled`, { payer: payer.publicKey, transaction: 'tx' }, { 'x-router-secret': 'router-secret' });
	assert.equal(settled.status, 200);
	for (let i = 0; i < 5; i++) {
		const unpaid = await h.call(null, 'POST', '/v1/router/quote', { network: 'test', model: 'qwen3-8b', maxInputTokens: 10, maxOutputTokens: 10 }, { 'x-router-secret': 'router-secret' });
		assert.equal(unpaid.status, 200, 'unpaid quotes do not use up the provider');
	}
	assert.equal((await h.call(newSigner(), 'POST', '/v1/jobs', { network: 'test', model: 'qwen3-8b', maxInputTokens: 10, maxOutputTokens: 10 })).status, 200);
});

test('Linux helpers pair by code with check string and master approval', async () => {
	const h = harness();
	const { node: master, operator } = await registerMac(h);
	const code = generatePairingCode();
	const created = await h.call(master, 'POST', '/v1/pairing', { codeHash: await pairingCodeHash(code) });
	assert.equal(created.status, 200);
	const { pairingId } = created.body as { pairingId: string };

	const helper = newSigner();
	/* A helper cannot self-register. */
	assert.equal((await h.call(helper, 'POST', '/v1/providers/register', { network: 'test', kind: 'linux-helper', hardware: hardware(128, 'linux') })).status, 403);
	assert.equal((await h.call(helper, 'POST', '/v1/pairing/claim', { codeHash: await pairingCodeHash(generatePairingCode()), descriptor: { ...hardware(128, 'linux'), name: 'box' } })).status, 404);
	const claimed = await h.call(helper, 'POST', '/v1/pairing/claim', { codeHash: await pairingCodeHash(code.toLowerCase()), descriptor: { ...hardware(128, 'linux'), name: 'gpu-box' } });
	assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
	const intruder = newSigner();
	assert.equal((await h.call(intruder, 'POST', '/v1/pairing/claim', { codeHash: await pairingCodeHash(code), descriptor: { ...hardware(128, 'linux'), name: 'x' } })).status, 404, 'single use');

	const status = await h.call(master, 'GET', `/v1/pairing/${pairingId}`);
	const record = status.body as { status: string; claim: { nodeKey: string; checkString: string } };
	assert.equal(record.status, 'claimed');
	assert.equal(record.claim.checkString, (claimed.body as { checkString: string }).checkString);

	const approvalSig = await master.sign(pairingApprovalMessage({ pairingId, helperNodeKey: helper.publicKey, masterNodeKey: master.publicKey, payTo: operator.publicKey }));
	assert.equal((await h.call(master, 'POST', `/v1/pairing/${pairingId}/approve`, { approvalSig })).status, 200);

	const registered = await h.call(helper, 'POST', '/v1/providers/register', { network: 'test', kind: 'linux-helper', name: 'gpu-box', hardware: hardware(128, 'linux') });
	assert.equal(registered.status, 200);
	assert.equal((registered.body as { provider: { payTo: string } }).provider.payTo, operator.publicKey, 'helper earnings go to the master wallet');

	/* The helper serves under the Mac's allowlist, whatever it reports itself. */
	const listed = newSigner();
	const stranger = newSigner();
	await h.call(master, 'POST', '/v1/providers/heartbeat', { status: 'paused', offers: [], access: { mode: 'allowlist', allow: [listed.publicKey] } });
	await h.call(helper, 'POST', '/v1/providers/heartbeat', { status: 'online', offers: [offer('qwen3-8b')], access: { mode: 'public', allow: [] }, load: { active: 0, capacity: 4 } });
	const job = { network: 'test', model: 'qwen3-8b', maxInputTokens: 10, maxOutputTokens: 10 };
	assert.equal((await h.call(stranger, 'POST', '/v1/jobs', job)).status, 503, 'buyers off the Mac allowlist are not scheduled on its helpers');
	assert.equal((await h.call(listed, 'POST', '/v1/jobs', job)).status, 200);
	await h.call(master, 'POST', '/v1/providers/heartbeat', { status: 'paused', offers: [], access: { mode: 'public', allow: [] } });
	assert.equal((await h.call(stranger, 'POST', '/v1/jobs', job)).status, 200, 'and follow the Mac when it opens up');

	const fleet = await h.call(master, 'GET', '/v1/fleet');
	assert.equal((fleet.body as { helpers: unknown[] }).helpers.length, 1);
	assert.equal((await h.call(master, 'DELETE', `/v1/fleet/${helper.publicKey}`)).status, 200);
	assert.equal((await h.call(helper, 'POST', '/v1/providers/heartbeat', { status: 'online', offers: [] })).status, 404, 'revoked helper is cut off');
});

test('sweep expires unused tickets and confirms late payments', async () => {
	let ledger: 'pending' | 'confirmed' = 'pending';
	const h = harness({ verifyPayment: async () => ledger });
	const { node, operator } = await registerMac(h);
	await h.call(node, 'POST', '/v1/providers/heartbeat', { status: 'online', offers: [offer('qwen3-8b')], load: { active: 0, capacity: 4 } });
	const buyer = newSigner();
	const unused = await h.call(buyer, 'POST', '/v1/jobs', { network: 'test', model: 'qwen3-8b', maxInputTokens: 10, maxOutputTokens: 10 });
	const used = await h.call(buyer, 'POST', '/v1/jobs', { network: 'test', model: 'qwen3-8b', maxInputTokens: 10, maxOutputTokens: 10 });
	const t = (used.body as { ticket: { ticket: { jobId: string; price: Offer['price'] } } }).ticket.ticket;
	const receipt: Receipt = {
		v: 1, jobId: t.jobId, network: 'test', nodeKey: node.publicKey, payTo: operator.publicKey, buyer: buyer.publicKey, modelId: 'qwen3-8b',
		weightsHash: 'c'.repeat(64), runtime: { kind: 'mlx', build: 'x' }, inputTokens: 5, outputTokens: 5, price: t.price,
		amount: jobCost(t.price, { inputTokens: 5, outputTokens: 5 }).toString(), asset: NETWORKS.test.settlementAsset.address,
		startedAt: 0, finishedAt: 0, outputHash: 'e'.repeat(64), finishReason: 'stop'
	};
	await h.call(node, 'POST', `/v1/jobs/${t.jobId}/receipt`, { receipt: { receipt, signature: await node.sign(receiptMessage(receipt)) } });
	const pending = await h.call(buyer, 'POST', `/v1/jobs/${t.jobId}/payment`, { blockHash: 'B'.repeat(64) });
	assert.equal((pending.body as { job: { status: string } }).job.status, 'completed');
	h.advance(10 * 60_000);
	ledger = 'confirmed';
	const result = await h.service.sweep();
	assert.deepEqual(result, { expired: 1, confirmed: 1 });
	const unusedId = (unused.body as { job: { jobId: string } }).job.jobId;
	assert.equal((await h.store.getJob(unusedId))?.status, 'expired');
	assert.equal((await h.store.getJob(t.jobId))?.status, 'paid');
});
