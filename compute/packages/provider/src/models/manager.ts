/**
 * The local model library (plan §5.3): install from the catalog or a custom
 * Hugging Face repo, verify, offer per model, remove.
 */

import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { CATALOG, checkCompatibility, findCatalogModel, type AccessPolicy, type CatalogModel, type HardwareProfile, type Price } from '@keeta-compute/protocol';
import type { CatalogEntry, InstallProgress, InstalledModel } from '@keeta-compute/protocol/rpc';
import type { MlxRuntime } from '@keeta-compute/runtime-mlx';
import type { ProviderStore } from '../store.ts';
import { downloadRepo } from './download.ts';

export interface HelperBackend {
	baseUrl: string;
	servedName: string;
}

/** Installed model as persisted; Linux helpers record their own server. */
export type StoredModel = InstalledModel & { backend?: HelperBackend; contextLength?: number; repo?: string };

export class ModelManager {
	private readonly installs = new Map<string, AbortController>();

	constructor(
		private readonly store: ProviderStore,
		private readonly dataDir: string,
		private readonly runtime: MlxRuntime | null,
		private readonly emit: (progress: InstallProgress) => void
	) {}

	get models(): StoredModel[] {
		return this.store.state.models as StoredModel[];
	}

	installed(modelId: string): StoredModel | undefined {
		return this.models.find((m) => m.modelId === modelId);
	}

	list(hardware: HardwareProfile | null): CatalogEntry[] {
		const entries: CatalogEntry[] = CATALOG.map((model) => {
			const installed = this.installed(model.id) ?? null;
			return {
				model,
				compatibility: hardware ? checkCompatibility(model, hardware, Boolean(installed)) : { fits: false, reason: 'not-enough-memory' as const },
				installed
			};
		});
		for (const custom of this.models.filter((m) => m.custom)) {
			entries.push({ model: customCatalogModel(custom), compatibility: { fits: true, headroomBytes: 0 }, installed: custom });
		}
		return entries;
	}

	/** Start installing; progress arrives through the emit callback. */
	install(model: CatalogModel, hardware: HardwareProfile | null, custom = false): void {
		if (this.installs.has(model.id)) {
			return;
		}
		if (!custom && hardware) {
			const fit = checkCompatibility(model, hardware);
			if (!fit.fits) {
				throw new Error(`${model.name} does not fit this machine (${fit.reason})`);
			}
		}
		if (!custom && !model.weightsHash && this.store.state.network === 'main') {
			throw new Error(`${model.name} has no pinned weights hash yet, so it cannot be installed for the main network`);
		}
		const controller = new AbortController();
		this.installs.set(model.id, controller);
		const progress = (phase: InstallProgress['phase'], bytesDone = 0, bytesTotal = model.diskBytes, message?: string) =>
			this.emit({ modelId: model.id, phase, bytesDone, bytesTotal, ...(message ? { message } : {}) });
		progress('queued');
		void (async () => {
			try {
				if (this.runtime && model.runtime === 'mlx' && !this.runtime.isInstalled()) {
					await this.runtime.ensureInstalled((message) => progress('runtime', 0, model.diskBytes, message));
				}
				const path = join(this.dataDir, 'models', model.id.replace(/[^a-zA-Z0-9._-]/g, '_'));
				let lastEmit = 0;
				const { weightsHash, sizeBytes } = await downloadRepo(model.source.repo, model.source.revision, path, {
					signal: controller.signal,
					onProgress: (done, total) => {
						if (Date.now() - lastEmit > 500 || done === total) {
							lastEmit = Date.now();
							progress('downloading', done, total);
						}
					}
				});
				progress('verifying', sizeBytes, sizeBytes);
				if (model.weightsHash && model.weightsHash !== weightsHash) {
					throw new Error('downloaded weights do not match the catalog hash');
				}
				const existing = this.installed(model.id);
				const record: StoredModel = {
					modelId: model.id,
					name: model.name,
					path,
					weightsHash,
					sizeBytes,
					installedAt: Date.now(),
					custom,
					offer: existing?.offer ?? { offered: false, price: model.suggestedPrice, access: null },
					contextLength: model.contextLength,
					...(custom ? { repo: model.source.repo } : {})
				};
				this.store.update((s) => {
					s.models = [...(s.models as StoredModel[]).filter((m) => m.modelId !== model.id), record];
				});
				progress('done', sizeBytes, sizeBytes);
			} catch (error) {
				progress('failed', 0, model.diskBytes, controller.signal.aborted ? 'cancelled' : (error as Error).message);
			} finally {
				this.installs.delete(model.id);
			}
		})();
	}

	installCatalog(modelId: string, hardware: HardwareProfile | null): void {
		const model = findCatalogModel(modelId);
		if (!model) {
			throw new Error(`unknown model ${modelId}`);
		}
		this.install(model, hardware);
	}

	installCustom(repo: string, name: string, contextLength = 8192): string {
		const id = `custom:${repo.toLowerCase()}`;
		this.install(
			{
				id,
				name,
				family: 'custom',
				parameters: 'unknown',
				quantization: 'unknown',
				runtime: 'mlx',
				source: { kind: 'huggingface', repo, revision: 'main' },
				diskBytes: 0,
				memoryBytes: 0,
				contextLength,
				license: { name: 'See the model card', url: `https://huggingface.co/${repo}`, operatorNotes: 'You are responsible for the license terms of models you add yourself.' },
				suggestedPrice: { inputPerMillion: '100000', outputPerMillion: '300000' },
				tags: ['custom']
			},
			null,
			true
		);
		return id;
	}

	cancel(modelId: string): boolean {
		const controller = this.installs.get(modelId);
		controller?.abort();
		return Boolean(controller);
	}

	remove(modelId: string): boolean {
		const model = this.installed(modelId);
		if (!model) {
			return false;
		}
		this.runtime?.stop(modelId);
		if (!model.backend && model.path.startsWith(join(this.dataDir, 'models'))) {
			rmSync(model.path, { recursive: true, force: true });
		}
		this.store.update((s) => {
			s.models = s.models.filter((m) => m.modelId !== modelId);
		});
		return true;
	}

	setOffer(modelId: string, offered: boolean, price?: Price, access?: AccessPolicy | null): StoredModel {
		const model = this.installed(modelId);
		if (!model) {
			throw new Error(`${modelId} is not installed`);
		}
		const next: StoredModel = {
			...model,
			offer: {
				offered,
				price: price ?? model.offer.price,
				access: access === undefined ? model.offer.access : access
			}
		};
		this.store.update((s) => {
			s.models = s.models.map((m) => (m.modelId === modelId ? next : m));
		});
		if (!offered) {
			this.runtime?.stop(modelId);
		}
		return next;
	}

	/** Linux helper: register a model served by a local OpenAI-compatible server. */
	addExternal(args: { modelId: string; name: string; backend: HelperBackend; weightsHash: string; sizeBytes: number; path: string; contextLength: number; price: Price }): StoredModel {
		const record: StoredModel = {
			modelId: args.modelId,
			name: args.name,
			path: args.path,
			weightsHash: args.weightsHash,
			sizeBytes: args.sizeBytes,
			installedAt: Date.now(),
			custom: !findCatalogModel(args.modelId),
			offer: { offered: true, price: args.price, access: null },
			backend: args.backend,
			contextLength: args.contextLength
		};
		this.store.update((s) => {
			s.models = [...(s.models as StoredModel[]).filter((m) => m.modelId !== args.modelId), record];
		});
		return record;
	}
}

export function customCatalogModel(model: StoredModel): CatalogModel {
	return {
		id: model.modelId,
		name: model.name,
		family: 'custom',
		parameters: 'unknown',
		quantization: 'unknown',
		runtime: model.backend ? 'openai-compatible' : 'mlx',
		source: { kind: 'huggingface', repo: model.repo ?? '', revision: 'main' },
		diskBytes: model.sizeBytes,
		memoryBytes: 0,
		contextLength: model.contextLength ?? 8192,
		license: { name: 'See the model card', url: model.repo ? `https://huggingface.co/${model.repo}` : '', operatorNotes: 'You are responsible for the license terms of models you add yourself.' },
		suggestedPrice: model.offer.price,
		tags: ['custom']
	};
}
