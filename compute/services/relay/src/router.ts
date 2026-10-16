/**
 * The public API router (plan §6.1, §6.3): OpenAI-compatible endpoints for
 * buyers without the app, paid per request with x402 on Keeta. Payment goes
 * straight to the serving provider's account.
 *
 * Flow: quote (control plane schedules a provider and signs a prepaid
 * ticket) → 402 with the ticket inside the requirements → client signs a
 * send → verify with the facilitator → run on the provider → settle once the
 * first token arrives (a provider that fails before streaming is never paid)
 * → stream or aggregate, with the provider's signed receipt attached.
 *
 * When no provider is free, the control plane may quote a fallback ticket
 * instead: paid to keeta.ai's own account and run on OpenRouter, with the
 * same pay-after-first-text rule and an X-Keeta-Fallback header.
 */

import {
	MODEL_REQUEST_FIELDS,
	NETWORKS,
	assertChatRequest,
	promptTokenBound,
	requestedMaxTokens,
	ticketMac,
	timingSafeEqual,
	ValidationError,
	type ChatCompletionRequest,
	type JobEnvelope,
	type NetworkName,
	type SignedTicket,
	readRelayEvents,
	aggregateCompletion,
	chunkText,
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
	/** Runs an envelope on its provider's channel; returns the relay SSE response. */
	runJob(envelope: JobEnvelope, signal: AbortSignal): Promise<Response>;
	/** OpenRouter credentials for fallback jobs (tickets the control plane marks `fallback`). Fallback is off without it. */
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
		payTo: ticket.payTo,
		maxTimeoutSeconds: 60,
		extra: {
			jobId: ticket.jobId,
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

	async function models(): Promise<Response> {
		const response = await doFetch(`${deps.controlUrl}/v1/models?network=${deps.network}${deps.openRouter ? '&fallback=1' : ''}`);
		if (!response.ok) {
			return errorResponse(502, 'control_unavailable', 'the model list is unavailable right now');
		}
		const { models } = (await response.json()) as { models: Array<{ id: string; name: string; providers: number; lowestPrice: unknown; contextLength: number; license?: string; fallback?: unknown }> };
		return Response.json({
			object: 'list',
			data: models.map((m) => ({
				id: m.id,
				object: 'model',
				owned_by: 'keeta-compute',
				keeta: { name: m.name, providers: m.providers, lowestPrice: m.lowestPrice, contextLength: m.contextLength, license: m.license, ...(m.fallback ? { fallback: m.fallback } : {}) }
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
		const verified = await deps.gateway.verify(payload, requirements);
		if (!verified.isValid) {
			return errorResponse(402, 'payment_invalid', verified.invalidReason ?? 'the payment did not verify');
		}

		let events: AsyncGenerator<RelayEvent>;
		/* Fallback jobs are marked on every successful response so callers know they were not served by a network provider. */
		const served: Record<string, string> = {};
		if (ticket.fallback) {
			if (!deps.openRouter) {
				return errorResponse(503, 'no_provider', `no provider is serving ${body.model} right now; you were not charged`, { 'retry-after': '5' });
			}
			const upstream = await runOnOpenRouter(deps.openRouter, ticket.fallback.model, body, ticket.maxOutputTokens, request.signal, doFetch).catch(() => null);
			if (!upstream?.ok || !upstream.body) {
				return errorResponse(502, 'provider_unavailable', 'the fallback provider could not take the job; you were not charged', { 'retry-after': '2' });
			}
			events = readOpenRouterEvents(upstream.body, ticket.modelId);
			served['x-keeta-fallback'] = ticket.fallback.via;
		} else {
			const envelope: JobEnvelope = { ticket: signed, request: { ...body, stream: true, stream_options: { include_usage: true } } };
			const upstream = await deps.runJob(envelope, request.signal);
			if (!upstream.ok || !upstream.body) {
				return errorResponse(502, 'provider_unavailable', 'the provider could not take the job; you were not charged', { 'retry-after': '2' });
			}
			events = readRelayEvents(upstream.body);
		}

		/* Pay the provider only once it has produced text: hold back events until the first chunk that carries some. */
		const held: RelayEvent[] = [];
		let failure: string | null = 'the provider closed the stream';
		/* Read with next(): breaking out of for-await would close the generator. */
		for (let step = await events.next(); !step.done; step = await events.next()) {
			const event = step.value;
			held.push(event);
			if (event.type === 'error') {
				failure = event.message;
				break;
			}
			if (event.type === 'chunk' && chunkText(event.data) !== '') {
				failure = null;
				break;
			}
		}
		async function* all(): AsyncGenerator<RelayEvent> {
			yield* held;
			if (failure === null) {
				yield* events;
			}
		}

		if (!body.stream) {
			/* A non-streaming caller waits for the whole answer anyway, so settle only for a complete one. */
			const aggregate = failure === null ? await aggregateCompletion(all(), body.model) : null;
			const error = failure ?? aggregate?.error ?? null;
			if (error || !aggregate) {
				return errorResponse(502, 'provider_failed', `${error ?? 'the provider returned no output'}; you were not charged`);
			}
			const settled = await settle();
			if (settled instanceof Response) {
				return settled;
			}
			const headers: Record<string, string> = { 'payment-response': settled, ...served };
			if (aggregate.receipt) {
				headers['x-keeta-receipt'] = base64Json(aggregate.receipt);
			}
			return Response.json(aggregate.completion, { headers });
		}

		if (failure !== null) {
			return errorResponse(502, 'provider_failed', `${failure}; you were not charged`);
		}
		const settled = await settle();
		if (settled instanceof Response) {
			return settled;
		}
		const stream = new ReadableStream<Uint8Array>({
			async start(controller) {
				for await (const event of all()) {
					if (event.type === 'chunk') {
						controller.enqueue(encoder.encode(`data: ${JSON.stringify(event.data)}\n\n`));
					} else if (event.type === 'receipt') {
						controller.enqueue(encoder.encode(`event: keeta.receipt\ndata: ${JSON.stringify(event.receipt)}\n\n`));
					} else {
						controller.enqueue(encoder.encode(`event: keeta.error\ndata: ${JSON.stringify({ code: event.code, message: event.message })}\n\n`));
					}
				}
				controller.enqueue(encoder.encode('data: [DONE]\n\n'));
				controller.close();
			}
		});
		return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'payment-response': settled, ...served } });

		/** Settle the x402 payment; returns the payment-response header, or an error response. */
		async function settle(): Promise<string | Response> {
			const settlement = await deps.gateway.settle(payload, requirements);
			if (!settlement.success) {
				return errorResponse(402, 'settlement_failed', settlement.errorReason ?? 'the payment could not be settled');
			}
			const payer = settlement.payer ?? verified.payer;
			void control(`/v1/router/jobs/${ticket.jobId}/settled`, { method: 'POST', body: { payer, transaction: settlement.transaction ?? '' } }).catch(() => undefined);
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

/** Read an OpenRouter SSE stream as relay events, renaming the model to the network id. */
async function* readOpenRouterEvents(body: ReadableStream<Uint8Array>, modelId: string): AsyncGenerator<RelayEvent> {
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
					yield { type: 'error', code: 'upstream_error', message: typeof error.message === 'string' ? error.message : 'the fallback provider failed' };
					return;
				}
				yield { type: 'chunk', data: { ...chunk, model: modelId } };
			}
			if (done) {
				return;
			}
		}
	} finally {
		reader.releaseLock();
	}
}
