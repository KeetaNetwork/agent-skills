import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import {
	CREDIT_DECIMALS,
	CREDIT_NAME,
	NETWORKS,
	QUOTE_TTL_MS,
	SETTLE_LAPSE_MS,
	TICKET_TTL_MS,
	assetListing,
	defaultAsset,
	generatePairingCode,
	jobCost,
	maxJobCost,
	operatorLinkMessage,
	pairingApprovalMessage,
	pairingCodeHash,
	receiptMessage,
	rescaleAmount,
	signRequest,
	ticketMac,
	ticketMessage,
	type EscrowQuote,
	type HardwareProfile,
	type JobRecord,
	type JobTicket,
	type Offer,
	type Receipt,
	type SignedTicket,
	type Signer
} from '@keeta-compute/protocol';
import { Account, accountSigner, checkPaymentBlock, verifyKeetaSignature } from '@keeta-compute/protocol/keeta';
import { createApi, type ApiRequest } from '../src/http.ts';
import { creditsFromEnv, fallbackFromEnv, type EnvConfig } from '../src/config.ts';
import { ControlService, type CreditBalanceReader, type FallbackConfig, type PaymentVerifier, type SettlementLedger } from '../src/service.ts';
import { MemoryStore } from '../src/store.ts';

const GB = 1024 ** 3;
type KeyPair = ReturnType<typeof Account.fromSeed>;
type Block = InstanceType<typeof KeetaNet.lib.Block>;
const randomAccount = (): KeyPair => Account.fromSeed(Account.generateRandomSeed({ asString: true }), 0);
const newSigner = (): Signer => accountSigner(randomAccount());
const hardware = (gb: number, os: 'macos' | 'linux' = 'macos'): HardwareProfile => ({ os, osVersion: '15.4', chip: 'Apple M4 Max', memoryBytes: gb * GB, freeDiskBytes: 500 * GB });
const TEST_NETWORK_ID = BigInt(NETWORKS.test.caip2.split(':')[1]!);
/* Any token address serves as the credit token offline: the test network's base token. */
const CREDITS = Account.generateBaseAddresses(TEST_NETWORK_ID).baseToken.publicKeyString.get();
const FX = randomAccount().publicKeyString.get();
const ROUTER = { 'x-router-secret': 'router-secret' };
/* service.ts: an unrecorded payout attempt may be retried this long after it started. */
const PAYOUT_RETRY_MS = 5 * 60_000;
/* service.ts: how long settlement waits for the relay's record after a receipt. */
const DELIVERY_GRACE_MS = 60_000;
const SECRETS: EnvConfig = { COORDINATOR_SEED: '', RELAY_SECRET: '', ROUTER_SECRET: '' };

/**
 * The ledger these tests run against: real signed Keeta blocks, kept in
 * memory. The control plane reads escrows from it with the production
 * checkPaymentBlock, and the settlement account publishes its payouts to it,
 * so balances, escrows, payouts and refunds are all read from blocks.
 */
class TestLedger {
	private readonly blocks = new Map<string, Block>();
	private readonly held = new Map<string, Block>();
	private readonly heads = new Map<string, string>();

	async getBlock(hash: string): Promise<Block | null> {
		return this.blocks.get(hash.toUpperCase()) ?? null;
	}

	/** Sign and publish one block of sends; `held` keeps it off the ledger until release(). */
	async publish(from: KeyPair, sends: Array<{ to: string; amount: bigint; token: string; external: string }>, options: { held?: boolean } = {}): Promise<string> {
		const address = from.publicKeyString.get();
		const builder = new KeetaNet.lib.Block.Builder();
		builder.account = from;
		builder.signer = from;
		builder.network = TEST_NETWORK_ID;
		builder.previous = this.heads.get(address) ?? KeetaNet.lib.Block.NO_PREVIOUS;
		builder.date = new Date();
		for (const send of sends) {
			builder.addOperation({
				type: KeetaNet.lib.Block.OperationType.SEND,
				to: Account.fromPublicKeyString(send.to as never),
				amount: send.amount,
				token: Account.fromPublicKeyString(send.token as never),
				external: send.external
			} as never);
		}
		const block = await builder.seal();
		const hash = block.hash.toString().toUpperCase();
		this.heads.set(address, hash);
		(options.held ? this.held : this.blocks).set(hash, block);
		return hash;
	}

	release(): void {
		for (const [hash, block] of this.held) {
			this.blocks.set(hash, block);
		}
		this.held.clear();
	}

	/** Every credit send on the ledger. */
	sends(): Array<{ block: string; from: string; to: string; amount: bigint; reference: string | undefined }> {
		return [...this.blocks.values()].flatMap((block) =>
			block.operations.flatMap((operation) => {
				if (operation.type !== KeetaNet.lib.Block.OperationType.SEND) {
					return [];
				}
				const send = operation as InstanceType<typeof KeetaNet.lib.Block.Operation.SEND>;
				if (send.token.publicKeyString.get() !== CREDITS) {
					return [];
				}
				return [{ block: block.hash.toString().toUpperCase(), from: block.account.publicKeyString.get(), to: send.to.publicKeyString.get(), amount: send.amount, reference: send.external }];
			})
		);
	}

	/** What the settlement account sent for a job, by recipient. */
	payouts(settlement: string, jobId: string): { blocks: string[]; to: Record<string, bigint> } {
		const sends = this.sends().filter((s) => s.from === settlement && s.reference === jobId);
		const to: Record<string, bigint> = {};
		for (const send of sends) {
			to[send.to] = (to[send.to] ?? 0n) + send.amount;
		}
		return { blocks: [...new Set(sends.map((s) => s.block))], to };
	}
}

/** keeta.ai's settlement account on the test ledger: it signs its own payout blocks and searches its own sends. */
function settlementAccount(ledger: TestLedger) {
	const account = randomAccount();
	const address = account.publicKeyString.get();
	const stats = { published: 0, searched: 0, failAfterPublish: false };
	const settlement: SettlementLedger = {
		account: address,
		async payout({ token, jobId, sends }) {
			stats.published++;
			const hash = await ledger.publish(account, sends.map((send) => ({ ...send, token, external: jobId })));
			if (stats.failAfterPublish) {
				stats.failAfterPublish = false;
				throw new Error('the connection dropped after the block was published');
			}
			return hash;
		},
		async findPayout({ jobId }) {
			stats.searched++;
			return ledger.sends().find((send) => send.from === address && send.reference === jobId)?.block ?? null;
		}
	};
	return { settlement, stats };
}

function harness(options: { fallback?: FallbackConfig; credits?: boolean; creditBalanceOf?: CreditBalanceReader } = {}) {
	let clock = 1_800_000_000_000;
	const store = new MemoryStore();
	const coordinator = newSigner();
	const ledger = new TestLedger();
	const { settlement, stats: payouts } = settlementAccount(ledger);
	/* What the production verifier does with checkPaymentBlock's answer (config.ts ledgerPaymentVerifier). */
	const verifyPayment: PaymentVerifier = async (args) => {
		const result = await checkPaymentBlock(ledger as never, args);
		return result.status === 'confirmed' ? result : result.status === 'not-found' ? { status: 'pending' } : { status: 'rejected', reason: result.reason };
	};
	const service = new ControlService({
		store,
		coordinator,
		verify: verifyKeetaSignature,
		relaySecret: 'relay-secret',
		routerSecret: 'router-secret',
		relayUrl: 'http://relay.local',
		networks: ['test'],
		verifyPayment,
		/* The test-network credit token, through the deployment settings that name one ahead of its pin. */
		credits: options.credits === false ? {} : creditsFromEnv({ ...SECRETS, TEST_CREDIT_TOKEN: CREDITS, TEST_FX_ACCOUNT: FX }, ['test']),
		settlement,
		...(options.fallback ? { fallback: options.fallback } : {}),
		...(options.creditBalanceOf ? { creditBalanceOf: options.creditBalanceOf } : {}),
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

	return { store, coordinator, service, call, ledger, settlement, payouts, advance: (ms: number) => (clock += ms), now: () => clock };
}

type Harness = ReturnType<typeof harness>;

const offer = (modelId: string, overrides: Partial<Offer> = {}): Offer => ({
	modelId,
	weightsHash: 'c'.repeat(64),
	runtime: { kind: 'mlx', build: 'mlx-lm 0.26.0' },
	price: { inputPerMillion: '100000', outputPerMillion: '400000' },
	access: { mode: 'public', allow: [] },
	contextLength: 32768,
	...overrides
});

async function registerMac(h: Harness, memoryGB = 64) {
	const node = newSigner();
	const operator = newSigner();
	const issuedAt = h.now();
	const link = await operator.sign(operatorLinkMessage({ nodeKey: node.publicKey, payTo: operator.publicKey, network: 'test', issuedAt }));
	const res = await h.call(node, 'POST', '/v1/providers/register', { network: 'test', kind: 'mac', name: 'Studio', hardware: hardware(memoryGB), payTo: operator.publicKey, link: { issuedAt, signature: link } });
	assert.equal(res.status, 200, JSON.stringify(res.body));
	return { node, operator };
}

/** A buyer: its ledger account signs escrow blocks, and as a signer it calls the control plane. */
function newBuyer() {
	const account = randomAccount();
	return { account, signer: accountSigner(account), address: account.publicKeyString.get() };
}
type Buyer = ReturnType<typeof newBuyer>;

const LIMITS = { maxInputTokens: 10, maxOutputTokens: 10 };

async function quote(h: Harness, buyer: Buyer, limits = LIMITS) {
	const created = await h.call(buyer.signer, 'POST', '/v1/jobs', { network: 'test', model: 'qwen3-8b', ...limits });
	assert.equal(created.status, 200, JSON.stringify(created.body));
	return created.body as { job: JobRecord; quote: EscrowQuote; ticket?: unknown };
}

/** Quote, escrow the maximum cost on the ledger (plus `extra`), and collect the ticket. */
async function escrowedJob(h: Harness, buyer: Buyer, options: { extra?: bigint } = {}) {
	const { quote: q } = await quote(h, buyer);
	const escrowed = BigInt(q.maxCost) + (options.extra ?? 0n);
	const blockHash = await h.ledger.publish(buyer.account, [{ to: q.settlement, amount: escrowed, token: q.token, external: q.jobId }]);
	const res = await h.call(buyer.signer, 'POST', `/v1/jobs/${q.jobId}/escrow`, { blockHash });
	assert.equal(res.status, 200, JSON.stringify(res.body));
	return { jobId: q.jobId, quote: q, escrowed, blockHash, ticket: (res.body as { ticket: SignedTicket }).ticket.ticket };
}

function receiptFor(t: JobTicket, buyer: string, options: { inputTokens?: number; outputTokens?: number; outputHash?: string; finishReason?: string } = {}): Receipt {
	const usage = { inputTokens: options.inputTokens ?? 5, outputTokens: options.outputTokens ?? 5 };
	return {
		v: 1, jobId: t.jobId, network: 'test', nodeKey: t.nodeKey, payTo: t.payTo, buyer, modelId: t.modelId,
		weightsHash: 'c'.repeat(64), runtime: { kind: 'mlx', build: 'x' }, ...usage, price: t.price,
		amount: jobCost(t.price, usage).toString(), asset: t.asset,
		startedAt: 0, finishedAt: 0, outputHash: options.outputHash ?? 'a'.repeat(64), finishReason: options.finishReason ?? 'stop'
	};
}

const fileReceipt = async (h: Harness, node: Signer, receipt: Receipt) => h.call(node, 'POST', `/v1/jobs/${receipt.jobId}/receipt`, { receipt: { receipt, signature: await node.sign(receiptMessage(receipt)) } });
const deliver = (h: Harness, jobId: string, outputHash: string, maxOutputTokens = 20) => h.call(null, 'POST', `/v1/relay/jobs/${jobId}/delivery`, { outputHash, maxOutputTokens }, ROUTER);

/** Settlement runs in the background after a receipt, failure or delivery record; wait for its payout block. */
async function paidOut(h: Harness, jobId: string): Promise<JobRecord> {
	for (let i = 0; i < 400; i++) {
		const job = await h.store.getJob(jobId);
		if (job?.settlement?.blockHash) {
			return job;
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.fail(`${jobId} was never paid out`);
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

test('an app job: quoted in credits, escrowed on the ledger before the ticket, paid out in one block from the relay record', async () => {
	const h = harness();
	const { node, operator } = await registerMac(h);
	const hb = await h.call(node, 'POST', '/v1/providers/heartbeat', { status: 'online', offers: [offer('qwen3-8b')], load: { active: 0, capacity: 2 } });
	assert.equal(hb.status, 200);
	assert.ok((hb.body as { relayToken: string }).relayToken);
	assert.equal((hb.body as { creditToken: string }).creditToken, CREDITS, 'providers learn which token app tickets are paid in');
	const models = await h.call(null, 'GET', '/v1/models?network=test');
	assert.deepEqual((models.body as { models: { id: string }[] }).models.map((m) => m.id), ['qwen3-8b']);

	/* The quote: the most the job can cost, in credits, to escrow with the settlement account. No ticket yet. */
	const buyer = newBuyer();
	const created = await quote(h, buyer, { maxInputTokens: 200, maxOutputTokens: 100 });
	const q = created.quote;
	assert.equal(created.ticket, undefined, 'nothing runs before the escrow');
	assert.equal(created.job.status, 'quoted');
	assert.deepEqual(q, {
		jobId: created.job.jobId,
		network: 'test',
		maxCost: maxJobCost(offer('qwen3-8b').price, { maxInputTokens: 200, maxOutputTokens: 100 }).toString(),
		token: CREDITS,
		decimals: CREDIT_DECIMALS,
		settlement: h.settlement.account,
		expiresAt: h.now() + QUOTE_TTL_MS
	});
	const escrow = (signer: Signer, blockHash: string) => h.call(signer, 'POST', `/v1/jobs/${q.jobId}/escrow`, { blockHash });
	const send = (overrides: Partial<{ to: string; amount: bigint; external: string }> = {}, options: { held?: boolean } = {}) =>
		h.ledger.publish(buyer.account, [{ to: q.settlement, amount: BigInt(q.maxCost), token: CREDITS, external: q.jobId, ...overrides }], options);

	/* Blocks that do not escrow this job, read from the ledger. */
	const refused = async (blockHash: string, why: string) => {
		const res = await escrow(buyer.signer, blockHash);
		assert.equal(res.status, 402, `${why}: ${JSON.stringify(res.body)}`);
	};
	await refused(await send({ amount: BigInt(q.maxCost) - 1n }), 'less than the quote');
	await refused(await send({ external: 'job_another' }), 'a send referencing another job');
	await refused(await send({ to: operator.publicKey }), 'paid to the provider instead of the settlement account');
	assert.equal((await escrow(newSigner(), await send())).status, 403, 'only the job\'s buyer reports its escrow');

	/* A block still on its way: pending, then the ticket once the ledger shows it. */
	const blockHash = await send({}, { held: true });
	const waiting = await escrow(buyer.signer, blockHash);
	assert.equal(waiting.status, 200);
	assert.equal((waiting.body as { pending?: boolean }).pending, true);
	h.ledger.release();
	const escrowed = await escrow(buyer.signer, blockHash);
	assert.equal(escrowed.status, 200, JSON.stringify(escrowed.body));
	const ticket = (escrowed.body as { ticket: SignedTicket }).ticket;
	assert.equal(ticket.ticket.payTo, operator.publicKey);
	assert.equal(ticket.ticket.paymentMode, 'escrow');
	assert.equal(ticket.ticket.asset, CREDITS);
	assert.ok(verifyKeetaSignature(h.coordinator.publicKey, ticketMessage(ticket.ticket), ticket.coordinatorSig));
	assert.equal(ticket.relayMac, await ticketMac('relay-secret', ticket.ticket));
	assert.equal((await escrow(buyer.signer, blockHash)).status, 200, 'reporting the same block again returns the ticket again');
	const another = await escrow(buyer.signer, await send());
	assert.equal(another.status, 409, 'one escrow block per job');

	/* The provider's receipt: priced exactly and signed by the node. */
	const receipt = receiptFor(ticket.ticket, buyer.address, { inputTokens: 150, outputTokens: 80, outputHash: 'd'.repeat(64) });
	const wrongAmount = { ...receipt, amount: '999999' };
	assert.equal((await h.call(node, 'POST', `/v1/jobs/${q.jobId}/receipt`, { receipt: { receipt: wrongAmount, signature: await node.sign(receiptMessage(wrongAmount)) } })).status, 400);
	assert.equal((await h.call(node, 'POST', `/v1/jobs/${q.jobId}/receipt`, { receipt: { receipt, signature: await buyer.signer.sign(receiptMessage(receipt)) } })).status, 401);
	assert.equal((await fileReceipt(h, node, receipt)).status, 200);
	assert.equal(h.payouts.published, 0, 'a receipt alone pays nothing until the relay records what it forwarded');

	/* The relay's record matches the receipt: one block pays the provider what it billed and returns the rest. */
	assert.equal((await h.call(null, 'POST', `/v1/relay/jobs/${q.jobId}/delivery`, { outputHash: 'd'.repeat(64), maxOutputTokens: 100 })).status, 401, 'only the relay records deliveries');
	assert.equal(((await deliver(h, q.jobId, 'd'.repeat(64), 100)).body as { recorded: boolean }).recorded, true);
	const settled = await paidOut(h, q.jobId);
	const payout = h.ledger.payouts(h.settlement.account, q.jobId);
	assert.deepEqual(payout.blocks, [settled.settlement!.blockHash], 'one payout block, recorded on the job');
	assert.deepEqual(payout.to, { [operator.publicKey]: BigInt(receipt.amount), [buyer.address]: BigInt(q.maxCost) - BigInt(receipt.amount) });
	assert.equal(settled.status, 'paid');
	assert.equal(settled.settlement!.reason, 'delivered');
	assert.ok(h.payouts.searched >= 1, 'the settlement account\'s history is searched before paying');

	/* The record keeps routing state and block hashes, never amounts or balances. */
	assert.deepEqual(Object.keys(settled.escrow!).sort(), ['at', 'blockHash']);
	assert.equal(settled.escrow!.blockHash, blockHash);
	assert.deepEqual(Object.keys(settled.settlement!).sort(), ['attemptAt', 'blockHash', 'decidedAt', 'reason', 'sentAt']);
	for (const field of ['amountDue', 'maxCost', 'payoutDue', 'payment']) {
		assert.ok(!(field in settled), `no ${field} on an app job`);
	}
	const me = (await h.call(node, 'GET', '/v1/providers/me')).body as { provider: { stats: Record<string, number>; load: { active: number } } };
	assert.deepEqual(me.provider.stats, { completed: 1, failed: 0, tokensOut: 80 }, 'scheduler counters only: earnings are the settlement account\'s payouts on the ledger');
	assert.equal(me.provider.load.active, 0);
	const mine = (await h.call(buyer.signer, 'GET', '/v1/jobs')).body as { jobs: JobRecord[] };
	assert.equal(mine.jobs.find((j) => j.jobId === q.jobId)?.settlement?.blockHash, payout.blocks[0], 'the buyer sees the payout block');

	/* The first delivery record stands. */
	assert.equal(((await deliver(h, q.jobId, 'b'.repeat(64))).body as { recorded: boolean }).recorded, false);
	assert.equal(h.payouts.published, 1);
});

test('the escrow comes back in full on a mismatch, a provider failure, a missing receipt or record, or an unused ticket', async () => {
	const h = harness();
	const { node, operator } = await registerMac(h);
	const online = () => h.call(node, 'POST', '/v1/providers/heartbeat', { status: 'online', offers: [offer('qwen3-8b')], load: { active: 0, capacity: 8 } });
	await online();
	const buyer = newBuyer();
	const refunded = async (jobId: string, escrowed: bigint) => {
		const job = await h.store.getJob(jobId);
		assert.deepEqual(h.ledger.payouts(h.settlement.account, jobId).to, { [buyer.address]: escrowed }, `${jobId}: all of it back to the buyer, nothing to the provider`);
		return job!;
	};

	/* The receipt bills text the relay did not forward. */
	const mismatch = await escrowedJob(h, buyer);
	await fileReceipt(h, node, receiptFor(mismatch.ticket, buyer.address, { outputHash: 'e'.repeat(64) }));
	await deliver(h, mismatch.jobId, 'd'.repeat(64));
	await paidOut(h, mismatch.jobId);
	const disputed = await refunded(mismatch.jobId, mismatch.escrowed);
	assert.equal(disputed.status, 'disputed');
	assert.equal(disputed.settlement!.reason, 'mismatch');

	/* More output tokens than the forwarded text can hold. */
	const inflated = await escrowedJob(h, buyer);
	await fileReceipt(h, node, receiptFor(inflated.ticket, buyer.address, { outputTokens: 9 }));
	await deliver(h, inflated.jobId, 'a'.repeat(64), 4);
	await paidOut(h, inflated.jobId);
	assert.equal((await refunded(inflated.jobId, inflated.escrowed)).settlement!.reason, 'mismatch');
	assert.equal((await h.store.getProvider(node.publicKey))!.stats.disputed, 2, 'the provider takes the strike');

	/* The provider fails the job. */
	const failed = await escrowedJob(h, buyer);
	assert.equal((await h.call(node, 'POST', `/v1/jobs/${failed.jobId}/fail`, { error: 'out of memory' })).status, 200);
	await paidOut(h, failed.jobId);
	assert.equal((await refunded(failed.jobId, failed.escrowed)).settlement!.reason, 'failed');

	/* A receipt can land before the relay's record, which the relay retries: settlement waits a minute for it, then refunds. */
	const noRecord = await escrowedJob(h, buyer);
	await fileReceipt(h, node, receiptFor(noRecord.ticket, buyer.address));
	const lateRecord = await escrowedJob(h, buyer);
	const lateReceipt = receiptFor(lateRecord.ticket, buyer.address);
	await fileReceipt(h, node, lateReceipt);
	h.advance(DELIVERY_GRACE_MS - 1);
	await deliver(h, lateRecord.jobId, 'a'.repeat(64));
	assert.equal((await paidOut(h, lateRecord.jobId)).settlement!.reason, 'delivered', 'a record within the grace still pays the provider');
	assert.equal(h.ledger.payouts(h.settlement.account, lateRecord.jobId).to[operator.publicKey], BigInt(lateReceipt.amount));
	assert.deepEqual(await h.service.sweep(), { expired: 0, settled: 0, paidOut: 0 }, 'a receipt is not refunded the moment it lands without a record');
	h.advance(2);
	assert.deepEqual(await h.service.sweep(), { expired: 0, settled: 1, paidOut: 0 });
	assert.equal((await refunded(noRecord.jobId, noRecord.escrowed)).settlement!.reason, 'no-delivery');
	assert.equal((await h.store.getProvider(node.publicKey))!.stats.disputed, 3, 'a receipt the relay never backed counts as a dispute');
	await deliver(h, noRecord.jobId, 'a'.repeat(64));
	assert.equal(h.ledger.payouts(h.settlement.account, noRecord.jobId).blocks.length, 1, 'a record after the refund changes nothing');

	/* At the lapse: a delivery record with no receipt, and a ticket never used. */
	const noReceipt = await escrowedJob(h, buyer);
	await deliver(h, noReceipt.jobId, 'a'.repeat(64));
	const unused = await escrowedJob(h, buyer);
	h.advance(SETTLE_LAPSE_MS - 1);
	await h.service.sweep();
	assert.equal(h.ledger.payouts(h.settlement.account, noReceipt.jobId).blocks.length, 0, 'nothing settles before the lapse');
	const freed = await h.store.getJob(unused.jobId);
	assert.equal(freed!.status, 'scheduled', 'an unused ticket stays open until the lapse');
	assert.ok(freed!.handedBackAt, 'but frees its provider once the ticket is stale');
	h.advance(2);
	const failedBefore = (await h.store.getProvider(node.publicKey))!.stats.failed;
	assert.deepEqual(await h.service.sweep(), { expired: 0, settled: 2, paidOut: 0 });
	assert.equal((await refunded(noReceipt.jobId, noReceipt.escrowed)).settlement!.reason, 'no-receipt');
	const lapsed = await refunded(unused.jobId, unused.escrowed);
	assert.equal(lapsed.status, 'expired');
	assert.equal(lapsed.settlement!.reason, 'expired');
	assert.equal((await h.store.getProvider(node.publicKey))!.stats.failed, failedBefore + 1, 'a delivery with no receipt counts as a failure');
	assert.equal(operator.publicKey in h.ledger.payouts(h.settlement.account, unused.jobId).to, false);
});

test('a payout is idempotent on the ledger: an attempt that published but never recorded is found, not paid twice', async () => {
	const h = harness();
	const { node, operator } = await registerMac(h);
	await h.call(node, 'POST', '/v1/providers/heartbeat', { status: 'online', offers: [offer('qwen3-8b')], load: { active: 0, capacity: 2 } });
	const buyer = newBuyer();
	const job = await escrowedJob(h, buyer);
	const receipt = receiptFor(job.ticket, buyer.address);
	await fileReceipt(h, node, receipt);

	h.payouts.failAfterPublish = true;
	await deliver(h, job.jobId, 'a'.repeat(64));
	for (let i = 0; i < 400 && !(await h.store.getJob(job.jobId))?.settlement?.error; i++) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	const unrecorded = (await h.store.getJob(job.jobId))!;
	assert.match(unrecorded.settlement!.error!, /connection dropped/);
	assert.equal(unrecorded.settlement!.blockHash, undefined, 'the store never heard of the block');
	assert.equal(h.ledger.payouts(h.settlement.account, job.jobId).blocks.length, 1, 'but the ledger has it');

	assert.deepEqual(await h.service.sweep(), { expired: 0, settled: 0, paidOut: 0 }, 'a retry waits until the attempt is stale');
	h.advance(PAYOUT_RETRY_MS + 1);
	assert.deepEqual(await h.service.sweep(), { expired: 0, settled: 0, paidOut: 1 });
	const recorded = (await h.store.getJob(job.jobId))!;
	const payout = h.ledger.payouts(h.settlement.account, job.jobId);
	assert.deepEqual(payout.blocks, [recorded.settlement!.blockHash], 'the block found on the ledger is recorded');
	assert.deepEqual(payout.to, { [operator.publicKey]: BigInt(receipt.amount), [buyer.address]: job.escrowed - BigInt(receipt.amount) }, 'paid once');
	assert.equal(h.payouts.published, 1);
	assert.equal(recorded.settlement!.error, undefined);
	assert.equal(recorded.payoutDue, undefined);
	h.advance(PAYOUT_RETRY_MS + 1);
	assert.deepEqual(await h.service.sweep(), { expired: 0, settled: 0, paidOut: 0 });
	assert.equal(h.payouts.published, 1);
});

test('a buyer who hands a ticket back mid-stream pays for what the relay forwarded, from the escrow on the ledger', async () => {
	const h = harness();
	const { node, operator } = await registerMac(h);
	const online = () => h.call(node, 'POST', '/v1/providers/heartbeat', { status: 'online', offers: [offer('qwen3-8b')], load: { active: 0, capacity: 1 } });
	await online();
	const buyer = newBuyer();
	/* The buyer escrowed a little more than the quote; the ledger's amount, not the quote, sets the refund. */
	const job = await escrowedJob(h, buyer, { extra: 7n });
	assert.equal((await h.call(newBuyer().signer, 'POST', `/v1/jobs/${job.jobId}/cancel`, {})).status, 403, 'only the buyer hands it back');
	assert.equal((await h.call(buyer.signer, 'POST', `/v1/jobs/${job.jobId}/cancel`, {})).status, 200);
	const handedBack = (await h.store.getJob(job.jobId))!;
	assert.equal(handedBack.status, 'scheduled', 'it stays open until it settles');
	assert.ok(handedBack.handedBackAt);
	await online();
	await quote(h, newBuyer());

	const receipt = receiptFor(job.ticket, buyer.address, { outputTokens: 2, finishReason: 'cancelled' });
	assert.equal((await fileReceipt(h, node, receipt)).status, 200, 'the provider files its receipt after the handback');
	await deliver(h, job.jobId, 'a'.repeat(64), 2);
	const settled = await paidOut(h, job.jobId);
	assert.equal(settled.settlement!.reason, 'delivered');
	assert.deepEqual(h.ledger.payouts(h.settlement.account, job.jobId).to, { [operator.publicKey]: BigInt(receipt.amount), [buyer.address]: job.escrowed - BigInt(receipt.amount) });
});

test('quotes: an escrow after expiry is refunded, quotes nobody escrows expire, and a buyer holds at most four', async () => {
	const h = harness();
	const { node } = await registerMac(h);
	const online = () => h.call(node, 'POST', '/v1/providers/heartbeat', { status: 'online', offers: [offer('qwen3-8b')], load: { active: 0, capacity: 16 } });
	await online();
	const buyer = newBuyer();
	const escrowLate = async (q: EscrowQuote) => {
		const blockHash = await h.ledger.publish(buyer.account, [{ to: q.settlement, amount: BigInt(q.maxCost), token: q.token, external: q.jobId }]);
		const res = await h.call(buyer.signer, 'POST', `/v1/jobs/${q.jobId}/escrow`, { blockHash });
		assert.equal(res.status, 409);
		assert.equal((res.body as { error: { code: string } }).error.code, 'quote_expired');
		const job = await paidOut(h, q.jobId);
		assert.equal(job.status, 'expired');
		assert.deepEqual(h.ledger.payouts(h.settlement.account, q.jobId).to, { [buyer.address]: BigInt(q.maxCost) });
	};

	/* Escrowed after the quote lapsed: before the sweep noticed, and after. */
	const late = (await quote(h, buyer)).quote;
	h.advance(QUOTE_TTL_MS + 1);
	await escrowLate(late);
	const swept = (await quote(h, buyer)).quote;
	h.advance(QUOTE_TTL_MS + 1);
	assert.deepEqual(await h.service.sweep(), { expired: 1, settled: 0, paidOut: 0 });
	assert.equal((await h.call(buyer.signer, 'POST', `/v1/jobs/${swept.jobId}/cancel`, {})).status, 200, 'cancelling an expired quote is harmless');
	await escrowLate(swept);

	/* Four open quotes per buyer, even when the requests race. */
	await online();
	const raced = await Promise.all([1, 2, 3, 4, 5, 6].map(() => h.call(buyer.signer, 'POST', '/v1/jobs', { network: 'test', model: 'qwen3-8b', ...LIMITS })));
	assert.deepEqual(raced.map((r) => r.status).sort(), [200, 200, 200, 200, 429, 429]);
	const open = raced.find((r) => r.status === 200)!.body as { quote: EscrowQuote };
	assert.equal((await h.call(buyer.signer, 'POST', `/v1/jobs/${open.quote.jobId}/cancel`, {})).status, 200);
	await quote(h, buyer);
	assert.equal((await quote(h, newBuyer())).job.status, 'quoted', 'the cap is per buyer');
});

test('a quote needs the buyer to hold the job\'s maximum cost in credits on the ledger, so empty keys cannot hold providers', async () => {
	const balances = new Map<string, bigint>();
	let ledgerDown = false;
	const reads: Array<{ network: string; account: string; token: string }> = [];
	const h = harness({
		creditBalanceOf: async (args) => {
			reads.push(args);
			if (ledgerDown) {
				throw new Error('connection reset');
			}
			return balances.get(args.account) ?? 0n;
		}
	});
	const { node } = await registerMac(h);
	await h.call(node, 'POST', '/v1/providers/heartbeat', { status: 'online', offers: [offer('qwen3-8b')], load: { active: 0, capacity: 1 } });
	const needed = maxJobCost(offer('qwen3-8b').price, LIMITS);
	const ask = (buyer: Buyer) => h.call(buyer.signer, 'POST', '/v1/jobs', { network: 'test', model: 'qwen3-8b', ...LIMITS });

	const empty = newBuyer();
	const refused = await ask(empty);
	assert.equal(refused.status, 402, JSON.stringify(refused.body));
	assert.match(JSON.stringify(refused.body), /buy credits/);
	assert.deepEqual(reads[0], { network: 'test', account: empty.address, token: CREDITS }, 'the balance read is of the credit token, for the signing buyer');
	balances.set(empty.address, needed - 1n);
	assert.equal((await ask(empty)).status, 402, 'one base unit short');

	ledgerDown = true;
	const unread = await ask(empty);
	assert.equal(unread.status, 503, 'a ledger that cannot be read refuses the quote rather than skipping the check');
	ledgerDown = false;

	/* None of the refusals held the provider's only slot. */
	const funded = newBuyer();
	balances.set(funded.address, needed);
	const created = await quote(h, funded);
	assert.equal(created.job.status, 'quoted');
	assert.equal(created.quote.maxCost, needed.toString());
});

test('quotes waiting for escrow must fit in the buyer\'s balance together, so one balance cannot hold several providers', async () => {
	const balances = new Map<string, bigint>();
	const h = harness({ creditBalanceOf: async (args) => balances.get(args.account) ?? 0n });
	const { node } = await registerMac(h);
	const online = () => h.call(node, 'POST', '/v1/providers/heartbeat', { status: 'online', offers: [offer('qwen3-8b')], load: { active: 0, capacity: 16 } });
	await online();
	const needed = maxJobCost(offer('qwen3-8b').price, LIMITS);
	const ask = (buyer: Buyer) => h.call(buyer.signer, 'POST', '/v1/jobs', { network: 'test', model: 'qwen3-8b', ...LIMITS });
	const held = async () => (await h.store.getProvider(node.publicKey))!.load.active;

	/* One quote's worth of credits backs one quote, even when the requests race. */
	const buyer = newBuyer();
	balances.set(buyer.address, needed);
	const raced = await Promise.all([1, 2, 3, 4].map(() => ask(buyer)));
	assert.deepEqual(raced.map((r) => r.status).sort(), [200, 402, 402, 402], JSON.stringify(raced.map((r) => r.body)));
	assert.match(JSON.stringify(raced.find((r) => r.status === 402)!.body), /waiting for escrow/);
	assert.equal(await held(), 1, 'the refused quotes hold no slot');

	/* Cancelling the quote frees its share of the balance; an expired one stops counting. */
	const open = raced.find((r) => r.status === 200)!.body as { quote: EscrowQuote };
	assert.equal((await h.call(buyer.signer, 'POST', `/v1/jobs/${open.quote.jobId}/cancel`, {})).status, 200);
	await quote(h, buyer);
	assert.equal((await ask(buyer)).status, 402);
	h.advance(QUOTE_TTL_MS + 1);
	await online();
	await quote(h, buyer);

	/* Twice the credits back two quotes at once, and an escrowed quote stops counting (its credits left the balance). */
	const larger = newBuyer();
	balances.set(larger.address, 2n * needed);
	const first = await quote(h, larger);
	await quote(h, larger);
	assert.equal((await ask(larger)).status, 402);
	const blockHash = await h.ledger.publish(larger.account, [{ to: first.quote.settlement, amount: needed, token: first.quote.token, external: first.quote.jobId }]);
	assert.equal((await h.call(larger.signer, 'POST', `/v1/jobs/${first.quote.jobId}/escrow`, { blockHash })).status, 200);
	balances.set(larger.address, needed);
	assert.equal((await ask(larger)).status, 402, 'the second quote still waits on the credits that are left');
	balances.set(larger.address, 2n * needed);
	await quote(h, larger);
});

test('app jobs need the credit token and the settlement account; /v1/config publishes both and the stablecoins in lead order', async () => {
	const off = harness({ credits: false });
	const { node } = await registerMac(off);
	await off.call(node, 'POST', '/v1/providers/heartbeat', { status: 'online', offers: [offer('qwen3-8b')], load: { active: 0, capacity: 2 } });
	const refused = await off.call(newSigner(), 'POST', '/v1/jobs', { network: 'test', model: 'qwen3-8b', ...LIMITS });
	assert.equal(refused.status, 403);
	assert.match(JSON.stringify(refused.body), /Keeta Compute Credits/);
	assert.deepEqual(((await off.call(null, 'GET', '/v1/config')).body as { credits: unknown }).credits, { test: null });

	const h = harness();
	const config = (await h.call(null, 'GET', '/v1/config')).body as { credits: Record<string, unknown>; assets: Record<string, Array<{ symbol: string }>> };
	assert.deepEqual(config.credits, { test: { token: CREDITS, decimals: CREDIT_DECIMALS, symbol: 'credits', name: CREDIT_NAME, settlement: h.settlement.account, fx: FX } });
	assert.deepEqual(config.assets.test!.map((a) => a.symbol), assetListing('test').map((a) => a.symbol));
	assert.equal(config.assets.test![0]!.symbol, 'KUSD');

	/* The test-network override never reaches the main network, whose credits come only from the pins. */
	assert.deepEqual(creditsFromEnv({ ...SECRETS, TEST_CREDIT_TOKEN: CREDITS, TEST_FX_ACCOUNT: FX }, ['test', 'main']), { test: { token: CREDITS, decimals: CREDIT_DECIMALS, fx: FX } });
	assert.throws(() => creditsFromEnv({ ...SECRETS, TEST_CREDIT_TOKEN: 'nope' }, ['test']), /TEST_CREDIT_TOKEN/);
});

test('allowlisted offers only serve listed buyers and never router traffic', async () => {
	const h = harness();
	const friend = newSigner();
	const stranger = newSigner();
	const { node } = await registerMac(h);
	await h.call(node, 'POST', '/v1/providers/heartbeat', { status: 'online', offers: [offer('qwen3-14b', { access: { mode: 'allowlist', allow: [friend.publicKey] } })], load: { active: 0, capacity: 4 } });
	assert.equal((await h.call(stranger, 'POST', '/v1/jobs', { network: 'test', model: 'qwen3-14b', maxInputTokens: 10, maxOutputTokens: 10 })).status, 503);
	assert.equal((await h.call(friend, 'POST', '/v1/jobs', { network: 'test', model: 'qwen3-14b', maxInputTokens: 10, maxOutputTokens: 10 })).status, 200);
	const routerQuote = await h.call(null, 'POST', '/v1/router/quote', { network: 'test', model: 'qwen3-14b', maxInputTokens: 10, maxOutputTokens: 10 }, ROUTER);
	assert.equal(routerQuote.status, 503);
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
	assert.equal((await h.call(buyer, 'POST', '/v1/jobs', { network: 'test', model: 'qwen3-8b', maxInputTokens: 10, maxOutputTokens: 10 })).status, 503, 'capacity 1 is held by the quote');
	h.advance(5 * 60_000);
	await h.call(node, 'POST', '/v1/providers/heartbeat', { status: 'online', offers: [offer('qwen3-8b')], load: { active: 0, capacity: 1 } });
	h.advance(5 * 60_000);
	assert.equal((await h.call(buyer, 'POST', '/v1/jobs', { network: 'test', model: 'qwen3-8b', maxInputTokens: 10, maxOutputTokens: 10 })).status, 503, 'stale provider');
});

test('a heartbeat keeps quoted and ticketed slots held, and a buyer cancel or provider fail frees them', async () => {
	const h = harness();
	const { node } = await registerMac(h);
	const beat = () => h.call(node, 'POST', '/v1/providers/heartbeat', { status: 'online', offers: [offer('qwen3-8b')], load: { active: 0, capacity: 1 } });
	await beat();
	const buyer = newBuyer();
	const job = () => h.call(buyer.signer, 'POST', '/v1/jobs', { network: 'test', model: 'qwen3-8b', ...LIMITS });
	const first = await job();
	assert.equal(first.status, 200);
	await beat();
	assert.equal((await job()).status, 503, 'the quote still holds the only slot after a heartbeat');
	const jobId = (first.body as { job: { jobId: string } }).job.jobId;
	assert.equal((await h.call(newSigner(), 'POST', `/v1/jobs/${jobId}/cancel`, {})).status, 403, 'only the buyer can cancel');
	assert.equal((await h.call(buyer.signer, 'POST', `/v1/jobs/${jobId}/cancel`, {})).status, 200);
	assert.equal((await h.call(buyer.signer, 'POST', `/v1/jobs/${jobId}/cancel`, {})).status, 200, 'cancelling twice is harmless');
	await beat();
	const second = await escrowedJob(h, buyer);
	await beat();
	assert.equal((await job()).status, 503, 'the ticket holds the slot, and a repeated cancel freed only one');
	assert.equal((await h.call(node, 'POST', `/v1/jobs/${second.jobId}/fail`, { error: 'busy' })).status, 200);
	assert.equal((await job()).status, 200, 'a job the provider rejected frees its slot');
});

test('machines under 32 GB register but are never scheduled', async () => {
	const h = harness();
	const { node } = await registerMac(h, 16);
	const hb = await h.call(node, 'POST', '/v1/providers/heartbeat', { status: 'online', offers: [offer('llama-3.2-3b-instruct')] });
	assert.equal((hb.body as { eligible: boolean; status: string }).eligible, false);
	assert.equal((hb.body as { status: string }).status, 'paused');
});

test('router quotes are prepaid to the provider over x402 in the default stablecoin, at a credit to the dollar', async () => {
	const h = harness();
	const { node, operator } = await registerMac(h);
	await h.call(node, 'POST', '/v1/providers/heartbeat', { status: 'online', offers: [offer('qwen3-8b')], load: { active: 0, capacity: 2 } });
	assert.equal((await h.call(null, 'POST', '/v1/router/quote', { network: 'test', model: 'qwen3-8b', maxInputTokens: 10, maxOutputTokens: 10 })).status, 401);
	const routerQuote = await h.call(null, 'POST', '/v1/router/quote', { network: 'test', model: 'qwen3-8b', maxInputTokens: 1000, maxOutputTokens: 1000 }, ROUTER);
	assert.equal(routerQuote.status, 200);
	const { job, asset } = routerQuote.body as { job: { jobId: string; payTo: string; prepaidAmount: string; asset: string; paymentMode: string }; asset: { symbol: string; address: string; decimals: number } };
	const stablecoin = defaultAsset('test');
	assert.deepEqual(asset, { symbol: stablecoin.symbol, address: stablecoin.address, decimals: stablecoin.decimals }, 'KUSD once it is pinned, else USDC');
	assert.equal(job.asset, stablecoin.address);
	assert.equal(job.paymentMode, 'prepaid');
	assert.equal(job.payTo, operator.publicKey);
	/* 1000 tokens each way at 0.1 and 0.4 credits per million: 0.0005 credits, the same in dollars. */
	assert.equal(job.prepaidAmount, rescaleAmount(500n, CREDIT_DECIMALS, stablecoin.decimals).toString());
	const settled = await h.call(null, 'POST', `/v1/router/jobs/${job.jobId}/settled`, { payer: newSigner().publicKey, transaction: 'tx' }, ROUTER);
	assert.equal(settled.status, 200);
	for (let i = 0; i < 5; i++) {
		const unpaid = await h.call(null, 'POST', '/v1/router/quote', { network: 'test', model: 'qwen3-8b', maxInputTokens: 10, maxOutputTokens: 10 }, ROUTER);
		assert.equal(unpaid.status, 200, 'unpaid quotes do not use up the provider');
	}
	assert.equal((await h.call(newSigner(), 'POST', '/v1/jobs', { network: 'test', model: 'qwen3-8b', maxInputTokens: 10, maxOutputTokens: 10 })).status, 200);
	assert.equal(h.payouts.published, 0, 'router jobs never touch the settlement account');
});

test('router quotes fall back to OpenRouter only when no provider is free', async () => {
	const house = newSigner();
	const fallback = fallbackFromEnv({
		...SECRETS,
		FALLBACK_PAY_TO: house.publicKey,
		FALLBACK_MODELS: JSON.stringify({ 'qwen3-8b': { route: 'qwen/qwen3-8b', price: { inputPerMillion: '200000', outputPerMillion: '800000' }, contextLength: 32768 } })
	})!;
	assert.throws(() => fallbackFromEnv({ ...SECRETS, FALLBACK_PAY_TO: house.publicKey, FALLBACK_MODELS: '{"qwen3-8b":{"route":"x y","price":{"inputPerMillion":"1","outputPerMillion":"1"},"contextLength":4096}}' }));
	const h = harness({ fallback });
	const routerQuote = (model: string) => h.call(null, 'POST', '/v1/router/quote', { network: 'test', model, maxInputTokens: 1000, maxOutputTokens: 1000 }, ROUTER);

	const viaFallback = await routerQuote('qwen3-8b');
	assert.equal(viaFallback.status, 200, JSON.stringify(viaFallback.body));
	const { job, ticket } = viaFallback.body as { job: { jobId: string; payTo: string; prepaidAmount: string; fallback?: unknown }; ticket: { ticket: Parameters<typeof ticketMac>[1]; relayMac: string } };
	assert.deepEqual(job.fallback, { via: 'openrouter', model: 'qwen/qwen3-8b' }, 'the route is kept on the job');
	assert.ok(!JSON.stringify(ticket).includes('openrouter'), 'the ticket buyers see does not name the fallback');
	assert.equal(job.payTo, house.publicKey, 'fallback payments go to the keeta.ai account');
	assert.equal(job.prepaidAmount, rescaleAmount(1000n, CREDIT_DECIMALS, defaultAsset('test').decimals).toString());
	assert.equal(ticket.relayMac, await ticketMac('relay-secret', ticket.ticket), 'the MAC covers the ticket');
	assert.equal((await routerQuote('llama-3.2-3b')).status, 503, 'models without a fallback route still get 503');

	const claim = () => h.call(null, 'POST', `/v1/router/jobs/${job.jobId}/claim`, {}, ROUTER);
	assert.deepEqual((await claim()).body, { fallback: { via: 'openrouter', model: 'qwen/qwen3-8b' } });
	assert.equal((await claim()).status, 409, 'a quote starts one upstream run');
	const settled = await h.call(null, 'POST', `/v1/router/jobs/${job.jobId}/settled`, { payer: newSigner().publicKey, transaction: 'tx' }, ROUTER);
	assert.equal((settled.body as { status: string }).status, 'paid', 'a fallback job is complete once paid');

	const models = await h.call(null, 'GET', '/v1/models?network=test&fallback=1');
	assert.deepEqual((models.body as { models: Array<{ id: string; providers: number; fallback?: unknown }> }).models.map((m) => [m.id, m.providers, !!m.fallback]), [['qwen3-8b', 0, true]]);
	assert.equal(((await h.call(null, 'GET', '/v1/models?network=test')).body as { models: unknown[] }).models.length, 0, 'app buyers only see network providers');

	const { node, operator } = await registerMac(h);
	await h.call(node, 'POST', '/v1/providers/heartbeat', { status: 'online', offers: [offer('qwen3-8b')], load: { active: 0, capacity: 2 } });
	const viaProvider = await routerQuote('qwen3-8b');
	assert.equal((viaProvider.body as { job: { payTo: string; fallback?: unknown } }).job.payTo, operator.publicKey, 'a free provider is always preferred');
	assert.equal((viaProvider.body as { job: { fallback?: unknown } }).job.fallback, undefined);
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

test('Linux nodes with their own wallet register with a link proof and can pair helpers', async () => {
	const h = harness();
	const node = newSigner();
	const operator = newSigner();
	const linux = hardware(128, 'linux');
	const register = (body: Record<string, unknown>) => h.call(node, 'POST', '/v1/providers/register', { network: 'test', kind: 'linux', name: 'gpu-box', hardware: linux, ...body });
	assert.equal((await register({ payTo: operator.publicKey })).status, 400, 'the link proof is required');
	const forged = await newSigner().sign(operatorLinkMessage({ nodeKey: node.publicKey, payTo: operator.publicKey, network: 'test', issuedAt: h.now() }));
	assert.equal((await register({ payTo: operator.publicKey, link: { issuedAt: h.now(), signature: forged } })).status, 401, 'signed by someone else');
	const issuedAt = h.now();
	const link = await operator.sign(operatorLinkMessage({ nodeKey: node.publicKey, payTo: operator.publicKey, network: 'test', issuedAt }));
	const registered = await register({ payTo: operator.publicKey, link: { issuedAt, signature: link } });
	assert.equal(registered.status, 200, JSON.stringify(registered.body));
	const provider = (registered.body as { provider: { kind: string; payTo: string } }).provider;
	assert.equal(provider.kind, 'linux');
	assert.equal(provider.payTo, operator.publicKey, 'a Linux node is paid to its own operator');

	/* It schedules and earns like a Mac. */
	await h.call(node, 'POST', '/v1/providers/heartbeat', { status: 'online', offers: [offer('qwen3-8b')], load: { active: 0, capacity: 1 } });
	const job = await h.call(newSigner(), 'POST', '/v1/jobs', { network: 'test', model: 'qwen3-8b', maxInputTokens: 10, maxOutputTokens: 10 });
	assert.equal(job.status, 200, JSON.stringify(job.body));
	assert.equal((job.body as { job: { payTo: string } }).job.payTo, operator.publicKey);

	/* And it can be a pairing master; its helpers pay its operator. */
	const code = generatePairingCode();
	const created = await h.call(node, 'POST', '/v1/pairing', { codeHash: await pairingCodeHash(code) });
	assert.equal(created.status, 200, JSON.stringify(created.body));
	const { pairingId } = created.body as { pairingId: string };
	const helper = newSigner();
	assert.equal((await h.call(helper, 'POST', '/v1/pairing/claim', { codeHash: await pairingCodeHash(code), descriptor: { ...linux, name: 'gpu-2' } })).status, 200);
	const approvalSig = await node.sign(pairingApprovalMessage({ pairingId, helperNodeKey: helper.publicKey, masterNodeKey: node.publicKey, payTo: operator.publicKey }));
	assert.equal((await h.call(node, 'POST', `/v1/pairing/${pairingId}/approve`, { approvalSig })).status, 200);
	const helperRegistered = await h.call(helper, 'POST', '/v1/providers/register', { network: 'test', kind: 'linux-helper', name: 'gpu-2', hardware: linux });
	assert.equal((helperRegistered.body as { provider: { payTo: string } }).provider.payTo, operator.publicKey);

	/* A helper cannot pair helpers of its own, nor claim to be a full node without a link. */
	const nested = await h.call(helper, 'POST', '/v1/pairing', { codeHash: await pairingCodeHash(generatePairingCode()) });
	assert.equal(nested.status, 403);
	assert.match(JSON.stringify(nested.body), /Mac or Linux node/);
	assert.equal((await h.call(helper, 'POST', '/v1/providers/register', { network: 'test', kind: 'linux', hardware: linux, payTo: operator.publicKey })).status, 403);
	assert.equal((await h.call(newSigner(), 'POST', '/v1/providers/register', { network: 'test', kind: 'linux-box', hardware: linux })).status, 400);

	/* Nor turn itself into a full node with a wallet of its own, which would drop its master's payTo and allowlist. */
	const own = newSigner();
	const ownIssuedAt = h.now();
	const ownLink = await own.sign(operatorLinkMessage({ nodeKey: helper.publicKey, payTo: own.publicKey, network: 'test', issuedAt: ownIssuedAt }));
	const breakaway = await h.call(helper, 'POST', '/v1/providers/register', { network: 'test', kind: 'linux', hardware: linux, payTo: own.publicKey, link: { issuedAt: ownIssuedAt, signature: ownLink } });
	assert.equal(breakaway.status, 403);
	const stillHelper = (await h.store.getProvider(helper.publicKey))!;
	assert.equal(stillHelper.masterNodeKey, node.publicKey);
	assert.equal(stillHelper.payTo, operator.publicKey);
});
