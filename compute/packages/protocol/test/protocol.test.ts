import { test } from 'node:test';
import assert from 'node:assert/strict';
import { p256 } from '@noble/curves/p256';
import { entropyToMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import {
	CATALOG,
	canonicalJSON,
	checkCompatibility,
	compatibleModels,
	formatAmount,
	generatePairingCode,
	hardwareTier,
	isValidPairingCode,
	jobCost,
	maxJobCost,
	pairingCheckString,
	pairingCodeHash,
	parseAmount,
	receiptMessage,
	requestMessage,
	signRequest,
	assertChatRequest,
	promptTokenBound,
	assertOffer,
	type HardwareProfile,
	type Receipt
} from '../src/index.ts';
import { Account, accountFromPasskeyEntropy, accountSigner, externalP256Account, verifyKeetaSignature } from '../src/keeta.ts';

const GB = 1024 ** 3;

const mac = (memoryGB: number): HardwareProfile => ({
	os: 'macos',
	osVersion: '15.4',
	chip: 'Apple M4 Max',
	memoryBytes: memoryGB * GB,
	freeDiskBytes: 500 * GB
});

test('canonical JSON sorts keys and drops undefined', () => {
	assert.equal(canonicalJSON({ b: 1, a: { d: undefined, c: [3, { z: 1, y: 2 }] }, n: 5n }), '{"a":{"c":[3,{"y":2,"z":1}]},"b":1,"n":"5"}');
});

test('pricing is exact, rounds up and never charges zero for work', () => {
	const price = { inputPerMillion: '100000', outputPerMillion: '400000' };
	assert.equal(jobCost(price, { inputTokens: 1_000_000, outputTokens: 1_000_000 }), 500_000n);
	assert.equal(jobCost(price, { inputTokens: 1, outputTokens: 0 }), 1n);
	assert.equal(jobCost(price, { inputTokens: 0, outputTokens: 0 }), 0n);
	assert.equal(jobCost({ inputPerMillion: '0', outputPerMillion: '0' }, { inputTokens: 10, outputTokens: 10 }), 1n);
	assert.equal(maxJobCost(price, { maxInputTokens: 2000, maxOutputTokens: 1000 }), 600n);
	assert.equal(formatAmount(1_234_567n, 6), '1.234567');
	assert.equal(formatAmount(1_000_000n, 6), '1');
	assert.equal(parseAmount('1.5', 6), 1_500_000n);
	assert.throws(() => parseAmount('1.0000001', 6));
});

test('hardware tiers follow the plan', () => {
	assert.equal(hardwareTier(mac(16)), 'excluded');
	assert.equal(hardwareTier(mac(36)), 'C');
	assert.equal(hardwareTier(mac(128)), 'B');
});

test('compatibility filters by usable memory, disk and cluster needs', () => {
	const small = compatibleModels(CATALOG, mac(16)).map((m) => m.id);
	assert.ok(small.includes('llama-3.2-3b-instruct'));
	assert.ok(!small.includes('qwen3-32b'));
	const big = compatibleModels(CATALOG, mac(256)).map((m) => m.id);
	assert.ok(big.includes('qwen3-235b-a22b'));
	assert.ok(!big.includes('muse-spark-open'));
	const muse = CATALOG.find((m) => m.id === 'muse-spark-open')!;
	assert.deepEqual(checkCompatibility(muse, mac(512)), { fits: false, reason: 'needs-cluster' });
	const linux: HardwareProfile = { ...mac(256), os: 'linux' };
	assert.equal(checkCompatibility(CATALOG[0]!, linux).fits, false);
});

test('pairing codes carry 130 bits and normalize', async () => {
	const code = generatePairingCode();
	assert.match(code, /^[A-Z2-9]{5}(-[A-Z2-9]{1,5}){5}$/);
	assert.ok(isValidPairingCode(code));
	assert.ok(isValidPairingCode(code.toLowerCase().replace(/-/g, ' ')));
	assert.equal(await pairingCodeHash(code), await pairingCodeHash(code.toLowerCase()));
	assert.match(await pairingCheckString('keeta_abc'), /^[A-Z2-9]{3}-[A-Z2-9]{3}$/);
});

test('software keys sign requests and receipts that verify', async () => {
	const account = Account.fromSeed(Account.generateRandomSeed({ asString: true }), 0);
	const signer = accountSigner(account);
	const headers = await signRequest(signer, 'POST', '/v1/jobs', '{"a":1}', 1000);
	const message = await requestMessage('POST', '/v1/jobs', 1000, headers['x-kc-nonce']!, '{"a":1}');
	assert.ok(verifyKeetaSignature(signer.publicKey, message, headers['x-kc-sig']!));
	const tampered = await requestMessage('POST', '/v1/jobs', 1000, headers['x-kc-nonce']!, '{"a":2}');
	assert.equal(verifyKeetaSignature(signer.publicKey, tampered, headers['x-kc-sig']!), false);
});

test('a Secure Enclave style P-256 key produces valid Keeta signatures', async () => {
	/* Emulates SecKeyCreateSignature(.ecdsaSignatureDigestX962SHA256) on the SDK's digest. */
	const privateKey = p256.utils.randomPrivateKey();
	const publicKey = p256.getPublicKey(privateKey, true);
	const account = externalP256Account(publicKey, async (digest) => {
		assert.equal(digest.length, 32);
		const signature = p256.sign(digest, privateKey, { prehash: false, lowS: true });
		return signature.toCompactRawBytes();
	});
	const signer = accountSigner(account);
	assert.match(signer.publicKey, /^keeta_ay/);
	const receipt: Receipt = {
		v: 1,
		jobId: 'job_1',
		network: 'test',
		nodeKey: signer.publicKey,
		payTo: signer.publicKey,
		buyer: signer.publicKey,
		modelId: 'qwen3-8b',
		weightsHash: 'a'.repeat(64),
		runtime: { kind: 'mlx', build: 'mlx-lm 0.26.0' },
		inputTokens: 10,
		outputTokens: 20,
		price: { inputPerMillion: '1', outputPerMillion: '2' },
		amount: '1',
		asset: 'keeta_x',
		startedAt: 1,
		finishedAt: 2,
		outputHash: 'b'.repeat(64),
		finishReason: 'stop'
	};
	const signature = await signer.sign(receiptMessage(receipt));
	assert.ok(verifyKeetaSignature(signer.publicKey, receiptMessage(receipt), signature));
	assert.equal(verifyKeetaSignature(signer.publicKey, receiptMessage({ ...receipt, outputTokens: 21 }), signature), false);
});

test('passkey entropy derives the same account the web wallet would', async () => {
	const entropy = new Uint8Array(32).fill(7);
	const a = await accountFromPasskeyEntropy(entropy, 0, (e) => entropyToMnemonic(e, wordlist));
	const b = await accountFromPasskeyEntropy(entropy, 0, (e) => entropyToMnemonic(e, wordlist));
	const c = await accountFromPasskeyEntropy(entropy, 1, (e) => entropyToMnemonic(e, wordlist));
	assert.equal(a.publicKeyString.get(), b.publicKeyString.get());
	assert.notEqual(a.publicKeyString.get(), c.publicKeyString.get());
	/* Same path as the SDK driver: mnemonic → seedFromPassphrase → fromSeed. */
	const seed = await Account.seedFromPassphrase(entropyToMnemonic(entropy, wordlist));
	assert.equal(Account.fromSeed(seed, 0).publicKeyString.get(), a.publicKeyString.get());
});

test('validation rejects malformed offers and requests', () => {
	assert.throws(() => assertChatRequest({ model: 'x', messages: [] }));
	assert.throws(() => assertChatRequest({ model: 'x', messages: [{ role: 'user', content: 'hi' }], max_tokens: 0 }));
	assert.ok(assertChatRequest({ model: 'qwen3-8b', messages: [{ role: 'user', content: 'hi' }] }));
	assert.throws(() => assertOffer({ modelId: 'x', weightsHash: 'nope' }, 0));
	assert.throws(() => assertChatRequest({ model: 'qwen3-8b', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:' } }] }] }), /text content/);
	assert.throws(() => assertChatRequest({ model: 'qwen3-8b', messages: [{ role: 'user', content: 'hi' }], n: 4 }), /n must be 1/);
});

test('the prompt bound covers dense scripts and tool definitions', () => {
	const base = { model: 'qwen3-8b', messages: [{ role: 'user' as const, content: 'hi' }] };
	const cjk = '漢'.repeat(1000);
	/* Roughly one token per character for CJK; the old chars/3 estimate priced a third of that. */
	assert.ok(promptTokenBound({ ...base, messages: [{ role: 'user', content: cjk }] }) >= 1000);
	const tools = [{ type: 'function', function: { name: 'f', description: 'x'.repeat(5000), parameters: {} } }];
	assert.ok(promptTokenBound({ ...base, tools }) > promptTokenBound(base) + 10_000, 'tools count toward the prompt');
});

test('catalog.json is in sync with catalog.ts (run npm run catalog:export)', async () => {
	const { readFileSync } = await import('node:fs');
	const { catalogExport } = await import('../scripts/export-catalog.ts');
	assert.deepEqual(JSON.parse(readFileSync(new URL('../catalog.json', import.meta.url), 'utf8')), catalogExport());
});
