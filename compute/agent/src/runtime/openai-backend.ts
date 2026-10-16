/**
 * Client for a local OpenAI-compatible inference server (mlx_lm.server on
 * macOS; llama.cpp, vLLM or SGLang on Linux helpers). Streams chunks and
 * returns what a receipt needs: usage, output text, finish reason.
 */

import { MODEL_REQUEST_FIELDS, chunkText, estimateTokens, promptText, type ChatCompletionRequest } from '@keeta-compute/protocol';

export interface Backend {
	/** e.g. http://127.0.0.1:8081/v1 */
	baseUrl: string;
	/** Model name the server expects in requests. */
	servedName: string;
}

export interface StreamResult {
	text: string;
	inputTokens: number;
	outputTokens: number;
	finishReason: string;
	/** True when the server reported usage; false when it was estimated. */
	exactUsage: boolean;
}

export async function streamChat(
	backend: Backend,
	request: ChatCompletionRequest,
	options: { networkModelId: string; maxOutputTokens: number; signal: AbortSignal; onChunk: (chunk: Record<string, unknown>) => void }
): Promise<StreamResult> {
	/* Forward only known fields: anything else (a custom chat template, extra documents) could change what gets prefilled. */
	const rest = Object.fromEntries(MODEL_REQUEST_FIELDS.filter((key) => request[key] !== undefined).map((key) => [key, request[key]]));
	const body = {
		...rest,
		model: backend.servedName,
		stream: true,
		stream_options: { include_usage: true },
		max_tokens: options.maxOutputTokens
	};
	const response = await fetch(`${backend.baseUrl}/chat/completions`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
		signal: options.signal
	});
	if (!response.ok || !response.body) {
		const detail = await response.text().catch(() => '');
		throw new Error(`model server returned ${response.status}: ${detail.slice(0, 200)}`);
	}

	let text = '';
	let finishReason = 'stop';
	let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
	let contentChunks = 0;
	const decoder = new TextDecoder();
	let buffer = '';
	const reader = response.body.getReader();
	for (;;) {
		const { value, done } = await reader.read();
		if (value) {
			buffer += decoder.decode(value, { stream: true });
		}
		let newline: number;
		while ((newline = buffer.indexOf('\n')) >= 0) {
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			if (!line.startsWith('data:')) {
				continue;
			}
			const data = line.slice(5).trim();
			if (data === '[DONE]') {
				continue;
			}
			let chunk: { choices?: Array<{ finish_reason?: string | null }>; usage?: typeof usage; model?: string };
			try {
				chunk = JSON.parse(data) as typeof chunk;
			} catch {
				continue;
			}
			const piece = chunkText(chunk);
			if (piece) {
				text += piece;
				contentChunks += 1;
			}
			for (const choice of chunk.choices ?? []) {
				if (choice.finish_reason) {
					finishReason = choice.finish_reason;
				}
			}
			if (chunk.usage) {
				usage = chunk.usage;
			}
			options.onChunk({ ...chunk, model: options.networkModelId });
		}
		if (done) {
			break;
		}
	}

	const exactUsage = typeof usage?.prompt_tokens === 'number' && typeof usage?.completion_tokens === 'number';
	return {
		text,
		inputTokens: exactUsage ? usage!.prompt_tokens! : estimateTokens(promptText(request)),
		/* Streaming servers emit one chunk per generated token when usage is missing. */
		outputTokens: exactUsage ? usage!.completion_tokens! : contentChunks,
		finishReason,
		exactUsage
	};
}

export async function waitForServer(baseUrl: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (signal?.aborted) {
			throw new Error('cancelled');
		}
		try {
			const response = await fetch(`${baseUrl}/models`);
			if (response.ok) {
				return;
			}
		} catch {
			/* not up yet */
		}
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}
	throw new Error(`model server at ${baseUrl} did not start in time`);
}
