import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sha256Hex, type JobEnvelope, type ProviderFrame, type RelayFrame, type SignedReceipt } from '@keeta-compute/protocol';
import { HANG_UP_GRACE_MS, ProviderChannel } from '../src/channel.ts';
import { postDelivery, postProviderOffline } from '../src/delivery.ts';

const record = { controlUrl: 'http://control', routerSecret: 'router-secret', jobId: 'job-1', outputHash: 'a'.repeat(64), maxOutputTokens: 3, presentedAt: 1_000, abandonedAt: 1_500 };

test('the delivery record is retried until the control plane accepts it', async () => {
	const statuses = [null, 503, 200];
	const calls: Array<{ url: string; secret: string | null; body: unknown }> = [];
	const fetchImpl = (async (url: string, init: RequestInit) => {
		calls.push({ url, secret: new Headers(init.headers).get('x-router-secret'), body: JSON.parse(String(init.body)) });
		const status = statuses.shift();
		if (status === null) {
			throw new TypeError('network down');
		}
		return new Response(null, { status });
	}) as typeof fetch;
	assert.equal(await postDelivery(record, fetchImpl, [1, 1, 1]), true);
	assert.equal(calls.length, 3, 'a dropped request and a 503 are both retried');
	assert.deepEqual(calls[0], {
		url: 'http://control/v1/relay/jobs/job-1/delivery',
		secret: 'router-secret',
		body: { outputHash: 'a'.repeat(64), maxOutputTokens: 3, presentedAt: 1_000, abandonedAt: 1_500 }
	}, 'the record carries what was forwarded and when, never the secret');
});

test('the delivery record stops on a refusal that will not change, or after its retries', async () => {
	let calls = 0;
	const refused = (async () => (calls++, new Response(null, { status: 401 }))) as typeof fetch;
	assert.equal(await postDelivery(record, refused, [1, 1, 1]), false);
	assert.equal(calls, 1);
	calls = 0;
	const down = (async () => (calls++, new Response(null, { status: 502 }))) as typeof fetch;
	assert.equal(await postDelivery(record, down, [1, 1]), false);
	assert.equal(calls, 3);
});

test('the provider-offline record goes to its own route, with the same retries', async () => {
	const calls: string[] = [];
	const statuses = [503, 200];
	const fetchImpl = (async (url: string) => (calls.push(url), new Response(null, { status: statuses.shift()! }))) as typeof fetch;
	assert.equal(await postProviderOffline({ controlUrl: 'http://control', routerSecret: 'router-secret', jobId: 'job-1' }, fetchImpl, [1, 1]), true);
	assert.deepEqual(calls, ['http://control/v1/relay/jobs/job-1/provider-offline', 'http://control/v1/relay/jobs/job-1/provider-offline']);
});

/** A provider's channel (the Durable Object) with its socket open, posting its records to a local control plane. */
async function openChannel(t: { after: (fn: () => void) => void }) {
	const records: Array<{ url: string; body: Record<string, unknown> }> = [];
	const control = createServer((req, res) => {
		let body = '';
		req.on('data', (chunk: Buffer) => (body += chunk.toString()));
		req.on('end', () => {
			records.push({ url: req.url!, body: JSON.parse(body) as Record<string, unknown> });
			res.writeHead(200, { 'content-type': 'application/json' }).end('{"recorded":true}');
		});
	});
	await new Promise<void>((resolve) => control.listen(0, '127.0.0.1', resolve));
	t.after(() => control.close());
	const posting: Array<Promise<unknown>> = [];
	const state = { waitUntil: (promise: Promise<unknown>) => void posting.push(promise) } as unknown as DurableObjectState;
	const channel = new ProviderChannel(state, { CONTROL_URL: `http://127.0.0.1:${(control.address() as AddressInfo).port}`, ROUTER_SECRET: 'router-secret' });
	const toProvider: RelayFrame[] = [];
	const internals = channel as unknown as { socket: { send(raw: string): void }; onFrame(data: string): void };
	internals.socket = { send: (raw) => void toProvider.push(JSON.parse(raw) as RelayFrame) };
	return {
		toProvider,
		/** The buyer brings an app ticket for `jobId`; its answer streams back until `signal` aborts (the buyer hangs up). */
		run: (jobId: string, signal: AbortSignal) => {
			const envelope = { ticket: { ticket: { jobId, paymentMode: 'escrow' } }, request: { model: 'my-model', messages: [] } } as unknown as JobEnvelope;
			return channel.fetch(new Request('https://channel/run', { method: 'POST', body: JSON.stringify(envelope), signal }));
		},
		fromProvider: (frame: ProviderFrame) => internals.onFrame(JSON.stringify(frame)),
		/** The delivery records posted so far, once their posts finish. */
		records: async () => (await Promise.all(posting), records)
	};
}

const piece = (content: string) => ({ choices: [{ index: 0, delta: { content } }] });
const receipt = {} as SignedReceipt;

test('after a buyer hangs up, the delivery record waits for the receipt and covers what the provider sent until the cancel reached it', async (t) => {
	const channel = await openChannel(t);
	const buyer = new AbortController();
	const answer = await channel.run('job_1', buyer.signal);
	assert.equal(answer.status, 200);
	const id = (channel.toProvider[0] as { id: string }).id;
	channel.fromProvider({ type: 'chunk', id, data: piece('Hello') });
	buyer.abort();
	await answer.body!.cancel();
	assert.deepEqual(channel.toProvider.map((f) => f.type), ['job', 'cancel'], 'the provider is told to stop');
	/* A piece the provider sent before the cancel reached it, then its receipt for everything it sent. */
	channel.fromProvider({ type: 'chunk', id, data: piece(' from') });
	channel.fromProvider({ type: 'receipt', id, receipt });
	const records = await channel.records();
	assert.equal(records.length, 1);
	assert.equal(records[0]!.url, '/v1/relay/jobs/job_1/delivery');
	assert.equal(records[0]!.body.outputHash, await sha256Hex('Hello from'), 'the same text the receipt bills');
	assert.equal(records[0]!.body.abandonedAt, undefined, 'text had come back before the hang-up');
});

test('after a hang-up, the delivery record stops counting HANG_UP_GRACE_MS later, receipt or not', async (t) => {
	const channel = await openChannel(t);
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const buyer = new AbortController();
	const answer = await channel.run('job_1', buyer.signal);
	const id = (channel.toProvider[0] as { id: string }).id;
	channel.fromProvider({ type: 'chunk', id, data: piece('Hello') });
	buyer.abort();
	channel.fromProvider({ type: 'chunk', id, data: piece(' from') });
	t.mock.timers.tick(HANG_UP_GRACE_MS);
	/* A provider that ignores the cancel cannot bill the buyer for more. */
	channel.fromProvider({ type: 'chunk', id, data: piece(' Keeta') });
	t.mock.timers.reset();
	await answer.body!.cancel();
	const records = await channel.records();
	assert.equal(records.length, 1);
	assert.equal(records[0]!.body.outputHash, await sha256Hex('Hello from'));
});
