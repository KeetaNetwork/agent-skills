/**
 * Cloudflare Worker: provider relay (relay.keeta.ai) and public API router
 * (api.keeta.ai).
 *
 *   GET  /v1/provider/connect?nodeKey&exp&token   provider WebSocket
 *   POST /v1/jobs/:jobId/run                       buyer (app) runs a ticketed job, SSE back
 *   GET  /v1/models                                public model list
 *   POST /v1/chat/completions                      public, paid with x402; served through
 *                                                  OpenRouter when no provider is free and a
 *                                                  fallback is configured
 */

import { HTTPFacilitatorClient, x402ResourceServer } from '@x402/core/server';
import { ExactKeetaScheme } from '@x402/keeta/exact/server';
import { NETWORKS, type JobEnvelope, type NetworkName } from '@keeta-compute/protocol';
import { ProviderChannel } from './channel.ts';
import { checkEnvelope, checkProviderToken, errorJson } from './relay.ts';
import { createRouter, type PaymentGateway } from './router.ts';

export { ProviderChannel };

export interface Env {
	PROVIDER_CHANNEL: DurableObjectNamespace;
	RELAY_SECRET: string;
	ROUTER_SECRET: string;
	CONTROL_URL: string;
	NETWORK: string;
	FACILITATOR_URL: string;
	/** Optional secret; when set, router jobs the control plane marks as fallback run on OpenRouter. */
	OPENROUTER_API_KEY?: string;
}

let gatewayPromise: Promise<PaymentGateway> | undefined;

function x402Gateway(env: Env, network: NetworkName): Promise<PaymentGateway> {
	gatewayPromise ??= (async () => {
		const server = new x402ResourceServer(new HTTPFacilitatorClient({ url: env.FACILITATOR_URL }));
		server.register(NETWORKS[network].caip2 as `${string}:${string}`, new ExactKeetaScheme());
		await server.initialize();
		return {
			async verify(payload, requirements) {
				const result = await server.verifyPayment(payload as never, requirements as never);
				return { isValid: result.isValid, ...(result.invalidReason ? { invalidReason: result.invalidReason } : {}), ...(result.payer ? { payer: result.payer } : {}) };
			},
			async settle(payload, requirements) {
				const result = await server.settlePayment(payload as never, requirements as never);
				return {
					success: result.success,
					...(result.transaction ? { transaction: result.transaction } : {}),
					...(result.payer ? { payer: result.payer } : {}),
					...(result.errorReason ? { errorReason: result.errorReason } : {})
				};
			}
		};
	})();
	return gatewayPromise;
}

const CORS = {
	'access-control-allow-origin': '*',
	'access-control-allow-headers': 'authorization, content-type, payment-signature, x-payment',
	'access-control-expose-headers': 'payment-required, payment-response, x-keeta-receipt, retry-after'
};

function withCors(response: Response): Response {
	if (response.status === 101) {
		return response;
	}
	const headers = new Headers(response.headers);
	for (const [key, value] of Object.entries(CORS)) {
		headers.set(key, value);
	}
	return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function channel(env: Env, nodeKey: string) {
	return env.PROVIDER_CHANNEL.get(env.PROVIDER_CHANNEL.idFromName(nodeKey));
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const network: NetworkName = env.NETWORK === 'main' ? 'main' : 'test';
		if (request.method === 'OPTIONS') {
			return new Response(null, { status: 204, headers: CORS });
		}

		if (url.pathname === '/v1/provider/connect') {
			const nodeKey = url.searchParams.get('nodeKey');
			const problem = await checkProviderToken(env.RELAY_SECRET, nodeKey, url.searchParams.get('exp'), url.searchParams.get('token'), Date.now());
			if (problem) {
				return errorJson(401, 'unauthorized', problem);
			}
			return channel(env, nodeKey!).fetch(new Request('https://channel/connect', request));
		}

		const run = /^\/v1\/jobs\/([A-Za-z0-9_]+)\/run$/.exec(url.pathname);
		if (run && request.method === 'POST') {
			let envelope: JobEnvelope;
			try {
				envelope = (await request.json()) as JobEnvelope;
			} catch {
				return withCors(errorJson(400, 'invalid_json', 'body must be a job envelope'));
			}
			const problem = await checkEnvelope(env.RELAY_SECRET, run[1]!, envelope, Date.now());
			if (problem) {
				return withCors(errorJson(403, 'forbidden', problem));
			}
			return withCors(await channel(env, envelope.ticket.ticket.nodeKey).fetch('https://channel/run', { method: 'POST', body: JSON.stringify(envelope), signal: request.signal }));
		}

		if (url.pathname === '/v1/models' || url.pathname === '/v1/chat/completions') {
			const router = createRouter({
				network,
				controlUrl: env.CONTROL_URL,
				routerSecret: env.ROUTER_SECRET,
				relaySecret: env.RELAY_SECRET,
				gateway: await x402Gateway(env, network),
				runJob: (envelope, signal) => channel(env, envelope.ticket.ticket.nodeKey).fetch('https://channel/run', { method: 'POST', body: JSON.stringify(envelope), signal }),
				...(env.OPENROUTER_API_KEY ? { openRouter: { apiKey: env.OPENROUTER_API_KEY } } : {})
			});
			if (url.pathname === '/v1/models' && request.method === 'GET') {
				return withCors(await router.models());
			}
			if (request.method === 'POST') {
				return withCors(await router.chatCompletions(request));
			}
		}

		if (url.pathname === '/' || url.pathname === '/health') {
			return Response.json({ service: 'keeta-compute-relay', network, docs: 'https://keeta.ai/compute/router' });
		}
		return withCors(errorJson(404, 'not_found', `${request.method} ${url.pathname} is not a route`));
	}
} satisfies ExportedHandler<Env>;
