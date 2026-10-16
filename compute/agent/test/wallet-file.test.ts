import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { entropyToMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { toHex } from '@keeta-compute/protocol';
import { Account } from '@keeta-compute/protocol/keeta';
import { parseAccess } from '../src/cli.ts';
import { operatorAccount } from '../src/keys.ts';
import { createWallet, entropyFromPhrase, readWallet, unlockWallet, walletPath, withOperatorEntropy } from '../src/wallet-file.ts';

/* A cheaper scrypt keeps the tests quick; one test uses the default cost. */
const kdf = { N: 2 ** 12, r: 8, p: 1 };

function tempDir(t: { after: (fn: () => void) => void }): string {
	const dir = mkdtempSync(join(tmpdir(), 'kc-wallet-'));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

test('a new wallet is encrypted, private, and unlocks to its operator', async (t) => {
	const dir = tempDir(t);
	const { operator, phrase } = await createWallet(dir, 'correct horse battery', {});
	assert.equal(phrase.split(' ').length, 24);
	assert.equal(statSync(walletPath(dir)).mode & 0o777, 0o600);
	const raw = readFileSync(walletPath(dir), 'utf8');
	assert.equal(readWallet(dir)!.operator, operator);
	const entropy = await unlockWallet(dir, 'correct horse battery');
	assert.ok(!raw.includes(phrase) && !raw.includes(toHex(entropy)), 'neither the phrase nor the entropy is stored in the clear');
	assert.equal((await operatorAccount(toHex(entropy))).publicKeyString.get(), operator);
	assert.equal(toHex(entropy), toHex(entropyFromPhrase(phrase)), 'the phrase is the entropy');
	await assert.rejects(createWallet(dir, 'correct horse battery', { kdf }), /already exists/);
});

test('a wrong passphrase or an edited wallet file does not unlock', async (t) => {
	const dir = tempDir(t);
	await assert.rejects(createWallet(dir, 'short', { kdf }), /at least 8/);
	const { operator } = await createWallet(dir, 'right passphrase', { kdf });
	await assert.rejects(unlockWallet(dir, 'wrong passphrase'), /wrong passphrase/);
	let seen = '';
	await withOperatorEntropy(dir, 'right passphrase', async (entropy) => void (seen = entropy));
	assert.match(seen, /^[0-9a-f]{64}$/);
	/* The operator in the header is bound to the ciphertext. */
	const file = JSON.parse(readFileSync(walletPath(dir), 'utf8'));
	const other = Account.fromSeed(Account.generateRandomSeed({ asString: true }) as string, 0).publicKeyString.get();
	writeFileSync(walletPath(dir), JSON.stringify({ ...file, operator: other }));
	await assert.rejects(unlockWallet(dir, 'right passphrase'), /wrong passphrase|changed/);
	writeFileSync(walletPath(dir), JSON.stringify({ ...file, kdf: { ...file.kdf, N: 2 ** 30 } }));
	await assert.rejects(unlockWallet(dir, 'right passphrase'), /scrypt parameters/);
	writeFileSync(walletPath(dir), JSON.stringify(file));
	assert.equal(toHex(await unlockWallet(dir, 'right passphrase')), seen);
	assert.equal(readWallet(dir)!.operator, operator);
});

test('restoring from the recovery phrase yields the same operator, which is also a Keeta passphrase', async (t) => {
	const first = tempDir(t);
	const second = tempDir(t);
	const { operator, phrase } = await createWallet(first, 'first passphrase', { kdf });
	const restored = await createWallet(second, 'a different one', { kdf, entropy: entropyFromPhrase(`  ${phrase.toUpperCase().replaceAll(' ', '   ')}\n`) });
	assert.equal(restored.operator, operator);
	assert.equal(restored.phrase, phrase);
	const keeta = Account.fromSeed(await Account.seedFromPassphrase(phrase), 0);
	assert.equal(keeta.publicKeyString.get(), operator);
	/* Fixed entropy, so the checksum failure below is deterministic. */
	const words = entropyToMnemonic(new Uint8Array(32).fill(0xab), wordlist).split(' ');
	assert.equal(toHex(entropyFromPhrase(words.join(' '))), 'ab'.repeat(32));
	assert.throws(() => entropyFromPhrase([...words.slice(0, 23), 'zoo'].join(' ')), /not a valid recovery phrase/);
	assert.throws(() => entropyFromPhrase(entropyToMnemonic(new Uint8Array(16).fill(1), wordlist)), /24 words/);
});

test('CLI access flags become an access policy', () => {
	const key = Account.fromSeed(Account.generateRandomSeed({ asString: true }) as string, 0).publicKeyString.get();
	assert.equal(parseAccess(undefined, undefined), undefined);
	assert.deepEqual(parseAccess('public', undefined), { mode: 'public', allow: [] });
	assert.deepEqual(parseAccess(undefined, ` ${key} ,`), { mode: 'allowlist', allow: [key] });
	assert.throws(() => parseAccess('allowlist', 'not-a-key'));
	assert.throws(() => parseAccess('friends', undefined));
});
