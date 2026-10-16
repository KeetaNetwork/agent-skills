/**
 * Pins every catalog model to the current commit of its Hugging Face repo and
 * records the weights hash those files produce, in the same form the provider
 * computes after a download (see src/models/download.ts). Writes
 * catalog-pins.ts in @keeta-compute/protocol. Needs network access to huggingface.co.
 *
 *   npm run catalog:pin                 pin every model (from compute/)
 *   npm run catalog:pin -- qwen3-8b     pin some models
 *
 * Review the diff before committing: a pin is a statement that Keeta vouches
 * for those exact weights.
 */

import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CATALOG, CATALOG_PINS, type CatalogPin } from '@keeta-compute/protocol';
import { listRepoFiles, weightsHashFrom } from '../src/models/download.ts';

async function resolveCommit(repo: string): Promise<string> {
	const response = await fetch(`https://huggingface.co/api/models/${repo}/revision/main`);
	if (!response.ok) {
		throw new Error(`Hugging Face returned ${response.status} for ${repo}`);
	}
	const { sha } = (await response.json()) as { sha?: string };
	if (!sha || !/^[0-9a-f]{40}$/.test(sha)) {
		throw new Error(`no commit for ${repo}`);
	}
	return sha;
}

async function pin(repo: string): Promise<CatalogPin> {
	const revision = await resolveCommit(repo);
	const entries: Array<[string, string]> = [];
	for (const file of await listRepoFiles(repo, revision)) {
		if (file.sha256) {
			entries.push([file.path, file.sha256]);
			continue;
		}
		/* Small files are not in LFS; fetch them from the pinned commit and hash them. */
		const response = await fetch(`https://huggingface.co/${repo}/resolve/${revision}/${file.path.split('/').map(encodeURIComponent).join('/')}`);
		if (!response.ok) {
			throw new Error(`${repo}/${file.path}: HTTP ${response.status}`);
		}
		entries.push([file.path, createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex')]);
	}
	return { revision, weightsHash: weightsHashFrom(entries) };
}

const only = new Set(process.argv.slice(2));
const pins: Record<string, CatalogPin> = { ...CATALOG_PINS };
for (const model of CATALOG) {
	if (only.size && !only.has(model.id)) {
		continue;
	}
	process.stdout.write(`${model.id} (${model.source.repo})... `);
	pins[model.id] = await pin(model.source.repo);
	process.stdout.write(`${pins[model.id]!.revision.slice(0, 12)} ${pins[model.id]!.weightsHash.slice(0, 12)}\n`);
}

/* Next to the protocol package's entry point, wherever the workspace keeps it. */
const target = fileURLToPath(new URL('./catalog-pins.ts', import.meta.resolve('@keeta-compute/protocol')));
const sorted = Object.fromEntries(Object.entries(pins).sort(([a], [b]) => a.localeCompare(b)));
const source = (await import('node:fs')).readFileSync(target, 'utf8').replace(/export const CATALOG_PINS: Record<string, CatalogPin> = [\s\S]*;\n$/, `export const CATALOG_PINS: Record<string, CatalogPin> = ${JSON.stringify(sorted, null, '\t')};\n`);
writeFileSync(target, source);
console.log(`Wrote ${Object.keys(sorted).length} pins to ${target}. Run npm run catalog:export -w @keeta-compute/protocol next.`);
