/**
 * Runs the real relay Worker (services/relay) under `wrangler dev`: the
 * workerd runtime with local Durable Objects, built from wrangler.toml the
 * same way `wrangler deploy` builds it. No Cloudflare account is needed.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { freePort, until } from './harness.ts';

const COMPUTE = fileURLToPath(new URL('../..', import.meta.url));
const RELAY_DIR = join(COMPUTE, 'services', 'relay');
const WRANGLER = join(COMPUTE, 'node_modules', '.bin', 'wrangler');

export interface WorkerVars {
	CONTROL_URL: string;
	RELAY_SECRET: string;
	ROUTER_SECRET: string;
	NETWORK: 'test';
	FACILITATOR_URL: string;
}

export interface RunningWorker {
	url: string;
	/** Everything wrangler and the Worker printed, for failure messages. */
	output(): string;
	stop(): Promise<void>;
}

export async function startWorker(vars: WorkerVars, persistDir: string): Promise<RunningWorker> {
	const port = await freePort();
	const inspectorPort = await freePort();
	const args = ['dev', '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', String(inspectorPort), '--persist-to', persistDir, '--show-interactive-dev-session=false'];
	for (const [key, value] of Object.entries(vars)) {
		args.push('--var', `${key}:${value}`);
	}
	const child: ChildProcess = spawn(WRANGLER, args, {
		cwd: RELAY_DIR,
		env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: process.env.CI ?? '1', NO_COLOR: '1' },
		stdio: ['ignore', 'pipe', 'pipe'],
		detached: true
	});
	let log = '';
	const capture = (chunk: Buffer) => {
		log += chunk.toString();
		if (process.env.KC_TEST_LOG) {
			process.stderr.write(`[wrangler] ${chunk.toString()}`);
		}
	};
	child.stdout!.on('data', capture);
	child.stderr!.on('data', capture);
	let exited = false;
	child.on('exit', () => (exited = true));
	const url = `http://127.0.0.1:${port}`;
	const stop = async () => {
		if (exited) {
			return;
		}
		try {
			process.kill(-child.pid!, 'SIGTERM');
		} catch {
			return;
		}
		await until('wrangler to exit', () => exited, 10_000).catch(() => process.kill(-child.pid!, 'SIGKILL'));
	};
	try {
		await until(
			'the Worker to answer under wrangler dev',
			async () => {
				if (exited) {
					throw new Error(`wrangler dev exited:\n${log}`);
				}
				const health = await fetch(`${url}/health`).catch(() => null);
				return health?.ok ? health : null;
			},
			120_000,
			250
		);
	} catch (error) {
		await stop();
		throw new Error(`${(error as Error).message}\n--- wrangler output ---\n${log}`);
	}
	return { url, output: () => log, stop };
}
