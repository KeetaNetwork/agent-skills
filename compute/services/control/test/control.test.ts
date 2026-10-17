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
	NO_SHOW_FEE,
	networkFee,
	providerShare,
	NO_SHOW_WINDOW_MS,
	escrowAmount,
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
	type AccessPolicy,
	type EscrowQuote,
	type HardwareProfile,
	type JobRecord,
	type JobTicket,
	type NetworkName,
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

	/** A published block in the base64 form an x402 payment carries it in. */
	encoded(hash: string): string {
		const block = this.blocks.get(hash) ?? this.held.get(hash);
		return Buffer.from(block!.toBytes(true)).toString('base64');
	}

	release(): void {
		for (const [hash, block] of this.held) {
			this.blocks.set(hash, block);
		}
		this.held.clear();
	}

	/** Every send of a token (credits unless named) on the ledger. */
	sends(token: string = CREDITS): Array<{ block: string; from: string; to: string; amount: bigint; reference: string | undefined }> {
		return [...this.blocks.values()].flatMap((block) =>
			block.operations.flatMap((operation) => {
				if (operation.type !== KeetaNet.lib.Block.OperationType.SEND) {
					return [];
				}
				const send = operation as InstanceType<typeof KeetaNet.lib.Block.Operation.SEND>;
				if (send.token.publicKeyString.get() !== token) {
					return [];
				}
				return [{ block: block.hash.toString().toUpperCase(), from: block.account.publicKeyString.get(), to: send.to.publicKeyString.get(), amount: send.amount, reference: send.external }];
			})
		);
	}

	/** What the settlement account sent for a job, by recipient. */
	payouts(settlement: string, jobId: string, token: string = CREDITS): { blocks: string[]; to: Record<string, bigint> } {
		const sends = this.sends(token).filter((s) => s.from === settlement && s.reference === jobId);
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

function harness(options: { fallback?: FallbackConfig; credits?: boolean; creditBalanceOf?: CreditBalanceReader; networks?: NetworkName[] } = {}) {
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
		networks: options.networks ?? ['test'],
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
const deliver = (h: Harness, jobId: string, outputHash: string, maxOutputTokens = 20, timing: Record<string, unknown> = {}) =>
	h.call(null, 'POST', `/v1/relay/jobs/${jobId}/delivery`, { outputHash, maxOutputTokens, ...timing }, ROUTER);

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

	/* The quote: the most the job can cost (at least the no-show fee), in credits, to escrow with the settlement account. No ticket yet. */
	const buyer = newBuyer();
	const created = await quote(h, buyer, { maxInputTokens: 200, maxOutputTokens: 100 });
	const q = created.quote;
	assert.equal(created.ticket, undefined, 'nothing runs before the escrow');
	assert.equal(created.job.status, 'quoted');
	assert.deepEqual(q, {
		jobId: created.job.jobId,
		network: 'test',
		maxCost: escrowAmount(offer('qwen3-8b').price, { maxInputTokens: 200, maxOutputTokens: 100 }).toString(),
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

	/* The relay's record matches the receipt: one block pays the provider what it billed less the network fee, and returns the rest. */
	assert.equal((await h.call(null, 'POST', `/v1/relay/jobs/${q.jobId}/delivery`, { outputHash: 'd'.repeat(64), maxOutputTokens: 100 })).status, 401, 'only the relay records deliveries');
	assert.equal(((await deliver(h, q.jobId, 'd'.repeat(64), 100)).body as { recorded: boolean }).recorded, true);
	const settled = await paidOut(h, q.jobId);
	const payout = h.ledger.payouts(h.settlement.account, q.jobId);
	assert.deepEqual(payout.blocks, [settled.settlement!.blockHash], 'one payout block, recorded on the job');
	assert.deepEqual(payout.to, { [operator.publicKey]: providerShare(BigInt(receipt.amount)), [buyer.address]: BigInt(q.maxCost) - BigInt(receipt.amount) });
	assert.ok(networkFee(BigInt(receipt.amount)) > 0n, 'the settlement account keeps the network fee');
	assert.equal(BigInt(q.maxCost) - Object.values(payout.to).reduce((a, b) => a + b, 0n), networkFee(BigInt(receipt.amount)));
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

test('the escrow comes back in full on a mismatch, a provider failure or a missing receipt or record, and less the no-show fee for a ticket never brought to the relay', async () => {
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
	assert.equal(h.ledger.payouts(h.settlement.account, lateRecord.jobId).to[operator.publicKey], providerShare(BigInt(lateReceipt.amount)));
	assert.deepEqual(await h.service.sweep(), { expired: 0, settled: 0, paidOut: 0 }, 'a receipt is not refunded the moment it lands without a record');
	h.advance(2);
	assert.deepEqual(await h.service.sweep(), { expired: 0, settled: 1, paidOut: 0 });
	assert.equal((await refunded(noRecord.jobId, noRecord.escrowed)).settlement!.reason, 'no-delivery');
	assert.equal((await h.store.getProvider(node.publicKey))!.stats.disputed, 3, 'a receipt the relay never backed counts as a dispute');
	await deliver(h, noRecord.jobId, 'a'.repeat(64));
	assert.equal(h.ledger.payouts(h.settlement.account, noRecord.jobId).blocks.length, 1, 'a record after the refund changes nothing');

	/* At the lapse: a delivery record with no receipt, a ticket the relay could not forward (the provider was offline), and a ticket never brought to the relay. */
	const noReceipt = await escrowedJob(h, buyer);
	await deliver(h, noReceipt.jobId, 'a'.repeat(64));
	const offline = await escrowedJob(h, buyer);
	assert.equal((await h.call(null, 'POST', `/v1/relay/jobs/${offline.jobId}/provider-offline`, {})).status, 401, 'only the relay records it');
	assert.equal(((await h.call(null, 'POST', `/v1/relay/jobs/${offline.jobId}/provider-offline`, {}, ROUTER)).body as { recorded: boolean }).recorded, true);
	assert.equal((await h.call(buyer.signer, 'POST', `/v1/jobs/${offline.jobId}/cancel`, {})).status, 200);
	/* Escrowed with a little extra, so the refund past the fee shows. */
	const unused = await escrowedJob(h, buyer, { extra: 500n });
	h.advance(SETTLE_LAPSE_MS - 1);
	await h.service.sweep();
	assert.equal(h.ledger.payouts(h.settlement.account, noReceipt.jobId).blocks.length, 0, 'nothing settles before the lapse');
	const freed = await h.store.getJob(unused.jobId);
	assert.equal(freed!.status, 'scheduled', 'an unused ticket stays open until the lapse');
	assert.ok(freed!.handedBackAt, 'but frees its provider once the ticket is stale');
	h.advance(2);
	const failedBefore = (await h.store.getProvider(node.publicKey))!.stats.failed;
	assert.deepEqual(await h.service.sweep(), { expired: 0, settled: 3, paidOut: 0 });
	assert.equal((await refunded(noReceipt.jobId, noReceipt.escrowed)).settlement!.reason, 'no-receipt');
	assert.equal((await refunded(offline.jobId, offline.escrowed)).settlement!.reason, 'no-receipt', 'the buyer showed up, so it pays no fee');
	assert.equal((await h.store.getProvider(node.publicKey))!.stats.failed, failedBefore + 2, 'a delivery with no receipt, or an offline provider, counts as a failure');
	/* The ticket held the provider's slot and the buyer never brought it to the relay: the provider keeps the no-show fee. */
	const lapsed = (await h.store.getJob(unused.jobId))!;
	assert.equal(lapsed.status, 'expired');
	assert.equal(lapsed.settlement!.reason, 'no-show');
	assert.deepEqual(h.ledger.payouts(h.settlement.account, unused.jobId).to, { [operator.publicKey]: NO_SHOW_FEE, [buyer.address]: unused.escrowed - NO_SHOW_FEE });
});

test('a ticket not used promptly pays its provider the no-show fee: brought to the relay late, or hung up on before any text', async () => {
	const h = harness();
	const { node, operator } = await registerMac(h);
	await h.call(node, 'POST', '/v1/providers/heartbeat', { status: 'online', offers: [offer('qwen3-8b')], load: { active: 0, capacity: 8 } });
	const buyer = newBuyer();
	const payouts = (jobId: string) => h.ledger.payouts(h.settlement.account, jobId).to;
	const nothing = 'e'.repeat(64);

	/* Brought to the relay on time: the bill only. Brought late: it runs and bills, and the provider also gets the fee. */
	const prompt = await escrowedJob(h, buyer, { extra: 5_000n });
	const promptReceipt = receiptFor(prompt.ticket, buyer.address);
	await fileReceipt(h, node, promptReceipt);
	await deliver(h, prompt.jobId, 'a'.repeat(64), 20, { presentedAt: h.now() + 500 });
	assert.equal((await paidOut(h, prompt.jobId)).settlement!.noShow, undefined);
	assert.deepEqual(payouts(prompt.jobId), { [operator.publicKey]: providerShare(BigInt(promptReceipt.amount)), [buyer.address]: prompt.escrowed - BigInt(promptReceipt.amount) });
	const late = await escrowedJob(h, buyer, { extra: 5_000n });
	const lateReceipt = receiptFor(late.ticket, buyer.address);
	await fileReceipt(h, node, lateReceipt);
	await deliver(h, late.jobId, 'a'.repeat(64), 20, { presentedAt: h.now() + NO_SHOW_WINDOW_MS + 1 });
	const lateSettled = await paidOut(h, late.jobId);
	assert.deepEqual([lateSettled.status, lateSettled.settlement!.reason, lateSettled.settlement!.noShow], ['paid', 'delivered', true]);
	const lateOwed = BigInt(lateReceipt.amount) + NO_SHOW_FEE;
	/* The network fee is on the billed tokens only, never on the no-show fee. */
	assert.deepEqual(payouts(late.jobId), { [operator.publicKey]: lateOwed - networkFee(BigInt(lateReceipt.amount)), [buyer.address]: late.escrowed - lateOwed });

	/* Hung up before any text: soon after arriving it is a no-show; after waiting out the window, the provider stalled and the buyer gets it all back. */
	const quit = await escrowedJob(h, buyer, { extra: 5_000n });
	const waited = await escrowedJob(h, buyer);
	const arrived = h.now() + 500;
	await deliver(h, quit.jobId, nothing, 16, { presentedAt: arrived, abandonedAt: arrived + 1_500 });
	await deliver(h, waited.jobId, nothing, 16, { presentedAt: arrived, abandonedAt: arrived + NO_SHOW_WINDOW_MS + 1 });
	assert.equal((await deliver(h, 'job_any', nothing, 16, { presentedAt: 'soon' })).status, 400, 'times are milliseconds');
	h.advance(SETTLE_LAPSE_MS + 1);
	const failedBefore = (await h.store.getProvider(node.publicKey))!.stats.failed;
	await h.service.sweep();
	const quitSettled = (await h.store.getJob(quit.jobId))!;
	assert.deepEqual([quitSettled.status, quitSettled.settlement!.reason, quitSettled.settlement!.noShow], ['expired', 'no-show', true]);
	assert.deepEqual(payouts(quit.jobId), { [operator.publicKey]: NO_SHOW_FEE, [buyer.address]: quit.escrowed - NO_SHOW_FEE });
	assert.equal((await h.store.getJob(waited.jobId))!.settlement!.reason, 'no-receipt');
	assert.deepEqual(payouts(waited.jobId), { [buyer.address]: waited.escrowed });
	assert.equal((await h.store.getProvider(node.publicKey))!.stats.failed, failedBefore + 1, 'only the stall counts against the provider');
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
	assert.deepEqual(payout.to, { [operator.publicKey]: providerShare(BigInt(receipt.amount)), [buyer.address]: job.escrowed - BigInt(receipt.amount) }, 'paid once');
	assert.equal(h.payouts.published, 1);
	assert.equal(recorded.settlement!.error, undefined);
	assert.equal(recorded.payoutDue, undefined);
	h.advance(PAYOUT_RETRY_MS + 1);
	assert.deepEqual(await h.service.sweep(), { expired: 0, settled: 0, paidOut: 0 });
	assert.equal(h.payouts.published, 1);
});

test('a job keeps only a small signed receipt, and a job the sweep cannot settle does not stop it settling the rest', async () => {
	const h = harness();
	const { node } = await registerMac(h);
	await h.call(node, 'POST', '/v1/providers/heartbeat', { status: 'online', offers: [offer('qwen3-8b')], load: { active: 0, capacity: 4 } });
	const buyer = newBuyer();

	/* Padding inside the receipt is covered by the node's signature, so a large receipt is refused; fields beside it are not signed, so they are dropped. */
	const padded = await escrowedJob(h, buyer);
	const large = await fileReceipt(h, node, { ...receiptFor(padded.ticket, buyer.address), pad: 'x'.repeat(8_192) } as Receipt);
	assert.equal(large.status, 400, JSON.stringify(large.body));
	assert.match(JSON.stringify(large.body), /at most 8192 bytes/);
	assert.equal((await h.store.getJob(padded.jobId))!.status, 'scheduled');
	const receipt = receiptFor(padded.ticket, buyer.address);
	const filed = await h.call(node, 'POST', `/v1/jobs/${padded.jobId}/receipt`, { receipt: { receipt, signature: await node.sign(receiptMessage(receipt)), pad: 'x'.repeat(8_192) } });
	assert.equal(filed.status, 200, JSON.stringify(filed.body));
	assert.deepEqual(Object.keys((await h.store.getJob(padded.jobId))!.receipt!).sort(), ['receipt', 'signature']);

	/* Receipts with no delivery record: one job's record can no longer be written (as one at the store's size limit could not), and the jobs after it still settle. */
	const stuck = await escrowedJob(h, buyer);
	await fileReceipt(h, node, receiptFor(stuck.ticket, buyer.address));
	const after = await escrowedJob(h, buyer);
	await fileReceipt(h, node, receiptFor(after.ticket, buyer.address));
	const updateJob = h.store.updateJob.bind(h.store);
	h.store.updateJob = async (jobId, update) => {
		if (jobId === stuck.jobId) {
			throw new Error('the document is too large');
		}
		return updateJob(jobId, update);
	};
	h.advance(DELIVERY_GRACE_MS + 1);
	assert.deepEqual(await h.service.sweep(), { expired: 0, settled: 2, paidOut: 0 });
	assert.equal((await h.store.getJob(after.jobId))!.settlement!.reason, 'no-delivery');
	assert.ok((await h.store.getJob(after.jobId))!.settlement!.blockHash, 'and paid out');
	assert.equal((await h.store.getJob(stuck.jobId))!.settlement, undefined, 'the stuck job waits for the next run');
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
	assert.deepEqual(h.ledger.payouts(h.settlement.account, job.jobId).to, { [operator.publicKey]: providerShare(BigInt(receipt.amount)), [buyer.address]: job.escrowed - BigInt(receipt.amount) });
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
	const racer = newBuyer();
	const raced = await Promise.all([1, 2, 3, 4, 5, 6].map(() => h.call(racer.signer, 'POST', '/v1/jobs', { network: 'test', model: 'qwen3-8b', ...LIMITS })));
	assert.deepEqual(raced.map((r) => r.status).sort(), [200, 200, 200, 200, 429, 429]);
	const open = raced.find((r) => r.status === 200)!.body as { quote: EscrowQuote };
	assert.equal((await h.call(racer.signer, 'POST', `/v1/jobs/${open.quote.jobId}/cancel`, {})).status, 200);
	await quote(h, racer);
	assert.equal((await quote(h, newBuyer())).job.status, 'quoted', 'the cap is per buyer');
});

test('a quote holds no slot: the ticket takes one on escrow, on another provider if the quoted one filled up, else the escrow is refunded', async () => {
	const h = harness();
	const a = await registerMac(h);
	const b = await registerMac(h);
	const dear = await registerMac(h);
	const dearPrice = { inputPerMillion: '100000000', outputPerMillion: '200000000' };
	const heartbeat = (mac: { node: Signer }, capacity: number, price?: Offer['price']) =>
		h.call(mac.node, 'POST', '/v1/providers/heartbeat', { status: 'online', offers: [offer('qwen3-8b', price ? { price } : {})], load: { active: 0, capacity } });
	const escrow = async (buyer: Buyer, q: EscrowQuote) => {
		const blockHash = await h.ledger.publish(buyer.account, [{ to: q.settlement, amount: BigInt(q.maxCost), token: q.token, external: q.jobId }]);
		return h.call(buyer.signer, 'POST', `/v1/jobs/${q.jobId}/escrow`, { blockHash });
	};

	/* Only A is online, with one slot: three buyers get quotes for it, since quotes hold nothing. */
	await heartbeat(a, 1);
	const [first, second, third] = [newBuyer(), newBuyer(), newBuyer()];
	const quotes = [await quote(h, first), await quote(h, second), await quote(h, third)];
	assert.deepEqual(quotes.map((q) => q.job.nodeKey), [a.node.publicKey, a.node.publicKey, a.node.publicKey]);
	assert.equal((await h.store.getProvider(a.node.publicKey))!.load.active, 0, 'no slot is held by a quote');

	/* B comes online at the same price, and a provider whose escrow would be larger than the quote's. */
	await heartbeat(b, 1);
	await heartbeat(dear, 1, dearPrice);
	assert.ok(escrowAmount(dearPrice, LIMITS) > BigInt(quotes[0]!.quote.maxCost));

	/* The first escrow takes A's slot. The second finds A full and moves to B, which fits the quote. */
	const ticketed = await escrow(first, quotes[0]!.quote);
	assert.equal((ticketed.body as { ticket: SignedTicket }).ticket.ticket.nodeKey, a.node.publicKey);
	const moved = await escrow(second, quotes[1]!.quote);
	assert.equal(moved.status, 200, JSON.stringify(moved.body));
	const movedTicket = (moved.body as { ticket: SignedTicket }).ticket.ticket;
	assert.deepEqual([movedTicket.nodeKey, movedTicket.payTo], [b.node.publicKey, b.operator.publicKey], 'the ticket names B and pays B');
	assert.equal((await h.store.getJob(quotes[1]!.job.jobId))!.nodeKey, b.node.publicKey);

	/* The third finds A and B full, and the only provider left would cost more than its escrow: refunded in full. */
	const refused = await escrow(third, quotes[2]!.quote);
	assert.equal(refused.status, 409, JSON.stringify(refused.body));
	assert.equal((refused.body as { error: { code: string } }).error.code, 'no_provider');
	const expired = await paidOut(h, quotes[2]!.job.jobId);
	assert.equal(expired.status, 'expired');
	assert.deepEqual(h.ledger.payouts(h.settlement.account, quotes[2]!.job.jobId).to, { [third.address]: BigInt(quotes[2]!.quote.maxCost) });
	assert.equal((await h.store.getProvider(dear.node.publicKey))!.load.active, 0, 'the dearer provider was not taken');
	assert.equal((await escrow(third, quotes[2]!.quote)).status, 409, 'an escrow block for the expired job is refused too');

	/* Heartbeats keep the tickets' slots held; a new quote goes to the one provider with room. */
	await heartbeat(a, 1);
	await heartbeat(b, 1);
	assert.equal((await quote(h, newBuyer())).job.nodeKey, dear.node.publicKey);
});

test('a buyer has at most eight jobs in flight, and can cap what a quote may cost', async () => {
	const h = harness();
	const { node } = await registerMac(h);
	await h.call(node, 'POST', '/v1/providers/heartbeat', { status: 'online', offers: [offer('qwen3-8b')], load: { active: 0, capacity: 16 } });
	const ask = (buyer: Buyer, extra: Record<string, unknown> = {}) => h.call(buyer.signer, 'POST', '/v1/jobs', { network: 'test', model: 'qwen3-8b', ...LIMITS, ...extra });

	const busy = newBuyer();
	for (let i = 0; i < 5; i++) {
		await escrowedJob(h, busy);
	}
	for (let i = 0; i < 3; i++) {
		await quote(h, busy);
	}
	const ninth = await ask(busy);
	assert.equal(ninth.status, 429);
	assert.match(JSON.stringify(ninth.body), /at most 8 jobs may be in flight at once/);

	/* A cost ceiling skips providers above it instead of quoting a job the buyer would refuse. */
	const careful = newBuyer();
	const needed = escrowAmount(offer('qwen3-8b').price, LIMITS);
	const tooDear = await ask(careful, { maxCost: (needed - 1n).toString() });
	assert.equal(tooDear.status, 402);
	assert.match(JSON.stringify(tooDear.body), /would charge more than/);
	assert.deepEqual(await h.store.listJobsByBuyer(careful.address, 10), [], 'no quote was made');
	assert.equal((await ask(careful, { maxCost: 'lots' })).status, 400);
	assert.equal((await quote(h, careful, LIMITS)).job.status, 'quoted');
	assert.equal(((await ask(newBuyer(), { maxCost: needed.toString() })).body as { job: JobRecord }).job.status, 'quoted', 'a ceiling at the escrow is enough');
});

test('a quote names at most 100 providers to use or skip, and its job keeps each one once', async () => {
	const h = harness();
	const { node, operator } = await registerMac(h);
	await h.call(node, 'POST', '/v1/providers/heartbeat', { status: 'online', offers: [offer('qwen3-8b')], load: { active: 0, capacity: 4 } });
	const ask = (extra: Record<string, unknown>) => h.call(newSigner(), 'POST', '/v1/jobs', { network: 'test', model: 'qwen3-8b', ...LIMITS, ...extra });

	/* Copies of a live provider's key would still route to it, so a long list could only make the job record large. */
	const padded = await ask({ allowedProviders: Array(101).fill(node.publicKey) });
	assert.equal(padded.status, 400, JSON.stringify(padded.body));
	assert.match(JSON.stringify(padded.body), /at most 100 providers/);
	assert.equal((await ask({ excludeProviders: Array(101).fill(newSigner().publicKey) })).status, 400);
	assert.equal(h.store.jobs.size, 0, 'nothing was quoted');

	const listed = await ask({ allowedProviders: [...Array(99).fill(node.publicKey), operator.publicKey] });
	assert.equal(listed.status, 200, JSON.stringify(listed.body));
	assert.deepEqual((await h.store.getJob((listed.body as { job: JobRecord }).job.jobId))!.allowedProviders, [node.publicKey, operator.publicKey]);
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
	const needed = escrowAmount(offer('qwen3-8b').price, LIMITS);
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

	/* The refusals left the provider's only slot free. */
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
	const needed = escrowAmount(offer('qwen3-8b').price, LIMITS);
	const ask = (buyer: Buyer) => h.call(buyer.signer, 'POST', '/v1/jobs', { network: 'test', model: 'qwen3-8b', ...LIMITS });
	const held = async () => (await h.store.getProvider(node.publicKey))!.load.active;

	/* One quote's worth of credits backs one quote, even when the requests race. */
	const buyer = newBuyer();
	balances.set(buyer.address, needed);
	const raced = await Promise.all([1, 2, 3, 4].map(() => ask(buyer)));
	assert.deepEqual(raced.map((r) => r.status).sort(), [200, 402, 402, 402], JSON.stringify(raced.map((r) => r.body)));
	assert.match(JSON.stringify(raced.find((r) => r.status === 402)!.body), /waiting for escrow/);
	assert.equal(await held(), 0, 'quotes hold no slot');

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

test('a node\'s allowlists hold at most 1000 addresses in total, and a list its offers repeat is stored once', async () => {
	const h = harness();
	const { node } = await registerMac(h);
	const friend = newSigner();
	/* An address only needs the right shape to be listed. */
	const filler = (count: number, salt: string) => Array.from({ length: count }, (_, i) => `keeta_${salt}${i.toString(2).padStart(52, '0').replaceAll('0', 'a').replaceAll('1', 'b')}`);
	const beat = (offers: Offer[], access: AccessPolicy) => h.call(node, 'POST', '/v1/providers/heartbeat', { status: 'online', offers, access, load: { active: 0, capacity: 4 } });
	const listed = (record: { access: AccessPolicy; offers: Offer[] }) => record.access.allow.length + record.offers.reduce((sum, o) => sum + o.access.allow.length, 0);

	/* A node sends its own list with every offer that sets none: three models under a 900-address list. */
	const own: AccessPolicy = { mode: 'allowlist', allow: [friend.publicKey, ...filler(899, 'c')] };
	const honest = await beat([offer('qwen3-8b', { access: own }), offer('qwen3-14b', { access: own }), offer('house-model', { access: own })], own);
	assert.equal(honest.status, 200, JSON.stringify(honest.body));
	const stored = (await h.store.getProvider(node.publicKey))!;
	assert.equal(listed(stored), 900, 'the list is stored once');
	assert.equal((await h.call(friend, 'POST', '/v1/jobs', { network: 'test', model: 'qwen3-14b', ...LIMITS })).status, 200, 'and still admits the listed buyer');
	assert.equal((await h.call(newSigner(), 'POST', '/v1/jobs', { network: 'test', model: 'qwen3-14b', ...LIMITS })).status, 503, 'and only listed buyers');

	/* Lists of the models' own add up, so a node cannot make its record large with many different lists. A list kept with a public policy admits no one and is not stored. */
	const padded = await beat(
		[offer('qwen3-8b', { access: { mode: 'allowlist', allow: filler(600, 'd') } }), offer('qwen3-14b', { access: { mode: 'allowlist', allow: filler(600, 'e') } })],
		{ mode: 'public', allow: filler(1000, 'f') }
	);
	assert.equal(padded.status, 400, JSON.stringify(padded.body));
	assert.match(JSON.stringify(padded.body), /at most 1000 addresses/);
	assert.deepEqual(await h.store.getProvider(node.publicKey), stored, 'the refused heartbeat changed nothing');
	assert.equal((await beat([offer('qwen3-8b', { access: { mode: 'allowlist', allow: filler(1000, 'd') } })], { mode: 'public', allow: filler(1000, 'f') })).status, 200);
	assert.equal(listed((await h.store.getProvider(node.publicKey))!), 1000);
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
	await escrowedJob(h, newBuyer());
	assert.equal((await h.call(buyer, 'POST', '/v1/jobs', { network: 'test', model: 'qwen3-8b', maxInputTokens: 10, maxOutputTokens: 10 })).status, 503, 'capacity 1 is held by the ticket');
	h.advance(5 * 60_000);
	await h.call(node, 'POST', '/v1/providers/heartbeat', { status: 'online', offers: [offer('qwen3-8b')], load: { active: 0, capacity: 1 } });
	h.advance(5 * 60_000);
	assert.equal((await h.call(buyer, 'POST', '/v1/jobs', { network: 'test', model: 'qwen3-8b', maxInputTokens: 10, maxOutputTokens: 10 })).status, 503, 'stale provider');
});

test('a heartbeat keeps ticketed slots held, and a buyer hand-back or provider fail frees them', async () => {
	const h = harness();
	const { node } = await registerMac(h);
	const beat = () => h.call(node, 'POST', '/v1/providers/heartbeat', { status: 'online', offers: [offer('qwen3-8b')], load: { active: 0, capacity: 1 } });
	await beat();
	const buyer = newBuyer();
	const job = () => h.call(buyer.signer, 'POST', '/v1/jobs', { network: 'test', model: 'qwen3-8b', ...LIMITS });
	const first = await escrowedJob(h, buyer);
	await beat();
	assert.equal((await job()).status, 503, 'the ticket still holds the only slot after a heartbeat');
	assert.equal((await h.call(newSigner(), 'POST', `/v1/jobs/${first.jobId}/cancel`, {})).status, 403, 'only the buyer can hand it back');
	assert.equal((await h.call(buyer.signer, 'POST', `/v1/jobs/${first.jobId}/cancel`, {})).status, 200);
	assert.equal((await h.call(buyer.signer, 'POST', `/v1/jobs/${first.jobId}/cancel`, {})).status, 200, 'handing back twice is harmless');
	await beat();
	const second = await escrowedJob(h, buyer);
	await beat();
	assert.equal((await job()).status, 503, 'the new ticket holds the slot, and a repeated hand-back freed only one');
	assert.equal((await h.call(node, 'POST', `/v1/jobs/${second.jobId}/fail`, { error: 'busy' })).status, 200);
	assert.equal((await job()).status, 200, 'a job the provider rejected frees its slot');
});

test('a heartbeat counts every ticket holding a slot, however many newer jobs the provider has', async () => {
	const h = harness();
	const { node } = await registerMac(h);
	const beat = () => h.call(node, 'POST', '/v1/providers/heartbeat', { status: 'online', offers: [offer('qwen3-8b')], load: { active: 0, capacity: 1 } });
	await beat();
	/* A buyer parks a quote on the idle provider and buries it under a hundred newer quotes it cancels. */
	const buyer = newBuyer();
	const parked = await quote(h, buyer);
	for (let i = 0; i < 101; i++) {
		h.advance(1);
		const buried = await quote(h, buyer);
		assert.equal((await h.call(buyer.signer, 'POST', `/v1/jobs/${buried.quote.jobId}/cancel`, {})).status, 200);
	}
	const blockHash = await h.ledger.publish(buyer.account, [{ to: parked.quote.settlement, amount: BigInt(parked.quote.maxCost), token: parked.quote.token, external: parked.quote.jobId }]);
	assert.equal((await h.call(buyer.signer, 'POST', `/v1/jobs/${parked.quote.jobId}/escrow`, { blockHash })).status, 200);
	await beat();
	assert.equal((await h.store.getProvider(node.publicKey))!.load.active, 1, 'the parked ticket still holds the only slot');
	assert.equal((await h.call(newBuyer().signer, 'POST', '/v1/jobs', { network: 'test', model: 'qwen3-8b', ...LIMITS })).status, 503);
});

test('machines under 32 GB register but are never scheduled', async () => {
	const h = harness();
	const { node } = await registerMac(h, 16);
	const hb = await h.call(node, 'POST', '/v1/providers/heartbeat', { status: 'online', offers: [offer('llama-3.2-3b-instruct')] });
	assert.equal((hb.body as { eligible: boolean; status: string }).eligible, false);
	assert.equal((hb.body as { status: string }).status, 'paused');
});

test('a node that moves to the main network leaves its test-network offers behind, so unpinned catalog models stay off main', async () => {
	const h = harness({ networks: ['test', 'main'] });
	const node = newSigner();
	const operator = newSigner();
	const register = async (network: NetworkName) => {
		const issuedAt = h.now();
		const link = await operator.sign(operatorLinkMessage({ nodeKey: node.publicKey, payTo: operator.publicKey, network, issuedAt }));
		const res = await h.call(node, 'POST', '/v1/providers/register', { network, kind: 'mac', name: 'Studio', hardware: hardware(64), payTo: operator.publicKey, link: { issuedAt, signature: link } });
		assert.equal(res.status, 200, JSON.stringify(res.body));
	};
	const beat = () => h.call(node, 'POST', '/v1/providers/heartbeat', { status: 'online', offers: [offer('qwen3-8b')], load: { active: 0, capacity: 1 } });
	const live = async (network: NetworkName) => ((await h.call(null, 'GET', `/v1/models?network=${network}`)).body as { models: Array<{ id: string }> }).models.map((m) => m.id);

	/* qwen3-8b has no pin: the test network takes it and the main network refuses it. */
	await register('test');
	await beat();
	assert.deepEqual(await live('test'), ['qwen3-8b']);
	await register('main');
	assert.deepEqual(await live('main'), [], 'the offer heartbeated on test does not carry over to main');
	const moved = (await h.store.getProvider(node.publicKey))!;
	assert.deepEqual([moved.offeredModels, moved.status], [[], 'paused']);
	await beat();
	assert.deepEqual(await live('main'), [], 'and a heartbeat on main drops it');
});

/** A router quote's x402 payment: the payer's send of the quoted amount to where the ticket says, referencing the job. */
/**
 * Pay a router quote as the router does: record the payer's signed block,
 * settle it (it lands on the ledger), then report the settlement, whose
 * transaction is the vote staple's hash. `report: false` loses the report.
 */
async function payRouterQuote(h: Harness, ticket: JobTicket, payer = randomAccount(), options: { beforeSettle?: () => Promise<unknown>; beforeReport?: () => Promise<unknown>; report?: boolean } = {}) {
	const blockHash = await h.ledger.publish(payer, [{ to: ticket.paymentTo ?? ticket.payTo, amount: BigInt(ticket.prepaidAmount!), token: ticket.asset, external: ticket.jobId }], { held: true });
	const recorded = await h.call(null, 'POST', `/v1/router/jobs/${ticket.jobId}/paying`, { payer: payer.publicKeyString.get(), block: h.ledger.encoded(blockHash) }, ROUTER);
	assert.equal(recorded.status, 200, JSON.stringify(recorded.body));
	await options.beforeSettle?.();
	h.ledger.release();
	await options.beforeReport?.();
	if (options.report !== false) {
		const staple = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex').toUpperCase();
		const res = await h.call(null, 'POST', `/v1/router/jobs/${ticket.jobId}/settled`, { payer: payer.publicKeyString.get(), transaction: staple, block: h.ledger.encoded(blockHash) }, ROUTER);
		assert.equal(res.status, 200, JSON.stringify(res.body));
		assert.equal((res.body as JobRecord).payment?.blockHash, blockHash, "the job keeps the payer's block, which the payout reads from the ledger");
	}
	return { payer: payer.publicKeyString.get(), blockHash, job: (await h.store.getJob(ticket.jobId))! };
}

test('router quotes are prepaid over x402 to the settlement account in the default stablecoin, at a credit to the dollar', async () => {
	const h = harness();
	const { node, operator } = await registerMac(h);
	await h.call(node, 'POST', '/v1/providers/heartbeat', { status: 'online', offers: [offer('qwen3-8b')], load: { active: 0, capacity: 2 } });
	assert.equal((await h.call(null, 'POST', '/v1/router/quote', { network: 'test', model: 'qwen3-8b', maxInputTokens: 10, maxOutputTokens: 10 })).status, 401);
	const routerQuote = await h.call(null, 'POST', '/v1/router/quote', { network: 'test', model: 'qwen3-8b', maxInputTokens: 1000, maxOutputTokens: 1000 }, ROUTER);
	assert.equal(routerQuote.status, 200);
	const { job, ticket, asset } = routerQuote.body as { job: { jobId: string; payTo: string; prepaidAmount: string; asset: string; paymentMode: string }; ticket: SignedTicket; asset: { symbol: string; address: string; decimals: number } };
	const stablecoin = defaultAsset('test');
	assert.deepEqual(asset, { symbol: stablecoin.symbol, address: stablecoin.address, decimals: stablecoin.decimals }, 'KUSD once it is pinned, else USDC');
	assert.equal(job.asset, stablecoin.address);
	assert.equal(job.paymentMode, 'prepaid');
	assert.equal(job.payTo, operator.publicKey);
	assert.equal(ticket.ticket.paymentTo, h.settlement.account, 'the payment goes to the settlement account, not the provider');
	/* 1000 tokens each way at 0.1 and 0.4 credits per million: 0.0005 credits, the same in dollars. */
	const prepaid = rescaleAmount(500n, CREDIT_DECIMALS, stablecoin.decimals);
	assert.equal(job.prepaidAmount, prepaid.toString());
	const { payer } = await payRouterQuote(h, ticket.ticket);
	for (let i = 0; i < 5; i++) {
		const unpaid = await h.call(null, 'POST', '/v1/router/quote', { network: 'test', model: 'qwen3-8b', maxInputTokens: 10, maxOutputTokens: 10 }, ROUTER);
		assert.equal(unpaid.status, 200, 'unpaid quotes do not use up the provider');
	}
	assert.equal((await h.call(newSigner(), 'POST', '/v1/jobs', { network: 'test', model: 'qwen3-8b', maxInputTokens: 10, maxOutputTokens: 10 })).status, 200);
	assert.equal(h.payouts.published, 0, 'nothing is paid out before the receipt');

	/* The receipt bills 1000 tokens in and 500 out: 0.0003 dollars. The provider gets that less the network fee, the payer the rest. */
	assert.equal((await fileReceipt(h, node, receiptFor(ticket.ticket, h.coordinator.publicKey, { inputTokens: 1000, outputTokens: 500 }))).status, 200);
	const done = await paidOut(h, job.jobId);
	assert.deepEqual([done.status, done.settlement!.reason], ['paid', 'delivered']);
	const billed = rescaleAmount(300n, CREDIT_DECIMALS, stablecoin.decimals);
	assert.deepEqual(h.ledger.payouts(h.settlement.account, job.jobId, stablecoin.address).to, { [operator.publicKey]: providerShare(billed), [payer]: prepaid - billed });
	const kept = prepaid - providerShare(billed) - (prepaid - billed);
	assert.equal(kept, networkFee(billed), 'the settlement account keeps the 0.25% fee');
});

test('a router payment goes back to its payer when the job fails, lapses, or failed before the payment', async () => {
	const h = harness();
	const { node } = await registerMac(h);
	await h.call(node, 'POST', '/v1/providers/heartbeat', { status: 'online', offers: [offer('qwen3-8b')], load: { active: 0, capacity: 4 } });
	const routerTicket = async () => ((await h.call(null, 'POST', '/v1/router/quote', { network: 'test', model: 'qwen3-8b', ...LIMITS }, ROUTER)).body as { ticket: SignedTicket }).ticket.ticket;
	const stablecoin = defaultAsset('test');
	const refunded = (ticket: JobTicket, payer: string) => assert.deepEqual(h.ledger.payouts(h.settlement.account, ticket.jobId, stablecoin.address).to, { [payer]: BigInt(ticket.prepaidAmount!) });

	/* The provider reports the job failed after it was paid. */
	const failed = await routerTicket();
	const failedPayer = (await payRouterQuote(h, failed)).payer;
	assert.equal((await h.call(node, 'POST', `/v1/jobs/${failed.jobId}/fail`, { error: 'out of memory' })).status, 200);
	assert.equal((await paidOut(h, failed.jobId)).settlement!.reason, 'failed');
	refunded(failed, failedPayer);

	/* The job failed while its payment was settling, and the payment was reported after. */
	const early = await routerTicket();
	const earlyPayer = (await payRouterQuote(h, early, undefined, { beforeSettle: () => h.call(node, 'POST', `/v1/jobs/${early.jobId}/fail`, { error: 'busy' }) })).payer;
	assert.equal((await paidOut(h, early.jobId)).status, 'failed');
	refunded(early, earlyPayer);
	const refused = await h.call(null, 'POST', `/v1/router/jobs/${early.jobId}/paying`, { payer: earlyPayer, block: h.ledger.encoded((await h.store.getJob(early.jobId))!.payment!.blockHash) }, ROUTER);
	assert.equal(refused.status, 409, 'a failed or paid job takes no further payment');

	/* Paid, but no receipt ever came: the sweep refunds it once the job could no longer be running. */
	const silent = await routerTicket();
	const silentPayer = (await payRouterQuote(h, silent)).payer;
	h.advance(TICKET_TTL_MS + 5 * 60_000 + 1);
	await h.service.sweep();
	assert.equal((await h.store.getJob(silent.jobId))!.status, 'scheduled', 'a paid job may still be running (up to MAX_JOB_MS)');
	h.advance(SETTLE_LAPSE_MS);
	await h.service.sweep();
	const lapsed = (await h.store.getJob(silent.jobId))!;
	assert.deepEqual([lapsed.status, lapsed.settlement?.reason, Boolean(lapsed.settlement?.blockHash)], ['failed', 'no-receipt', true]);
	refunded(silent, silentPayer);
});

test('the router records each payment before settling it: a block that does not pay the job is refused, and a payment whose report is lost is found on the ledger', async () => {
	const h = harness();
	const { node, operator } = await registerMac(h);
	await h.call(node, 'POST', '/v1/providers/heartbeat', { status: 'online', offers: [offer('qwen3-8b')], load: { active: 0, capacity: 4 } });
	const routerTicket = async () => {
		/* Time moves on here, so the provider heartbeats before each quote to stay schedulable. */
		await h.call(node, 'POST', '/v1/providers/heartbeat', { status: 'online', offers: [offer('qwen3-8b')], load: { active: 0, capacity: 4 } });
		return ((await h.call(null, 'POST', '/v1/router/quote', { network: 'test', model: 'qwen3-8b', ...LIMITS }, ROUTER)).body as { ticket: SignedTicket }).ticket.ticket;
	};
	const stablecoin = defaultAsset('test');
	const paying = async (ticket: JobTicket, payer: KeyPair, send: { to: string; amount: bigint; external: string }) => {
		const hash = await h.ledger.publish(payer, [{ ...send, token: ticket.asset }], { held: true });
		return h.call(null, 'POST', `/v1/router/jobs/${ticket.jobId}/paying`, { payer: payer.publicKeyString.get(), block: h.ledger.encoded(hash) }, ROUTER);
	};

	/* Blocks the payout could never count are refused before they are settled: no job id as the reference, too little, or paid to the provider. */
	const delivered = await routerTicket();
	const payer = randomAccount();
	const due = BigInt(delivered.prepaidAmount!);
	for (const send of [
		{ to: h.settlement.account, amount: due, external: 'job_other' },
		{ to: h.settlement.account, amount: due - 1n, external: delivered.jobId },
		{ to: delivered.payTo, amount: due, external: delivered.jobId }
	]) {
		const refused = await paying(delivered, payer, send);
		assert.equal(refused.status, 400, JSON.stringify(refused.body));
		assert.match((refused.body as { error: { message: string } }).error.message, /does not pay this job/);
	}
	const forged = await h.call(null, 'POST', `/v1/router/jobs/${delivered.jobId}/paying`, { payer: payer.publicKeyString.get(), block: 'bm90IGEgYmxvY2s=' }, ROUTER);
	assert.equal(forged.status, 400);

	/* Settled and run, but the router's report never arrived: the sweep reads the recorded block from the ledger and settles as the report would have. */
	await payRouterQuote(h, delivered, payer, { report: false });
	const receipt = receiptFor(delivered, h.coordinator.publicKey);
	assert.equal((await fileReceipt(h, node, receipt)).status, 200);
	h.advance(TICKET_TTL_MS + 5 * 60_000 + 1);
	await h.service.sweep();
	const found = await paidOut(h, delivered.jobId);
	assert.deepEqual([found.status, found.settlement!.reason, found.routerPayer], ['paid', 'delivered', payer.publicKeyString.get()]);
	const billed = rescaleAmount(BigInt(receipt.amount), CREDIT_DECIMALS, stablecoin.decimals);
	assert.deepEqual(h.ledger.payouts(h.settlement.account, delivered.jobId, stablecoin.address).to, { [operator.publicKey]: providerShare(billed), [payer.publicKeyString.get()]: due - billed });

	/* Settled with no receipt and no report: refunded once the job could no longer be running. */
	const silent = await routerTicket();
	const silentPayer = (await payRouterQuote(h, silent, undefined, { report: false })).payer;
	h.advance(TICKET_TTL_MS + 5 * 60_000 + 1);
	await h.service.sweep();
	const foundSilent = (await h.store.getJob(silent.jobId))!;
	assert.deepEqual([foundSilent.status, foundSilent.routerPayer, foundSilent.settlement], ['scheduled', silentPayer, undefined], 'the payment is found, and the job may still be running');
	h.advance(SETTLE_LAPSE_MS);
	await h.service.sweep();
	assert.deepEqual(h.ledger.payouts(h.settlement.account, silent.jobId, stablecoin.address).to, { [silentPayer]: BigInt(silent.prepaidAmount!) });

	/* Recorded but never settled (the payment service refused it): nothing landed, so the quote expires with nothing to pay. */
	const unsettled = await routerTicket();
	assert.equal((await paying(unsettled, randomAccount(), { to: h.settlement.account, amount: BigInt(unsettled.prepaidAmount!), external: unsettled.jobId })).status, 200);
	h.advance(TICKET_TTL_MS + 5 * 60_000 + 1);
	await h.service.sweep();
	assert.equal((await h.store.getJob(unsettled.jobId))!.status, 'scheduled', 'a recorded block may still land until the lapse');
	h.advance(SETTLE_LAPSE_MS);
	await h.service.sweep();
	const expired = (await h.store.getJob(unsettled.jobId))!;
	assert.deepEqual([expired.status, expired.settlement], ['expired', undefined]);
});

test('a receipt on a router quote counts for its provider only once the router reports the payment', async () => {
	const h = harness();
	const { node } = await registerMac(h);
	await h.call(node, 'POST', '/v1/providers/heartbeat', { status: 'online', offers: [offer('qwen3-8b')], load: { active: 0, capacity: 2 } });
	const stats = async () => (await h.store.getProvider(node.publicKey))!.stats;
	const routerTicket = async () => ((await h.call(null, 'POST', '/v1/router/quote', { network: 'test', model: 'qwen3-8b', ...LIMITS }, ROUTER)).body as { ticket: SignedTicket }).ticket.ticket;

	/* The 402 hands anyone the signed ticket, so a provider can file receipts on quotes nobody pays. */
	const unpaid = await routerTicket();
	assert.equal((await fileReceipt(h, node, receiptFor(unpaid, h.coordinator.publicKey, { outputTokens: 7 }))).status, 200);
	assert.equal((await h.store.getJob(unpaid.jobId))!.status, 'completed');
	assert.deepEqual(await stats(), { completed: 0, failed: 0, tokensOut: 0 }, 'a receipt with no payment reported counts for nothing');

	const latePayer = randomAccount();
	const unpaidBlock = await h.ledger.publish(latePayer, [{ to: unpaid.paymentTo!, amount: BigInt(unpaid.prepaidAmount!), token: unpaid.asset, external: unpaid.jobId }], { held: true });
	const late = await h.call(null, 'POST', `/v1/router/jobs/${unpaid.jobId}/paying`, { payer: latePayer.publicKeyString.get(), block: h.ledger.encoded(unpaidBlock) }, ROUTER);
	assert.equal(late.status, 409, 'and nobody can pay that quote afterwards');

	/* A payment reported after the receipt (the report is slow) counts it then, once. */
	const slow = await routerTicket();
	const payment = await payRouterQuote(h, slow, undefined, {
		beforeReport: async () => {
			assert.equal((await fileReceipt(h, node, receiptFor(slow, h.coordinator.publicKey, { outputTokens: 7 }))).status, 200);
			assert.deepEqual(await stats(), { completed: 0, failed: 0, tokensOut: 0 });
		}
	});
	assert.equal(payment.job.status, 'paid');
	assert.deepEqual(await stats(), { completed: 1, failed: 0, tokensOut: 7 });
	const repeated = await h.call(null, 'POST', `/v1/router/jobs/${slow.jobId}/settled`, { payer: payment.payer, transaction: payment.blockHash }, ROUTER);
	assert.equal(repeated.status, 200);
	assert.deepEqual(await stats(), { completed: 1, failed: 0, tokensOut: 7 }, 'a repeated report counts nothing more');
	assert.equal((await paidOut(h, slow.jobId)).settlement!.reason, 'delivered');

	/* The usual order: the payment, then the receipt. */
	const paid = await routerTicket();
	await payRouterQuote(h, paid);
	assert.equal((await fileReceipt(h, node, receiptFor(paid, h.coordinator.publicKey, { outputTokens: 3 }))).status, 200);
	assert.equal((await h.store.getJob(paid.jobId))!.status, 'paid');
	assert.deepEqual(await stats(), { completed: 2, failed: 0, tokensOut: 10 });
	await paidOut(h, paid.jobId);
	assert.equal(h.payouts.published, 2, 'each job is paid out once');
});

test('router quotes nobody paid, and receipts filed on them, never hold up the sweep settling app jobs', async () => {
	const h = harness();
	const { node } = await registerMac(h);
	await h.call(node, 'POST', '/v1/providers/heartbeat', { status: 'online', offers: [offer('qwen3-8b')], load: { active: 0, capacity: 4 } });
	const routerTicket = async () => {
		const res = await h.call(null, 'POST', '/v1/router/quote', { network: 'test', model: 'qwen3-8b', ...LIMITS }, ROUTER);
		assert.equal(res.status, 200, JSON.stringify(res.body));
		return (res.body as { ticket: SignedTicket }).ticket.ticket;
	};

	/* What is left behind for free: a quote nobody pays (any caller of the public router), and one its provider filed a receipt on with no payment reported. */
	const unpaid = (await h.store.getJob((await routerTicket()).jobId))!;
	const filed = await routerTicket();
	assert.equal((await fileReceipt(h, node, receiptFor(filed, h.coordinator.publicKey))).status, 200);
	const receipted = (await h.store.getJob(filed.jobId))!;
	assert.equal(receipted.status, 'completed');
	for (let i = 0; i < 250; i++) {
		await h.store.putJob({ ...unpaid, jobId: `job_unpaid${i}` });
		await h.store.putJob({ ...receipted, jobId: `job_receipted${i}` });
	}

	/* App jobs after them: a ticket never brought to the relay, and a receipt the relay never recorded a delivery for. */
	h.advance(1);
	const buyer = newBuyer();
	const unused = await escrowedJob(h, buyer);
	const undelivered = await escrowedJob(h, buyer);
	await fileReceipt(h, node, receiptFor(undelivered.ticket, buyer.address));
	h.advance(SETTLE_LAPSE_MS + 1);
	assert.equal((await h.service.sweep()).settled, 2, 'both settle in the first sweep after their lapse');
	assert.equal((await h.store.getJob(unused.jobId))!.settlement!.reason, 'no-show');
	assert.equal((await h.store.getJob(undelivered.jobId))!.settlement!.reason, 'no-delivery');

	/* The router jobs expire in passes of their own; a receipt with no payment does not stay completed. */
	await h.service.sweep();
	assert.deepEqual([...h.store.jobs.values()].filter((j) => j.paymentMode === 'prepaid' && j.status !== 'expired'), []);
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

	/* The Mac has an allowlist when it approves the helper, so the helper's record starts with a copy of it. */
	const listed = newSigner();
	const stranger = newSigner();
	await h.call(master, 'POST', '/v1/providers/heartbeat', { status: 'paused', offers: [], access: { mode: 'allowlist', allow: [listed.publicKey] } });
	const approvalSig = await master.sign(pairingApprovalMessage({ pairingId, helperNodeKey: helper.publicKey, masterNodeKey: master.publicKey, payTo: operator.publicKey }));
	assert.equal((await h.call(master, 'POST', `/v1/pairing/${pairingId}/approve`, { approvalSig })).status, 200);

	const registered = await h.call(helper, 'POST', '/v1/providers/register', { network: 'test', kind: 'linux-helper', name: 'gpu-box', hardware: hardware(128, 'linux') });
	assert.equal(registered.status, 200);
	assert.equal((registered.body as { provider: { payTo: string } }).provider.payTo, operator.publicKey, 'helper earnings go to the master wallet');

	/* The helper serves under the Mac's allowlist, whatever it reports itself. */
	await h.call(helper, 'POST', '/v1/providers/heartbeat', { status: 'online', offers: [offer('qwen3-8b')], access: { mode: 'public', allow: [] }, load: { active: 0, capacity: 4 } });
	const job = { network: 'test', model: 'qwen3-8b', maxInputTokens: 10, maxOutputTokens: 10 };
	assert.equal((await h.call(stranger, 'POST', '/v1/jobs', job)).status, 503, 'buyers off the Mac allowlist are not scheduled on its helpers');
	assert.equal((await h.call(listed, 'POST', '/v1/jobs', job)).status, 200);
	await h.call(master, 'POST', '/v1/providers/heartbeat', { status: 'paused', offers: [], access: { mode: 'public', allow: [] } });
	assert.equal((await h.call(stranger, 'POST', '/v1/jobs', job)).status, 200, 'and follow the Mac when it opens up');
	assert.equal((await h.call(null, 'POST', '/v1/router/quote', job, ROUTER)).status, 200, 'public router traffic included, whatever list the Mac had at pairing');

	const fleet = await h.call(master, 'GET', '/v1/fleet');
	assert.equal((fleet.body as { helpers: unknown[] }).helpers.length, 1);
	assert.equal((await h.call(master, 'DELETE', `/v1/fleet/${helper.publicKey}`)).status, 200);
	assert.equal((await h.call(helper, 'POST', '/v1/providers/heartbeat', { status: 'online', offers: [] })).status, 404, 'revoked helper is cut off');
});

test('no provider can report hardware or offers its master\'s app cannot show', async () => {
	const h = harness();
	const { node: master, operator } = await registerMac(h);
	const code = generatePairingCode();
	const { pairingId } = (await h.call(master, 'POST', '/v1/pairing', { codeHash: await pairingCodeHash(code) })).body as { pairingId: string };
	const helper = newSigner();
	const huge = { ...hardware(128, 'linux'), memoryBytes: 1e30 };
	assert.equal((await h.call(helper, 'POST', '/v1/pairing/claim', { codeHash: await pairingCodeHash(code), descriptor: { ...huge, name: 'box' } })).status, 400);
	assert.equal((await h.call(helper, 'POST', '/v1/pairing/claim', { codeHash: await pairingCodeHash(code), descriptor: { ...hardware(128, 'linux'), name: 'box' } })).status, 200);
	const approvalSig = await master.sign(pairingApprovalMessage({ pairingId, helperNodeKey: helper.publicKey, masterNodeKey: master.publicKey, payTo: operator.publicKey }));
	assert.equal((await h.call(master, 'POST', `/v1/pairing/${pairingId}/approve`, { approvalSig })).status, 200);

	/* A paired helper re-registers whenever it likes; 1e30 bytes of memory crashed the master's Fleet view, where revoking happens. */
	assert.equal((await h.call(helper, 'POST', '/v1/providers/register', { network: 'test', kind: 'linux-helper', hardware: huge })).status, 400);
	const odd = await h.call(helper, 'POST', '/v1/providers/register', { network: 'test', kind: 'linux-helper', hardware: { ...hardware(128, 'linux'), freeDiskBytes: 2 ** 63, gpuCores: 1e300 } });
	assert.equal(odd.status, 200, JSON.stringify(odd.body));
	const { helpers } = (await h.call(master, 'GET', '/v1/fleet')).body as { helpers: Array<{ hardware: HardwareProfile }> };
	assert.equal(helpers[0]!.hardware.memoryBytes, 128 * GB);
	assert.equal(helpers[0]!.hardware.freeDiskBytes, 2 ** 50, 'free disk is clamped');
	assert.equal(helpers[0]!.hardware.gpuCores, undefined, 'a core count that does not fit an integer is dropped');

	/* Nor can a provider advertise a context length the app cannot decode: one such offer blanked every app's model list. */
	const beat = (contextLength: number) => h.call(master, 'POST', '/v1/providers/heartbeat', { status: 'online', offers: [offer('qwen3-8b', { contextLength })] });
	assert.equal((await beat(1e300)).status, 400);
	assert.equal((await beat(131072)).status, 200);
	const { models } = (await h.call(null, 'GET', '/v1/models?network=test')).body as { models: Array<{ id: string; contextLength: number }> };
	assert.deepEqual(models.map((m) => [m.id, m.contextLength]), [['qwen3-8b', 131072]]);
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

test('a paired helper cannot pair with another master until its master revokes it', async () => {
	const h = harness();
	const a = await registerMac(h);
	const b = await registerMac(h);
	const helper = newSigner();
	const descriptor = { ...hardware(128, 'linux'), name: 'gpu-box' };
	const create = async (master: Signer) => {
		const code = generatePairingCode();
		const created = await h.call(master, 'POST', '/v1/pairing', { codeHash: await pairingCodeHash(code) });
		assert.equal(created.status, 200, JSON.stringify(created.body));
		return { code, pairingId: (created.body as { pairingId: string }).pairingId };
	};
	const claim = async (code: string) => h.call(helper, 'POST', '/v1/pairing/claim', { codeHash: await pairingCodeHash(code), descriptor });
	const approve = async (master: { node: Signer; operator: Signer }, pairingId: string) => {
		const approvalSig = await master.node.sign(pairingApprovalMessage({ pairingId, helperNodeKey: helper.publicKey, masterNodeKey: master.node.publicKey, payTo: master.operator.publicKey }));
		return h.call(master.node, 'POST', `/v1/pairing/${pairingId}/approve`, { approvalSig });
	};

	/* The helper claims both codes while unpaired; A approves first, so B's approval must not re-home it. */
	const fromA = await create(a.node);
	const fromB = await create(b.node);
	assert.equal((await claim(fromA.code)).status, 200);
	assert.equal((await claim(fromB.code)).status, 200);
	assert.equal((await approve(a, fromA.pairingId)).status, 200);
	assert.equal((await approve(b, fromB.pairingId)).status, 403, 'another master cannot approve a bound helper');
	assert.equal((await claim((await create(b.node)).code)).status, 403, 'nor can a bound helper claim its code');
	const bound = (await h.store.getProvider(helper.publicKey))!;
	assert.equal(bound.masterNodeKey, a.node.publicKey);
	assert.equal(bound.payTo, a.operator.publicKey);
	assert.equal(((await h.call(a.node, 'GET', '/v1/fleet')).body as { helpers: unknown[] }).helpers.length, 1);

	/* Its own master can pair it again, and once it revokes the helper, another master can. */
	const again = await create(a.node);
	assert.equal((await claim(again.code)).status, 200);
	assert.equal((await approve(a, again.pairingId)).status, 200);
	assert.equal((await h.call(a.node, 'DELETE', `/v1/fleet/${helper.publicKey}`)).status, 200);
	const moved = await create(b.node);
	assert.equal((await claim(moved.code)).status, 200);
	assert.equal((await approve(b, moved.pairingId)).status, 200);
	assert.equal((await h.store.getProvider(helper.publicKey))!.payTo, b.operator.publicKey);
});
