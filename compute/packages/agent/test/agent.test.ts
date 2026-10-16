import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { BuyerStore } from '@keeta-compute/buyer';
import { utcDay } from '@keeta-compute/protocol';
import { RPC_ERRORS } from '@keeta-compute/protocol/rpc';
import type { ProviderStore } from '@keeta-compute/provider';
import { RpcPeer, StateStore } from '../src/index.ts';

function tempDir(t: { after: (fn: () => void) => void }): string {
	const dir = mkdtempSync(join(tmpdir(), 'kc-agent-'));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

test('the state file is private to the user, and the local endpoint token can be rotated', (t) => {
	const dir = tempDir(t);
	const store = new StateStore(dir);
	store.save();
	assert.equal(statSync(join(dir, 'state.json')).mode & 0o777, 0o600);
	assert.notEqual(store.state.buyer.token, store.rotateBuyerToken());
});

test('one saved state serves the provider and the buyer, and survives a restart', (t) => {
	const dir = tempDir(t);
	const store = new StateStore(dir);
	/* The provider and buyer packages see the store only through their own interfaces. */
	const provider: ProviderStore = store;
	const buyer: BuyerStore = store;
	provider.update((s) => (s.tokensByDay[utcDay()] = 42));
	buyer.update((s) => s.escrows.push({ jobId: 'job_1', network: 'test', blockHash: 'A'.repeat(64), at: 1 }));
	buyer.addToDay('spentByDay', 1_500n);
	buyer.addToDay('spentByDay', 500n);

	const reopened = new StateStore(dir);
	assert.equal(reopened.state.tokensByDay[utcDay()], 42);
	assert.deepEqual(reopened.state.escrows.map((e) => e.jobId), ['job_1']);
	assert.equal(reopened.state.spentByDay[utcDay()], '2000');
});

test('JSON-RPC peers call each other both ways', async () => {
	const aToB = new PassThrough();
	const bToA = new PassThrough();
	const notes: unknown[] = [];
	const app = new RpcPeer(bToA, aToB, {
		'signer.signDigest': async (params) => ({ signature: `signed:${(params as { digest: string }).digest}` }),
		'event.log': async (params) => void notes.push(params)
	});
	const agent = new RpcPeer(aToB, bToA, {
		'agent.version': async () => '1',
		'agent.fail': async () => {
			throw new Error('nope');
		}
	});
	assert.equal(await app.request('agent.version', {}), '1');
	await assert.rejects(app.request('agent.fail', {}), /nope/);
	await assert.rejects(app.request('agent.missing', {}), (error: { code: number }) => error.code === RPC_ERRORS.methodNotFound);
	assert.deepEqual(await agent.request('signer.signDigest', { digest: 'ff' }), { signature: 'signed:ff' });
	agent.notify('event.log', { level: 'info', message: 'hi' });
	await new Promise((r) => setTimeout(r, 10));
	assert.deepEqual(notes, [{ level: 'info', message: 'hi' }]);
});
