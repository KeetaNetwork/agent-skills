/**
 * One Durable Object per provider node. The provider keeps an outbound
 * WebSocket open to it (works behind NAT and sleep/wake), and buyers' job
 * requests are forwarded over that socket. Prompts and tokens pass through
 * memory only; nothing is stored. For app jobs the relay reports a hash of
 * the text it forwarded, which settles a dispute over the provider's receipt.
 */

import { chunkText, maxOutputTokensFor, sha256Hex, type JobEnvelope, type ProviderFrame, type RelayFrame } from '@keeta-compute/protocol';
import { sseData, sseEvent } from './sse.ts';

const FIRST_FRAME_TIMEOUT_MS = 120_000;
const IDLE_FRAME_TIMEOUT_MS = 120_000;
const PING_INTERVAL_MS = 25_000;

interface Pending {
	writer: WritableStreamDefaultWriter<Uint8Array>;
	timer: ReturnType<typeof setTimeout>;
	closed: boolean;
	jobId: string;
	/** App jobs only: the text forwarded so far, hashed for the delivery record. */
	delivered: string | null;
	attested: boolean;
}

interface ChannelEnv {
	CONTROL_URL: string;
	ROUTER_SECRET: string;
}

export class ProviderChannel {
	private socket: WebSocket | null = null;
	private readonly pending = new Map<string, Pending>();
	private pinger: ReturnType<typeof setInterval> | null = null;

	constructor(
		private readonly state: DurableObjectState,
		private readonly env: ChannelEnv
	) {}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === '/connect') {
			return this.connect(request);
		}
		if (url.pathname === '/run' && request.method === 'POST') {
			return this.run((await request.json()) as JobEnvelope, request.signal);
		}
		if (url.pathname === '/status') {
			return Response.json({ online: this.socket !== null, inflight: this.pending.size });
		}
		return new Response('not found', { status: 404 });
	}

	private connect(request: Request): Response {
		if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
			return new Response('expected a WebSocket upgrade', { status: 426 });
		}
		const pair = new WebSocketPair();
		const [client, server] = [pair[0], pair[1]];
		server.accept();
		/* A reconnect replaces the old socket; its in-flight jobs fail. */
		if (this.socket) {
			try {
				this.socket.close(4000, 'replaced by a new connection');
			} catch {
				/* already closed */
			}
			this.failAll('provider_reconnected', 'the provider reconnected while the job was running');
		}
		this.socket = server;
		server.addEventListener('message', (event) => this.onFrame(event.data));
		const onClose = () => {
			if (this.socket === server) {
				this.socket = null;
				this.failAll('provider_disconnected', 'the provider disconnected');
				if (this.pinger) {
					clearInterval(this.pinger);
					this.pinger = null;
				}
			}
		};
		server.addEventListener('close', onClose);
		server.addEventListener('error', onClose);
		if (!this.pinger) {
			this.pinger = setInterval(() => this.send({ type: 'ping' }), PING_INTERVAL_MS);
		}
		return new Response(null, { status: 101, webSocket: client });
	}

	private send(frame: RelayFrame): boolean {
		if (!this.socket) {
			return false;
		}
		try {
			this.socket.send(JSON.stringify(frame));
			return true;
		} catch {
			return false;
		}
	}

	private run(envelope: JobEnvelope, signal: AbortSignal): Response {
		if (!this.socket) {
			return Response.json({ error: { code: 'provider_offline', message: 'the provider is not connected' } }, { status: 503, headers: { 'retry-after': '2' } });
		}
		const id = crypto.randomUUID();
		const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
		const writer = writable.getWriter();
		const entry: Pending = {
			writer,
			timer: setTimeout(() => this.finish(id, 'timeout', 'the provider did not respond in time'), FIRST_FRAME_TIMEOUT_MS),
			closed: false,
			jobId: envelope.ticket.ticket.jobId,
			delivered: envelope.ticket.ticket.paymentMode === 'postpay' ? '' : null,
			attested: false
		};
		this.pending.set(id, entry);
		signal.addEventListener('abort', () => {
			this.send({ type: 'cancel', id });
			this.close(id);
		});
		if (!this.send({ type: 'job', id, envelope })) {
			this.finish(id, 'provider_offline', 'could not reach the provider');
		}
		return new Response(readable, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } });
	}

	private onFrame(data: unknown) {
		let frame: ProviderFrame;
		try {
			frame = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data as ArrayBuffer)) as ProviderFrame;
		} catch {
			return;
		}
		if (frame.type === 'pong') {
			return;
		}
		const entry = this.pending.get(frame.id);
		if (!entry || entry.closed) {
			return;
		}
		clearTimeout(entry.timer);
		if (frame.type === 'chunk') {
			entry.timer = setTimeout(() => this.finish(frame.id, 'timeout', 'the provider stopped responding'), IDLE_FRAME_TIMEOUT_MS);
			if (entry.delivered !== null) {
				entry.delivered += chunkText(frame.data);
			}
			void entry.writer.write(sseData(frame.data)).catch(() => this.close(frame.id));
		} else if (frame.type === 'receipt') {
			/* Record the delivery before the buyer sees the receipt, so a dispute over it is decided by this record. */
			void this.attest(entry)
				.then(() => entry.writer.write(sseEvent('keeta.receipt', frame.receipt)))
				.finally(() => this.close(frame.id));
		} else if (frame.type === 'error') {
			this.finish(frame.id, frame.code, frame.message);
		}
	}

	private finish(id: string, code: string, message: string) {
		const entry = this.pending.get(id);
		if (!entry || entry.closed) {
			return;
		}
		void entry.writer.write(sseEvent('keeta.error', { code, message })).finally(() => this.close(id));
	}

	private close(id: string) {
		const entry = this.pending.get(id);
		if (!entry || entry.closed) {
			return;
		}
		entry.closed = true;
		clearTimeout(entry.timer);
		this.pending.delete(id);
		void entry.writer.close().catch(() => undefined);
		/* A buyer hang-up or a provider error still bills what was forwarded, so record it too. */
		this.state.waitUntil(this.attest(entry));
	}

	/** Report the hash of the text forwarded for an app job to the control plane (once). */
	private async attest(entry: Pending): Promise<void> {
		if (entry.delivered === null || entry.attested) {
			return;
		}
		entry.attested = true;
		const body = JSON.stringify({ outputHash: await sha256Hex(entry.delivered), maxOutputTokens: maxOutputTokensFor(entry.delivered) });
		await fetch(`${this.env.CONTROL_URL}/v1/relay/jobs/${encodeURIComponent(entry.jobId)}/delivery`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-router-secret': this.env.ROUTER_SECRET },
			body
		}).catch(() => undefined);
	}

	private failAll(code: string, message: string) {
		for (const id of [...this.pending.keys()]) {
			this.finish(id, code, message);
		}
	}
}
