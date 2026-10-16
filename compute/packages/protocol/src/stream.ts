/**
 * Server-sent events between relay and buyers.
 *
 * The relay emits provider chunks as `data:` events (OpenAI chunk objects),
 * the signed receipt as `event: keeta.receipt`, and failures as
 * `event: keeta.error`. Buyers (the router, the app's agent) translate these
 * into plain OpenAI streams.
 */

import type { SignedReceipt } from './types.ts';

const encoder = new TextEncoder();

export function sseData(data: unknown): Uint8Array {
	return encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
}

/**
 * The generated text in one OpenAI stream chunk: answer plus any reasoning,
 * in that order per choice. Providers hash exactly this text into the
 * receipt's outputHash, and buyers rebuild it from what they received.
 */
export function chunkText(chunk: unknown): string {
	const choices = (chunk as { choices?: unknown } | null)?.choices;
	if (!Array.isArray(choices)) {
		return '';
	}
	let text = '';
	for (const choice of choices as Array<{ delta?: Record<string, unknown> } | null>) {
		const delta = choice?.delta ?? {};
		for (const key of ['content', 'reasoning', 'reasoning_content']) {
			if (typeof delta[key] === 'string') {
				text += delta[key];
			}
		}
	}
	return text;
}

/**
 * Most output tokens a receipt may bill for text a buyer received. Every
 * token decodes to at least one byte, so a provider cannot bill more tokens
 * than bytes delivered; the slack covers special tokens a server strips.
 */
export function maxOutputTokensFor(text: string): number {
	return encoder.encode(text).length + 16;
}

export function sseEvent(event: string, data: unknown): Uint8Array {
	return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export type RelayEvent =
	| { type: 'chunk'; data: Record<string, unknown> }
	| { type: 'receipt'; receipt: SignedReceipt }
	| { type: 'error'; code: string; message: string };

/** Parse a relay SSE body into events. */
export async function* readRelayEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<RelayEvent> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (value) {
				buffer += decoder.decode(value, { stream: true });
			}
			let boundary: number;
			while ((boundary = buffer.indexOf('\n\n')) >= 0) {
				const raw = buffer.slice(0, boundary);
				buffer = buffer.slice(boundary + 2);
				const event = parseEvent(raw);
				if (event) {
					yield event;
				}
			}
			if (done) {
				return;
			}
		}
	} finally {
		reader.releaseLock();
	}
}

function parseEvent(raw: string): RelayEvent | null {
	let name = 'message';
	const data: string[] = [];
	for (const line of raw.split('\n')) {
		if (line.startsWith('event:')) {
			name = line.slice(6).trim();
		} else if (line.startsWith('data:')) {
			data.push(line.slice(5).trimStart());
		}
	}
	if (data.length === 0) {
		return null;
	}
	const payload = JSON.parse(data.join('\n')) as Record<string, unknown>;
	if (name === 'keeta.receipt') {
		return { type: 'receipt', receipt: payload as unknown as SignedReceipt };
	}
	if (name === 'keeta.error') {
		return { type: 'error', code: String(payload.code ?? 'error'), message: String(payload.message ?? 'provider error') };
	}
	return { type: 'chunk', data: payload };
}

/** Collapse an OpenAI chunk stream into one chat.completion object. */
export async function aggregateCompletion(events: AsyncIterable<RelayEvent>, model: string) {
	let content = '';
	let reasoning = '';
	let finishReason: string | null = null;
	let usage: Record<string, unknown> | undefined;
	let id = '';
	let created = Math.floor(Date.now() / 1000);
	let receipt: SignedReceipt | undefined;
	let error: string | undefined;
	for await (const event of events) {
		if (event.type === 'receipt') {
			receipt = event.receipt;
			continue;
		}
		if (event.type === 'error') {
			error = event.message;
			continue;
		}
		const chunk = event.data as { id?: string; created?: number; choices?: Array<{ delta?: { content?: string; reasoning?: string }; finish_reason?: string | null }>; usage?: Record<string, unknown> };
		id ||= chunk.id ?? '';
		created = chunk.created ?? created;
		for (const choice of chunk.choices ?? []) {
			content += choice.delta?.content ?? '';
			reasoning += choice.delta?.reasoning ?? '';
			finishReason = choice.finish_reason ?? finishReason;
		}
		if (chunk.usage) {
			usage = chunk.usage;
		}
	}
	return {
		receipt,
		error,
		completion: {
			id: id || `chatcmpl-${crypto.randomUUID()}`,
			object: 'chat.completion',
			created,
			model,
			choices: [{ index: 0, message: { role: 'assistant', content, ...(reasoning ? { reasoning } : {}) }, finish_reason: finishReason ?? 'stop' }],
			...(usage ? { usage } : {})
		}
	};
}
