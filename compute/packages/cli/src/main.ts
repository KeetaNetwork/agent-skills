#!/usr/bin/env node
/**
 * keeta-compute-agent
 *
 * The macOS app runs `app` and drives the agent over JSON-RPC. On Linux the
 * same agent is a full node from the command line (cli.ts): its own
 * encrypted operator wallet, provider loop, local buyer endpoint, models and
 * helper fleet. `helper ...` keeps the satellite mode: a provider paired with
 * a Mac or a Linux node that pays that node's operator.
 *
 * Every command takes --data-dir DIR (default $KEETA_COMPUTE_HOME or
 * ~/.keeta-compute). The wallet passphrase comes from
 * $KEETA_COMPUTE_PASSPHRASE or a hidden prompt on the terminal.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { AGENT_VERSION, AgentApp, RpcPeer } from '@keeta-compute/agent';
import type { Log } from '@keeta-compute/protocol';
import * as cli from './cli.ts';
import { addHelperModel, helperStatus, pairHelper, runHelper } from './helper.ts';
import { selfTest } from './self-test.ts';

const USAGE = `usage: keeta-compute-agent COMMAND [--data-dir DIR]

Linux node (own wallet, provides and buys):
  init [--network test|main] [--control URL] [--relay URL] [--name NAME] [--restore]
  status [--json]
  config [--network test|main] [--control URL] [--relay URL] [--name NAME]
  wallet                                   balances (credits, stablecoins, KTA) and addresses
  wallet buy-credits AMOUNT [--with KUSD|KEUR|KJPY|KMXN|KCAD|KAED|KGBP|USDC] [--keep]
                                           buy credits with a stablecoin; they go to the agent budget unless --keep
  wallet sell-credits AMOUNT [--to KUSD|...|USDC]
                                           cash out credits for a stablecoin
  wallet send TO AMOUNT [--asset credits|kta|KUSD|...] [--memo TEXT]
  wallet fund-budget AMOUNT [--asset credits|kta|KUSD|...]
  wallet drain-budget AMOUNT [--asset credits|kta|KUSD|...]
  wallet test-funds
  models list
  models add --id ID --url URL --served-name NAME --weights DIR [--price-in CREDITS] [--price-out CREDITS] [--context N] [--name NAME]
  models offer ID [--on|--off] [--price-in CREDITS] [--price-out CREDITS] [--access public|allowlist|default] [--allow KEY,...]
  models remove ID
  provide [--on|--off] [--max-jobs N] [--access public|allowlist] [--allow KEY,...]
  buy [--per-request-max CREDITS] [--daily-max CREDITS]
  token [--rotate]
  pair
  fleet list | approve PAIRING_ID | reject PAIRING_ID | revoke NODE_KEY
  run

Linux helper (paired satellite, pays its master's operator):
  helper pair CODE [--control URL] [--name NAME]
  helper add-model --id ID --url URL --served-name NAME --weights DIR [--price-in CREDITS] [--price-out CREDITS] [--context N]
  helper run
  helper status

macOS app:
  app

  version
  self-test                                checks this build can run the agent (no network)

Prices and limits are in Keeta Compute Credits per million tokens; one credit is one US dollar.
The passphrase is read from KEETA_COMPUTE_PASSPHRASE or asked for on the terminal.`;

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
				throw new Error('pair needs the code shown on your Mac or Linux node');
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

/* ------------------------------------------------------------ terminal */

/** Read one line from the terminal without echoing it. */
function readHidden(prompt: string): Promise<string> {
	const stdin = process.stdin;
	if (!stdin.isTTY) {
		return Promise.reject(new Error('no terminal to ask for the passphrase on; set KEETA_COMPUTE_PASSPHRASE'));
	}
	process.stderr.write(prompt);
	return new Promise((resolve, reject) => {
		let value = '';
		stdin.setRawMode(true);
		stdin.resume();
		stdin.setEncoding('utf8');
		const done = (error?: Error) => {
			stdin.setRawMode(false);
			stdin.pause();
			stdin.off('data', onData);
			process.stderr.write('\n');
			if (error) {
				reject(error);
			} else {
				resolve(value);
			}
		};
		const onData = (chunk: string) => {
			for (const char of chunk) {
				if (char === '\r' || char === '\n' || char === '\u0004') {
					done();
					return;
				}
				if (char === '\u0003') {
					done(new Error('cancelled'));
					return;
				}
				if (char === '\u007f' || char === '\b') {
					value = value.slice(0, -1);
				} else {
					value += char;
				}
			}
		};
		stdin.on('data', onData);
	});
}

/** Read one line from stdin, for a recovery phrase piped in. */
async function readLine(): Promise<string> {
	let text = '';
	process.stdin.setEncoding('utf8');
	for await (const chunk of process.stdin) {
		text += chunk as string;
		if (text.includes('\n')) {
			break;
		}
	}
	return text.split('\n')[0]!;
}

async function askPassphrase(confirm: boolean): Promise<string> {
	const fromEnv = process.env.KEETA_COMPUTE_PASSPHRASE;
	if (fromEnv) {
		return fromEnv;
	}
	const first = await readHidden(confirm ? 'New wallet passphrase: ' : 'Wallet passphrase: ');
	if (confirm && (await readHidden('Repeat the passphrase: ')) !== first) {
		throw new Error('the passphrases do not match');
	}
	return first;
}

async function askYesNo(question: string): Promise<boolean> {
	process.stderr.write(`${question} [y/N] `);
	const answer = await readLine();
	return /^y(es)?$/i.test(answer.trim());
}

function terminalIO(): cli.CliIO {
	return {
		out: (line) => process.stdout.write(`${line}\n`),
		log: stderrLog,
		passphrase: askPassphrase,
		recoveryPhrase: () => (process.stdin.isTTY ? readHidden('Recovery phrase (24 words): ') : readLine()),
		...(process.stdin.isTTY ? { confirm: askYesNo } : {})
	};
}

function waitForSignal(stop: () => void): Promise<never> {
	for (const signal of ['SIGTERM', 'SIGINT'] as const) {
		process.on(signal, () => {
			stop();
			process.exit(0);
		});
	}
	return new Promise(() => undefined);
}

/* ----------------------------------------------------------- Linux node */

async function runNodeCommand(command: string, argv: string[]): Promise<void> {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			'data-dir': { type: 'string' },
			network: { type: 'string' },
			control: { type: 'string' },
			relay: { type: 'string' },
			name: { type: 'string' },
			restore: { type: 'boolean' },
			json: { type: 'boolean' },
			asset: { type: 'string' },
			with: { type: 'string' },
			to: { type: 'string' },
			keep: { type: 'boolean' },
			memo: { type: 'string' },
			id: { type: 'string' },
			url: { type: 'string' },
			'served-name': { type: 'string' },
			weights: { type: 'string' },
			'price-in': { type: 'string' },
			'price-out': { type: 'string' },
			context: { type: 'string' },
			on: { type: 'boolean' },
			off: { type: 'boolean' },
			access: { type: 'string' },
			allow: { type: 'string' },
			'max-jobs': { type: 'string' },
			'per-request-max': { type: 'string' },
			'daily-max': { type: 'string' },
			rotate: { type: 'boolean' }
		}
	});
	const dataDir = values['data-dir'] ?? defaultDataDir();
	const io = terminalIO();
	const [sub, ...args] = positionals;
	if (values.on && values.off) {
		throw new Error('pass --on or --off, not both');
	}
	const enabled = values.on ? true : values.off ? false : undefined;
	const configArgs = {
		dataDir,
		...(values.network ? { network: values.network } : {}),
		...(values.control ? { controlUrl: values.control } : {}),
		...(values.relay ? { relayUrl: values.relay } : {}),
		...(values.name ? { name: values.name } : {})
	};
	switch (command) {
		case 'init':
			await cli.init({ ...configArgs, ...(values.restore ? { restore: true } : {}) }, io);
			return;
		case 'config':
			await cli.config(configArgs, io);
			return;
		case 'status':
			await cli.status({ dataDir, ...(values.json ? { json: true } : {}) }, io);
			return;
		case 'wallet': {
			const asset = values.asset ? { asset: values.asset } : {};
			switch (sub) {
				case undefined:
				case 'show':
					await cli.walletShow({ dataDir }, io);
					return;
				case 'send':
					if (!args[0] || !args[1]) {
						throw new Error('wallet send needs TO and AMOUNT');
					}
					await cli.walletSend({ dataDir, to: args[0], amount: args[1], ...asset, ...(values.memo ? { memo: values.memo } : {}) }, io);
					return;
				case 'fund-budget':
					await cli.walletFundBudget({ dataDir, amount: args[0] ?? '', ...asset }, io);
					return;
				case 'drain-budget':
					await cli.walletDrainBudget({ dataDir, amount: args[0] ?? '', ...asset }, io);
					return;
				case 'buy-credits':
					await cli.walletBuyCredits({ dataDir, amount: args[0] ?? '', ...(values.with ? { with: values.with } : {}), ...(values.keep ? { keep: true } : {}) }, io);
					return;
				case 'sell-credits':
					await cli.walletSellCredits({ dataDir, amount: args[0] ?? '', ...(values.to ? { to: values.to } : {}) }, io);
					return;
				case 'test-funds':
					await cli.walletTestFunds({ dataDir }, io);
					return;
			}
			break;
		}
		case 'models':
			switch (sub) {
				case undefined:
				case 'list':
					cli.modelsList({ dataDir }, io);
					return;
				case 'add':
					if (!values.id || !values.url || !values['served-name'] || !values.weights) {
						throw new Error('models add needs --id, --url, --served-name and --weights');
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
				case 'offer':
					if (!args[0]) {
						throw new Error('models offer needs the model id');
					}
					await cli.modelsOffer(
						{
							dataDir,
							modelId: args[0],
							...(enabled !== undefined ? { offered: enabled } : {}),
							...(values['price-in'] ? { priceIn: values['price-in'] } : {}),
							...(values['price-out'] ? { priceOut: values['price-out'] } : {}),
							...(values.access ? { access: values.access } : {}),
							...(values.allow ? { allow: values.allow } : {})
						},
						io
					);
					return;
				case 'remove':
					if (!args[0]) {
						throw new Error('models remove needs the model id');
					}
					await cli.modelsRemove({ dataDir, modelId: args[0] }, io);
					return;
			}
			break;
		case 'provide':
			await cli.provide(
				{
					dataDir,
					...(enabled !== undefined ? { enabled } : {}),
					...(values['max-jobs'] ? { maxJobs: values['max-jobs'] } : {}),
					...(values.access ? { access: values.access } : {}),
					...(values.allow ? { allow: values.allow } : {})
				},
				io
			);
			return;
		case 'buy':
			await cli.buy({ dataDir, ...(values['per-request-max'] ? { perRequestMax: values['per-request-max'] } : {}), ...(values['daily-max'] ? { dailyMax: values['daily-max'] } : {}) }, io);
			return;
		case 'token':
			await cli.token({ dataDir, ...(values.rotate ? { rotate: true } : {}) }, io);
			return;
		case 'pair':
			await cli.pair({ dataDir }, io);
			return;
		case 'fleet':
			await cli.fleet({ dataDir, action: sub ?? 'list', ...(args[0] ? { target: args[0] } : {}) }, io);
			return;
		case 'run': {
			const app = await cli.run({ dataDir }, io);
			io.out('Running. Press Ctrl-C to stop.');
			await waitForSignal(() => app.shutdown());
			return;
		}
	}
	throw new Error(USAGE);
}

const NODE_COMMANDS = new Set(['init', 'config', 'status', 'wallet', 'models', 'provide', 'buy', 'token', 'pair', 'fleet', 'run']);

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
		case 'self-test':
			await selfTest((line) => process.stdout.write(`${line}\n`));
			/* initialize starts the provider loop and timers; the check is done. */
			process.exit(0);
		default:
			if (command && NODE_COMMANDS.has(command)) {
				await runNodeCommand(command, rest);
				/* One-shot commands may leave a balance read in flight; do not wait for it. */
				process.exit(0);
			}
			process.stderr.write(`${USAGE}\n`);
			process.exit(command && command !== 'help' && command !== '--help' ? 2 : 0);
	}
}

main(process.argv.slice(2)).catch((error: Error) => {
	process.stderr.write(`error: ${error.message}\n`);
	process.exit(1);
});
