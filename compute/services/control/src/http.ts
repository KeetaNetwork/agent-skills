/**
 * HTTP routing for the control plane, independent of the host (Firebase
 * Functions or a plain Node server).
 */

import { REQUEST_HEADERS, REQUEST_SKEW_MS, requestMessage, timingSafeEqual, type NetworkName } from '@keeta-compute/protocol';
import { AuthError, type ControlService } from './service.ts';
import type { Store } from './store.ts';
import type { Verifier } from '@keeta-compute/protocol';

export interface ApiRequest {
	method: string;
	/** Path without query string, e.g. /v1/jobs. */
	path: string;
	query: URLSearchParams;
	/** Lower-cased header names. */
	headers: Record<string, string | undefined>;
	rawBody: string;
}

export interface ApiResponse {
	status: number;
	body: unknown;
	headers?: Record<string, string>;
}

type Handler = (ctx: { req: ApiRequest; params: Record<string, string>; body: Record<string, unknown>; caller: string }) => Promise<unknown>;

interface Route {
	method: string;
	pattern: RegExp;
	keys: string[];
	auth: 'none' | 'signed' | 'router';
	handler: Handler;
}

export function createApi(service: ControlService, deps: { store: Store; verify: Verifier; routerSecret: string; now?: () => number }) {
	const now = deps.now ?? Date.now;
	const routes: Route[] = [];
	const route = (method: string, path: string, auth: Route['auth'], handler: Handler) => {
		const keys: string[] = [];
		const pattern = new RegExp(
			`^${path.replace(/:([a-zA-Z]+)/g, (_m, key: string) => {
				keys.push(key);
				return '([^/]+)';
			})}$`
		);
		routes.push({ method, pattern, keys, auth, handler });
	};

	const network = (req: ApiRequest): NetworkName => (req.query.get('network') === 'main' ? 'main' : 'test');

	route('GET', '/v1/config', 'none', async () => service.publicConfig());
	route('GET', '/v1/catalog', 'none', async () => ({ models: service.catalog() }));
	route('GET', '/v1/models', 'none', async ({ req }) => ({ models: await service.networkModels(network(req), req.query.get('fallback') === '1') }));

	route('POST', '/v1/providers/register', 'signed', async ({ caller, body }) => service.registerProvider(caller, body));
	route('POST', '/v1/providers/heartbeat', 'signed', async ({ caller, body }) => service.heartbeat(caller, body));
	route('GET', '/v1/providers/me', 'signed', async ({ caller }) => service.providerSelf(caller));

	route('POST', '/v1/jobs', 'signed', async ({ caller, body }) => service.createJob(caller, body));
	route('GET', '/v1/jobs', 'signed', async ({ caller }) => service.buyerJobs(caller));
	route('POST', '/v1/jobs/:jobId/receipt', 'signed', async ({ caller, params, body }) => service.submitReceipt(caller, params.jobId!, body));
	route('POST', '/v1/jobs/:jobId/fail', 'signed', async ({ caller, params, body }) => service.failJob(caller, params.jobId!, body));
	route('POST', '/v1/jobs/:jobId/escrow', 'signed', async ({ caller, params, body }) => service.submitEscrow(caller, params.jobId!, body));
	route('POST', '/v1/jobs/:jobId/cancel', 'signed', async ({ caller, params }) => service.cancelJob(caller, params.jobId!));

	route('POST', '/v1/relay/jobs/:jobId/delivery', 'router', async ({ params, body }) => service.recordDelivery(params.jobId!, body));
	route('POST', '/v1/relay/jobs/:jobId/provider-offline', 'router', async ({ params }) => service.recordProviderOffline(params.jobId!));
	route('POST', '/v1/router/quote', 'router', async ({ body }) => service.routerQuote(body));
	route('GET', '/v1/router/jobs/:jobId', 'router', async ({ params }) => service.routerJob(params.jobId!));
	route('POST', '/v1/router/jobs/:jobId/claim', 'router', async ({ params }) => service.routerClaim(params.jobId!));
	route('POST', '/v1/router/jobs/:jobId/paying', 'router', async ({ params, body }) => service.routerPaying(params.jobId!, body));
	route('POST', '/v1/router/jobs/:jobId/settled', 'router', async ({ params, body }) => service.routerSettled(params.jobId!, body));

	route('POST', '/v1/pairing', 'signed', async ({ caller, body }) => service.createPairing(caller, body));
	route('POST', '/v1/pairing/claim', 'signed', async ({ caller, body }) => service.claimPairing(caller, body));
	route('GET', '/v1/pairing/:pairingId', 'signed', async ({ caller, params }) => service.pairingStatus(caller, params.pairingId!));
	route('POST', '/v1/pairing/:pairingId/approve', 'signed', async ({ caller, params, body }) => service.approvePairing(caller, params.pairingId!, body));
	route('POST', '/v1/pairing/:pairingId/reject', 'signed', async ({ caller, params }) => service.rejectPairing(caller, params.pairingId!));
	route('GET', '/v1/fleet', 'signed', async ({ caller }) => service.fleet(caller));
	route('DELETE', '/v1/fleet/:nodeKey', 'signed', async ({ caller, params }) => service.revokeHelper(caller, params.nodeKey!));

	async function authenticate(req: ApiRequest): Promise<string> {
		const key = req.headers[REQUEST_HEADERS.key];
		const ts = Number(req.headers[REQUEST_HEADERS.timestamp]);
		const nonce = req.headers[REQUEST_HEADERS.nonce];
		const signature = req.headers[REQUEST_HEADERS.signature];
		if (!key || !nonce || !signature || !Number.isFinite(ts)) {
			throw new AuthError('signed request headers are required');
		}
		if (Math.abs(now() - ts) > REQUEST_SKEW_MS) {
			throw new AuthError('request timestamp is outside the allowed window; check the clock');
		}
		if (!/^[0-9a-f]{16,64}$/.test(nonce)) {
			throw new AuthError('invalid nonce');
		}
		const message = await requestMessage(req.method, req.path, ts, nonce, req.rawBody);
		if (!deps.verify(key, message, signature)) {
			throw new AuthError('signature does not verify');
		}
		if (!(await deps.store.claimNonce(key, nonce, ts + REQUEST_SKEW_MS))) {
			throw new AuthError('request was replayed');
		}
		return key;
	}

	return async function handle(req: ApiRequest): Promise<ApiResponse> {
		try {
			for (const candidate of routes) {
				if (candidate.method !== req.method) {
					continue;
				}
				const match = candidate.pattern.exec(req.path);
				if (!match) {
					continue;
				}
				const params = Object.fromEntries(candidate.keys.map((key, i) => [key, decodeURIComponent(match[i + 1] ?? '')]));
				let caller = '';
				if (candidate.auth === 'signed') {
					caller = await authenticate(req);
				} else if (candidate.auth === 'router') {
					const secret = req.headers['x-router-secret'] ?? '';
					if (!deps.routerSecret || !timingSafeEqual(secret, deps.routerSecret)) {
						throw new AuthError('router secret required');
					}
				}
				let body: Record<string, unknown> = {};
				if (req.rawBody) {
					try {
						body = JSON.parse(req.rawBody) as Record<string, unknown>;
					} catch {
						return { status: 400, body: { error: { code: 'invalid_json', message: 'body is not valid JSON' } } };
					}
					if (!body || typeof body !== 'object' || Array.isArray(body)) {
						return { status: 400, body: { error: { code: 'invalid_json', message: 'body must be a JSON object' } } };
					}
				}
				return { status: 200, body: await candidate.handler({ req, params, body, caller }) };
			}
			return { status: 404, body: { error: { code: 'not_found', message: `${req.method} ${req.path} is not a route` } } };
		} catch (error) {
			const status = typeof (error as { status?: unknown }).status === 'number' ? (error as { status: number }).status : 500;
			const message = status === 500 ? 'internal error' : (error as Error).message;
			if (status === 500) {
				console.error('control-plane error', error);
			}
			const headers: Record<string, string> = {};
			const retry = (error as { retryAfterSeconds?: number }).retryAfterSeconds;
			if ((status === 503 || status === 429) && retry) {
				headers['retry-after'] = String(retry);
			}
			const code = status !== 500 && typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : errorCode(status);
			return { status, headers, body: { error: { code, message } } };
		}
	};
}

function errorCode(status: number): string {
	switch (status) {
		case 400:
			return 'invalid_request';
		case 401:
			return 'unauthorized';
		case 402:
			return 'payment_required';
		case 403:
			return 'forbidden';
		case 404:
			return 'not_found';
		case 409:
			return 'conflict';
		case 429:
			return 'rate_limited';
		case 503:
			return 'unavailable';
		default:
			return 'internal';
	}
}
