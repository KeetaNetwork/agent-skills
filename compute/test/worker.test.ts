/**
 * The real relay Worker under `wrangler dev` (workerd with local Durable
 * Objects), with no network beyond this machine. It owns what the in-process
 * end-to-end test cannot prove because it emulates the relay: that the
 * Worker bundle starts, that providers connect to it over a real WebSocket,
 * that the Durable Object carries jobs and hang-ups between buyer and
 * provider, that it records what it forwarded with the control plane, and
 * that the public router answers without the payment service, and that
 * the record it posts settles each app job's escrow.
 *
 * Escrows and payouts move on the in-memory ledger (test/support/ledger.ts);
 * the live suite (test/live) makes them on the Keeta test network.
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { Readable } from 'node:stream';
import { ONE_CREDIT, operatorLinkMessage, promptTokenBound, requestedMaxTokens, jobAuthMessage, readRelayEvents, chunkText, sha256Hex, type ChatCompletionRequest, type EscrowQuote, type SignedReceipt, type SignedTicket, type Signer, type JobRecord } from '@keeta-compute/protocol';
import { Account, accountSigner } from '@keeta-compute/protocol/keeta';
import { startServer } from '../services/control/src/server.ts';
import { ControlClient } from '@keeta-compute/protocol/client';
import type { ModelManager } from '@keeta-compute/provider';
import { Scratch, fakeModelServer, freePort, listen, macAgent, passkeyEntropy, until } from './support/harness.ts';
import { FakeLedger, newTokenAddress } from './support/ledger.ts';
import { startWorker, type RunningWorker } from './support/worker.ts';

const RELAY_SECRET = 'relay-secret-for-worker-tests';
const ROUTER_SECRET = 'router-secret-for-worker-tests';
const MODEL = 'llama-3.2-3b';

const CREDITS = newTokenAddress();
const SETTLEMENT = Account.fromSeed(Account.generateRandomSeed({ asString: true }), 0).publicKeyString.get();
const ledger = new FakeLedger();

const scratch = new Scratch();
let control: Awaited<ReturnType<typeof startServer>>;
let worker: RunningWorker;
let controlClient: ControlClient;
let operator: string;
let nodeKey: string;

before(async () => {
	const model = fakeModelServer();
	const modelUrl = `${await listen(model)}/v1`;
	scratch.defer(() => model.close());

	/* The Worker starts before the control plane knows its URL, so reserve the control port first. */
	const controlPort = await freePort();
	worker = await startWorker(
		{
			CONTROL_URL: `http://127.0.0.1:${controlPort}`,
			RELAY_SECRET,
			ROUTER_SECRET,
			NETWORK: 'test',
			/* Nothing listens here: the payment service is down for the whole file. */
			FACILITATOR_URL: `http://127.0.0.1:${await freePort()}`
		},
		scratch.dir('wrangler')
	);
	scratch.defer(() => worker.stop());

	control = await startServer({
		port: controlPort,
		env: {
			COORDINATOR_SEED: Account.generateRandomSeed({ asString: true }) as string,
			RELAY_SECRET,
			ROUTER_SECRET,
			RELAY_URL: worker.url,
			ALLOW_SMALL_PROVIDERS: 'true',
			TEST_CREDIT_TOKEN: CREDITS,
			TEST_FX_ACCOUNT: Account.fromSeed(Account.generateRandomSeed({ asString: true }), 0).publicKeyString.get()
		},
		verifyPayment: ledger.verifier(),
		settlement: ledger.settlement(SETTLEMENT),
		creditBalanceOf: async ({ account, token }) => ledger.balanceOf(account, token)
	});
	scratch.defer(() => new Promise((resolve) => control.server.close(resolve)));
	scratch.defer(() => control.server.closeAllConnections());
	controlClient = new ControlClient(control.url);

	const provider = macAgent(scratch.dir('provider'), { ledger });
	scratch.defer(() => provider.app.shutdown());
	await provider.rpc['agent.initialize']!({ network: 'test', controlUrl: control.url, relayUrl: worker.url, nodePublicKey: provider.nodePublicKey, appVersion: 'test', machineName: 'Studio' });
	(provider.app as unknown as { models: ModelManager }).models.addExternal({
		modelId: MODEL,
		name: 'Llama 3.2 3B',
		backend: { baseUrl: modelUrl, servedName: 'fake' },
		weightsHash: 'a'.repeat(64),
		sizeBytes: 1,
		path: '/dev/null',
		contextLength: 8192,
		price: { inputPerMillion: '100000', outputPerMillion: '400000' }
	});
	await provider.rpc['provider.setPolicy']!({ enabled: true });
	({ operator } = await provider.rpc['wallet.setOperator']!({ entropy: passkeyEntropy() }));
	/* Online means the Worker accepted the provider's WebSocket with the token the control plane minted. */
	await until('the provider to connect to the Worker', async () => (await provider.rpc['provider.status']!({})).state === 'online', 30_000);
	nodeKey = (await provider.rpc['agent.state']!({})).nodeKey as string;
});

after(() => scratch.cleanup());

/** A buyer holding one credit on the ledger. */
function newBuyer(): Signer {
	const buyer = accountSigner(Account.fromSeed(Account.generateRandomSeed({ asString: true }), 0));
	ledger.mint(buyer.publicKey, CREDITS, ONE_CREDIT);
	return buyer;
}

/** A buyer without the agent: get a quote, escrow it, collect the ticket, run it through the Worker, read the stream. */
async function runJob(buyer: Signer, content: string, options: { hangUpAfter?: string } = {}) {
	const request: ChatCompletionRequest = { model: MODEL, messages: [{ role: 'user', content }], max_tokens: 64, stream: true, stream_options: { include_usage: true } };
	const { quote } = await controlClient.post<{ quote: EscrowQuote }>(buyer, '/v1/jobs', {
		network: 'test',
		model: MODEL,
		maxInputTokens: promptTokenBound(request),
		maxOutputTokens: requestedMaxTokens(request)
	});
	const blockHash = ledger.publish([{ from: buyer.publicKey, to: quote.settlement, amount: BigInt(quote.maxCost), token: quote.token, reference: quote.jobId }]);
	const { ticket } = await controlClient.post<{ ticket: SignedTicket }>(buyer, `/v1/jobs/${quote.jobId}/escrow`, { blockHash });
	const jobId = ticket.ticket.jobId;
	/* node:http rather than fetch: a hang-up must close the connection the way a buyer process going away does. */
	const run = await postStream(`${worker.url}/v1/jobs/${jobId}/run`, JSON.stringify({ ticket, request, buyerSig: await buyer.sign(await jobAuthMessage(jobId, request)) }));
	let text = '';
	let receipt: SignedReceipt | undefined;
	let hungUp = false;
	try {
		for await (const event of readRelayEvents(run.body)) {
			if (event.type === 'chunk') {
				text += chunkText(event.data);
				if (options.hangUpAfter && text.includes(options.hangUpAfter)) {
					hungUp = true;
					run.hangUp();
					break;
				}
			} else if (event.type === 'receipt') {
				receipt = event.receipt;
			} else {
				assert.fail(event.type === 'error' ? `the job failed: ${event.code} ${event.message}` : 'an app job waited for a router start');
			}
		}
	} catch (error) {
		if (!hungUp) {
			throw error;
		}
	}
	return { jobId, ticket, text, receipt, escrowed: BigInt(quote.maxCost) };
}

/** POST and stream the answer; `hangUp` drops the connection. */
function postStream(url: string, body: string): Promise<{ body: ReadableStream<Uint8Array>; hangUp: () => void }> {
	return new Promise((resolve, reject) => {
		const req = httpRequest(url, { method: 'POST', headers: { 'content-type': 'application/json' }, agent: false }, (res) => {
			if (res.statusCode !== 200) {
				let text = '';
				res.on('data', (chunk: Buffer) => (text += chunk.toString()));
				res.on('end', () => reject(new Error(`the Worker answered ${res.statusCode}: ${text}`)));
				return;
			}
			resolve({ body: Readable.toWeb(res) as ReadableStream<Uint8Array>, hangUp: () => req.destroy() });
		});
		req.on('error', reject);
		req.end(body);
	});
}

const job = (jobId: string) => control.store.getJob(jobId) as Promise<JobRecord>;

/** The settlement account's payout for a job, by recipient, once it is on the ledger. */
async function payout(jobId: string) {
	const settled = await until(`${jobId} to be paid out`, async () => {
		const current = await job(jobId);
		return current.settlement?.blockHash ? current : null;
	}, 20_000);
	const sends = ledger.sendsFor(jobId, SETTLEMENT);
	assert.deepEqual([...new Set(sends.map((s) => s.block))], [settled.settlement!.blockHash], 'one payout block');
	return { settled, to: Object.fromEntries(sends.map((s) => [s.to, s.amount])) };
}

test('an app job runs through the Worker to the provider, and the relay records what it forwarded before the receipt', async () => {
	const buyer = newBuyer();
	const { jobId, text, receipt, escrowed } = await runJob(buyer, 'Say hello');
	assert.equal(text, 'Hello from Keeta');
	assert.ok(receipt, 'the receipt reached the buyer through the Worker');
	assert.equal(receipt.receipt.nodeKey, nodeKey);
	assert.equal(receipt.receipt.payTo, operator);
	assert.equal(receipt.receipt.outputHash, await sha256Hex(text));

	/* The Durable Object posts the record before it passes the receipt on, so it is already there. */
	const record = await job(jobId);
	assert.equal(record.delivery?.outputHash, receipt.receipt.outputHash);
	assert.ok(record.delivery!.maxOutputTokens >= receipt.receipt.outputTokens);
	assert.ok(record.delivery!.presentedAt! >= record.ticketIssuedAt!, 'it says when the buyer brought the ticket');
	assert.equal(record.delivery!.abandonedAt, undefined);

	/* The record matches the receipt, so the escrow pays the provider its bill and the buyer the rest. */
	const { settled, to } = await payout(jobId);
	assert.equal(settled.status, 'paid');
	assert.equal(settled.settlement!.reason, 'delivered');
	assert.deepEqual(to, { [operator]: BigInt(receipt.receipt.amount), [buyer.publicKey]: escrowed - BigInt(receipt.receipt.amount) });
});

test('a buyer hanging up mid-answer cancels the job on the provider, and the receipt bills what the relay forwarded', async () => {
	const buyer = newBuyer();
	const started = Date.now();
	const { jobId, text, escrowed } = await runJob(buyer, 'Say hello slowly', { hangUpAfter: 'Hello' });
	assert.equal(text, 'Hello');

	const record = await until('the provider to file the receipt for the cancelled job', async () => {
		const current = await job(jobId);
		return current.receipt && current.delivery ? current : null;
	}, 20_000);
	/*
	 * The model stalls 5 s after each of its three pieces unless cancelled. The
	 * runtime notices a dropped connection when it next writes to it, so the
	 * piece in flight at the hang-up may count as forwarded, but no more.
	 */
	assert.ok(Date.now() - started < 9_000, `the hang-up did not reach the provider: ${JSON.stringify(record.receipt!.receipt)}`);
	const billed = record.receipt!.receipt;
	assert.equal(billed.finishReason, 'cancelled');
	assert.ok(billed.outputTokens < 3, 'the provider stopped before the whole answer');
	assert.ok([await sha256Hex('Hello'), await sha256Hex('Hello from')].includes(record.delivery!.outputHash), 'the relay records what it forwarded, not the whole answer');
	assert.equal(billed.outputHash, record.delivery!.outputHash, 'the receipt bills exactly what the relay forwarded');
	assert.equal(record.delivery!.abandonedAt, undefined, 'text had arrived, so the hang-up is not a no-show');

	const { settled, to } = await payout(jobId);
	assert.equal(settled.settlement!.reason, 'delivered');
	assert.deepEqual(to, { [operator]: BigInt(billed.amount), [buyer.publicKey]: escrowed - BigInt(billed.amount) }, 'the provider is paid for what was forwarded, and the rest comes back');
});

test('a ticket brought to the Worker while its provider is offline is recorded, so the buyer owes no no-show fee', async () => {
	/* A provider the control plane sees online that never connected to the Worker, serving a model no one else does. */
	const node = accountSigner(Account.fromSeed(Account.generateRandomSeed({ asString: true }), 0));
	const payTo = accountSigner(Account.fromSeed(Account.generateRandomSeed({ asString: true }), 0));
	const issuedAt = Date.now();
	const signature = await payTo.sign(operatorLinkMessage({ nodeKey: node.publicKey, payTo: payTo.publicKey, network: 'test', issuedAt }));
	const hardware = { os: 'macos', osVersion: '15.4', chip: 'Apple M4 Max', memoryBytes: 64 * 1024 ** 3, freeDiskBytes: 500 * 1024 ** 3 };
	await controlClient.post(node, '/v1/providers/register', { network: 'test', kind: 'mac', name: 'Asleep', hardware, payTo: payTo.publicKey, link: { issuedAt, signature } });
	const asleep = 'asleep-model';
	const offer = { modelId: asleep, weightsHash: 'b'.repeat(64), runtime: { kind: 'mlx', build: 'test' }, price: { inputPerMillion: '100000', outputPerMillion: '400000' }, access: { mode: 'public', allow: [] }, contextLength: 8192 };
	await controlClient.post(node, '/v1/providers/heartbeat', { status: 'online', offers: [offer], load: { active: 0, capacity: 1 } });

	const buyer = newBuyer();
	const request: ChatCompletionRequest = { model: asleep, messages: [{ role: 'user', content: 'Say hello' }], max_tokens: 16 };
	const { quote } = await controlClient.post<{ quote: EscrowQuote }>(buyer, '/v1/jobs', { network: 'test', model: asleep, maxInputTokens: promptTokenBound(request), maxOutputTokens: requestedMaxTokens(request) });
	const blockHash = ledger.publish([{ from: buyer.publicKey, to: quote.settlement, amount: BigInt(quote.maxCost), token: quote.token, reference: quote.jobId }]);
	const { ticket } = await controlClient.post<{ ticket: SignedTicket }>(buyer, `/v1/jobs/${quote.jobId}/escrow`, { blockHash });
	const run = await fetch(`${worker.url}/v1/jobs/${quote.jobId}/run`, { method: 'POST', body: JSON.stringify({ ticket, request, buyerSig: await buyer.sign(await jobAuthMessage(quote.jobId, request)) }) });
	assert.equal(run.status, 503);
	assert.equal(((await run.json()) as { error: { code: string } }).error.code, 'provider_offline');
	const record = await until('the Worker to record that the provider was offline', async () => {
		const current = await job(quote.jobId);
		return current.providerOfflineAt ? current : null;
	}, 20_000);
	assert.equal(record.delivery, undefined, 'nothing was forwarded');
});

test('the public router lists models and quotes while the payment service is down, and runs nothing it cannot check', async () => {
	const models = await fetch(`${worker.url}/v1/models`);
	assert.equal(models.status, 200, worker.output());
	const listed = (await models.json()) as { data: Array<{ id: string; keeta: { providers: number } }> };
	assert.ok(listed.data.some((m) => m.id === MODEL && m.keeta.providers >= 1));

	const body = JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'Say hello' }], max_tokens: 32 });
	const quote = await fetch(`${worker.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
	assert.equal(quote.status, 402);
	const required = JSON.parse(atob(quote.headers.get('payment-required')!)) as { accepts: Array<{ payTo: string; amount: string; network: string; extra: { jobId: string } }> };
	const [accepted] = required.accepts;
	assert.equal(accepted!.payTo, operator, 'the provider is paid directly');
	assert.equal(accepted!.network, 'keeta:1413829460');

	const header = btoa(JSON.stringify({ x402Version: 2, accepted, payload: { block: 'unchecked' } }));
	const paid = await fetch(`${worker.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', 'payment-signature': header }, body });
	assert.equal(paid.status, 503);
	assert.equal(((await paid.json()) as { error: { code: string } }).error.code, 'payment_unavailable');
	assert.equal((await job(accepted!.extra.jobId)).status, 'scheduled', 'the provider never ran the job');
});
