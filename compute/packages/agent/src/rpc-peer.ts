/**
 * Bidirectional JSON-RPC 2.0 over newline-delimited JSON streams.
 */

import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { RPC_ERRORS } from '@keeta-compute/protocol/rpc';

export class RpcError extends Error {
	constructor(
		readonly code: number,
		message: string,
		readonly data?: unknown
	) {
		super(message);
	}
}

type Handler = (params: unknown) => Promise<unknown>;

interface Message {
	jsonrpc: '2.0';
	id?: number | string | null;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

export class RpcPeer {
	private nextId = 1;
	private readonly pending = new Map<number | string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();

	constructor(
		input: Readable,
		private readonly output: Writable,
		private readonly handlers: Record<string, Handler>,
		private readonly onClose: () => void = () => undefined
	) {
		const lines = createInterface({ input, crlfDelay: Infinity });
		lines.on('line', (line) => void this.onLine(line));
		lines.on('close', () => {
			for (const entry of this.pending.values()) {
				clearTimeout(entry.timer);
				entry.reject(new Error('the app closed the connection'));
			}
			this.pending.clear();
			this.onClose();
		});
	}

	private write(message: Message): void {
		this.output.write(`${JSON.stringify(message)}\n`);
	}

	notify(method: string, params: unknown): void {
		this.write({ jsonrpc: '2.0', method, params });
	}

	request<T>(method: string, params: unknown, timeoutMs = 30_000): Promise<T> {
		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`${method} timed out`));
			}, timeoutMs);
			this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
			this.write({ jsonrpc: '2.0', id, method, params });
		});
	}

	private async onLine(line: string): Promise<void> {
		if (!line.trim()) {
			return;
		}
		let message: Message;
		try {
			message = JSON.parse(line) as Message;
		} catch {
			this.write({ jsonrpc: '2.0', id: null, error: { code: RPC_ERRORS.parse, message: 'invalid JSON' } });
			return;
		}
		if (message.method === undefined && message.id !== undefined && message.id !== null) {
			const entry = this.pending.get(message.id);
			if (!entry) {
				return;
			}
			this.pending.delete(message.id);
			clearTimeout(entry.timer);
			if (message.error) {
				entry.reject(new RpcError(message.error.code, message.error.message, message.error.data));
			} else {
				entry.resolve(message.result);
			}
			return;
		}
		if (typeof message.method !== 'string') {
			this.write({ jsonrpc: '2.0', id: message.id ?? null, error: { code: RPC_ERRORS.invalidRequest, message: 'missing method' } });
			return;
		}
		const handler = this.handlers[message.method];
		if (message.id === undefined) {
			void handler?.(message.params ?? {}).catch(() => undefined);
			return;
		}
		if (!handler) {
			this.write({ jsonrpc: '2.0', id: message.id, error: { code: RPC_ERRORS.methodNotFound, message: `unknown method ${message.method}` } });
			return;
		}
		try {
			const result = await handler(message.params ?? {});
			this.write({ jsonrpc: '2.0', id: message.id, result: result ?? null });
		} catch (error) {
			const code = error instanceof RpcError ? error.code : RPC_ERRORS.internal;
			this.write({ jsonrpc: '2.0', id: message.id, error: { code, message: (error as Error).message } });
		}
	}
}
