import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findCatalogModel, promptTokenBound, type ChatCompletionRequest } from '@keeta-compute/protocol';
import { PROMPT_MARGIN_TOKENS, PromptCounter, TokenizerCache, pinnedTokenizer, promptTokenLimit } from '../src/index.ts';
import { byteTokenizerFiles, byteTokenizerPin } from '../src/testing.ts';

const chat = (content: string, extra: Partial<ChatCompletionRequest> = {}): ChatCompletionRequest => ({ model: 'm', messages: [{ role: 'user', content }], ...extra });

/* In ChatML, one user message renders as <|im_start|>user\n…<|im_end|>\n<|im_start|>assistant\n: three special tokens and 16 bytes of markup. */
const MARKUP = 3 + 16;
const utf8 = (text: string) => new TextEncoder().encode(text).length;

test('a prompt is counted with the model\'s chat template and tokenizer, in any script', () => {
	const counter = new PromptCounter(byteTokenizerFiles());
	assert.equal(counter.count(chat('Say hello')), MARKUP + 9);
	/* Three bytes, so three tokens, per CJK character in a byte-level tokenizer; a characters-over-three estimate prices one. */
	const cjk = '你好世界'.repeat(50);
	assert.equal(counter.count(chat(cjk)), MARKUP + utf8(cjk));
	/* Text parts are joined as the model server joins them. */
	assert.equal(counter.count({ model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'Say ' }, { type: 'text', text: 'hello' }] }] }), MARKUP + 9);
	/* Tools go through the template; a schema some servers put in the prompt is counted on top. */
	const tools = [{ type: 'function', function: { name: 'f', parameters: { type: 'object' } } }];
	assert.ok(counter.count(chat('hi', { tools }))! > counter.count(chat('hi'))! + JSON.stringify(tools[0]).length);
	const format = { type: 'json_object' };
	assert.equal(counter.count(chat('hi', { response_format: format })), counter.count(chat('hi'))! + JSON.stringify(format).length);
	assert.equal(counter.count(chat('hi', { response_format: { type: 'text' } })), counter.count(chat('hi')));
	/* The exact count stays under the size bound quotes used before. */
	assert.ok(counter.count(chat(cjk))! <= promptTokenBound(chat(cjk)));
});

test('the ticket limit is the exact count plus a small margin', () => {
	assert.equal(promptTokenLimit(0), PROMPT_MARGIN_TOKENS);
	assert.equal(promptTokenLimit(1000), 1000 + PROMPT_MARGIN_TOKENS + 10);
	assert.equal(promptTokenLimit(1001), 1001 + PROMPT_MARGIN_TOKENS + 11);
});

test('a template that cannot render a request leaves it to the size bound', () => {
	const files = byteTokenizerFiles();
	const counter = new PromptCounter({ ...files, 'chat_template.jinja': "{{ raise_exception('no system messages') }}" });
	assert.equal(counter.count(chat('hi')), null);
	assert.throws(() => new PromptCounter({ 'tokenizer.json': files['tokenizer.json'] }), /no chat template/);
});

test('the cache loads a pinned tokenizer from the model directory, else downloads it once, and refuses files that do not match the pin', async (t) => {
	const dir = mkdtempSync(join(tmpdir(), 'kc-tokens-'));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const files = byteTokenizerFiles();
	const pin = byteTokenizerPin();
	const fetched: string[] = [];
	let served = files;
	const fetchImpl = (async (url: string) => {
		fetched.push(url);
		const name = decodeURIComponent(url.split('/').pop()!);
		return served[name] ? new Response(served[name]) : new Response('missing', { status: 404 });
	}) as typeof fetch;
	const pins: Record<string, typeof pin | null> = { pinned: pin, custom: null };
	const cache = () => new TokenizerCache({ dir: join(dir, 'cache'), fetchImpl, pinFor: (id) => pins[id] ?? null });

	/* A model with no pinned tokenizer is left to the size bound. */
	assert.equal(await cache().count('custom', chat('Say hello')), null);

	/* From the provider's model directory: nothing downloaded. */
	const modelDir = join(dir, 'model');
	mkdirSync(modelDir);
	for (const [name, text] of Object.entries(files)) {
		writeFileSync(join(modelDir, name), text);
	}
	assert.equal(await cache().count('pinned', chat('Say hello'), { localDir: modelDir }), MARKUP + 9);
	assert.equal(fetched.length, 0, "nothing downloaded");

	/* Elsewhere: downloaded from the pinned commit, then read from disk. */
	assert.equal(await cache().count('pinned', chat('Say hello')), MARKUP + 9);
	assert.ok(fetched.every((url) => url.startsWith(`https://huggingface.co/${pin.repo}/resolve/${pin.revision}/`)));
	assert.equal(fetched.length, Object.keys(files).length);
	assert.equal(await cache().count('pinned', chat('Say hello')), MARKUP + 9);
	assert.equal(fetched.length, Object.keys(files).length, 'the second load reads the disk copy');

	/* A file that does not match its pin is never used. */
	const tampered = mkdtempSync(join(tmpdir(), 'kc-tokens-'));
	t.after(() => rmSync(tampered, { recursive: true, force: true }));
	served = { ...files, 'tokenizer_config.json': files['tokenizer_config.json']!.replace('<|im_end|>', '<|im_start|>') };
	const strict = new TokenizerCache({ dir: tampered, fetchImpl, pinFor: () => pin });
	await assert.rejects(strict.count('pinned', chat('hi')), /does not match its pinned hash/);
	assert.deepEqual(readdirSync(tampered), [], 'nothing unverified is kept');
	assert.equal(createHash('sha256').update(files['tokenizer.json']!).digest('hex'), pin.files['tokenizer.json']);
});

test('a catalog model counts once its tokenizer is pinned with its commit', (t) => {
	const model = findCatalogModel('qwen3-8b')!;
	const saved = { source: model.source, tokenizer: model.tokenizer };
	t.after(() => {
		model.source = saved.source;
		if (saved.tokenizer) {
			model.tokenizer = saved.tokenizer;
		} else {
			delete model.tokenizer;
		}
	});
	const files = { 'tokenizer.json': 'a'.repeat(64), 'tokenizer_config.json': 'b'.repeat(64) };
	model.tokenizer = files;
	model.source = { ...model.source, revision: 'main' };
	assert.equal(pinnedTokenizer('qwen3-8b'), null, 'files from main are not a pin');
	model.source = { ...model.source, revision: 'c'.repeat(40) };
	assert.deepEqual(pinnedTokenizer('qwen3-8b'), { repo: model.source.repo, revision: 'c'.repeat(40), files });
	assert.equal(pinnedTokenizer('not-a-catalog-model'), null);
});
