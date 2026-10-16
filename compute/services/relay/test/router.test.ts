import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NETWORKS, ticketMac, type JobTicket, type SignedTicket } from '@keeta-compute/protocol';
import { createRouter, type PaymentGateway, type PaymentPayload } from '../src/router.ts';
import { checkEnvelope } from '../src/relay.ts';
import { sseData, sseEvent } from '../src/sse.ts';

const SECRET = 'relay-secret';
const payTo = 'keeta_aabpjkb2hmzj5wjiksxyxjpnbkvnelocqermwxd2ee2diikzy72cjtwd24gm37a';

async function makeTicket(overrides: Partial<JobTicket> = {}): Promise<SignedTicket> {
	const ticket: JobTicket = {
		v: 1, jobId: 'job_abc', network: 'test', nodeKey: payTo, modelId: 'qwen3-8b', buyer: payTo,
		maxInputTokens: 100, maxOutputTokens: 64, price: { inputPerMillion: '100000', outputPerMillion: '400000' },
		asset: NETWORKS.test.settlementAsset.address, payTo, paymentMode: 'prepaid', prepaidAmount: '36',
		issuedAt: Date.now(), expiresAt: Date.now() + 60_000, ...overrides
	};
	return { ticket, coordinatorSig: '00', relayMac: await ticketMac(SECRET, ticket) };
}

function sse(...parts: Uint8Array[]): Response {
	return new Response(new ReadableStream({ start(c) { parts.forEach((p) => c.enqueue(p)); c.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
}

const chunk = (content: string, extra: Record<string, unknown> = {}) => ({ id: 'c1', created: 1, choices: [{ index: 0, delta: { content }, finish_reason: null }], ...extra });
const receipt = { receipt: { jobId: 'job_abc' }, signature: 'ff' };

function setup(options: { runJob?: () => Promise<Response>; gateway?: Partial<PaymentGateway>; ticket?: SignedTicket } = {}) {
	const calls: string[] = [];
	const gateway: PaymentGateway = {
		verify: async () => ({ isValid: true, payer: 'keeta_payer' }),
		settle: async () => {
			calls.push('settle');
			return { success: true, transaction: 'TX1', payer: 'keeta_payer' };
		},
		...options.gateway
	};
	const router = createRouter({
		network: 'test',
		controlUrl: 'http://control',
		routerSecret: 'router-secret',
		relaySecret: SECRET,
		gateway,
		runJob: options.runJob ?? (async () => sse(sseData(chunk('Hel')), sseData(chunk('lo', { usage: { prompt_tokens: 5, completion_tokens: 2 } })), sseEvent('keeta.receipt', receipt))),
		fetch: (async (url: string, init?: RequestInit) => {
			calls.push(`${init?.method ?? 'GET'} ${url}`);
			assert.equal((init?.headers as Record<string, string> | undefined)?.['x-router-secret'] ?? 'router-secret', 'router-secret');
			if (url.endsWith('/v1/router/quote')) {
				return Response.json({ job: {}, ticket: options.ticket ?? (await makeTicket()) });
			}
			return Response.json({ ok: true });
		}) as typeof fetch
	});
	return { router, calls };
}

const chatBody = (extra: Record<string, unknown> = {}) => JSON.stringify({ model: 'qwen3-8b', messages: [{ role: 'user', content: 'hi' }], max_tokens: 64, ...extra });

async function paymentFor(router: ReturnType<typeof setup>['router']): Promise<string> {
	const challenge = await router.chatCompletions(new Request('http://api/v1/chat/completions', { method: 'POST', body: chatBody() }));
	assert.equal(challenge.status, 402);
	const required = JSON.parse(atob(challenge.headers.get('payment-required')!)) as { accepts: PaymentPayload['accepted'][] };
	assert.equal(required.accepts[0]!.payTo, payTo);
	assert.equal(required.accepts[0]!.amount, '36');
	assert.equal(required.accepts[0]!.network, 'keeta:1413829460');
	const payload: PaymentPayload = { x402Version: 2, accepted: required.accepts[0]!, payload: { block: 'signed-block' } };
	return btoa(JSON.stringify(payload));
}

test('unpaid request gets a 402 with the provider as payee', async () => {
	const { router } = setup();
	await paymentFor(router);
});

test('paid non-streaming request aggregates output, settles and returns the receipt', async () => {
	const { router, calls } = setup();
	const header = await paymentFor(router);
	const response = await router.chatCompletions(new Request('http://api/v1/chat/completions', { method: 'POST', body: chatBody(), headers: { 'payment-signature': header } }));
	assert.equal(response.status, 200);
	const body = (await response.json()) as { choices: Array<{ message: { content: string } }>; usage: { completion_tokens: number } };
	assert.equal(body.choices[0]!.message.content, 'Hello');
	assert.equal(body.usage.completion_tokens, 2);
	assert.deepEqual(JSON.parse(atob(response.headers.get('x-keeta-receipt')!)), receipt);
	assert.ok(calls.includes('settle'));
	assert.ok(calls.some((c) => c.includes('/v1/router/jobs/job_abc/settled')));
});

test('streaming request passes chunks, receipt and [DONE]', async () => {
	const { router } = setup();
	const header = await paymentFor(router);
	const response = await router.chatCompletions(new Request('http://api/v1/chat/completions', { method: 'POST', body: chatBody({ stream: true }), headers: { 'payment-signature': header } }));
	const text = await response.text();
	assert.match(text, /"content":"Hel"/);
	assert.match(text, /event: keeta.receipt/);
	assert.ok(text.trimEnd().endsWith('data: [DONE]'));
});

test('a provider that fails before output is never paid', async () => {
	const { router, calls } = setup({ runJob: async () => sse(sseEvent('keeta.error', { code: 'model_failed', message: 'model crashed' })) });
	const header = await paymentFor(router);
	const response = await router.chatCompletions(new Request('http://api/v1/chat/completions', { method: 'POST', body: chatBody(), headers: { 'payment-signature': header } }));
	assert.equal(response.status, 502);
	assert.ok(!calls.includes('settle'));
});

test('forged, expired or mismatched quotes are rejected before verification', async () => {
	const { router } = setup();
	const forged = await makeTicket();
	forged.ticket.payTo = 'keeta_attacker';
	const expired = await makeTicket({ expiresAt: Date.now() - 1 });
	for (const ticket of [forged, expired]) {
		const payload = { x402Version: 2, accepted: { extra: { ticket } }, payload: {} };
		const res = await router.chatCompletions(new Request('http://api/v1/chat/completions', { method: 'POST', body: chatBody(), headers: { 'payment-signature': btoa(JSON.stringify(payload)) } }));
		assert.equal(res.status, 402);
	}
	const valid = await makeTicket();
	const bigger = await router.chatCompletions(new Request('http://api/v1/chat/completions', { method: 'POST', body: chatBody({ max_tokens: 500 }), headers: { 'payment-signature': btoa(JSON.stringify({ x402Version: 2, accepted: { extra: { ticket: valid } }, payload: {} })) } }));
	assert.equal(bigger.status, 402);
});

test('relay rejects envelopes without a valid MAC or buyer signature', async () => {
	const ticket = await makeTicket({ paymentMode: 'postpay' });
	const request = { model: 'qwen3-8b', messages: [] };
	assert.equal(await checkEnvelope(SECRET, 'job_abc', { ticket, request, buyerSig: 'aa' }, Date.now()), null);
	assert.match((await checkEnvelope(SECRET, 'job_abc', { ticket, request }, Date.now()))!, /buyer signature/);
	assert.match((await checkEnvelope(SECRET, 'job_other', { ticket, request, buyerSig: 'aa' }, Date.now()))!, /another job/);
	assert.match((await checkEnvelope('wrong', 'job_abc', { ticket, request, buyerSig: 'aa' }, Date.now()))!, /not issued/);
	const quoted = await makeTicket();
	assert.match((await checkEnvelope(SECRET, 'job_abc', { ticket: quoted, request, buyerSig: 'aa' }, Date.now()))!, /paid API/, 'a prepaid ticket from a 402 quote cannot be run directly');
});
