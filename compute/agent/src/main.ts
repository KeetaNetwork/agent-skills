#!/usr/bin/env node
/**
 * keeta-compute-agent
 *
 *   app --data-dir DIR           JSON-RPC over stdin/stdout for the macOS app
 *   helper pair CODE [--control URL] [--name NAME] [--data-dir DIR]
 *   helper add-model --id ID --url URL --served-name NAME --weights DIR
 *                    [--price-in USDC] [--price-out USDC] [--context N]
 *   helper run [--data-dir DIR]
 *   helper status [--data-dir DIR]
 *   version
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { AGENT_VERSION, AgentApp } from './app.ts';
import { addHelperModel, helperStatus, pairHelper, runHelper } from './helper.ts';
import { RpcPeer } from './rpc/peer.ts';
import type { Log } from './runtime/mlx.ts';

const USAGE = `usage:
  keeta-compute-agent app --data-dir DIR
  keeta-compute-agent helper pair CODE [--control URL] [--name NAME]
  keeta-compute-agent helper add-model --id ID --url URL --served-name NAME --weights DIR [--price-in USDC] [--price-out USDC] [--context N]
  keeta-compute-agent helper run
  keeta-compute-agent helper status
  keeta-compute-agent version`;

function defaultDataDir(): string {
	return process.env.KEETA_COMPUTE_HOME ?? join(homedir(), '.keeta-compute');
}

async function runApp(dataDir: string): Promise<void> {
	/* stdout is the RPC channel; anything else goes to stderr. */
	console.log = console.error;
	let peer: RpcPeer | null = null;
	const app = new AgentApp({
		dataDir,
		signDigest: async (digest) => (await peer!.request<{ signature: string }>('signer.signDigest', { digest })).signature,
		notify: (method, params) => peer?.notify(method, params)
	});
	peer = new RpcPeer(process.stdin, process.stdout, app.handlers() as Record<string, (params: unknown) => Promise<unknown>>, () => {
		app.shutdown();
		process.exit(0);
	});
	for (const signal of ['SIGTERM', 'SIGINT'] as const) {
		process.on(signal, () => {
			app.shutdown();
			process.exit(0);
		});
	}
}

const stderrLog: Log = (level, message) => {
	if (level !== 'debug' || process.env.KEETA_COMPUTE_DEBUG) {
		process.stderr.write(`${new Date().toISOString()} ${level} ${message}\n`);
	}
};

async function runHelperCommand(argv: string[]): Promise<void> {
	const [command, ...rest] = argv;
	const { values, positionals } = parseArgs({
		args: rest,
		allowPositionals: true,
		options: {
			'data-dir': { type: 'string' },
			control: { type: 'string' },
			name: { type: 'string' },
			id: { type: 'string' },
			url: { type: 'string' },
			'served-name': { type: 'string' },
			weights: { type: 'string' },
			'price-in': { type: 'string' },
			'price-out': { type: 'string' },
			context: { type: 'string' }
		}
	});
	const dataDir = values['data-dir'] ?? defaultDataDir();
	const io = { out: (line: string) => process.stdout.write(`${line}\n`) };
	switch (command) {
		case 'pair': {
			const code = positionals[0];
			if (!code) {
				throw new Error('pair needs the code shown on your Mac');
			}
			await pairHelper({ dataDir, code, ...(values.control ? { controlUrl: values.control } : {}), ...(values.name ? { name: values.name } : {}) }, io);
			return;
		}
		case 'add-model': {
			if (!values.id || !values.url || !values['served-name'] || !values.weights) {
				throw new Error('add-model needs --id, --url, --served-name and --weights');
			}
			await addHelperModel(
				{
					dataDir,
					id: values.id,
					url: values.url,
					servedName: values['served-name'],
					weights: values.weights,
					...(values['price-in'] ? { priceIn: values['price-in'] } : {}),
					...(values['price-out'] ? { priceOut: values['price-out'] } : {}),
					...(values.context ? { context: Number(values.context) } : {}),
					...(values.name ? { name: values.name } : {})
				},
				io
			);
			return;
		}
		case 'run': {
			const provider = await runHelper({ dataDir }, io, stderrLog);
			io.out('Helper running. Press Ctrl-C to stop.');
			for (const signal of ['SIGTERM', 'SIGINT'] as const) {
				process.on(signal, () => {
					provider.stop();
					process.exit(0);
				});
			}
			await new Promise(() => undefined);
			return;
		}
		case 'status':
			io.out(JSON.stringify(helperStatus(dataDir), null, 2));
			return;
		default:
			throw new Error(USAGE);
	}
}

async function main(argv: string[]): Promise<void> {
	const [command, ...rest] = argv;
	switch (command) {
		case 'app': {
			const { values } = parseArgs({ args: rest, options: { 'data-dir': { type: 'string' } } });
			await runApp(values['data-dir'] ?? defaultDataDir());
			return;
		}
		case 'helper':
			await runHelperCommand(rest);
			return;
		case 'version':
		case '--version':
			process.stdout.write(`${AGENT_VERSION}\n`);
			return;
		default:
			process.stderr.write(`${USAGE}\n`);
			process.exit(command ? 2 : 0);
	}
}

main(process.argv.slice(2)).catch((error: Error) => {
	process.stderr.write(`error: ${error.message}\n`);
	process.exit(1);
});
