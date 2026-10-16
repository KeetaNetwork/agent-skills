/**
 * Input validation for anything that crosses a trust boundary. Kept
 * dependency-free so the relay Worker can use it.
 */

import type { AccessPolicy, ChatCompletionRequest, Offer } from './types.ts';
import type { Price } from './pricing.ts';

export class ValidationError extends Error {
	readonly status = 400;
}

const KEETA_ADDRESS = /^keeta_[a-z2-7]{50,80}$/;

export function isKeetaAddress(value: unknown): value is string {
	return typeof value === 'string' && KEETA_ADDRESS.test(value);
}

export function assertKeetaAddress(value: unknown, field: string): string {
	if (!isKeetaAddress(value)) {
		throw new ValidationError(`${field} must be a Keeta address`);
	}
	return value;
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) {
		throw new ValidationError(message);
	}
}

const BASE_UNITS = /^\d{1,30}$/;

export function assertPrice(value: unknown, field = 'price'): Price {
	const price = value as Price;
	assert(price && typeof price === 'object', `${field} is required`);
	assert(typeof price.inputPerMillion === 'string' && BASE_UNITS.test(price.inputPerMillion), `${field}.inputPerMillion must be base units`);
	assert(typeof price.outputPerMillion === 'string' && BASE_UNITS.test(price.outputPerMillion), `${field}.outputPerMillion must be base units`);
	return { inputPerMillion: price.inputPerMillion, outputPerMillion: price.outputPerMillion };
}

export function assertAccess(value: unknown, field = 'access'): AccessPolicy {
	const access = value as AccessPolicy;
	assert(access && typeof access === 'object', `${field} is required`);
	assert(access.mode === 'public' || access.mode === 'allowlist', `${field}.mode must be public or allowlist`);
	assert(Array.isArray(access.allow) && access.allow.length <= 1000, `${field}.allow must be a list`);
	return { mode: access.mode, allow: access.allow.map((key, i) => assertKeetaAddress(key, `${field}.allow[${i}]`)) };
}

const MODEL_ID = /^[a-z0-9][a-z0-9._:/-]{0,127}$/i;

export function assertModelId(value: unknown, field = 'model'): string {
	assert(typeof value === 'string' && MODEL_ID.test(value), `${field} is not a valid model id`);
	return value;
}

export function assertOffer(value: unknown, index: number): Offer {
	const offer = value as Offer;
	const field = `offers[${index}]`;
	assert(offer && typeof offer === 'object', `${field} is required`);
	assert(typeof offer.weightsHash === 'string' && /^[0-9a-f]{64}$/.test(offer.weightsHash), `${field}.weightsHash must be a sha256 hex digest`);
	assert(offer.runtime && (offer.runtime.kind === 'mlx' || offer.runtime.kind === 'openai-compatible'), `${field}.runtime.kind is invalid`);
	assert(typeof offer.runtime.build === 'string' && offer.runtime.build.length <= 200, `${field}.runtime.build is invalid`);
	assert(Number.isInteger(offer.contextLength) && offer.contextLength > 0, `${field}.contextLength is invalid`);
	return {
		modelId: assertModelId(offer.modelId, `${field}.modelId`),
		weightsHash: offer.weightsHash,
		runtime: { kind: offer.runtime.kind, build: offer.runtime.build },
		price: assertPrice(offer.price, `${field}.price`),
		access: assertAccess(offer.access, `${field}.access`),
		contextLength: offer.contextLength
	};
}

export const MAX_OUTPUT_TOKENS = 32_768;
export const DEFAULT_MAX_OUTPUT_TOKENS = 1_024;

export function assertChatRequest(value: unknown): ChatCompletionRequest {
	const request = value as ChatCompletionRequest;
	assert(request && typeof request === 'object', 'request body must be a JSON object');
	assertModelId(request.model);
	assert(Array.isArray(request.messages) && request.messages.length > 0, 'messages must be a non-empty list');
	for (const message of request.messages) {
		assert(message && typeof message === 'object' && typeof message.role === 'string', 'each message needs a role');
		const content = message.content;
		assert(content === null || content === undefined || typeof content === 'string' || Array.isArray(content), 'message content must be text');
		if (Array.isArray(content)) {
			/* Images and audio are not counted in quotes, so a server that accepted them would prefill unpaid input. */
			for (const part of content) {
				assert(part && part.type === 'text' && typeof part.text === 'string', 'only text content parts are supported');
			}
		}
	}
	assert(request.tools === undefined || Array.isArray(request.tools), 'tools must be a list');
	assert(request.n === undefined || request.n === 1, 'n must be 1');
	const maxTokens = request.max_completion_tokens ?? request.max_tokens;
	assert(maxTokens === undefined || (Number.isInteger(maxTokens) && maxTokens > 0 && maxTokens <= MAX_OUTPUT_TOKENS), `max_tokens must be between 1 and ${MAX_OUTPUT_TOKENS}`);
	return request;
}

export function requestedMaxTokens(request: ChatCompletionRequest): number {
	return request.max_completion_tokens ?? request.max_tokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
}

/** Request fields a provider forwards to its model server; everything else is dropped. */
export const MODEL_REQUEST_FIELDS = [
	'messages',
	'max_tokens',
	'temperature',
	'top_p',
	'stop',
	'seed',
	'frequency_penalty',
	'presence_penalty',
	'tools',
	'tool_choice',
	'response_format'
] as const;

const utf8Encoder = new TextEncoder();

/**
 * Most prompt tokens a request can make a model server prefill. Every token
 * covers at least one byte of the rendered prompt, so the UTF-8 size of
 * everything forwarded (messages, and tools at twice their size for
 * template indentation) bounds it whatever the language; the slack covers
 * chat-template markup. Quotes, tickets and providers all size prompts
 * with this, so no request can prefill more than it was priced for.
 */
export function promptTokenBound(request: ChatCompletionRequest): number {
	const bytes = (value: unknown) => utf8Encoder.encode(JSON.stringify(value ?? null)).length;
	const tools = Array.isArray(request.tools) && request.tools.length > 0;
	return bytes(request.messages) + (tools ? 2 * bytes(request.tools) + bytes(request.tool_choice) + 512 : 0) + 16 * request.messages.length + 128;
}

/** Text the model will read, for token estimates. */
export function promptText(request: ChatCompletionRequest): string {
	return request.messages
		.map((message) => {
			if (typeof message.content === 'string') {
				return message.content;
			}
			if (Array.isArray(message.content)) {
				return message.content.map((part) => (typeof part.text === 'string' ? part.text : '')).join('\n');
			}
			return '';
		})
		.join('\n');
}
