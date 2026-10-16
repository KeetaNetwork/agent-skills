import { test } from 'node:test';
import assert from 'node:assert/strict';
import { postDelivery } from '../src/delivery.ts';

const record = { controlUrl: 'http://control', routerSecret: 'router-secret', jobId: 'job-1', outputHash: 'a'.repeat(64), maxOutputTokens: 3 };

test('the delivery record is retried until the control plane accepts it', async () => {
	const statuses = [null, 503, 200];
	const calls: Array<{ url: string; secret: string | null }> = [];
	const fetchImpl = (async (url: string, init: RequestInit) => {
		calls.push({ url, secret: new Headers(init.headers).get('x-router-secret') });
		const status = statuses.shift();
		if (status === null) {
			throw new TypeError('network down');
		}
		return new Response(null, { status });
	}) as typeof fetch;
	assert.equal(await postDelivery(record, fetchImpl, [1, 1, 1]), true);
	assert.equal(calls.length, 3, 'a dropped request and a 503 are both retried');
	assert.deepEqual(calls[0], { url: 'http://control/v1/relay/jobs/job-1/delivery', secret: 'router-secret' });
});

test('the delivery record stops on a refusal that will not change, or after its retries', async () => {
	let calls = 0;
	const refused = (async () => (calls++, new Response(null, { status: 401 }))) as typeof fetch;
	assert.equal(await postDelivery(record, refused, [1, 1, 1]), false);
	assert.equal(calls, 1);
	calls = 0;
	const down = (async () => (calls++, new Response(null, { status: 502 }))) as typeof fetch;
	assert.equal(await postDelivery(record, down, [1, 1]), false);
	assert.equal(calls, 3);
});
