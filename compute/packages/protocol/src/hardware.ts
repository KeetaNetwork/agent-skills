/**
 * Hardware inventory, tiers (plan §5.4) and model compatibility.
 */

import type { CatalogModel } from './catalog.ts';

export type HardwareTier = 'A' | 'B' | 'C' | 'excluded';

export interface HardwareProfile {
	os: 'macos' | 'linux';
	osVersion: string;
	/** e.g. "Apple M4 Max" or "AMD EPYC 7763 + NVIDIA RTX 4090". */
	chip: string;
	/** Unified memory on Apple Silicon; VRAM (or RAM for CPU) elsewhere. */
	memoryBytes: number;
	freeDiskBytes: number;
	gpuCores?: number;
	machineModel?: string;
	/** Thunderbolt 5 RDMA capable (cluster eligibility, not used in v1 scheduling). */
	rdmaCapable?: boolean;
}

const GB = 1024 ** 3;

/** Machines below this are excluded from providing at launch (plan §5.4). */
export const MIN_PROVIDER_MEMORY_BYTES = 32 * GB;

export function hardwareTier(profile: Pick<HardwareProfile, 'memoryBytes'>): HardwareTier {
	const gb = profile.memoryBytes / GB;
	if (gb >= 64) {
		return 'B';
	}
	if (gb >= 32) {
		return 'C';
	}
	return 'excluded';
}

/**
 * The share of memory a model may use. macOS lets the GPU wire roughly 75% of
 * unified memory on larger machines and about two thirds on smaller ones;
 * the rest has to stay free for the system and the operator's own work.
 */
export function usableModelMemory(profile: Pick<HardwareProfile, 'memoryBytes' | 'os'>): number {
	const fraction = profile.os === 'macos' && profile.memoryBytes < 64 * GB ? 0.66 : 0.75;
	return Math.floor(profile.memoryBytes * fraction);
}

export type Compatibility =
	| { fits: true; headroomBytes: number }
	| { fits: false; reason: 'needs-cluster' | 'not-enough-memory' | 'not-enough-disk' | 'unsupported-runtime'; shortByBytes?: number };

export function checkCompatibility(model: CatalogModel, profile: HardwareProfile, alreadyInstalled = false): Compatibility {
	if (model.requiresCluster) {
		return { fits: false, reason: 'needs-cluster' };
	}
	if (model.runtime === 'mlx' && profile.os !== 'macos') {
		return { fits: false, reason: 'unsupported-runtime' };
	}
	const usable = usableModelMemory(profile);
	if (model.memoryBytes > usable) {
		return { fits: false, reason: 'not-enough-memory', shortByBytes: model.memoryBytes - usable };
	}
	if (!alreadyInstalled && model.diskBytes > profile.freeDiskBytes) {
		return { fits: false, reason: 'not-enough-disk', shortByBytes: model.diskBytes - profile.freeDiskBytes };
	}
	return { fits: true, headroomBytes: usable - model.memoryBytes };
}

/** Catalog models this machine can run, largest first. */
export function compatibleModels(catalog: CatalogModel[], profile: HardwareProfile): CatalogModel[] {
	return catalog
		.filter((model) => checkCompatibility(model, profile).fits)
		.sort((a, b) => b.memoryBytes - a.memoryBytes);
}

export function formatBytes(bytes: number): string {
	if (bytes >= GB) {
		return `${(bytes / GB).toFixed(bytes >= 10 * GB ? 0 : 1)} GB`;
	}
	return `${Math.round(bytes / 1024 ** 2)} MB`;
}
