/**
 * Where a node gets a pinned model's tokenizer: the model's own directory
 * when the provider has it installed, otherwise a download from the pinned
 * Hugging Face commit, kept on disk. Every file is checked against the pin's
 * SHA-256 before it is used, so a buyer and a provider always count with the
 * same files.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findCatalogModel, type ChatCompletionRequest, type Log } from '@keeta-compute/protocol';
import { PromptCounter, type TokenizerFiles } from './count.ts';

export interface PinnedTokenizer {
	repo: string;
	revision: string;
	/** File name → SHA-256. */
	files: Record<string, string>;
}

/** A catalog model's pinned tokenizer, or null when the model has none (custom models, unpinned ones). */
export function pinnedTokenizer(modelId: string): PinnedTokenizer | null {
	const model = findCatalogModel(modelId);
	if (!model?.tokenizer || model.source.revision === 'main' || !model.tokenizer['tokenizer.json']) {
		return null;
	}
	return { repo: model.source.repo, revision: model.source.revision, files: model.tokenizer };
}

/**
 * The exact prompt tokens of a request for a model: null when the model has
 * no pinned tokenizer or its template cannot render the request (price it by
 * size), and an error when it has one that could not be loaded.
 */
export type PromptCount = (modelId: string, request: ChatCompletionRequest, options?: { localDir?: string }) => Promise<number | null>;

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

/** Tokenizers held in memory at once; each can take a few hundred megabytes. */
const IN_MEMORY = 2;

export class TokenizerCache {
	private readonly loaded = new Map<string, Promise<PromptCounter>>();

	constructor(
		private readonly options: {
			/** Directory for downloaded tokenizer files. */
			dir: string;
			fetchImpl?: typeof fetch;
			log?: Log;
			/** Which tokenizer a model has; defaults to the catalog pins. */
			pinFor?: (modelId: string) => PinnedTokenizer | null;
		}
	) {}

	readonly count: PromptCount = async (modelId, request, options = {}) => {
		const pin = (this.options.pinFor ?? pinnedTokenizer)(modelId);
		if (!pin) {
			return null;
		}
		return (await this.counter(modelId, pin, options.localDir)).count(request);
	};

	private counter(modelId: string, pin: PinnedTokenizer, localDir?: string): Promise<PromptCounter> {
		const key = `${modelId}@${pin.revision}`;
		let counter = this.loaded.get(key);
		if (!counter) {
			counter = this.load(modelId, pin, localDir).then((files) => new PromptCounter(files));
			/* A failed load is tried again on the next request. */
			counter.catch(() => this.loaded.delete(key));
			this.loaded.set(key, counter);
			while (this.loaded.size > IN_MEMORY) {
				this.loaded.delete(this.loaded.keys().next().value!);
			}
		}
		return counter;
	}

	private async load(modelId: string, pin: PinnedTokenizer, localDir?: string): Promise<TokenizerFiles> {
		const cacheDir = join(this.options.dir, modelId.replace(/[^\w.-]/g, '_'), pin.revision);
		const files: TokenizerFiles = {};
		const downloaded: Array<[string, Buffer]> = [];
		for (const [name, expected] of Object.entries(pin.files)) {
			const local = [localDir && join(localDir, name), join(cacheDir, name)].find((path): path is string => Boolean(path) && existsSync(path as string));
			const onDisk = local ? readFileSync(local) : null;
			let data: Buffer;
			if (onDisk && sha256(onDisk) === expected) {
				data = onDisk;
			} else {
				data = await this.download(pin, name);
				if (sha256(data) !== expected) {
					throw new Error(`${pin.repo}/${name} at ${pin.revision} does not match its pinned hash`);
				}
				downloaded.push([name, data]);
			}
			files[name] = data.toString('utf8');
		}
		/* Kept only once every file checked out. */
		for (const [name, data] of downloaded) {
			mkdirSync(cacheDir, { recursive: true });
			writeFileSync(join(cacheDir, `${name}.partial`), data);
			renameSync(join(cacheDir, `${name}.partial`), join(cacheDir, name));
		}
		if (downloaded.length) {
			this.options.log?.('info', `downloaded the ${modelId} tokenizer (${downloaded.map(([name]) => name).join(', ')})`);
		}
		return files;
	}

	private async download(pin: PinnedTokenizer, name: string): Promise<Buffer> {
		const url = `https://huggingface.co/${pin.repo}/resolve/${encodeURIComponent(pin.revision)}/${encodeURIComponent(name)}`;
		const response = await (this.options.fetchImpl ?? fetch)(url);
		if (!response.ok) {
			throw new Error(`could not download ${pin.repo}/${name}: HTTP ${response.status}`);
		}
		return Buffer.from(await response.arrayBuffer());
	}
}
