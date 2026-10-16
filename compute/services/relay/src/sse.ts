/**
 * Server-sent events between relay and buyers.
 *
 * The relay emits provider chunks as `data:` events (OpenAI chunk objects),
 * the signed receipt as `event: keeta.receipt`, and failures as
 * `event: keeta.error`. Buyers (the router, the app's agent) translate these
 * into plain OpenAI streams.
 */

import type { SignedReceipt } from '@keeta-compute/protocol';

const encoder = new TextEncoder();

export function sseData(data: unknown): Uint8Array {
	return encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
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
