/**
 * Firebase entry point: one HTTPS function for the API and a scheduled sweep.
 * Deploy with `npm run deploy` after setting the secrets:
 *   firebase functions:secrets:set COORDINATOR_SEED RELAY_SECRET ROUTER_SECRET
 */

import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { defineSecret, defineString } from 'firebase-functions/params';
import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { serviceFromEnv } from './config.ts';
import { FirestoreStore } from './firestore-store.ts';
import { createApi } from './http.ts';
import type { ControlService } from './service.ts';
import { verifyKeetaSignature } from '@keeta-compute/protocol/keeta';

const COORDINATOR_SEED = defineSecret('COORDINATOR_SEED');
const RELAY_SECRET = defineSecret('RELAY_SECRET');
const ROUTER_SECRET = defineSecret('ROUTER_SECRET');
const RELAY_URL = defineString('RELAY_URL', { default: 'https://relay.keeta.ai' });
const NETWORKS = defineString('NETWORKS', { default: 'test' });
const ALLOW_SMALL_PROVIDERS = defineString('ALLOW_SMALL_PROVIDERS', { default: 'false' });

initializeApp();
const store = new FirestoreStore(getFirestore());

let cached: { service: ControlService; handle: ReturnType<typeof createApi> } | undefined;
function instance() {
	if (!cached) {
		const service = serviceFromEnv(store, {
			COORDINATOR_SEED: COORDINATOR_SEED.value(),
			RELAY_SECRET: RELAY_SECRET.value(),
			ROUTER_SECRET: ROUTER_SECRET.value(),
			RELAY_URL: RELAY_URL.value(),
			NETWORKS: NETWORKS.value(),
			ALLOW_SMALL_PROVIDERS: ALLOW_SMALL_PROVIDERS.value()
		});
		cached = { service, handle: createApi(service, { store, verify: verifyKeetaSignature, routerSecret: ROUTER_SECRET.value() }) };
	}
	return cached;
}

export const api = onRequest(
	{ secrets: [COORDINATOR_SEED, RELAY_SECRET, ROUTER_SECRET], cors: false, concurrency: 80, memory: '512MiB', timeoutSeconds: 30 },
	async (req, res) => {
		const url = new URL(req.originalUrl ?? req.url, 'http://local');
		const headers: Record<string, string | undefined> = {};
		for (const [key, value] of Object.entries(req.headers)) {
			headers[key.toLowerCase()] = Array.isArray(value) ? value.join(',') : value;
		}
		const response = await instance().handle({
			method: req.method,
			path: url.pathname,
			query: url.searchParams,
			headers,
			rawBody: req.rawBody ? req.rawBody.toString('utf8') : ''
		});
		for (const [key, value] of Object.entries(response.headers ?? {})) {
			res.setHeader(key, value);
		}
		res.status(response.status).json(response.body);
	}
);

export const sweep = onSchedule({ schedule: 'every 2 minutes', secrets: [COORDINATOR_SEED, RELAY_SECRET, ROUTER_SECRET] }, async () => {
	const result = await instance().service.sweep();
	console.log('sweep', result);
});
