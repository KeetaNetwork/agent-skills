/**
 * One Durable Object per provider node. The provider keeps an outbound
 * WebSocket open to it (works behind NAT and sleep/wake), and buyers' job
 * requests are forwarded over that socket. Prompts and tokens pass through
 * memory only; nothing is stored. For app jobs the relay reports a hash of
 * the text it forwarded, which decides how the job's escrow is settled, or
 * that the provider was offline when the buyer brought the ticket.
 */

import { chunkText, maxOutputTokensFor, sha256Hex, type JobEnvelope, type ProviderFrame, type RelayFrame } from '@keeta-compute/protocol';
import { sseData, sseEvent } from './sse.ts';
import { postDelivery, postProviderOffline } from './delivery.ts';

const FIRST_FRAME_TIMEOUT_MS = 120_000;
const IDLE_FRAME_TIMEOUT_MS = 120_000;
/** How long after a buyer hangs up the relay still counts the provider's text, waiting for its receipt: what it sent before the cancel reached it. */
export const HANG_UP_GRACE_MS = 5_000;
const PING_INTERVAL_MS = 25_000;

interface Pending {
	writer: WritableStreamDefaultWriter<Uint8Array>;
	timer: ReturnType<typeof setTimeout>;
	closed: boolean;
	jobId: string;
	/** App jobs only: the text forwarded so far, hashed for the delivery record. */
	delivered: string | null;
	/** When the buyer brought the ticket, and when it hung up if nothing had been forwarded yet: the control plane charges a no-show fee for a ticket not used promptly. */
	presentedAt: number;
	abandonedAt?: number;
	/** App jobs only: the buyer hung up, and the record waits for the provider's receipt (or HANG_UP_GRACE_MS). */
	hungUp?: boolean;
	/** The one delivery record post for this job, once started. */
	attesting: Promise<void> | null;
	/** Router jobs only: the provider holds a slot for it and waits for `start`. */
	accepted?: boolean;
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
		if (url.pathname === '/start' && request.method === 'POST') {
			return this.start(((await request.json()) as { jobId: string }).jobId);
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
			/* The buyer showed up with its ticket, so it owes the provider no no-show fee. */
			if (envelope.ticket.ticket.paymentMode === 'escrow') {
				this.state.waitUntil(postProviderOffline({ controlUrl: this.env.CONTROL_URL, routerSecret: this.env.ROUTER_SECRET, jobId: envelope.ticket.ticket.jobId }).then(() => undefined));
			}
			return Response.json({ error: { code: 'provider_offline', message: 'the provider is not connected' } }, { status: 503, headers: { 'retry-after': '2' } });
		}
		/* A ticket runs once at a time: the provider would refuse a second run, and the record for that empty run could stand for the job instead of the real one. */
		const jobId = envelope.ticket.ticket.jobId;
		if ([...this.pending.values()].some((e) => e.jobId === jobId)) {
			return Response.json({ error: { code: 'ticket_used', message: 'this ticket is already running' } }, { status: 409 });
		}
		const id = crypto.randomUUID();
		const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
		const writer = writable.getWriter();
		const entry: Pending = {
			writer,
			timer: setTimeout(() => this.finish(id, 'timeout', 'the provider did not respond in time'), FIRST_FRAME_TIMEOUT_MS),
			closed: false,
			jobId,
			delivered: envelope.ticket.ticket.paymentMode === 'escrow' ? '' : null,
			presentedAt: Date.now(),
			attesting: null
		};
		this.pending.set(id, entry);
		signal.addEventListener('abort', () => this.hangUp(id));
		if (!this.send({ type: 'job', id, envelope })) {
			this.finish(id, 'provider_offline', 'could not reach the provider');
		}
		return new Response(readable, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } });
	}

	/** The router settled a prepaid job's payment: tell the provider holding it to run it. */
	private start(jobId: string): Response {
		const entry = [...this.pending.entries()].find(([, e]) => e.jobId === jobId && e.accepted && !e.closed);
		if (!entry || !this.send({ type: 'start', id: entry[0] })) {
			return Response.json({ error: { code: 'not_accepted', message: 'the provider is not holding this job' } }, { status: 409 });
		}
		return Response.json({ started: true });
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
		if (entry.hungUp) {
			/* The buyer is gone, but the provider bills what it sent until the cancel reached it: count that too, so the record and the receipt cover the same text. */
			if (frame.type === 'chunk' && entry.delivered !== null) {
				entry.delivered += chunkText(frame.data);
			} else if (frame.type === 'receipt' || frame.type === 'error') {
				this.close(frame.id);
			}
			return;
		}
		clearTimeout(entry.timer);
		if (frame.type === 'accepted') {
			/* The provider drops the job itself if the router never starts it; this only bounds a provider that goes quiet. */
			entry.accepted = true;
			entry.timer = setTimeout(() => this.finish(frame.id, 'timeout', 'the provider stopped responding'), IDLE_FRAME_TIMEOUT_MS);
			void entry.writer.write(sseEvent('keeta.accepted', {})).catch(() => this.hangUp(frame.id));
		} else if (frame.type === 'chunk') {
			entry.timer = setTimeout(() => this.finish(frame.id, 'timeout', 'the provider stopped responding'), IDLE_FRAME_TIMEOUT_MS);
			if (entry.delivered !== null) {
				entry.delivered += chunkText(frame.data);
			}
			void entry.writer.write(sseData(frame.data)).catch(() => this.hangUp(frame.id));
		} else if (frame.type === 'receipt') {
			/* Record the delivery before the buyer sees the receipt; the control plane pays the receipt only if it matches this record. */
			void this.attest(entry)
				.then(() => entry.writer.write(sseEvent('keeta.receipt', frame.receipt)))
				.finally(() => this.close(frame.id));
		} else if (frame.type === 'error') {
			this.finish(frame.id, frame.code, frame.message);
		}
	}

	/**
	 * The buyer went away: cancel the job on the provider. The provider learns
	 * of it a round trip later and bills what it sent until then, so an app
	 * job's record waits for its receipt, for at most HANG_UP_GRACE_MS.
	 */
	private hangUp(id: string) {
		const entry = this.pending.get(id);
		if (entry?.hungUp) {
			return;
		}
		this.send({ type: 'cancel', id });
		if (!entry || entry.closed || entry.delivered === null) {
			this.close(id);
			return;
		}
		entry.hungUp = true;
		if (entry.delivered === '') {
			entry.abandonedAt = Date.now();
		}
		clearTimeout(entry.timer);
		entry.timer = setTimeout(() => this.close(id), HANG_UP_GRACE_MS);
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
		void entry.writer.close().catch(() => undefined);
		/* A buyer hang-up or a provider error still bills what was forwarded, so record it too; the entry stays until then, so the ticket cannot run again meanwhile. */
		this.state.waitUntil(this.attest(entry).finally(() => this.pending.delete(id)));
	}

	/** Report the hash of the text forwarded for an app job to the control plane, once, retrying until it is accepted. */
	private attest(entry: Pending): Promise<void> {
		if (entry.delivered === null) {
			return Promise.resolve();
		}
		const delivered = entry.delivered;
		const { presentedAt, abandonedAt } = entry;
		entry.attesting ??= (async () => {
			await postDelivery({
				controlUrl: this.env.CONTROL_URL,
				routerSecret: this.env.ROUTER_SECRET,
				jobId: entry.jobId,
				outputHash: await sha256Hex(delivered),
				maxOutputTokens: maxOutputTokensFor(delivered),
				presentedAt,
				...(abandonedAt !== undefined ? { abandonedAt } : {})
			});
		})();
		return entry.attesting;
	}

	private failAll(code: string, message: string) {
		for (const id of [...this.pending.keys()]) {
			this.finish(id, code, message);
		}
	}
}
