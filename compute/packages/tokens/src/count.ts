/**
 * Counts the tokens a model server prefills for a chat request: the request's
 * messages (and tools) rendered with the model's own chat template, then
 * encoded with its own tokenizer, as mlx_lm.server, vLLM and llama.cpp do
 * through Hugging Face's tokenizers. Buyers price a ticket with this count
 * and providers check it before running anything, so the input side of a
 * bill is bounded by the real prompt rather than by its size in bytes.
 */

import { Template } from '@huggingface/jinja';
import { Tokenizer } from '@huggingface/tokenizers';
import type { ChatCompletionRequest } from '@keeta-compute/protocol';

/** A tokenizer's files as a Hugging Face repository keeps them, by file name (see TOKENIZER_FILES). */
export type TokenizerFiles = Partial<Record<string, string>>;

/**
 * Tokens a ticket allows past the exact count: a model server's rendering can
 * differ slightly from this one (a date in the template, how it joins content
 * parts), and an honest provider should not lose those few tokens. A provider
 * can overbill by no more than this.
 */
export const PROMPT_MARGIN_TOKENS = 16;
export const PROMPT_MARGIN_BPS = 100;

/** The input limit a ticket carries for a prompt of `count` tokens: the count plus the margin. */
export function promptTokenLimit(count: number): number {
	return count + PROMPT_MARGIN_TOKENS + Math.ceil((count * PROMPT_MARGIN_BPS) / 10_000);
}

type SpecialToken = string | { content?: string } | null | undefined;

const tokenText = (token: SpecialToken) => (typeof token === 'string' ? token : (token?.content ?? undefined));

/** The chat template a repository's files carry: chat_template.jinja, then tokenizer_config.json, then chat_template.json. */
function chatTemplate(files: TokenizerFiles, config: Record<string, unknown>): string | null {
	if (files['chat_template.jinja']) {
		return files['chat_template.jinja'];
	}
	const fromConfig = config.chat_template;
	if (typeof fromConfig === 'string') {
		return fromConfig;
	}
	if (Array.isArray(fromConfig)) {
		const named = fromConfig as Array<{ name?: string; template?: string }>;
		return (named.find((t) => t.name === 'default') ?? named[0])?.template ?? null;
	}
	if (files['chat_template.json']) {
		const parsed = JSON.parse(files['chat_template.json']) as { chat_template?: unknown };
		return typeof parsed.chat_template === 'string' ? parsed.chat_template : null;
	}
	return null;
}

export class PromptCounter {
	private readonly tokenizer: Tokenizer;
	private readonly template: Template;
	private readonly specials: Record<string, string | undefined>;

	constructor(files: TokenizerFiles) {
		if (!files['tokenizer.json']) {
			throw new Error('tokenizer.json is missing');
		}
		const config = files['tokenizer_config.json'] ? (JSON.parse(files['tokenizer_config.json']) as Record<string, unknown>) : {};
		const template = chatTemplate(files, config);
		if (!template) {
			throw new Error('the tokenizer has no chat template');
		}
		this.tokenizer = new Tokenizer(JSON.parse(files['tokenizer.json']), config);
		this.template = new Template(template);
		this.specials = {
			bos_token: tokenText(config.bos_token as SpecialToken),
			eos_token: tokenText(config.eos_token as SpecialToken),
			unk_token: tokenText(config.unk_token as SpecialToken),
			pad_token: tokenText(config.pad_token as SpecialToken)
		};
	}

	/** Tokens in `text` on its own, with no special tokens added. */
	tokens(text: string): number {
		return this.tokenizer.encode(text, { add_special_tokens: false }).ids.length;
	}

	/**
	 * The prompt tokens for a request, or null when its template cannot render
	 * the request (the request is then priced by its size instead).
	 */
	count(request: ChatCompletionRequest): number | null {
		/* Text parts are joined the way mlx_lm.server joins them before templating. */
		const messages = request.messages.map((message) =>
			Array.isArray(message.content) ? { ...message, content: (message.content as Array<{ text?: string }>).map((part) => part.text ?? '').join('') } : message
		);
		const tools = Array.isArray(request.tools) && request.tools.length > 0 ? request.tools : undefined;
		let prompt: string;
		try {
			prompt = this.template.render({ messages, ...(tools ? { tools } : {}), add_generation_prompt: true, ...this.specials });
		} catch {
			return null;
		}
		/* Some servers put a structured-output schema in the prompt; count it, so their providers are not short. */
		const format = request.response_format as { type?: string } | undefined;
		const schema = format && format.type !== 'text' ? this.tokens(JSON.stringify(format)) : 0;
		return this.tokens(prompt) + schema;
	}
}
