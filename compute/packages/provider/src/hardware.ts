/**
 * Hardware inventory for macOS and Linux, and the local conditions the
 * provider policy cares about (battery, idle time).
 */

import { execFile } from 'node:child_process';
import { statfs } from 'node:fs/promises';
import { cpus, platform, release, totalmem } from 'node:os';
import { promisify } from 'node:util';
import type { HardwareProfile } from '@keeta-compute/protocol';

const run = promisify(execFile);

async function output(command: string, args: string[]): Promise<string> {
	try {
		const { stdout } = await run(command, args, { timeout: 5000 });
		return stdout.trim();
	} catch {
		return '';
	}
}

export async function freeDiskBytes(path: string): Promise<number> {
	try {
		const stats = await statfs(path);
		return stats.bavail * stats.bsize;
	} catch {
		return 0;
	}
}

export async function detectHardware(dataDir: string): Promise<HardwareProfile> {
	const disk = await freeDiskBytes(dataDir);
	if (platform() === 'darwin') {
		const [chip, memory, osVersion, model, gpu] = await Promise.all([
			output('sysctl', ['-n', 'machdep.cpu.brand_string']),
			output('sysctl', ['-n', 'hw.memsize']),
			output('sw_vers', ['-productVersion']),
			output('sysctl', ['-n', 'hw.model']),
			output('system_profiler', ['SPDisplaysDataType', '-json'])
		]);
		let gpuCores: number | undefined;
		try {
			const displays = JSON.parse(gpu) as { SPDisplaysDataType?: Array<{ sppci_cores?: string }> };
			const cores = Number(displays.SPDisplaysDataType?.[0]?.sppci_cores);
			gpuCores = Number.isFinite(cores) && cores > 0 ? cores : undefined;
		} catch {
			gpuCores = undefined;
		}
		return {
			os: 'macos',
			osVersion: osVersion || release(),
			chip: chip || cpus()[0]?.model || 'Apple Silicon',
			memoryBytes: Number(memory) || totalmem(),
			freeDiskBytes: disk,
			...(gpuCores ? { gpuCores } : {}),
			...(model ? { machineModel: model } : {}),
			/* Thunderbolt 5 ships on M4 Pro/Max/Ultra class machines; cluster scheduling is not in v1. */
			rdmaCapable: /M[4-9] (Pro|Max|Ultra)|M[5-9]/.test(chip)
		};
	}
	const cpu = cpus()[0]?.model ?? 'CPU';
	const gpus = await output('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits']);
	let chip = cpu;
	let memoryBytes = totalmem();
	if (gpus) {
		const rows = gpus.split('\n').map((line) => line.split(',').map((part) => part.trim()));
		const vram = rows.reduce((sum, row) => sum + Number(row[1] ?? 0), 0) * 1024 * 1024;
		chip = `${cpu} + ${rows.map((row) => row[0]).join(', ')}`;
		if (vram > 0) {
			memoryBytes = vram;
		}
	}
	const osRelease = await output('sh', ['-c', '. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME"']);
	return { os: 'linux', osVersion: osRelease || release(), chip, memoryBytes, freeDiskBytes: disk };
}

export async function onBattery(): Promise<boolean> {
	if (platform() !== 'darwin') {
		return false;
	}
	const text = await output('pmset', ['-g', 'batt']);
	return text.includes("'Battery Power'");
}

/** Seconds since the last keyboard or mouse input (macOS). */
export async function idleSeconds(): Promise<number> {
	if (platform() !== 'darwin') {
		return Number.POSITIVE_INFINITY;
	}
	const text = await output('ioreg', ['-c', 'IOHIDSystem', '-d', '4']);
	const match = /"HIDIdleTime" = (\d+)/.exec(text);
	return match ? Number(match[1]) / 1e9 : 0;
}
