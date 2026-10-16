import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SerialQueue, fileAccount, operatorAccount, spendAccount } from '../src/index.ts';

function tempDir(t: { after: (fn: () => void) => void }): string {
	const dir = mkdtempSync(join(tmpdir(), 'kc-keys-'));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

test('key files are private to the user and stable, with one budget key per network', (t) => {
	const dir = tempDir(t);
	const first = fileAccount(dir, 'node');
	assert.equal(statSync(join(dir, 'node.seed')).mode & 0o777, 0o600);
	assert.equal(fileAccount(dir, 'node').publicKeyString.get(), first.publicKeyString.get(), 'the node key is stable');
	const testBudget = spendAccount(dir, 'test');
	assert.equal(statSync(join(dir, 'budget-test.seed')).mode & 0o777, 0o600);
	assert.notEqual(spendAccount(dir, 'main').publicKeyString.get(), testBudget.publicKeyString.get());
});

test('the operator account depends only on the passkey entropy', async () => {
	const entropy = 'ab'.repeat(32);
	const a = await operatorAccount(entropy);
	const b = await operatorAccount(entropy);
	assert.equal(a.publicKeyString.get(), b.publicKeyString.get());
	assert.notEqual((await operatorAccount('cd'.repeat(32))).publicKeyString.get(), a.publicKeyString.get());
});

test('payments from one account run one at a time', async () => {
	const queue = new SerialQueue();
	const order: string[] = [];
	await Promise.all(
		['a', 'b', 'c'].map((name, i) =>
			queue.run('acct', async () => {
				order.push(`start ${name}`);
				await new Promise((r) => setTimeout(r, 10 - i * 3));
				order.push(`end ${name}`);
			})
		)
	);
	assert.deepEqual(order, ['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
});
