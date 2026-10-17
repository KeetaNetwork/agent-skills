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

/**
 * Longest context an offer may advertise: above any model served today, and
 * small enough that every client (the macOS app decodes it as an Int) can
 * represent it.
 */
export const MAX_CONTEXT_LENGTH = 16_777_216;

export function assertOffer(value: unknown, index: number): Offer {
	const offer = value as Offer;
	const field = `offers[${index}]`;
	assert(offer && typeof offer === 'object', `${field} is required`);
	assert(typeof offer.weightsHash === 'string' && /^[0-9a-f]{64}$/.test(offer.weightsHash), `${field}.weightsHash must be a sha256 hex digest`);
	assert(offer.runtime && (offer.runtime.kind === 'mlx' || offer.runtime.kind === 'openai-compatible'), `${field}.runtime.kind is invalid`);
	assert(typeof offer.runtime.build === 'string' && offer.runtime.build.length <= 200, `${field}.runtime.build is invalid`);
	assert(Number.isInteger(offer.contextLength) && offer.contextLength > 0 && offer.contextLength <= MAX_CONTEXT_LENGTH, `${field}.contextLength must be between 1 and ${MAX_CONTEXT_LENGTH}`);
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
	assertStop(request.stop);
	assertResponseFormat(request.response_format);
	/* A forced tool call makes the model server compile the tool's parameters into a grammar, like a JSON schema. */
	const forcesTool = request.tool_choice === 'required' || (typeof request.tool_choice === 'object' && request.tool_choice !== null);
	if (forcesTool && Array.isArray(request.tools)) {
		for (const tool of request.tools as Array<{ function?: { parameters?: unknown } }>) {
			assertBoundedSchema(tool?.function?.parameters, 'forced tool parameters');
		}
	}
	assert(request.n === undefined || request.n === 1, 'n must be 1');
	const maxTokens = request.max_completion_tokens ?? request.max_tokens;
	assert(maxTokens === undefined || (Number.isInteger(maxTokens) && maxTokens > 0 && maxTokens <= MAX_OUTPUT_TOKENS), `max_tokens must be between 1 and ${MAX_OUTPUT_TOKENS}`);
	return request;
}

const utf8Encoder = new TextEncoder();
const MAX_STOP_SEQUENCES = 4;
const MAX_STOP_BYTES = 256;
const MAX_SCHEMA_BYTES = 8_192;
const MAX_SCHEMA_DEPTH = 8;
/* Keywords whose grammar compile is not bounded by the schema's size (alternation, references, regexes, conditionals). */
const UNBOUNDED_SCHEMA_KEYS = new Set(['anyOf', 'oneOf', 'allOf', 'not', '$ref', '$defs', 'definitions', 'pattern', 'patternProperties', 'if', 'then', 'else', 'dependentSchemas', 'dependentRequired', 'unevaluatedProperties']);

function assertStop(stop: unknown): void {
	if (stop === undefined || stop === null) {
		return;
	}
	const list = typeof stop === 'string' ? [stop] : stop;
	assert(Array.isArray(list) && list.length <= MAX_STOP_SEQUENCES, `stop must be a string or a list of at most ${MAX_STOP_SEQUENCES}`);
	for (const item of list) {
		assert(typeof item === 'string' && utf8Encoder.encode(item).length <= MAX_STOP_BYTES, `each stop sequence must be text of at most ${MAX_STOP_BYTES} bytes`);
	}
}

/**
 * Structured output is compiled into a grammar before the first token, which
 * the buyer has not paid for yet. Only small, plain schemas are accepted: no
 * alternation, references, regexes or conditionals, bounded size and depth.
 */
function assertResponseFormat(format: unknown): void {
	if (format === undefined || format === null) {
		return;
	}
	const f = format as { type?: unknown; json_schema?: { schema?: unknown } };
	assert(typeof f === 'object' && (f.type === 'text' || f.type === 'json_object' || f.type === 'json_schema'), 'response_format.type must be text, json_object or json_schema');
	if (f.type === 'json_schema') {
		assert(f.json_schema && typeof f.json_schema === 'object', 'response_format.json_schema is required');
		assertBoundedSchema(f.json_schema.schema, 'response_format schema');
	}
}

function assertBoundedSchema(schema: unknown, field: string): void {
	if (schema === undefined) {
		return;
	}
	assert(utf8Encoder.encode(JSON.stringify(schema)).length <= MAX_SCHEMA_BYTES, `${field} must be at most ${MAX_SCHEMA_BYTES} bytes`);
	const walk = (node: unknown, depth: number): void => {
		if (Array.isArray(node)) {
			node.forEach((item) => walk(item, depth));
			return;
		}
		if (!node || typeof node !== 'object') {
			return;
		}
		assert(depth <= MAX_SCHEMA_DEPTH, `${field} nests deeper than ${MAX_SCHEMA_DEPTH} levels`);
		for (const [key, value] of Object.entries(node)) {
			assert(!UNBOUNDED_SCHEMA_KEYS.has(key), `${field} may not use ${key}`);
			walk(value, depth + 1);
		}
	};
	walk(schema, 0);
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


/**
 * Most prompt tokens a request can make a model server prefill. Every token
 * covers at least one byte of the rendered prompt, so the UTF-8 size of
 * everything forwarded (messages, tools at twice their size for template
 * indentation, and any response format, which some servers put in the
 * prompt) bounds it whatever the language; the slack covers
 * chat-template markup. Quotes, tickets and providers all size prompts
 * with this, so no request can prefill more than it was priced for.
 */
export function promptTokenBound(request: ChatCompletionRequest): number {
	const bytes = (value: unknown) => utf8Encoder.encode(JSON.stringify(value ?? null)).length;
	const tools = Array.isArray(request.tools) && request.tools.length > 0;
	const schema = request.response_format ? bytes(request.response_format) : 0;
	return bytes(request.messages) + (tools ? 2 * bytes(request.tools) + bytes(request.tool_choice) + 512 : 0) + schema + 16 * request.messages.length + 128;
}

/**
 * The largest promptTokenBound a ticket for `maxInputTokens` may carry.
 * Counting a prompt's tokens takes time in proportion to its size, so a
 * provider refuses a larger request before counting it, and the work a
 * refused request costs is set by what its ticket priced. No tokenizer packs
 * more than a few bytes of a real prompt into a token, so only a request far
 * larger than its ticket is refused; the slack covers tools that a model's
 * chat template leaves out of the prompt.
 */
export function maxPromptBoundFor(maxInputTokens: number): number {
	return 16 * maxInputTokens + 65_536;
}
