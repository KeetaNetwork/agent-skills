/**
 * Pieces shared by the end-to-end suites: polling, local servers, a fake
 * OpenAI-compatible model server, and a Mac-style agent with a software
 * stand-in for its Secure Enclave key.
 */

import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { p256 } from '@noble/curves/p256';
import { fromHex, toHex, type HardwareProfile } from '@keeta-compute/protocol';
import { AgentApp } from '../../agent/src/app.ts';
import type { CreditExchange } from '../../agent/src/fx.ts';
import type { Ledger } from '../../agent/src/ledger.ts';

export const GB = 1024 ** 3;

export const mac64: HardwareProfile = { os: 'macos', osVersion: '15.4', chip: 'Apple M4 Max', memoryBytes: 64 * GB, freeDiskBytes: 500 * GB };

export function listen(server: Server): Promise<string> {
	return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
}

/** A TCP port nothing listens on right now. */
export async function freePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as AddressInfo;
	await new Promise((resolve) => server.close(resolve));
	return port;
}

export async function until<T>(what: string, probe: () => Promise<T | null | undefined | false> | T | null | undefined | false, timeoutMs = 10_000, everyMs = 25): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await probe();
		if (value) {
			return value;
		}
		if (Date.now() > deadline) {
			throw new Error(`timed out waiting for ${what}`);
		}
		await new Promise((r) => setTimeout(r, everyMs));
	}
}

export async function readBody(req: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) {
		chunks.push(chunk as Buffer);
	}
	return Buffer.concat(chunks).toString('utf8');
}

/** Temporary directories and teardown steps, run in reverse order. */
export class Scratch {
	private readonly dirs: string[] = [];
	private readonly steps: Array<() => unknown> = [];

	dir(name: string): string {
		const dir = mkdtempSync(join(tmpdir(), `kc-${name}-`));
		this.dirs.push(dir);
		return dir;
	}

	defer(step: () => unknown): void {
		this.steps.push(step);
	}

	async cleanup(): Promise<void> {
		for (const step of this.steps.reverse()) {
			try {
				await step();
			} catch (error) {
				console.warn('cleanup step failed:', (error as Error).message);
			}
		}
		for (const dir of this.dirs) {
			rmSync(dir, { recursive: true, force: true });
		}
	}
}

/**
 * An OpenAI-compatible model server that streams "Hello from Keeta" with
 * usage 12 in / 3 out. A prompt containing "slowly" stalls after each piece
 * until the caller hangs up.
 */
export function fakeModelServer(servedName = 'fake'): Server {
	return createServer(async (req, res) => {
		if (req.method === 'GET' && req.url === '/v1/models') {
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ object: 'list', data: [{ id: servedName }] }));
			return;
		}
		if (req.method === 'POST' && req.url === '/v1/chat/completions') {
			const body = JSON.parse(await readBody(req)) as { model: string; stream: boolean; messages: Array<{ content: string }> };
			assert.equal(body.model, servedName);
			assert.equal(body.stream, true);
			const slow = body.messages.some((m) => m.content.includes('slowly'));
			res.writeHead(200, { 'content-type': 'text/event-stream' });
			for (const piece of ['Hello', ' from', ' Keeta']) {
				res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] })}\n\n`);
				if (slow) {
					/* Stall after each piece until the caller hangs up. */
					await new Promise<void>((resolve) => {
						const timer = setTimeout(resolve, 5_000);
						res.once('close', () => (clearTimeout(timer), resolve()));
					});
					if (res.destroyed) {
						return;
					}
				}
			}
			res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
			res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } })}\n\n`);
			res.end('data: [DONE]\n\n');
			return;
		}
		res.writeHead(404).end();
	});
}

/** A Mac agent as the macOS app runs it, with a P-256 software key standing in for the Secure Enclave. */
export function macAgent(dataDir: string, options: { ledger?: Ledger; exchange?: CreditExchange; WebSocketImpl?: typeof WebSocket; hardware?: HardwareProfile } = {}) {
	const enclaveKey = p256.utils.randomPrivateKey();
	const app = new AgentApp({
		dataDir,
		signDigest: async (digestHex) => toHex(p256.sign(fromHex(digestHex), enclaveKey, { prehash: false, lowS: true }).toCompactRawBytes()),
		notify: () => undefined,
		log: (level, message) => void (process.env.KC_TEST_LOG ? process.stderr.write(`[agent ${level}] ${message}\n`) : undefined),
		...(options.ledger ? { ledgerFor: () => options.ledger! } : {}),
		...(options.exchange ? { exchangeFor: () => options.exchange! } : {}),
		...(options.WebSocketImpl ? { WebSocketImpl: options.WebSocketImpl } : {}),
		buyerPort: 0,
		hardware: options.hardware ?? mac64,
		localConditions: async () => ({ onBattery: false, idleSeconds: 1e9 }),
		noRuntime: true
	});
	return { app, rpc: app.handlers() as unknown as Record<string, (params: unknown) => Promise<any>>, nodePublicKey: toHex(p256.getPublicKey(enclaveKey, true)) };
}

/** Random 32 bytes of hex: the passkey PRF output the macOS app derives the operator from. */
export function passkeyEntropy(): string {
	return toHex(crypto.getRandomValues(new Uint8Array(32)));
}
