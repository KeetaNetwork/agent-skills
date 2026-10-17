/**
 * The MLX runtime on macOS: a private Python environment (managed with uv)
 * with mlx-lm, and one `mlx_lm.server` process per offered model, bound to
 * 127.0.0.1 only. It never exposes a shell or runs arbitrary code; it only
 * serves model directories the provider downloaded and hash-verified.
 */

import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { promisify } from 'node:util';
import type { Log } from '@keeta-compute/protocol';
import { waitForServer, type Backend } from '@keeta-compute/runtime-openai';
import { MLX_REQUIREMENTS_LOCK } from './mlx-lock.ts';

const run = promisify(execFile);

/*
 * Everything the runtime executes is pinned: uv by version and SHA-256 (checked
 * before it is unpacked), Python by uv's own pinned download list, and mlx-lm
 * with its dependencies by a hash-locked requirements file.
 */
const UV_VERSION = '0.9.5';
const UV_URL = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-aarch64-apple-darwin.tar.gz`;
const UV_SHA256 = 'dc098ff224d78ed418e121fd374f655949d2c7031a70f6f6604eaf016a130433';
const PYTHON_VERSION = '3.12';
const START_TIMEOUT_MS = 15 * 60_000;

/*
 * Runs `mlx_lm.server` on port 0, so the kernel picks a free port as the
 * server binds it: a port chosen first and bound later would be free in
 * between, and any local account could take it and receive buyer prompts.
 * mlx_lm.server logs only the port it was given, so this reports the one
 * it got, once it listens, on fd 3: a pipe only the runtime reads.
 */
const SERVE = [
	'import http.server, os',
	'activate = http.server.HTTPServer.server_activate',
	'def server_activate(self):',
	'    activate(self)',
	"    os.write(3, b'%d\\n' % self.server_address[1])",
	'    os.close(3)',
	'http.server.HTTPServer.server_activate = server_activate',
	'from mlx_lm.server import main',
	'main()'
].join('\n');

/** The port a server started with SERVE reports on its fd 3. */
function reportedPort(pipe: Readable, timeoutMs: number): Promise<number> {
	return new Promise((resolve, reject) => {
		let text = '';
		const timer = setTimeout(() => reject(new Error('model server did not start in time')), timeoutMs);
		pipe.setEncoding('utf8');
		pipe.on('data', (chunk: string) => {
			text += chunk;
			if (text.includes('\n') || text.length > 6) {
				clearTimeout(timer);
				const port = Number(/^\d{1,5}\n/.exec(text)?.[0]);
				if (port > 0 && port < 65536) {
					resolve(port);
				} else {
					reject(new Error('model server reported no port'));
				}
			}
		});
		pipe.on('end', () => {
			clearTimeout(timer);
			reject(new Error('model server exited before it was listening'));
		});
	});
}

interface Running {
	process: ChildProcess;
	ready: Promise<Backend>;
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
			const response = await fetch(UV_URL);
			if (!response.ok) {
				throw new Error(`could not download uv ${UV_VERSION}: HTTP ${response.status}`);
			}
			const archive = Buffer.from(await response.arrayBuffer());
			const digest = createHash('sha256').update(archive).digest('hex');
			if (digest !== UV_SHA256) {
				throw new Error(`uv ${UV_VERSION} failed its checksum (got ${digest}); not installing it`);
			}
			const tarball = join(this.dir, 'bin', 'uv.tar.gz');
			writeFileSync(tarball, archive);
			try {
				await run('/usr/bin/tar', ['-xzf', tarball, '-C', join(this.dir, 'bin'), '--strip-components', '1'], { timeout: 120_000 });
			} finally {
				rmSync(tarball, { force: true });
			}
		}
		const env = { ...process.env, UV_PYTHON_INSTALL_DIR: join(this.dir, 'python'), UV_CACHE_DIR: join(this.dir, 'cache'), UV_PYTHON_PREFERENCE: 'only-managed' };
		if (!this.isInstalled()) {
			onStep('Setting up Python');
			await run(uv, ['venv', '--python', PYTHON_VERSION, join(this.dir, 'venv')], { env, timeout: 600_000 });
		}
		onStep('Installing MLX');
		const lockFile = join(this.dir, 'mlx-requirements.txt');
		writeFileSync(lockFile, MLX_REQUIREMENTS_LOCK);
		await run(uv, ['pip', 'install', '--python', this.python, '--require-hashes', '--no-deps', '-r', lockFile], { env, timeout: 1_200_000 });
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
			return existing.ready;
		}
		const child = spawn(this.python, ['-c', SERVE, '--model', modelPath, '--host', '127.0.0.1', '--port', '0'], {
			stdio: ['ignore', 'ignore', 'pipe', 'pipe'],
			env: { ...process.env, HF_HUB_OFFLINE: '1' }
		});
		child.stderr?.on('data', (data: Buffer) => this.log('debug', `[mlx ${modelId}] ${data.toString().trim()}`));
		const controller = new AbortController();
		child.on('exit', (code) => {
			controller.abort();
			if (this.running.get(modelId)?.process === child) {
				this.running.delete(modelId);
				this.log(code === 0 ? 'info' : 'warn', `model server for ${modelId} exited (${code})`);
			}
		});
		const ready = (async () => {
			const deadline = Date.now() + START_TIMEOUT_MS;
			const port = await reportedPort(child.stdio[3] as Readable, START_TIMEOUT_MS);
			const backend: Backend = { baseUrl: `http://127.0.0.1:${port}/v1`, servedName: modelPath };
			await waitForServer(backend.baseUrl, deadline - Date.now(), controller.signal);
			this.log('info', `serving ${modelId} on 127.0.0.1:${port}`);
			return backend;
		})();
		this.running.set(modelId, { process: child, ready });
		try {
			return await ready;
		} catch (error) {
			this.stop(modelId);
			throw error;
		}
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
