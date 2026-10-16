/**
 * End to end, in one process, with no network: the control plane (memory
 * store), a Node emulation of the relay that reuses the Worker's checks, two
 * agents (a Mac provider and a Mac buyer), a paired Linux helper, a Linux CLI
 * node with its own wallet, a fake OpenAI-compatible model server and a fake
 * ledger. Every signature is real: the Mac node keys are P-256 keys emulating
 * the Secure Enclave, the Mac operator comes from passkey PRF entropy, the
 * Linux operator from its encrypted wallet file, and buyers pay from their
 * budget keys.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { p256 } from '@noble/curves/p256';
import { fromHex, randomId, sseData, sseEvent, toHex, type HardwareProfile, type JobEnvelope, type ProviderFrame } from '@keeta-compute/protocol';
import { Account } from '@keeta-compute/protocol/keeta';
import { startServer } from '../services/control/src/server.ts';
import { checkEnvelope, checkProviderToken } from '../services/relay/src/relay.ts';
import { AgentApp } from '../agent/src/app.ts';
import * as cli from '../agent/src/cli.ts';
import { addHelperModel, pairHelper, runHelper } from '../agent/src/helper.ts';
import type { Balances, Ledger } from '../agent/src/ledger.ts';
import type { ModelManager } from '../agent/src/models/manager.ts';

const GB = 1024 ** 3;
const RELAY_SECRET = 'relay-secret-for-tests';
const ROUTER_SECRET = 'router-secret-for-tests';
const MODEL = 'llama-3.2-3b';

/* ------------------------------------------------------------ helpers */

function listen(server: Server): Promise<string> {
	return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
}

async function until<T>(what: string, probe: () => Promise<T | null | undefined | false> | T | null | undefined | false, timeoutMs = 10_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await probe();
		if (value) {
			return value;
		}
		if (Date.now() > deadline) {
			throw new Error(`timed out waiting for ${what}`);
		}
		await new Promise((r) => setTimeout(r, 25));
	}
}

async function readBody(req: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) {
		chunks.push(chunk as Buffer);
	}
	return Buffer.concat(chunks).toString('utf8');
}

/* ------------------------------------------------- fake model server */

function fakeModelServer(): Server {
	return createServer(async (req, res) => {
		if (req.method === 'GET' && req.url === '/v1/models') {
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake' }] }));
			return;
		}
		if (req.method === 'POST' && req.url === '/v1/chat/completions') {
			const body = JSON.parse(await readBody(req)) as { model: string; stream: boolean; messages: Array<{ content: string }> };
			assert.equal(body.model, 'fake');
			assert.equal(body.stream, true);
			const slow = body.messages.some((m) => m.content.includes('slowly'));
			res.writeHead(200, { 'content-type': 'text/event-stream' });
			for (const piece of ['Hello', ' from', ' Keeta']) {
				res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] })}\n\n`);
				if (slow) {
					/* Stall after each piece until the caller hangs up. */
					await new Promise<void>((resolve) => {
						const timer = setTimeout(resolve, 5_000);
						res.once('close', () => (clearTimeout(timer), resolve()));
					});
					if (res.destroyed) {
						return;
					}
				}
			}
			res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
			res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } })}\n\n`);
			res.end('data: [DONE]\n\n');
			return;
		}
		res.writeHead(404).end();
	});
}

/* ------------------------------------------------------- fake ledger */

interface Send {
	hash: string;
	from: string;
	to: string;
	amount: bigint;
	asset: 'usdc' | 'kta';
	reference?: string;
}

class FakeLedger implements Ledger {
	readonly sends: Send[] = [];

	async balances(): Promise<Balances> {
		return { usdc: 10_000_000n, kta: 10n ** 18n };
	}

	async send(from: InstanceType<typeof Account>, to: string, amount: bigint, asset: 'usdc' | 'kta', reference?: string): Promise<string> {
		const hash = toHex(crypto.getRandomValues(new Uint8Array(32))).toUpperCase();
		this.sends.push({ hash, from: from.publicKeyString.get(), to, amount, asset, ...(reference ? { reference } : {}) });
		return hash;
	}

	async requestTestFunds(): Promise<string> {
		return 'ok';
	}
}

/* ------------------------------------------------ relay emulation */

/** Stands in for the Worker + Durable Object, using the Worker's own checks. */
class RelayEmulator {
	readonly sockets = new Map<string, FakeSocket>();
	lastEnvelope: JobEnvelope | null = null;
	private readonly pending = new Map<string, ServerResponse>();
	readonly server = createServer((req, res) => void this.handle(req, res));
	url = '';

	async start() {
		this.url = await listen(this.server);
	}

	async connect(socket: FakeSocket, url: URL): Promise<boolean> {
		const nodeKey = url.searchParams.get('nodeKey');
		const problem = await checkProviderToken(RELAY_SECRET, nodeKey, url.searchParams.get('exp'), url.searchParams.get('token'), Date.now());
		if (problem) {
			return false;
		}
		this.sockets.get(nodeKey!)?.close();
		this.sockets.set(nodeKey!, socket);
		socket.nodeKey = nodeKey!;
		return true;
	}

	disconnect(socket: FakeSocket) {
		if (this.sockets.get(socket.nodeKey) === socket) {
			this.sockets.delete(socket.nodeKey);
		}
	}

	fromProvider(raw: string) {
		const frame = JSON.parse(raw) as ProviderFrame;
		if (frame.type === 'pong') {
			return;
		}
		const res = this.pending.get(frame.id);
		if (!res) {
			return;
		}
		if (frame.type === 'chunk') {
			res.write(sseData(frame.data));
		} else {
			this.pending.delete(frame.id);
			res.end(frame.type === 'receipt' ? sseEvent('keeta.receipt', frame.receipt) : sseEvent('keeta.error', { code: frame.code, message: frame.message }));
		}
	}

	private async handle(req: IncomingMessage, res: ServerResponse) {
		const run = /^\/v1\/jobs\/([A-Za-z0-9_]+)\/run$/.exec(req.url ?? '');
		if (!run || req.method !== 'POST') {
			res.writeHead(404).end();
			return;
		}
		const envelope = JSON.parse(await readBody(req)) as JobEnvelope;
		const problem = await checkEnvelope(RELAY_SECRET, run[1]!, envelope, Date.now());
		if (problem) {
			res.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: 'forbidden', message: problem } }));
			return;
		}
		const socket = this.sockets.get(envelope.ticket.ticket.nodeKey);
		if (!socket) {
			res.writeHead(503).end();
			return;
		}
		this.lastEnvelope = envelope;
		const id = randomId('run');
		this.pending.set(id, res);
		/* Like the Durable Object: a buyer hanging up cancels the job on the provider. */
		res.on('close', () => {
			if (this.pending.delete(id)) {
				socket.deliver(JSON.stringify({ type: 'cancel', id }));
			}
		});
		res.writeHead(200, { 'content-type': 'text/event-stream' });
		socket.deliver(JSON.stringify({ type: 'job', id, envelope }));
	}
}

let relay: RelayEmulator;

/** WebSocket the agents use; connects to the relay emulator in memory. */
class FakeSocket extends EventTarget {
	readyState = 0;
	nodeKey = '';

	constructor(url: string) {
		super();
		void relay.connect(this, new URL(url)).then((ok) => {
			if (this.readyState !== 0) {
				return;
			}
			this.readyState = ok ? 1 : 3;
			this.dispatchEvent(new Event(ok ? 'open' : 'error'));
		});
	}

	send(data: string) {
		if (this.readyState === 1) {
			relay.fromProvider(data);
		}
	}

	deliver(data: string) {
		this.dispatchEvent(new MessageEvent('message', { data }));
	}

	close() {
		if (this.readyState === 3) {
			return;
		}
		this.readyState = 3;
		relay.disconnect(this);
		this.dispatchEvent(new Event('close'));
	}
}

/* ------------------------------------------------------------ agents */

type Handlers = Record<string, (params: unknown) => Promise<any>>;

const mac64: HardwareProfile = { os: 'macos', osVersion: '15.4', chip: 'Apple M4 Max', memoryBytes: 64 * GB, freeDiskBytes: 500 * GB };
const linux128: HardwareProfile = { os: 'linux', osVersion: 'Ubuntu 24.04', chip: 'NVIDIA H100', memoryBytes: 128 * GB, freeDiskBytes: 2000 * GB };

function macAgent(dataDir: string, ledger: Ledger) {
	const enclaveKey = p256.utils.randomPrivateKey();
	const app = new AgentApp({
		dataDir,
		signDigest: async (digestHex) => toHex(p256.sign(fromHex(digestHex), enclaveKey, { prehash: false, lowS: true }).toCompactRawBytes()),
		notify: () => undefined,
		ledgerFor: () => ledger,
		WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
		buyerPort: 0,
		hardware: mac64,
		localConditions: async () => ({ onBattery: false, idleSeconds: 1e9 }),
		noRuntime: true
	});
	return { app, rpc: app.handlers() as unknown as Handlers, nodePublicKey: toHex(p256.getPublicKey(enclaveKey, true)) };
}

/* -------------------------------------------------------------- test */

test('a buyer runs a job on a Mac provider and a paired Linux helper, and pays each receipt', async (t) => {
	const dirs: string[] = [];
	const tmp = (name: string) => {
		const dir = mkdtempSync(join(tmpdir(), `kc-${name}-`));
		dirs.push(dir);
		return dir;
	};
	const cleanups: Array<() => void> = [];
	t.after(() => {
		for (const cleanup of cleanups.reverse()) {
			cleanup();
		}
		for (const dir of dirs) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	const model = fakeModelServer();
	const modelUrl = `${await listen(model)}/v1`;
	cleanups.push(() => model.close());

	relay = new RelayEmulator();
	await relay.start();
	cleanups.push(() => relay.server.close());

	const ledger = new FakeLedger();
	const control = await startServer({
		port: 0,
		env: {
			COORDINATOR_SEED: Account.generateRandomSeed({ asString: true }) as string,
			RELAY_SECRET,
			ROUTER_SECRET,
			RELAY_URL: relay.url,
			ALLOW_SMALL_PROVIDERS: 'true'
		},
		verifyPayment: async (args) => {
			const send = ledger.sends.find((s) => s.hash === args.blockHash);
			if (!send) {
				return 'pending';
			}
			return send.from === args.from && send.to === args.to && send.asset === 'usdc' && send.amount >= args.minAmount && send.reference === args.reference ? 'confirmed' : 'rejected';
		},
		balanceOf: async () => (await ledger.balances()).usdc
	});
	cleanups.push(() => control.server.close());

	const init = (nodePublicKey: string, machineName: string) => ({ network: 'test', controlUrl: control.url, relayUrl: relay.url, nodePublicKey, appVersion: 'test', machineName });

	/* Provider Mac: wallet from passkey entropy, one model, providing on. */
	const provider = macAgent(tmp('provider'), ledger);
	cleanups.push(() => provider.app.shutdown());
	await provider.rpc['agent.initialize']!(init(provider.nodePublicKey, 'Studio'));
	(provider.app as unknown as { models: ModelManager }).models.addExternal({
		modelId: MODEL,
		name: 'Llama 3.2 3B',
		backend: { baseUrl: modelUrl, servedName: 'fake' },
		weightsHash: 'a'.repeat(64),
		sizeBytes: 1,
		path: '/dev/null',
		contextLength: 8192,
		price: { inputPerMillion: '100000', outputPerMillion: '400000' }
	});
	await provider.rpc['provider.setPolicy']!({ enabled: true });
	const { operator } = await provider.rpc['wallet.setOperator']!({ entropy: toHex(crypto.getRandomValues(new Uint8Array(32))) });
	assert.match(operator, /^keeta_/);
	await until('the Mac provider to come online', async () => (await provider.rpc['provider.status']!({})).state === 'online');
	const macKey = (await provider.rpc['agent.state']!({})).nodeKey as string;
	assert.ok(relay.sockets.has(macKey));

	/* Buyer Mac: the local OpenAI-compatible endpoint. */
	const buyer = macAgent(tmp('buyer'), ledger);
	cleanups.push(() => buyer.app.shutdown());
	await buyer.rpc['agent.initialize']!(init(buyer.nodePublicKey, 'Laptop'));
	const buyerStatus = await buyer.rpc['buyer.status']!({});
	const spendKey = (await buyer.rpc['wallet.refresh']!({})).spend as string;

	const listed = await fetch(`${buyerStatus.endpoint}/models`, { headers: { authorization: `Bearer ${buyerStatus.token}` } });
	assert.equal(listed.status, 200);
	assert.ok(((await listed.json()) as { data: Array<{ id: string }> }).data.some((m) => m.id === MODEL));

	const refused = await fetch(`${buyerStatus.endpoint}/models`, { headers: { authorization: `Bearer ${buyerStatus.token}`, origin: 'https://evil.example' } });
	assert.equal(refused.status, 403, 'web pages cannot call the local endpoint');

	const complete = async () => {
		const response = await fetch(`${buyerStatus.endpoint}/chat/completions`, {
			method: 'POST',
			headers: { authorization: `Bearer ${buyerStatus.token}`, 'content-type': 'application/json' },
			body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'Say hello' }], max_tokens: 64 })
		});
		const body = (await response.json()) as { choices: Array<{ message: { content: string } }>; usage: { completion_tokens: number } };
		assert.equal(response.status, 200, JSON.stringify(body));
		return { jobId: response.headers.get('x-keeta-job')!, body };
	};

	const first = await complete();
	assert.equal(first.body.choices[0]!.message.content, 'Hello from Keeta');
	assert.equal(first.body.usage.completion_tokens, 3);

	const paidFirst = await until('the first job to be paid', async () => {
		const job = await control.store.getJob(first.jobId);
		return job?.status === 'paid' ? job : null;
	});
	assert.equal(paidFirst.nodeKey, macKey);
	assert.equal(paidFirst.payTo, operator);
	const firstSend = ledger.sends.find((s) => s.reference === first.jobId)!;
	assert.equal(firstSend.from, spendKey);
	assert.equal(firstSend.to, operator);
	/* 12 in at 0.10/M + 3 out at 0.40/M rounds up to 3 base units. */
	assert.equal(firstSend.amount, 3n);
	assert.equal((await buyer.rpc['buyer.status']!({})).unpaid, 0);

	/* Replaying a ticket that already ran is refused by the provider. */
	const replay = await fetch(`${relay.url}/v1/jobs/${first.jobId}/run`, { method: 'POST', body: JSON.stringify(relay.lastEnvelope) });
	assert.match(await replay.text(), /ticket_used/);

	/* A request over the per-request limit is refused and its ticket handed back. */
	await buyer.rpc['buyer.setPolicy']!({ perRequestMax: '1' });
	const tooDear = await fetch(`${buyerStatus.endpoint}/chat/completions`, {
		method: 'POST',
		headers: { authorization: `Bearer ${buyerStatus.token}`, 'content-type': 'application/json' },
		body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'Say hello' }], max_tokens: 4000 })
	});
	assert.equal(tooDear.status, 402);
	const [cancelled] = await control.store.listJobsByBuyer(spendKey, 1);
	assert.ok(cancelled!.handedBackAt, 'the ticket is handed back');
	assert.equal((await control.store.getProvider(macKey))!.load.active, 0, 'the refused job does not hold the provider');
	await buyer.rpc['buyer.setPolicy']!({ perRequestMax: '250000' });

	/* A caller that hangs up mid-answer still pays for the text it received, and only for that. */
	const hangUp = new AbortController();
	const streaming = await fetch(`${buyerStatus.endpoint}/chat/completions`, {
		method: 'POST',
		headers: { authorization: `Bearer ${buyerStatus.token}`, 'content-type': 'application/json' },
		body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'Say hello slowly' }], max_tokens: 64, stream: true }),
		signal: hangUp.signal
	});
	const hungUpJob = streaming.headers.get('x-keeta-job')!;
	const reader = streaming.body!.getReader();
	let seen = '';
	while (!seen.includes('Hello')) {
		seen += new TextDecoder().decode((await reader.read()).value);
	}
	hangUp.abort();
	const paidHungUp = await until('the hung-up job to be paid', async () => {
		const job = await control.store.getJob(hungUpJob);
		return job?.status === 'paid' ? job : null;
	}, 20_000);
	assert.equal(paidHungUp.receipt!.receipt.finishReason, 'cancelled');
	assert.equal(paidHungUp.receipt!.receipt.outputTokens, 1, 'billed only for the one piece delivered');
	assert.equal((await buyer.rpc['buyer.status']!({})).unpaid, 0);

	/* Linux helper: pair by code, approve on the Mac, serve the same model. */
	const helperDir = tmp('helper');
	const weightsDir = tmp('weights');
	mkdirSync(join(weightsDir, 'shards'));
	writeFileSync(join(weightsDir, 'shards', 'model.safetensors'), 'weights');
	const pairing = await provider.rpc['fleet.createPairing']!({});
	const lines: string[] = [];
	const paired = pairHelper({ dataDir: helperDir, code: pairing.code.toLowerCase(), controlUrl: control.url, name: 'gpu-box', pollMs: 20 }, { out: (line) => lines.push(line) });
	const claimed = await until('the helper to claim the code', async () => {
		const record = await provider.rpc['fleet.pairingStatus']!({ pairingId: pairing.pairingId });
		return record.status === 'claimed' ? record : null;
	});
	assert.ok(lines.some((line) => line.includes(claimed.claim.checkString)), 'the helper shows the same check string as the Mac');
	await provider.rpc['fleet.approve']!({ pairingId: pairing.pairingId });
	assert.equal((await paired).payTo, operator);

	await addHelperModel({ dataDir: helperDir, id: MODEL, url: modelUrl, servedName: 'fake', weights: weightsDir, priceIn: '0.10', priceOut: '0.40' }, { out: () => undefined });
	const helper = await runHelper({ dataDir: helperDir }, { out: () => undefined, WebSocketImpl: FakeSocket as unknown as typeof WebSocket }, () => undefined);
	cleanups.push(() => helper.stop());
	const helperKey = claimed.claim.nodeKey as string;
	await until('the helper to come online', async () => relay.sockets.has(helperKey) && (await control.store.getProvider(helperKey))?.status === 'online');
	const fleet = (await provider.rpc['fleet.list']!({})) as Array<{ nodeKey: string }>;
	assert.ok(fleet.some((h) => h.nodeKey === helperKey));

	await buyer.rpc['buyer.setPolicy']!({ allowedProviders: [helperKey] });
	const second = await complete();
	assert.equal(second.body.choices[0]!.message.content, 'Hello from Keeta');
	const paidSecond = await until('the helper job to be paid', async () => {
		const job = await control.store.getJob(second.jobId);
		return job?.status === 'paid' ? job : null;
	});
	assert.equal(paidSecond.nodeKey, helperKey);
	assert.equal(ledger.sends.find((s) => s.reference === second.jobId)!.to, operator, 'helpers pay the Mac operator');
	assert.equal((await control.store.getProvider(helperKey))!.stats.earned, '3');

	/* Linux CLI node: its own wallet and operator, registered as kind 'linux'. */
	const linuxDir = tmp('linux');
	const out: string[] = [];
	const io: cli.CliIO = {
		out: (line) => out.push(line),
		log: () => undefined,
		passphrase: async () => 'linux node passphrase',
		recoveryPhrase: async () => {
			throw new Error('not restoring');
		},
		app: {
			ledgerFor: () => ledger,
			WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
			buyerPort: 0,
			hardware: linux128,
			localConditions: async () => ({ onBattery: false, idleSeconds: 1e9 })
		}
	};
	const { operator: linuxOperator, nodeKey: linuxKey } = await cli.init({ dataDir: linuxDir, network: 'test', controlUrl: control.url, relayUrl: relay.url, name: 'h100' }, io);
	assert.notEqual(linuxOperator, operator, 'the Linux node has its own operator');
	assert.ok(out.some((line) => line.split(/\s+/).filter((w) => /^\d+\.$/.test(w)).length === 6), 'the recovery phrase is shown once at creation');
	const registeredLinux = await control.store.getProvider(linuxKey);
	assert.equal(registeredLinux?.kind, 'linux', 'init registers without going online');
	assert.equal(registeredLinux?.payTo, linuxOperator);
	assert.equal(registeredLinux?.status, 'paused');

	await addHelperModel({ dataDir: linuxDir, id: MODEL, url: modelUrl, servedName: 'fake', weights: weightsDir, priceIn: '0.10', priceOut: '0.40' }, { out: () => undefined });
	await cli.provide({ dataDir: linuxDir, enabled: true }, io);
	const linuxNode = await cli.run({ dataDir: linuxDir }, io);
	cleanups.push(() => linuxNode.shutdown());
	await until('the Linux node to come online', async () => relay.sockets.has(linuxKey) && (await control.store.getProvider(linuxKey))?.status === 'online');

	await buyer.rpc['buyer.setPolicy']!({ allowedProviders: [linuxKey] });
	const third = await complete();
	assert.equal(third.body.choices[0]!.message.content, 'Hello from Keeta');
	const paidThird = await until('the Linux job to be paid', async () => {
		const job = await control.store.getJob(third.jobId);
		return job?.status === 'paid' ? job : null;
	});
	assert.equal(paidThird.nodeKey, linuxKey);
	assert.equal(paidThird.payTo, linuxOperator);
	assert.equal(ledger.sends.find((s) => s.reference === third.jobId)!.to, linuxOperator, 'the Linux node is paid to its own operator');

	/* The Linux node buys too, through its own local endpoint and budget key. */
	const linuxBuyer = linuxNode.state().buyer!;
	const linuxSpend = linuxNode.state().wallet?.spend ?? (await linuxNode.refreshWallet()).spend;
	const bought = await fetch(`${linuxBuyer.endpoint}/chat/completions`, {
		method: 'POST',
		headers: { authorization: `Bearer ${linuxBuyer.token}`, 'content-type': 'application/json' },
		body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'Say hello' }], max_tokens: 64 })
	});
	assert.equal(bought.status, 200);
	const boughtJob = bought.headers.get('x-keeta-job')!;
	await until('the Linux node to pay for its job', async () => (await control.store.getJob(boughtJob))?.status === 'paid');
	assert.equal(ledger.sends.find((s) => s.reference === boughtJob)!.from, linuxSpend);

	/* Wallet commands use the encrypted wallet; a wrong passphrase moves nothing. */
	const sendsBefore = ledger.sends.length;
	await cli.walletFundBudget({ dataDir: linuxDir, amount: '1.5' }, io);
	const funded = ledger.sends.at(-1)!;
	assert.deepEqual([funded.from, funded.to, funded.amount, funded.asset], [linuxOperator, linuxSpend, 1_500_000n, 'usdc']);
	await assert.rejects(cli.walletSend({ dataDir: linuxDir, to: operator, amount: '1' }, { ...io, passphrase: async () => 'not the passphrase' }), /wrong passphrase/);
	assert.equal(ledger.sends.length, sendsBefore + 1);
});
