/**
 * Downloads model weights from Hugging Face and computes the weights hash
 * advertised in offers and receipts.
 *
 * Every large file is stored with Git LFS, whose object id is the file's
 * SHA-256, so each download is verified against the hash the hub publishes.
 * The weights hash is SHA-256 over "path<TAB>sha256\n" lines sorted by path.
 */

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export interface HubFile {
	path: string;
	size: number;
	/** SHA-256 from the LFS pointer, when the file is in LFS. */
	sha256?: string;
}

const SKIP = /(^|\/)(\.gitattributes|README\.md|LICENSE.*|.*\.md)$/i;

export async function listRepoFiles(repo: string, revision: string, fetchImpl: typeof fetch = fetch): Promise<HubFile[]> {
	if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
		throw new Error('repository must look like owner/name');
	}
	const response = await fetchImpl(`https://huggingface.co/api/models/${repo}/tree/${encodeURIComponent(revision)}?recursive=1`);
	if (!response.ok) {
		throw new Error(`Hugging Face returned ${response.status} for ${repo}`);
	}
	const entries = (await response.json()) as Array<{ type: string; path: string; size: number; lfs?: { oid: string; size: number } }>;
	return entries
		.filter((entry) => entry.type === 'file' && !SKIP.test(entry.path) && !entry.path.includes('..'))
		.map((entry) => ({ path: entry.path, size: entry.lfs?.size ?? entry.size, ...(entry.lfs ? { sha256: entry.lfs.oid } : {}) }));
}

async function hashFile(path: string): Promise<string> {
	const hash = createHash('sha256');
	await pipeline(createReadStream(path), hash);
	return hash.digest('hex');
}

export async function downloadRepo(
	repo: string,
	revision: string,
	destination: string,
	options: { signal: AbortSignal; onProgress: (done: number, total: number) => void; fetchImpl?: typeof fetch }
): Promise<{ weightsHash: string; sizeBytes: number }> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const files = await listRepoFiles(repo, revision, fetchImpl);
	if (!files.some((file) => file.path.endsWith('.safetensors') || file.path.endsWith('.gguf'))) {
		throw new Error(`${repo} has no .safetensors or .gguf weights`);
	}
	const total = files.reduce((sum, file) => sum + file.size, 0);
	let done = 0;
	const hashes: Array<[string, string]> = [];
	for (const file of files) {
		const target = join(destination, file.path);
		mkdirSync(dirname(target), { recursive: true });
		if (existsSync(target) && statSync(target).size === file.size) {
			const existing = await hashFile(target);
			if (!file.sha256 || existing === file.sha256) {
				hashes.push([file.path, existing]);
				done += file.size;
				options.onProgress(done, total);
				continue;
			}
		}
		const url = `https://huggingface.co/${repo}/resolve/${encodeURIComponent(revision)}/${file.path.split('/').map(encodeURIComponent).join('/')}`;
		const response = await fetchImpl(url, { signal: options.signal });
		if (!response.ok || !response.body) {
			throw new Error(`download of ${file.path} failed with ${response.status}`);
		}
		const partial = `${target}.partial`;
		const hash = createHash('sha256');
		const reader = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>);
		reader.on('data', (chunk: Buffer) => {
			hash.update(chunk);
			done += chunk.length;
			options.onProgress(done, total);
		});
		await pipeline(reader, createWriteStream(partial), { signal: options.signal });
		const digest = hash.digest('hex');
		if (file.sha256 && digest !== file.sha256) {
			throw new Error(`${file.path} failed hash verification`);
		}
		renameSync(partial, target);
		hashes.push([file.path, digest]);
	}
	/* The runtime loads every weight file in the directory, so it must hold only what the hash covers: an interrupted install of another revision can leave shards the listing no longer names. */
	await removeUnlisted(destination, new Set(files.map((file) => file.path)));
	return { weightsHash: weightsHashFrom(hashes), sizeBytes: total };
}

/** Delete every file under `dir` whose path relative to `root` is not in `keep`. */
async function removeUnlisted(root: string, keep: ReadonlySet<string>, dir = root): Promise<void> {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			await removeUnlisted(root, keep, full);
		} else if (!keep.has(relative(root, full))) {
			rmSync(full, { force: true });
		}
	}
}

export function weightsHashFrom(entries: Array<[string, string]>): string {
	const lines = [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([path, sha]) => `${path}\t${sha}\n`);
	return createHash('sha256').update(lines.join('')).digest('hex');
}

/** Weights hash of a directory already on disk (custom models, Linux helpers). */
export async function hashDirectory(root: string): Promise<{ weightsHash: string; sizeBytes: number }> {
	const entries: Array<[string, string]> = [];
	let size = 0;
	async function walk(dir: string) {
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				await walk(full);
			} else if (entry.isFile() && !SKIP.test(entry.name) && !entry.name.endsWith('.partial')) {
				entries.push([relative(root, full), await hashFile(full)]);
				size += statSync(full).size;
			}
		}
	}
	if (statSync(root).isFile()) {
		return { weightsHash: weightsHashFrom([[root.split('/').pop()!, await hashFile(root)]]), sizeBytes: statSync(root).size };
	}
	await walk(root);
	return { weightsHash: weightsHashFrom(entries), sizeBytes: size };
}
