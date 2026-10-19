/**
 * A small tokenizer for tests: byte-level BPE with no merges, so every UTF-8
 * byte is one token (as the worst case of a real byte-level tokenizer), plus
 * ChatML special tokens and a ChatML chat template like Qwen's. Counts are easy
 * to work out by hand.
 */

import { createHash } from 'node:crypto';
import type { TokenizerFiles } from './count.ts';
import type { PinnedTokenizer } from './cache.ts';

/** GPT-2's byte-to-character table, which byte-level tokenizers use for their vocabulary. */
function byteCharacters(): Array<[number, string]> {
	const bytes: number[] = [];
	for (const [from, to] of [
		[33, 126],
		[161, 172],
		[174, 255]
	] as const) {
		for (let b = from; b <= to; b++) {
			bytes.push(b);
		}
	}
	const chars = [...bytes];
	let extra = 0;
	for (let b = 0; b < 256; b++) {
		if (!bytes.includes(b)) {
			bytes.push(b);
			chars.push(256 + extra++);
		}
	}
	return bytes.map((b, i) => [b, String.fromCharCode(chars[i]!)]);
}

const SPECIAL = ['<|endoftext|>', '<|im_start|>', '<|im_end|>'];

export const CHATML_TEMPLATE =
	"{%- if tools %}{{- '<|im_start|>system\\n# Tools\\n' }}{%- for tool in tools %}{{- tool | tojson }}{{- '\\n' }}{%- endfor %}{{- '<|im_end|>\\n' }}{%- endif %}" +
	"{%- for message in messages %}{{- '<|im_start|>' + message.role + '\\n' + (message.content or '') + '<|im_end|>\\n' }}{%- endfor %}" +
	"{%- if add_generation_prompt %}{{- '<|im_start|>assistant\\n' }}{%- endif %}";

/** tokenizer.json and tokenizer_config.json of the test tokenizer. */
export function byteTokenizerFiles(): Record<string, string> {
	const vocab: Record<string, number> = {};
	for (const [byte, char] of byteCharacters()) {
		vocab[char] = byte;
	}
	SPECIAL.forEach((token, i) => (vocab[token] = 256 + i));
	const tokenizer = {
		version: '1.0',
		truncation: null,
		padding: null,
		added_tokens: SPECIAL.map((content, i) => ({ id: 256 + i, content, single_word: false, lstrip: false, rstrip: false, normalized: false, special: true })),
		normalizer: null,
		pre_tokenizer: { type: 'ByteLevel', add_prefix_space: false, trim_offsets: true, use_regex: true },
		post_processor: null,
		decoder: { type: 'ByteLevel', add_prefix_space: true, trim_offsets: true, use_regex: true },
		model: { type: 'BPE', dropout: null, unk_token: null, continuing_subword_prefix: '', end_of_word_suffix: '', fuse_unk: false, byte_fallback: false, ignore_merges: false, vocab, merges: [] }
	};
	return {
		'tokenizer.json': JSON.stringify(tokenizer),
		'tokenizer_config.json': JSON.stringify({ chat_template: CHATML_TEMPLATE, eos_token: '<|im_end|>', pad_token: '<|endoftext|>', bos_token: null })
	};
}

/** A pin for the test tokenizer's files, as catalog-pins.ts would hold it. */
export function byteTokenizerPin(repo = 'keeta-test/byte-tokenizer', revision = 'f'.repeat(40)): PinnedTokenizer {
	const files = Object.fromEntries(Object.entries(byteTokenizerFiles() as TokenizerFiles).map(([name, text]) => [name, createHash('sha256').update(text!).digest('hex')]));
	return { repo, revision, files };
}
