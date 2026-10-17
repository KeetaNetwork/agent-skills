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
	escrowAmount,
	NO_SHOW_FEE,
	networkFee,
	providerShare,
	pairingCheckString,
	pairingCodeHash,
	parseAmount,
	receiptMessage,
	requestMessage,
	signRequest,
	assertChatRequest,
	promptTokenBound,
	assertOffer,
	aggregateCompletion,
	chunkText,
	maxOutputTokensFor,
	MAX_CONTEXT_LENGTH,
	type HardwareProfile,
	type Receipt,
	type RelayEvent
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
	assert.equal(escrowAmount(price, { maxInputTokens: 2000, maxOutputTokens: 1000 }), NO_SHOW_FEE, 'an escrow can always pay the no-show fee');
	assert.equal(escrowAmount(price, { maxInputTokens: 20_000, maxOutputTokens: 10_000 }), 6_000n, 'above the fee, the escrow is the maximum cost');
	assert.equal(formatAmount(1_234_567n, 6), '1.234567');
	assert.equal(formatAmount(1_000_000n, 6), '1');
	assert.equal(parseAmount('1.5', 6), 1_500_000n);
	assert.throws(() => parseAmount('1.0000001', 6));
});

test('the network fee is 0.25% of the bill, rounded up, and comes out of the provider\'s share', () => {
	assert.equal(networkFee(1_000_000n), 2_500n, 'one credit pays 0.0025');
	assert.equal(providerShare(1_000_000n), 997_500n);
	assert.equal(networkFee(92_000n), 230n);
	assert.equal(networkFee(401n), 2n, 'a part of a base unit rounds up');
	assert.equal(networkFee(1n), 1n);
	assert.equal(networkFee(0n), 0n, 'nothing billed, no fee');
	assert.equal(providerShare(0n), 0n);
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

test('an offer\'s context length must fit what every client can represent', () => {
	const offer = (contextLength: number) => ({
		modelId: 'qwen3-8b',
		weightsHash: 'c'.repeat(64),
		runtime: { kind: 'mlx', build: 'mlx-lm 0.26.0' },
		price: { inputPerMillion: '100000', outputPerMillion: '400000' },
		access: { mode: 'public', allow: [] },
		contextLength
	});
	assert.equal(assertOffer(offer(1_000_000), 0).contextLength, 1_000_000);
	assert.equal(assertOffer(offer(MAX_CONTEXT_LENGTH), 0).contextLength, MAX_CONTEXT_LENGTH);
	/* Number.isInteger holds for 1e300, which the macOS app cannot decode as an Int: one such offer blanked its model list. */
	for (const bad of [1e300, 1e19, 2 ** 31, MAX_CONTEXT_LENGTH + 1, 0, 1.5]) {
		assert.throws(() => assertOffer(offer(bad), 0), /contextLength/, String(bad));
	}
});

test('structured output and stop lists are bounded before anything is paid', () => {
	const ask = (extra: Record<string, unknown>) => () => assertChatRequest({ model: 'qwen3-8b', messages: [{ role: 'user', content: 'hi' }], ...extra });
	const schema = (s: unknown) => ({ response_format: { type: 'json_schema', json_schema: { name: 'x', schema: s } } });
	assert.doesNotThrow(ask(schema({ type: 'object', properties: { name: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } }, required: ['name'] })));
	assert.doesNotThrow(ask({ response_format: { type: 'json_object' }, stop: ['\n\n', 'END'] }));
	assert.throws(ask(schema({ anyOf: [{ type: 'string' }, { type: 'number' }] })), /anyOf/);
	assert.throws(ask(schema({ type: 'string', pattern: '(a+)+$' })), /pattern/);
	let deep: Record<string, unknown> = { type: 'string' };
	for (let i = 0; i < 12; i++) {
		deep = { type: 'object', properties: { a: deep } };
	}
	assert.throws(ask(schema(deep)), /nests deeper/);
	assert.throws(ask(schema({ type: 'object', description: 'x'.repeat(9000) })), /bytes/);
	assert.throws(ask({ response_format: { type: 'grammar' } }), /response_format/);
	assert.throws(ask({ stop: ['a', 'b', 'c', 'd', 'e'] }), /stop/);
	assert.throws(ask({ stop: 'x'.repeat(300) }), /stop/);
	const forced = { tools: [{ type: 'function', function: { name: 'f', parameters: { oneOf: [{ type: 'string' }] } } }] };
	assert.doesNotThrow(ask({ ...forced, tool_choice: 'auto' }), 'free tool choice compiles no grammar');
	assert.throws(ask({ ...forced, tool_choice: 'required' }), /oneOf/);
	const base = { model: 'qwen3-8b', messages: [{ role: 'user' as const, content: 'hi' }] };
	assert.ok(promptTokenBound({ ...base, response_format: { type: 'json_object', pad: 'x'.repeat(500) } }) >= promptTokenBound(base) + 500, 'the response format is priced');
});

test('the prompt bound covers dense scripts and tool definitions', () => {
	const base = { model: 'qwen3-8b', messages: [{ role: 'user' as const, content: 'hi' }] };
	const cjk = '漢'.repeat(1000);
	/* Roughly one token per character for CJK; the old chars/3 estimate priced a third of that. */
	assert.ok(promptTokenBound({ ...base, messages: [{ role: 'user', content: cjk }] }) >= 1000);
	const tools = [{ type: 'function', function: { name: 'f', description: 'x'.repeat(5000), parameters: {} } }];
	assert.ok(promptTokenBound({ ...base, tools }) > promptTokenBound(base) + 10_000, 'tools count toward the prompt');
});

test('a tool call is metered like the same text sent as an answer, and a completion keeps it', async () => {
	const args = '{"text": "' + 'a long answer '.repeat(40) + '"}';
	const call = (piece: Record<string, unknown>) => ({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, ...piece }] }, finish_reason: null }] });
	/* As vLLM, llama.cpp and mlx_lm.server stream a forced call: the id and name first, then the arguments in pieces. */
	const chunks = [
		{ choices: [{ index: 0, delta: { role: 'assistant', content: 'Sure. ' }, finish_reason: null }] },
		call({ id: 'call_1', type: 'function', function: { name: 'write', arguments: '' } }),
		call({ function: { arguments: args.slice(0, 100) } }),
		call({ function: { arguments: args.slice(100) } }),
		{ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }
	];
	const delivered = chunks.map(chunkText).join('');
	assert.equal(delivered, `Sure. write${args}`, 'the delivered text holds the call\'s name and arguments');
	assert.equal(maxOutputTokensFor(delivered), maxOutputTokensFor(`Sure. write${args}`), 'so its output can be billed as if it were the answer');
	assert.equal(chunkText({ choices: [{ index: 0, delta: { refusal: 'I cannot help with that.' } }] }), 'I cannot help with that.');
	assert.equal(chunkText({ choices: [{ index: 0, delta: { tool_calls: 'call' } }, { delta: { tool_calls: [null, { function: { arguments: 1 } }] } }] }), '', 'malformed calls add nothing');

	const events = (async function* (): AsyncGenerator<RelayEvent> {
		for (const data of chunks) {
			yield { type: 'chunk', data };
		}
	})();
	const { completion } = await aggregateCompletion(events, 'qwen3-8b');
	assert.deepEqual(completion.choices, [
		{ index: 0, message: { role: 'assistant', content: 'Sure. ', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'write', arguments: args } }] }, finish_reason: 'tool_calls' }
	]);
	const reasoned = await aggregateCompletion(
		(async function* (): AsyncGenerator<RelayEvent> {
			yield { type: 'chunk', data: { choices: [{ index: 0, delta: { reasoning_content: 'Think. ' }, finish_reason: null }] } };
			yield { type: 'chunk', data: { choices: [{ index: 0, delta: { refusal: 'No.' }, finish_reason: 'stop' }] } };
		})(),
		'qwen3-8b'
	);
	assert.deepEqual(reasoned.completion.choices[0]?.message, { role: 'assistant', content: '', reasoning_content: 'Think. ', refusal: 'No.' }, 'billed reasoning and refusals reach a buyer that does not stream');
});

test('catalog.json is in sync with catalog.ts (run npm run catalog:export)', async () => {
	const { readFileSync } = await import('node:fs');
	const { catalogExport } = await import('../scripts/export-catalog.ts');
	assert.deepEqual(JSON.parse(readFileSync(new URL('../catalog.json', import.meta.url), 'utf8')), catalogExport());
});

test('stablecoins: the Keeta stablecoins lead and USDC comes last; only pinned ones are usable; credits are dollars at 6 decimals', async () => {
	const { CREDIT_DECIMALS, ONE_CREDIT, assetListing, availableAssets, defaultAsset, findAsset, pinnedCredits, rescaleAmount } = await import('../src/index.ts');
	for (const network of ['test', 'main'] as const) {
		const listing = assetListing(network);
		assert.deepEqual(
			listing.map((a) => a.symbol),
			['KUSD', 'KEUR', 'KJPY', 'KMXN', 'KCAD', 'KAED', 'KGBP', 'USDC']
		);
		assert.deepEqual(
			availableAssets(network).map((a) => a.symbol),
			listing.filter((a) => a.available).map((a) => a.symbol),
			'usable means pinned, in the same order'
		);
		assert.equal(defaultAsset(network).symbol, findAsset(network, 'KUSD') ? 'KUSD' : 'USDC', 'x402 asks for KUSD once it is pinned, else USDC');
		const usdc = findAsset(network, 'usdc')!;
		assert.equal(findAsset(network, usdc.address)?.symbol, 'USDC', 'found by symbol in any case, or by address');
		assert.equal(pinnedCredits(network)?.decimals ?? CREDIT_DECIMALS, CREDIT_DECIMALS);
	}
	assert.equal(pinnedCredits('main'), null, 'main-network credits stay unset until keeta.ai issues them');
	assert.equal(ONE_CREDIT, 1_000_000n);
	assert.equal(rescaleAmount(1_234_567n, 6, 4), 12_346n, 'down-scaling rounds up, so a price never becomes zero');
	assert.equal(rescaleAmount(5n, 6, 18), 5_000_000_000_000n);
});

test('escrow blocks: only the buyer\'s sends of the token to the settlement account that reference the job count', async () => {
	const KeetaNet = await import('@keetanetwork/keetanet-client');
	const { NETWORKS } = await import('../src/index.ts');
	const { checkPaymentBlock } = await import('../src/keeta.ts');
	const random = () => Account.fromSeed(Account.generateRandomSeed({ asString: true }), 0);
	const [buyer, settlement, stranger] = [random(), random(), random()];
	const credits = Account.generateBaseAddresses(BigInt(NETWORKS.test.caip2.split(':')[1]!)).baseToken;
	const otherToken = Account.generateBaseAddresses(BigInt(NETWORKS.main.caip2.split(':')[1]!)).baseToken;
	/* A real signed block, served by a stand-in for the ledger client's block lookup. */
	const builder = new KeetaNet.lib.Block.Builder();
	builder.account = buyer;
	builder.signer = buyer;
	builder.network = BigInt(NETWORKS.test.caip2.split(':')[1]!);
	builder.previous = KeetaNet.lib.Block.NO_PREVIOUS;
	builder.date = new Date();
	const send = (to: typeof buyer, amount: bigint, token: typeof credits, external: string) =>
		builder.addOperation({ type: KeetaNet.lib.Block.OperationType.SEND, to, amount, token, external } as never);
	send(settlement, 3n, credits, 'job_1');
	send(settlement, 4n, credits, 'job_1');
	send(settlement, 9n, credits, 'job_2');
	send(settlement, 100n, otherToken, 'job_1');
	send(stranger, 50n, credits, 'job_1');
	const block = await builder.seal();
	const ledger = { getBlock: async (hash: string) => (hash === block.hash.toString() ? block : null) } as unknown as Parameters<typeof checkPaymentBlock>[0];
	const expect = { blockHash: block.hash.toString(), from: buyer.publicKeyString.get(), to: settlement.publicKeyString.get(), asset: credits.publicKeyString.get(), minAmount: 7n, reference: 'job_1' };

	assert.deepEqual(await checkPaymentBlock(ledger, expect), { status: 'confirmed', amount: 7n }, 'every send for the job counts, and only those');
	assert.deepEqual(await checkPaymentBlock(ledger, { ...expect, minAmount: 8n }), { status: 'mismatch', reason: 'paid 7, due 8' });
	assert.deepEqual(await checkPaymentBlock(ledger, { ...expect, reference: 'job_2', minAmount: 9n }), { status: 'confirmed', amount: 9n }, 'a send for another job counts only for that job');
	assert.equal((await checkPaymentBlock(ledger, { ...expect, reference: 'job_3', minAmount: 1n })).status, 'mismatch', 'a block cannot escrow a job it does not name');
	assert.equal((await checkPaymentBlock(ledger, { ...expect, to: random().publicKeyString.get() })).status, 'mismatch', 'sent somewhere else');
	assert.equal((await checkPaymentBlock(ledger, { ...expect, asset: random().publicKeyString.get() })).status, 'mismatch', 'another token');
	assert.deepEqual(await checkPaymentBlock(ledger, { ...expect, from: stranger.publicKeyString.get() }), { status: 'mismatch', reason: 'block was not signed by the buyer account' });
	assert.deepEqual(await checkPaymentBlock(ledger, { ...expect, blockHash: 'F'.repeat(64) }), { status: 'not-found' }, 'not on the ledger yet');
});
