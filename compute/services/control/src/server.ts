/**
 * Standalone control-plane server for local development and tests, backed by
 * the in-memory store. Not for production (state is lost on restart).
 *
 *   COORDINATOR_SEED=… RELAY_SECRET=… ROUTER_SECRET=… npm run dev
 */

import { createServer, type Server } from 'node:http';
import { verifyKeetaSignature } from '@keeta-compute/protocol/keeta';
import { serviceFromEnv, type EnvConfig } from './config.ts';
import { createApi } from './http.ts';
import type { BalanceReader, ControlService, PaymentVerifier } from './service.ts';
import { MemoryStore } from './store.ts';

export function startServer(options: { port: number; env: EnvConfig; verifyPayment?: PaymentVerifier; balanceOf?: BalanceReader }): Promise<{ server: Server; service: ControlService; store: MemoryStore; url: string }> {
	const store = new MemoryStore();
	const service = serviceFromEnv(store, options.env, {
		...(options.verifyPayment ? { verifyPayment: options.verifyPayment } : {}),
		...(options.balanceOf ? { balanceOf: options.balanceOf } : {})
	});
	const handle = createApi(service, { store, verify: verifyKeetaSignature, routerSecret: options.env.ROUTER_SECRET });
	const server = createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) {
			chunks.push(chunk as Buffer);
		}
		const url = new URL(req.url ?? '/', 'http://local');
		const headers: Record<string, string | undefined> = {};
		for (const [key, value] of Object.entries(req.headers)) {
			headers[key.toLowerCase()] = Array.isArray(value) ? value.join(',') : value;
		}
		const response = await handle({ method: req.method ?? 'GET', path: url.pathname, query: url.searchParams, headers, rawBody: Buffer.concat(chunks).toString('utf8') });
		res.writeHead(response.status, { 'content-type': 'application/json', ...(response.headers ?? {}) });
		res.end(JSON.stringify(response.body));
	});
	const sweeper = setInterval(() => void service.sweep().catch((e) => console.error('sweep failed', e)), 60_000);
	server.on('close', () => clearInterval(sweeper));
	return new Promise((resolve) => {
		server.listen(options.port, '127.0.0.1', () => {
			const address = server.address();
			const port = typeof address === 'object' && address ? address.port : options.port;
			resolve({ server, service, store, url: `http://127.0.0.1:${port}` });
		});
	});
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const env = process.env as unknown as EnvConfig;
	startServer({ port: Number(process.env.PORT ?? 8787), env }).then(({ url }) => console.log(`control plane listening on ${url}`));
}
