import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultAsset, ticketMac, type JobTicket, type SignedTicket } from '@keeta-compute/protocol';
import { createRouter, type PaymentGateway, type PaymentPayload } from '../src/router.ts';
import { checkEnvelope } from '../src/relay.ts';
import { lazyGateway } from '../src/gateway.ts';
import { sseData, sseEvent } from '../src/sse.ts';

const SECRET = 'relay-secret';
const payTo = 'keeta_aabpjkb2hmzj5wjiksxyxjpnbkvnelocqermwxd2ee2diikzy72cjtwd24gm37a';
const coordinator = 'keeta_coordinator';

async function makeTicket(overrides: Partial<JobTicket> = {}): Promise<SignedTicket> {
	const ticket: JobTicket = {
		v: 1, jobId: 'job_abc', network: 'test', nodeKey: payTo, modelId: 'qwen3-8b', buyer: coordinator,
		maxInputTokens: 1000, maxOutputTokens: 64, price: { inputPerMillion: '100000', outputPerMillion: '400000' },
		asset: defaultAsset('test').address, payTo, paymentMode: 'prepaid', prepaidAmount: '36',
		issuedAt: Date.now(), expiresAt: Date.now() + 60_000, ...overrides
	};
	return { ticket, coordinatorSig: '00', relayMac: await ticketMac(SECRET, ticket) };
}

function sse(...parts: Uint8Array[]): Response {
	return new Response(new ReadableStream({ start(c) { parts.forEach((p) => c.enqueue(p)); c.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
}

const chunk = (content: string, extra: Record<string, unknown> = {}) => ({ id: 'c1', created: 1, choices: [{ index: 0, delta: { content }, finish_reason: null }], ...extra });
const receipt = { receipt: { jobId: 'job_abc' }, signature: 'ff' };

function setup(options: { runJob?: () => Promise<Response>; gateway?: Partial<PaymentGateway>; ticket?: SignedTicket; openRouter?: (body: Record<string, unknown>) => Response; fallback?: { via: 'openrouter'; model: string } } = {}) {
	const calls: string[] = [];
	const upstreamBodies: Array<Record<string, unknown>> = [];
	let claims = 0;
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
		...(options.openRouter ? { openRouter: { apiKey: 'or-key' } } : {}),
		fetch: (async (url: string, init?: RequestInit) => {
			calls.push(`${init?.method ?? 'GET'} ${url}`);
			if (url.startsWith('https://openrouter.ai/')) {
				assert.equal((init?.headers as Record<string, string>).authorization, 'Bearer or-key');
				const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
				upstreamBodies.push(body);
				return options.openRouter!(body);
			}
			assert.equal((init?.headers as Record<string, string> | undefined)?.['x-router-secret'] ?? 'router-secret', 'router-secret');
			if (url.endsWith('/v1/router/quote')) {
				return Response.json({ job: {}, ticket: options.ticket ?? (await makeTicket()) });
			}
			if (url.endsWith('/claim')) {
				/* The control plane lets one claim through per fallback job. */
				if (!options.fallback) {
					return Response.json({ error: { message: 'not a fallback job' } }, { status: 404 });
				}
				return claims++ === 0 ? Response.json({ fallback: options.fallback }) : Response.json({ error: { message: 'used' } }, { status: 409 });
			}
			return Response.json({ ok: true });
		}) as typeof fetch
	});
	return { router, calls, upstreamBodies };
}

const chatBody = (extra: Record<string, unknown> = {}) => JSON.stringify({ model: 'qwen3-8b', messages: [{ role: 'user', content: 'hi' }], max_tokens: 64, ...extra });

async function paymentFor(router: ReturnType<typeof setup>['router']): Promise<string> {
	const challenge = await router.chatCompletions(new Request('http://api/v1/chat/completions', { method: 'POST', body: chatBody() }));
	assert.equal(challenge.status, 402);
	const required = JSON.parse(atob(challenge.headers.get('payment-required')!)) as { accepts: PaymentPayload['accepted'][] };
	assert.equal(required.accepts[0]!.payTo, payTo);
	assert.equal(required.accepts[0]!.amount, '36');
	assert.equal(required.accepts[0]!.network, 'keeta:1413829460');
	assert.equal(required.accepts[0]!.asset, defaultAsset('test').address, 'paid in the stablecoin the ticket names');
	assert.equal((required.accepts[0]!.extra as { assetSymbol?: string }).assetSymbol, defaultAsset('test').symbol, 'and named, so a client knows KUSD from USDC');
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

test('a provider is paid only after it streams text, never for empty chunks', async () => {
	const empty = { id: 'c1', created: 1, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] };
	for (const stream of [false, true]) {
		const { router, calls } = setup({ runJob: async () => sse(sseData(empty), sseData({}), sseEvent('keeta.error', { code: 'model_failed', message: 'model crashed' })) });
		const header = await paymentFor(router);
		const response = await router.chatCompletions(new Request('http://api/v1/chat/completions', { method: 'POST', body: chatBody({ stream }), headers: { 'payment-signature': header } }));
		assert.equal(response.status, 502);
		assert.equal(response.headers.get('payment-response'), null);
		assert.ok(!calls.includes('settle'));
	}
	const { router, calls } = setup({ runJob: async () => sse(sseData(chunk('Hel')), sseEvent('keeta.error', { code: 'model_failed', message: 'model crashed' })) });
	const header = await paymentFor(router);
	const response = await router.chatCompletions(new Request('http://api/v1/chat/completions', { method: 'POST', body: chatBody(), headers: { 'payment-signature': header } }));
	assert.equal(response.status, 502, 'a non-streaming answer that ends in an error is not paid');
	assert.ok(!calls.includes('settle'));
});

const houseTicket = () => makeTicket({ nodeKey: coordinator, buyer: coordinator });
const route = { via: 'openrouter' as const, model: 'qwen/qwen3-8b' };

test('with no provider free, a fallback quote is served through OpenRouter with no trace of it', async () => {
	const fallbackTicket = await houseTicket();
	const text = (...lines: string[]) => new Response(lines.join('\n'), { headers: { 'content-type': 'text/event-stream' } });
	const upstreamChunk = (content: string, extra: Record<string, unknown> = {}) => ({ ...chunk(content), id: 'gen-123', model: 'qwen/qwen3-8b', provider: 'DeepInfra', system_fingerprint: 'fp', ...extra });
	const { router, calls, upstreamBodies } = setup({
		ticket: fallbackTicket,
		fallback: route,
		openRouter: () => text(': OPENROUTER PROCESSING', '', `data: ${JSON.stringify(upstreamChunk('Hi'))}`, '', `data: ${JSON.stringify(upstreamChunk(' there', { usage: { prompt_tokens: 4, completion_tokens: 2, cost: 0.0001, is_byok: false } }))}`, '', 'data: [DONE]', '')
	});
	const challenge = await router.chatCompletions(new Request('http://api/v1/chat/completions', { method: 'POST', body: chatBody() }));
	assert.ok(!atob(challenge.headers.get('payment-required')!).includes('openrouter'), 'the quote does not name the fallback');
	const header = await paymentFor(router);
	const response = await router.chatCompletions(new Request('http://api/v1/chat/completions', { method: 'POST', body: chatBody({ chat_template: '{{ evil }}' }), headers: { 'payment-signature': header } }));
	assert.equal(response.status, 200);
	assert.equal(response.headers.get('x-keeta-fallback'), null);
	const raw = await response.text();
	for (const marker of ['openrouter', 'gen-123', 'DeepInfra', 'cost', 'is_byok', 'system_fingerprint']) {
		assert.ok(!raw.toLowerCase().includes(marker.toLowerCase()), `response leaks ${marker}`);
	}
	const body = JSON.parse(raw) as { id: string; model: string; choices: Array<{ message: { content: string } }> };
	assert.equal(body.choices[0]!.message.content, 'Hi there');
	assert.equal(body.model, 'qwen3-8b', 'the network model id, not the upstream slug');
	assert.ok(calls.includes('settle'));
	const sent = upstreamBodies[0]!;
	assert.equal(sent.model, 'qwen/qwen3-8b');
	assert.equal(sent.max_tokens, 64);
	assert.equal(sent.chat_template, undefined, 'only known fields are forwarded');
	assert.deepEqual(sent.provider, { data_collection: 'deny' });
});

test('provider jobs never look up a fallback route', async () => {
	const { router, calls } = setup({ fallback: route, openRouter: () => new Response('') });
	const response = await router.chatCompletions(new Request('http://api/v1/chat/completions', { method: 'POST', body: chatBody(), headers: { 'payment-signature': await paymentFor(router) } }));
	assert.equal(response.status, 200);
	assert.ok(!calls.some((c) => c.endsWith('/claim')));
	assert.ok(!calls.some((c) => c.includes('openrouter')));
});

test('one fallback payment replayed in parallel starts one upstream run', async () => {
	const text = () => new Response(`data: ${JSON.stringify(chunk('Hi', { usage: { prompt_tokens: 4, completion_tokens: 1 } }))}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
	const { router, upstreamBodies } = setup({ ticket: await houseTicket(), fallback: route, openRouter: text });
	const header = await paymentFor(router);
	const send = () => router.chatCompletions(new Request('http://api/v1/chat/completions', { method: 'POST', body: chatBody(), headers: { 'payment-signature': header } }));
	const statuses = (await Promise.all([send(), send(), send()])).map((r) => r.status).sort();
	assert.deepEqual(statuses, [200, 409, 409]);
	assert.equal(upstreamBodies.length, 1, 'OpenRouter ran once');
});

test('a fallback that fails before text, or is not configured, is never paid', async () => {
	const fallbackTicket = await houseTicket();
	const failing = setup({ ticket: fallbackTicket, fallback: route, openRouter: () => new Response(`data: ${JSON.stringify({ error: { code: 502, message: 'OpenRouter: upstream down' } })}\n\n`) });
	let response = await failing.router.chatCompletions(new Request('http://api/v1/chat/completions', { method: 'POST', body: chatBody(), headers: { 'payment-signature': await paymentFor(failing.router) } }));
	assert.equal(response.status, 502);
	assert.ok(!(await response.text()).includes('OpenRouter'), 'upstream error text is not passed on');
	assert.ok(!failing.calls.includes('settle'));
	const off = setup({ ticket: fallbackTicket, fallback: route });
	response = await off.router.chatCompletions(new Request('http://api/v1/chat/completions', { method: 'POST', body: chatBody(), headers: { 'payment-signature': await paymentFor(off.router) } }));
	assert.equal(response.status, 503);
	assert.ok(!off.calls.includes('settle'));
});

test('a payment service outage answers 503 and runs nothing; a failed settlement charges nothing', async () => {
	let ran = 0;
	const runJob = async () => (ran++, sse(sseData(chunk('Hello', { usage: { prompt_tokens: 5, completion_tokens: 1 } })), sseEvent('keeta.receipt', receipt)));
	const down = setup({ runJob, gateway: { verify: async () => Promise.reject(new Error('facilitator unreachable')) } });
	const paid = await down.router.chatCompletions(new Request('http://api/v1/chat/completions', { method: 'POST', body: chatBody(), headers: { 'payment-signature': await paymentFor(down.router) } }));
	assert.equal(paid.status, 503);
	assert.equal(paid.headers.get('retry-after'), '5');
	assert.equal(ran, 0, 'no provider runs a job whose payment was not checked');

	const failing = setup({ runJob, gateway: { settle: async () => Promise.reject(new Error('facilitator timed out')) } });
	const unsettled = await failing.router.chatCompletions(new Request('http://api/v1/chat/completions', { method: 'POST', body: chatBody(), headers: { 'payment-signature': await paymentFor(failing.router) } }));
	assert.equal(unsettled.status, 402);
	assert.match(((await unsettled.json()) as { error: { message: string } }).error.message, /not charged/);
	assert.ok(!failing.calls.some((c) => c.includes('/settled')), 'an unsettled job is not reported as paid');
});

test('the payment gateway connects on first use and retries a failed connection', async () => {
	let attempts = 0;
	const gateway = lazyGateway(async () => {
		attempts++;
		if (attempts === 1) {
			throw new Error('facilitator unreachable');
		}
		return { verify: async () => ({ isValid: true }), settle: async () => ({ success: true }) };
	});
	assert.equal(attempts, 0, 'nothing connects until a payment needs checking');
	const payload = {} as PaymentPayload;
	await assert.rejects(gateway.verify(payload, payload.accepted), /unreachable/);
	assert.deepEqual(await gateway.verify(payload, payload.accepted), { isValid: true });
	assert.deepEqual(await gateway.settle(payload, payload.accepted), { success: true });
	assert.equal(attempts, 2, 'a working connection is kept');
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
	const ticket = await makeTicket({ paymentMode: 'escrow' });
	const request = { model: 'qwen3-8b', messages: [] };
	assert.equal(await checkEnvelope(SECRET, 'job_abc', { ticket, request, buyerSig: 'aa' }, Date.now()), null);
	assert.match((await checkEnvelope(SECRET, 'job_abc', { ticket, request }, Date.now()))!, /buyer signature/);
	assert.match((await checkEnvelope(SECRET, 'job_other', { ticket, request, buyerSig: 'aa' }, Date.now()))!, /another job/);
	assert.match((await checkEnvelope('wrong', 'job_abc', { ticket, request, buyerSig: 'aa' }, Date.now()))!, /not issued/);
	const quoted = await makeTicket();
	assert.match((await checkEnvelope(SECRET, 'job_abc', { ticket: quoted, request, buyerSig: 'aa' }, Date.now()))!, /paid API/, 'a prepaid ticket from a 402 quote cannot be run directly');
});
