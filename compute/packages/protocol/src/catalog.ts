/**
 * The curated model catalog. The network is model-agnostic: operators may
 * also install their own weights. Catalog entries exist to make the common
 * case one click and to surface each model's license terms before an operator
 * offers it (plan §4.5, §11.9).
 *
 * Revisions and `weightsHash` come from `catalog-pins.ts`. Until a model is
 * pinned it installs from `main` on the test network only; the agent computes
 * the hash at install time and buyers see it on every receipt.
 */

import { CATALOG_PINS } from './catalog-pins.ts';

export type RuntimeKind = 'mlx' | 'openai-compatible';

export interface ModelLicense {
	name: string;
	url: string;
	/** Plain-language obligations an operator takes on by serving the model commercially. */
	operatorNotes: string;
	attribution?: string;
}

export interface CatalogModel {
	/** Stable network-wide model id, used in the OpenAI `model` field. */
	id: string;
	name: string;
	family: string;
	parameters: string;
	quantization: string;
	runtime: RuntimeKind;
	/** Hugging Face repository holding the runtime-ready weights. */
	source: { kind: 'huggingface'; repo: string; revision: string };
	/** Bytes on disk, approximately. */
	diskBytes: number;
	/** Unified memory the model needs loaded, including working headroom. */
	memoryBytes: number;
	contextLength: number;
	license: ModelLicense;
	/** Suggested price in settlement-asset base units per million tokens. */
	suggestedPrice: { inputPerMillion: string; outputPerMillion: string };
	weightsHash?: string;
	/** True when no single machine can hold the model (multi-Mac cluster only). */
	requiresCluster?: boolean;
	tags: string[];
}

const GB = 1024 ** 3;

function llamaLicense(version: '3_1' | '3_2' | '3_3'): ModelLicense {
	return {
		name: `Llama ${version.replace('_', '.')} Community License`,
		url: `https://www.llama.com/llama${version}/license/`,
		operatorNotes: 'Display "Built with Llama" where you offer the model; follow the Llama acceptable use policy. Services above 700M monthly users need a separate license from Meta.',
		attribution: 'Built with Llama'
	};
}

const QWEN_LICENSE: ModelLicense = {
	name: 'Apache-2.0',
	url: 'https://www.apache.org/licenses/LICENSE-2.0',
	operatorNotes: 'Permissive. Keep the license and notices with the weights.'
};

const GEMMA_LICENSE: ModelLicense = {
	name: 'Gemma Terms of Use',
	url: 'https://ai.google.dev/gemma/terms',
	operatorNotes: 'Follow the Gemma prohibited use policy and pass its restrictions on to the people you serve.'
};

const MUSE_LICENSE: ModelLicense = {
	name: 'Muse Model License',
	url: 'https://huggingface.co/meta-models/Muse-Spark-Open-816B-A42B',
	operatorNotes: 'Show "Built with Muse Spark Open" attribution, follow its usage policy, and contact Meta before offering it as a service once your gross revenue from it passes US$20M in 12 months. This is your compliance question as the operator, not the network\'s.',
	attribution: 'Built with Muse Spark Open'
};

function price(input: number, output: number): CatalogModel['suggestedPrice'] {
	/* Credits have 6 decimals and track the US dollar: 0.10 credits per million tokens is 100000 base units. */
	return {
		inputPerMillion: String(Math.round(input * 1_000_000)),
		outputPerMillion: String(Math.round(output * 1_000_000))
	};
}

function hf(repo: string): CatalogModel['source'] {
	return { kind: 'huggingface', repo, revision: 'main' };
}

export const CATALOG: CatalogModel[] = [
	{
		id: 'llama-3.2-3b-instruct',
		name: 'Llama 3.2 3B Instruct',
		family: 'llama',
		parameters: '3B',
		quantization: '4-bit',
		runtime: 'mlx',
		source: hf('mlx-community/Llama-3.2-3B-Instruct-4bit'),
		diskBytes: 1.8 * GB,
		memoryBytes: 4 * GB,
		contextLength: 131072,
		license: llamaLicense('3_2'),
		suggestedPrice: price(0.02, 0.04),
		tags: ['small', 'chat']
	},
	{
		id: 'qwen3-4b',
		name: 'Qwen3 4B',
		family: 'qwen',
		parameters: '4B',
		quantization: '4-bit',
		runtime: 'mlx',
		source: hf('mlx-community/Qwen3-4B-4bit'),
		diskBytes: 2.3 * GB,
		memoryBytes: 5 * GB,
		contextLength: 32768,
		license: QWEN_LICENSE,
		suggestedPrice: price(0.03, 0.06),
		tags: ['small', 'reasoning']
	},
	{
		id: 'llama-3.1-8b-instruct',
		name: 'Llama 3.1 8B Instruct',
		family: 'llama',
		parameters: '8B',
		quantization: '4-bit',
		runtime: 'mlx',
		source: hf('mlx-community/Meta-Llama-3.1-8B-Instruct-4bit'),
		diskBytes: 4.5 * GB,
		memoryBytes: 7 * GB,
		contextLength: 131072,
		license: llamaLicense('3_1'),
		suggestedPrice: price(0.05, 0.08),
		tags: ['chat']
	},
	{
		id: 'qwen3-8b',
		name: 'Qwen3 8B',
		family: 'qwen',
		parameters: '8B',
		quantization: '4-bit',
		runtime: 'mlx',
		source: hf('mlx-community/Qwen3-8B-4bit'),
		diskBytes: 4.6 * GB,
		memoryBytes: 7 * GB,
		contextLength: 32768,
		license: QWEN_LICENSE,
		suggestedPrice: price(0.05, 0.1),
		tags: ['reasoning', 'coding']
	},
	{
		id: 'qwen3-14b',
		name: 'Qwen3 14B',
		family: 'qwen',
		parameters: '14B',
		quantization: '4-bit',
		runtime: 'mlx',
		source: hf('mlx-community/Qwen3-14B-4bit'),
		diskBytes: 8.3 * GB,
		memoryBytes: 11 * GB,
		contextLength: 32768,
		license: QWEN_LICENSE,
		suggestedPrice: price(0.08, 0.2),
		tags: ['reasoning', 'coding']
	},
	{
		id: 'gemma-3-27b-it',
		name: 'Gemma 3 27B',
		family: 'gemma',
		parameters: '27B',
		quantization: '4-bit',
		runtime: 'mlx',
		source: hf('mlx-community/gemma-3-27b-it-4bit'),
		diskBytes: 16 * GB,
		memoryBytes: 20 * GB,
		contextLength: 131072,
		license: GEMMA_LICENSE,
		suggestedPrice: price(0.1, 0.25),
		tags: ['chat', 'vision']
	},
	{
		id: 'qwen3-30b-a3b',
		name: 'Qwen3 30B A3B (MoE)',
		family: 'qwen',
		parameters: '30B total / 3B active',
		quantization: '4-bit',
		runtime: 'mlx',
		source: hf('mlx-community/Qwen3-30B-A3B-4bit'),
		diskBytes: 17 * GB,
		memoryBytes: 21 * GB,
		contextLength: 32768,
		license: QWEN_LICENSE,
		suggestedPrice: price(0.08, 0.25),
		tags: ['moe', 'reasoning', 'coding']
	},
	{
		id: 'qwen3-32b',
		name: 'Qwen3 32B',
		family: 'qwen',
		parameters: '32B',
		quantization: '4-bit',
		runtime: 'mlx',
		source: hf('mlx-community/Qwen3-32B-4bit'),
		diskBytes: 18.5 * GB,
		memoryBytes: 23 * GB,
		contextLength: 32768,
		license: QWEN_LICENSE,
		suggestedPrice: price(0.15, 0.4),
		tags: ['reasoning', 'coding']
	},
	{
		id: 'llama-3.3-70b-instruct',
		name: 'Llama 3.3 70B Instruct',
		family: 'llama',
		parameters: '70B',
		quantization: '4-bit',
		runtime: 'mlx',
		source: hf('mlx-community/Llama-3.3-70B-Instruct-4bit'),
		diskBytes: 40 * GB,
		memoryBytes: 46 * GB,
		contextLength: 131072,
		license: llamaLicense('3_3'),
		suggestedPrice: price(0.3, 0.6),
		tags: ['large', 'chat']
	},
	{
		id: 'qwen3-235b-a22b',
		name: 'Qwen3 235B A22B (MoE)',
		family: 'qwen',
		parameters: '235B total / 22B active',
		quantization: '4-bit',
		runtime: 'mlx',
		source: hf('mlx-community/Qwen3-235B-A22B-4bit'),
		diskBytes: 132 * GB,
		memoryBytes: 145 * GB,
		contextLength: 32768,
		license: QWEN_LICENSE,
		suggestedPrice: price(0.4, 1.2),
		tags: ['large', 'moe', 'reasoning']
	},
	{
		id: 'muse-spark-open',
		name: 'Muse Spark Open',
		family: 'muse',
		parameters: '816B total / 42B active',
		quantization: 'NVFP4',
		runtime: 'mlx',
		source: hf('meta-models/Muse-Spark-Open-816B-A42B'),
		diskBytes: 493 * GB,
		memoryBytes: 560 * GB,
		contextLength: 1_000_000,
		license: MUSE_LICENSE,
		suggestedPrice: price(1.25, 4.25),
		requiresCluster: true,
		tags: ['frontier', 'moe', 'cluster']
	}
];

for (const model of CATALOG) {
	const pin = CATALOG_PINS[model.id];
	if (pin) {
		model.source = { ...model.source, revision: pin.revision };
		model.weightsHash = pin.weightsHash;
	}
}

export function findCatalogModel(id: string): CatalogModel | undefined {
	return CATALOG.find((model) => model.id === id);
}
