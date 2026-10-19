import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { promptTokenBound, type ChatCompletionRequest } from '@keeta-compute/protocol';
import { streamChat, waitForServer } from '../src/index.ts';

/** A model server that streams `chunks` as server-sent events and records each request body. */
async function modelServer(t: { after: (fn: () => void) => void }, chunks: unknown[]): Promise<{ baseUrl: string; bodies: Array<Record<string, unknown>> }> {
	const bodies: Array<Record<string, unknown>> = [];
	const server: Server = createServer(async (req: IncomingMessage, res) => {
		let raw = '';
		for await (const part of req) {
			raw += part;
		}
		bodies.push(JSON.parse(raw) as Record<string, unknown>);
		res.writeHead(200, { 'content-type': 'text/event-stream' });
		for (const chunk of chunks) {
			res.write(`data: ${JSON.stringify(chunk)}\n\n`);
		}
		res.end('data: [DONE]\n\n');
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	t.after(() => server.close());
	const address = server.address() as { port: number };
	return { baseUrl: `http://127.0.0.1:${address.port}/v1`, bodies };
}

const request = { model: 'qwen3-8b', messages: [{ role: 'user', content: 'hello there' }], max_tokens: 50, temperature: 0.2, chat_template: 'evil' } as unknown as ChatCompletionRequest;
const delta = (content: string, finish: string | null = null) => ({ choices: [{ index: 0, delta: { content }, finish_reason: finish }] });

test('a stream is forwarded under the network model id, with only known request fields, and the server usage is billed', async (t) => {
	const server = await modelServer(t, [delta('Hi'), delta(' there', 'stop'), { choices: [], usage: { prompt_tokens: 9, completion_tokens: 2 } }]);
	const forwarded: Array<Record<string, unknown>> = [];
	const result = await streamChat({ baseUrl: server.baseUrl, servedName: '/models/qwen' }, request, {
		networkModelId: 'qwen3-8b',
		maxOutputTokens: 20,
		signal: new AbortController().signal,
		onChunk: (chunk) => forwarded.push(chunk)
	});
	assert.deepEqual(result, { text: 'Hi there', inputTokens: 9, outputTokens: 2, finishReason: 'stop', exactUsage: true });
	const [body] = server.bodies;
	assert.equal(body!.model, '/models/qwen', 'the server is asked for its own model name');
	assert.equal(body!.max_tokens, 20, 'the ticket caps the output, not the request');
	assert.equal(body!.temperature, 0.2);
	assert.equal(body!.chat_template, undefined, 'unknown fields could change the prefill and are dropped');
	assert.deepEqual(body!.stream_options, { include_usage: true });
	assert.ok(forwarded.every((chunk) => chunk.model === 'qwen3-8b'));
});

test('without server usage, output is counted by chunks and input is the prompt\'s size bound, tools included', async (t) => {
	const server = await modelServer(t, [delta('a'), delta('b'), delta('c', 'length')]);
	/* One word of message and 50 KB of tools, which the server prefills too. */
	const tools = [{ type: 'function', function: { name: 'lookup', description: 'x'.repeat(50_000), parameters: { type: 'object' } } }];
	const withTools = { ...request, messages: [{ role: 'user', content: 'hi' }], tools } as ChatCompletionRequest;
	const result = await streamChat({ baseUrl: server.baseUrl, servedName: 'm' }, withTools, { networkModelId: 'm', maxOutputTokens: 3, signal: new AbortController().signal, onChunk: () => undefined });
	assert.equal(result.exactUsage, false);
	assert.equal(result.outputTokens, 3);
	assert.equal(result.finishReason, 'length');
	assert.equal(result.inputTokens, promptTokenBound(withTools), 'the bound a ticket prices without a pinned tokenizer, not an estimate from the message text');
	assert.ok(result.inputTokens > 50_000);
});

test('waitForServer gives up when nothing answers, and stops when cancelled', async () => {
	await assert.rejects(waitForServer('http://127.0.0.1:1/v1', 50), /did not start in time/);
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(waitForServer('http://127.0.0.1:1/v1', 5_000, controller.signal), /cancelled/);
});
