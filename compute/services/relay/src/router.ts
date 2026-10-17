/**
 * The public API router (plan §6.1, §6.3): OpenAI-compatible endpoints for
 * buyers without the app, paid per request with x402 on Keeta in a
 * stablecoin: KUSD once it is pinned, otherwise USDC. Offer prices are in
 * credits, and one credit is one US dollar of the stablecoin. Payment goes
 * to keeta.ai's settlement account, referencing the job; once the job is
 * decided, the control plane pays the provider what the receipt bills, less
 * the 0.25% network fee, and sends the rest of the payment back to the payer.
 *
 * Flow: quote (control plane schedules a provider and signs a prepaid
 * ticket) → 402 with the ticket inside the requirements → client signs a
 * send → verify with the facilitator → the provider checks the ticket and
 * holds a slot → settle → the provider runs the job → stream or aggregate,
 * with the provider's signed receipt attached. Verify only simulates the
 * send, so nothing runs before it settles; a provider that is offline, busy
 * or refuses the ticket is never paid.
 *
 * When no provider is free, the control plane may quote a fallback ticket
 * instead: paid to keeta.ai's own account, settled, then run on OpenRouter.
 * Fallback responses carry no upstream markers: chunks are rebuilt in the
 * plain OpenAI shape.
 */

import {
	MODEL_REQUEST_FIELDS,
	NETWORKS,
	assertChatRequest,
	findAsset,
	promptTokenBound,
	requestedMaxTokens,
	ticketMac,
	timingSafeEqual,
	ValidationError,
	type ChatCompletionRequest,
	type FallbackRoute,
	type JobEnvelope,
	type NetworkName,
	type JobTicket,
	type SignedTicket,
	readRelayEvents,
	aggregateCompletion,
	type RelayEvent
} from '@keeta-compute/protocol';


export interface PaymentRequirements {
	scheme: string;
	network: string;
	asset: string;
	amount: string;
	payTo: string;
	maxTimeoutSeconds: number;
	extra: Record<string, unknown>;
}

export interface PaymentPayload {
	x402Version: number;
	accepted: PaymentRequirements;
	payload: Record<string, unknown>;
	resource?: unknown;
}

export interface PaymentGateway {
	verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<{ isValid: boolean; invalidReason?: string; payer?: string }>;
	settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<{ success: boolean; transaction?: string; payer?: string; errorReason?: string }>;
}

export interface RouterDeps {
	network: NetworkName;
	controlUrl: string;
	routerSecret: string;
	relaySecret: string;
	gateway: PaymentGateway;
	/** Runs an envelope on its provider's channel; returns the relay SSE response. A prepaid job waits there, accepted, for startJob. */
	runJob(envelope: JobEnvelope, signal: AbortSignal): Promise<Response>;
	/** Starts an accepted prepaid job once its payment settled; false when the provider no longer holds it. */
	startJob(ticket: JobTicket): Promise<boolean>;
	/** OpenRouter credentials for fallback jobs (jobs the control plane records with a `fallback` route). Fallback is off without it. */
	openRouter?: { apiKey: string; baseUrl?: string };
	fetch?: typeof fetch;
	now?: () => number;
}

const encoder = new TextEncoder();

function base64Json(value: unknown): string {
	const bytes = encoder.encode(JSON.stringify(value));
	let binary = '';
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary);
}

function fromBase64Json<T>(text: string): T {
	const binary = atob(text);
	const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
	return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

function errorResponse(status: number, code: string, message: string, headers: Record<string, string> = {}): Response {
	return Response.json({ error: { code, message, type: code } }, { status, headers });
}

export function requirementsFromTicket(signed: SignedTicket, network: NetworkName): PaymentRequirements {
	const { ticket } = signed;
	return {
		scheme: 'exact',
		network: NETWORKS[network].caip2,
		asset: ticket.asset,
		amount: ticket.prepaidAmount ?? '0',
		payTo: ticket.paymentTo ?? ticket.payTo,
		maxTimeoutSeconds: 60,
		extra: {
			jobId: ticket.jobId,
			/* Written into the send, so the settlement account can tell which job a payment is for. */
			external: ticket.jobId,
			/* Which stablecoin `asset` is (KUSD or USDC); the price is in credits, one to the dollar. */
			assetSymbol: findAsset(network, ticket.asset)?.symbol ?? null,
			model: ticket.modelId,
			maxInputTokens: ticket.maxInputTokens,
			maxOutputTokens: ticket.maxOutputTokens,
			price: ticket.price,
			ticket: signed
		}
	};
}

export function createRouter(deps: RouterDeps) {
	const doFetch = deps.fetch ?? fetch;
	const now = deps.now ?? Date.now;

	async function control(path: string, init: { method: string; body?: unknown }) {
		return doFetch(`${deps.controlUrl}${path}`, {
			method: init.method,
			headers: { 'content-type': 'application/json', 'x-router-secret': deps.routerSecret },
			...(init.body === undefined ? {} : { body: JSON.stringify(init.body) })
		});
	}

	/**
	 * Claim a fallback job before running it upstream. The control plane lets
	 * exactly one claim through per job, so one x402 payment replayed in
	 * parallel cannot start more than one paid upstream run.
	 */
	async function claimFallback(jobId: string): Promise<FallbackRoute | 'used' | null> {
		const response = await control(`/v1/router/jobs/${encodeURIComponent(jobId)}/claim`, { method: 'POST', body: {} }).catch(() => null);
		if (response?.status === 409) {
			return 'used';
		}
		if (!response?.ok) {
			return null;
		}
		const { fallback } = (await response.json().catch(() => ({}))) as { fallback?: FallbackRoute };
		return fallback ?? null;
	}

	async function models(): Promise<Response> {
		const response = await doFetch(`${deps.controlUrl}/v1/models?network=${deps.network}${deps.openRouter ? '&fallback=1' : ''}`);
		if (!response.ok) {
			return errorResponse(502, 'control_unavailable', 'the model list is unavailable right now');
		}
		const { models } = (await response.json()) as { models: Array<{ id: string; name: string; providers: number; lowestPrice: unknown; contextLength: number; license?: string }> };
		return Response.json({
			object: 'list',
			data: models.map((m) => ({
				id: m.id,
				object: 'model',
				owned_by: 'keeta-compute',
				keeta: { name: m.name, providers: m.providers, lowestPrice: m.lowestPrice, priceUnit: 'credit base units per million tokens (1 credit = 1 USD, 6 decimals)', contextLength: m.contextLength, license: m.license }
			}))
		});
	}

	async function chatCompletions(request: Request): Promise<Response> {
		let body: ChatCompletionRequest;
		try {
			body = assertChatRequest(await request.json());
		} catch (error) {
			return errorResponse(400, 'invalid_request', error instanceof ValidationError ? error.message : 'body must be a JSON chat completion request');
		}
		const maxOutputTokens = requestedMaxTokens(body);
		const maxInputTokens = promptTokenBound(body);
		const paymentHeader = request.headers.get('payment-signature') ?? request.headers.get('x-payment');
		const resource = { url: request.url, description: `Chat completion with ${body.model} on Keeta Compute`, mimeType: body.stream ? 'text/event-stream' : 'application/json' };

		if (!paymentHeader) {
			const quote = await control('/v1/router/quote', { method: 'POST', body: { network: deps.network, model: body.model, maxInputTokens, maxOutputTokens } });
			if (quote.status === 503) {
				return errorResponse(503, 'no_provider', `no provider is serving ${body.model} right now`, { 'retry-after': quote.headers.get('retry-after') ?? '5' });
			}
			if (!quote.ok) {
				const detail = (await quote.json().catch(() => ({}))) as { error?: { message?: string } };
				return errorResponse(quote.status === 400 ? 400 : 502, 'quote_failed', detail.error?.message ?? 'could not quote this request');
			}
			const { ticket } = (await quote.json()) as { ticket: SignedTicket };
			const paymentRequired = { x402Version: 2, error: 'payment required', resource, accepts: [requirementsFromTicket(ticket, deps.network)] };
			return Response.json(paymentRequired, { status: 402, headers: { 'payment-required': base64Json(paymentRequired), 'cache-control': 'private, no-store' } });
		}

		let payload: PaymentPayload;
		try {
			payload = fromBase64Json<PaymentPayload>(paymentHeader);
		} catch {
			return errorResponse(402, 'invalid_payment', 'the payment header is not valid base64 JSON');
		}
		const signed = payload.accepted?.extra?.ticket as SignedTicket | undefined;
		if (!signed?.ticket || typeof signed.relayMac !== 'string') {
			return errorResponse(402, 'invalid_payment', 'the payment does not reference a quote; request a new one');
		}
		const { ticket } = signed;
		if (!timingSafeEqual(signed.relayMac, await ticketMac(deps.relaySecret, ticket)) || ticket.paymentMode !== 'prepaid') {
			return errorResponse(402, 'invalid_payment', 'the quote was not issued by this router');
		}
		if (ticket.expiresAt < now()) {
			return errorResponse(402, 'quote_expired', 'the quote expired; request a new one');
		}
		if (ticket.modelId !== body.model || maxOutputTokens > ticket.maxOutputTokens || maxInputTokens > ticket.maxInputTokens) {
			return errorResponse(402, 'quote_mismatch', 'the request does not match the quote it pays for');
		}
		const requirements = requirementsFromTicket(signed, deps.network);
		const checked = await deps.gateway.verify(payload, requirements).catch(() => null);
		if (!checked) {
			return errorResponse(503, 'payment_unavailable', 'the payment could not be checked right now; you were not charged', { 'retry-after': '5' });
		}
		const verified = checked;
		if (!verified.isValid) {
			return errorResponse(402, 'payment_invalid', verified.invalidReason ?? 'the payment did not verify');
		}

		/* Verify only simulated the send, so a payer could still spend it elsewhere: nothing runs until the payment settles. */
		const upstreamAbort = new AbortController();
		const stopUpstream = () => upstreamAbort.abort();
		request.signal.addEventListener('abort', stopUpstream, { once: true });
		let events: AsyncGenerator<RelayEvent>;
		let settled: string;
		/* keeta.ai serves the job itself (node = buyer = coordinator) only on a fallback quote; its route stays server-side, off the ticket buyers see. */
		if (ticket.nodeKey === ticket.buyer) {
			if (!deps.openRouter) {
				return errorResponse(503, 'no_provider', `no provider is serving ${body.model} right now; you were not charged`, { 'retry-after': '5' });
			}
			const route = await claimFallback(ticket.jobId);
			if (route === 'used') {
				return errorResponse(409, 'quote_used', 'this quote was already used; request a new one');
			}
			if (!route) {
				return errorResponse(502, 'control_unavailable', 'the job could not be started; you were not charged', { 'retry-after': '2' });
			}
			const paid = await settle();
			if (paid instanceof Response) {
				return paid;
			}
			settled = paid;
			const upstream = await runOnOpenRouter(deps.openRouter, route.model, body, ticket.maxOutputTokens, upstreamAbort.signal, doFetch).catch(() => null);
			if (!upstream?.ok || !upstream.body) {
				return errorResponse(502, 'provider_unavailable', 'the job could not be run after its payment settled', { 'payment-response': settled });
			}
			events = readOpenRouterEvents(upstream.body, ticket.modelId, ticket.jobId);
		} else {
			const envelope: JobEnvelope = { ticket: signed, request: { ...body, stream: true, stream_options: { include_usage: true } } };
			const upstream = await deps.runJob(envelope, upstreamAbort.signal);
			if (!upstream.ok || !upstream.body) {
				return errorResponse(502, 'provider_unavailable', 'the provider could not take the job; you were not charged', { 'retry-after': '2' });
			}
			events = readRelayEvents(upstream.body);
			/* The provider checks the ticket and holds a slot first; anything else (a refusal, or output before the payment settled) is not paid. */
			const first = await events.next();
			if (first.done || first.value.type !== 'accepted') {
				stopUpstream();
				const reason = !first.done && first.value.type === 'error' ? first.value.message : 'the provider did not accept the job';
				return errorResponse(502, 'provider_unavailable', `${reason}; you were not charged`, { 'retry-after': '2' });
			}
			const paid = await settle();
			if (paid instanceof Response) {
				stopUpstream();
				return paid;
			}
			settled = paid;
			if (!(await deps.startJob(ticket).catch(() => false))) {
				stopUpstream();
				return errorResponse(502, 'provider_failed', 'the provider dropped the job after its payment settled', { 'payment-response': settled });
			}
		}

		if (!body.stream) {
			const aggregate = await aggregateCompletion(events, body.model);
			if (aggregate.error) {
				return errorResponse(502, 'provider_failed', `${aggregate.error}; the payment had settled when the job started`, { 'payment-response': settled });
			}
			const headers: Record<string, string> = { 'payment-response': settled };
			if (aggregate.receipt) {
				headers['x-keeta-receipt'] = base64Json(aggregate.receipt);
			}
			return Response.json(aggregate.completion, { headers });
		}

		const stream = new ReadableStream<Uint8Array>({
			async start(controller) {
				for await (const event of events) {
					if (event.type === 'chunk') {
						controller.enqueue(encoder.encode(`data: ${JSON.stringify(event.data)}\n\n`));
					} else if (event.type === 'receipt') {
						controller.enqueue(encoder.encode(`event: keeta.receipt\ndata: ${JSON.stringify(event.receipt)}\n\n`));
					} else if (event.type === 'error') {
						controller.enqueue(encoder.encode(`event: keeta.error\ndata: ${JSON.stringify({ code: event.code, message: event.message })}\n\n`));
					}
				}
				controller.enqueue(encoder.encode('data: [DONE]\n\n'));
				controller.close();
			}
		});
		return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'payment-response': settled } });

		/** Settle the x402 payment; returns the payment-response header, or an error response. */
		async function settle(): Promise<string | Response> {
			const settlement = await deps.gateway.settle(payload, requirements).catch(() => ({ success: false as const, errorReason: 'the payment service could not settle the payment; you were not charged' }));
			if (!settlement.success) {
				return errorResponse(402, 'settlement_failed', settlement.errorReason ?? 'the payment could not be settled');
			}
			const payer = settlement.payer ?? verified.payer;
			/* The payer's signed block too: the settlement's transaction names the vote staple, and the control plane reads the block itself. */
			const block = typeof payload.payload?.block === 'string' ? payload.payload.block : undefined;
			void control(`/v1/router/jobs/${ticket.jobId}/settled`, { method: 'POST', body: { payer, transaction: settlement.transaction ?? '', ...(block ? { block } : {}) } }).catch(() => undefined);
			return base64Json({ success: true, transaction: settlement.transaction, network: requirements.network, payer });
		}
	}

	return { models, chatCompletions };
}

const OPENROUTER_URL = 'https://openrouter.ai/api/v1';

/** Send a fallback job to OpenRouter: only the fields a provider would forward, capped at the paid output. */
function runOnOpenRouter(
	config: { apiKey: string; baseUrl?: string },
	model: string,
	body: ChatCompletionRequest,
	maxOutputTokens: number,
	signal: AbortSignal,
	doFetch: typeof fetch
): Promise<Response> {
	const forwarded = Object.fromEntries(MODEL_REQUEST_FIELDS.filter((key) => body[key] !== undefined).map((key) => [key, body[key]]));
	return doFetch(`${config.baseUrl ?? OPENROUTER_URL}/chat/completions`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}`, 'http-referer': 'https://keeta.ai/compute', 'x-title': 'Keeta Compute' },
		body: JSON.stringify({
			...forwarded,
			model,
			stream: true,
			max_tokens: Math.min(requestedMaxTokens(body), maxOutputTokens),
			usage: { include: true },
			/* Keep prompts away from upstream providers that train on or retain them. */
			provider: { data_collection: 'deny' }
		}),
		signal
	});
}

/** Read an OpenRouter SSE stream as relay events, rebuilt as plain OpenAI chunks under the network model id. */
async function* readOpenRouterEvents(body: ReadableStream<Uint8Array>, modelId: string, jobId: string): AsyncGenerator<RelayEvent> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (value) {
				buffer += decoder.decode(value, { stream: true });
			}
			let newline: number;
			while ((newline = buffer.indexOf('\n')) >= 0) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				/* Skip keep-alive comments and the end marker. */
				if (!line.startsWith('data:')) {
					continue;
				}
				const data = line.slice(5).trim();
				if (data === '[DONE]') {
					continue;
				}
				let chunk: Record<string, unknown>;
				try {
					chunk = JSON.parse(data) as Record<string, unknown>;
				} catch {
					continue;
				}
				const error = chunk.error as { code?: unknown; message?: unknown } | undefined;
				if (error) {
					yield { type: 'error', code: 'upstream_error', message: 'the model failed while answering' };
					return;
				}
				yield { type: 'chunk', data: plainChunk(chunk, modelId, jobId) };
			}
			if (done) {
				return;
			}
		}
	} finally {
		reader.releaseLock();
	}
}

/** Keep only standard OpenAI chunk fields, so upstream ids, provider names and costs never reach the buyer. */
function plainChunk(chunk: Record<string, unknown>, modelId: string, jobId: string): Record<string, unknown> {
	const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
	const usage = chunk.usage as { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown } | undefined;
	return {
		id: `chatcmpl-${jobId}`,
		object: 'chat.completion.chunk',
		created: typeof chunk.created === 'number' ? chunk.created : Math.floor(Date.now() / 1000),
		model: modelId,
		choices: choices.map((choice: { index?: unknown; delta?: Record<string, unknown>; finish_reason?: unknown }) => {
			const delta = choice.delta ?? {};
			return {
				index: typeof choice.index === 'number' ? choice.index : 0,
				delta: Object.fromEntries(['role', 'content', 'reasoning', 'reasoning_content', 'tool_calls', 'refusal'].filter((key) => delta[key] !== undefined && delta[key] !== null).map((key) => [key, delta[key]])),
				finish_reason: choice.finish_reason ?? null
			};
		}),
		...(usage && typeof usage.prompt_tokens === 'number' && typeof usage.completion_tokens === 'number'
			? { usage: { prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens, total_tokens: usage.prompt_tokens + usage.completion_tokens } }
			: {})
	};
}
