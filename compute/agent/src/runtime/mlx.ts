/**
 * The MLX runtime on macOS: a private Python environment (managed with uv)
 * with mlx-lm, and one `mlx_lm.server` process per offered model, bound to
 * 127.0.0.1 only. The agent never exposes a shell or runs arbitrary code;
 * it only serves model directories it downloaded and hash-verified.
 */

import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { waitForServer, type Backend } from './openai-backend.ts';

const run = promisify(execFile);

/* Pinned lower bound; uv resolves the newest compatible release at install time. */
const MLX_LM_REQUIREMENT = 'mlx-lm>=0.26,<1';
const UV_URL = 'https://github.com/astral-sh/uv/releases/latest/download/uv-aarch64-apple-darwin.tar.gz';
const START_TIMEOUT_MS = 15 * 60_000;

export type Log = (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			const port = typeof address === 'object' && address ? address.port : 0;
			server.close(() => resolve(port));
		});
		server.on('error', reject);
	});
}

interface Running {
	process: ChildProcess;
	backend: Backend;
	ready: Promise<void>;
}

export class MlxRuntime {
	private readonly dir: string;
	private readonly running = new Map<string, Running>();
	private build: string | null = null;

	constructor(
		dataDir: string,
		private readonly log: Log
	) {
		this.dir = join(dataDir, 'runtime');
	}

	get python(): string {
		return join(this.dir, 'venv', 'bin', 'python');
	}

	isInstalled(): boolean {
		return existsSync(this.python);
	}

	/** Install uv, Python and mlx-lm into the app's data directory. Idempotent. */
	async ensureInstalled(onStep: (message: string) => void): Promise<void> {
		if (process.platform !== 'darwin' || process.arch !== 'arm64') {
			throw new Error('the MLX runtime needs a Mac with Apple Silicon');
		}
		mkdirSync(join(this.dir, 'bin'), { recursive: true });
		const uv = join(this.dir, 'bin', 'uv');
		if (!existsSync(uv)) {
			onStep('Downloading the Python package manager');
			await run('/bin/sh', ['-c', `curl -fsSL "${UV_URL}" | tar -xz -C "${join(this.dir, 'bin')}" --strip-components 1`], { timeout: 300_000 });
		}
		const env = { ...process.env, UV_PYTHON_INSTALL_DIR: join(this.dir, 'python'), UV_CACHE_DIR: join(this.dir, 'cache') };
		if (!this.isInstalled()) {
			onStep('Setting up Python');
			await run(uv, ['venv', '--python', '3.12', join(this.dir, 'venv')], { env, timeout: 600_000 });
		}
		onStep('Installing MLX');
		await run(uv, ['pip', 'install', '--python', this.python, MLX_LM_REQUIREMENT], { env, timeout: 1_200_000 });
		this.build = null;
	}

	async runtimeBuild(): Promise<string> {
		if (this.build) {
			return this.build;
		}
		try {
			const { stdout } = await run(this.python, ['-c', 'import mlx_lm, mlx.core as mx; print(mlx_lm.__version__, mx.__version__)'], { timeout: 30_000 });
			const [lm, core] = stdout.trim().split(' ');
			this.build = `mlx-lm ${lm} (mlx ${core})`;
		} catch {
			this.build = 'mlx-lm unknown';
		}
		return this.build;
	}

	/** Start (or reuse) a server for a model directory; resolves when it answers. */
	async start(modelId: string, modelPath: string): Promise<Backend> {
		const existing = this.running.get(modelId);
		if (existing) {
			await existing.ready;
			return existing.backend;
		}
		const port = await freePort();
		const child = spawn(this.python, ['-m', 'mlx_lm.server', '--model', modelPath, '--host', '127.0.0.1', '--port', String(port)], {
			stdio: ['ignore', 'ignore', 'pipe'],
			env: { ...process.env, HF_HUB_OFFLINE: '1' }
		});
		child.stderr?.on('data', (data: Buffer) => this.log('debug', `[mlx ${modelId}] ${data.toString().trim()}`));
		const backend: Backend = { baseUrl: `http://127.0.0.1:${port}/v1`, servedName: modelPath };
		const controller = new AbortController();
		child.on('exit', (code) => {
			controller.abort();
			if (this.running.get(modelId)?.process === child) {
				this.running.delete(modelId);
				this.log(code === 0 ? 'info' : 'warn', `model server for ${modelId} exited (${code})`);
			}
		});
		const ready = waitForServer(backend.baseUrl, START_TIMEOUT_MS, controller.signal);
		this.running.set(modelId, { process: child, backend, ready });
		try {
			await ready;
		} catch (error) {
			this.stop(modelId);
			throw error;
		}
		this.log('info', `serving ${modelId} on 127.0.0.1:${port}`);
		return backend;
	}

	isRunning(modelId: string): boolean {
		return this.running.has(modelId);
	}

	stop(modelId: string): void {
		const entry = this.running.get(modelId);
		if (entry) {
			this.running.delete(modelId);
			entry.process.kill('SIGTERM');
		}
	}

	stopAll(): void {
		for (const modelId of [...this.running.keys()]) {
			this.stop(modelId);
		}
	}
}
