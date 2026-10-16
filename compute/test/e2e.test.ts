/**
 * End to end, in one process, with no network: the control plane (memory
 * store), a Node emulation of the relay that reuses the Worker's checks and
 * records what it forwards, two agents (a Mac provider and a Mac buyer), a
 * paired Linux helper, a Linux CLI node with its own wallet, a fake
 * OpenAI-compatible model server, and an in-memory ledger holding the
 * stablecoins, Keeta Compute Credits, keeta.ai's settlement account and the
 * FX provider's swaps (priced by the FX service itself). Every signature is
 * real: the Mac node keys are P-256 keys emulating the Secure Enclave, the
 * Mac operator comes from passkey PRF entropy, the Linux operator from its
 * encrypted wallet file, and buyers escrow from their budget keys.
 *
 * The money path: buy credits with a stablecoin, escrow each job's maximum
 * cost with the settlement account at ticket time, and let the relay's
 * delivery record settle it in one payout block: the provider's bill to
 * its operator, the rest back to the buyer. Balances live only on the ledger.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ONE_CREDIT, availableAssets, chunkText, maxJobCost, maxOutputTokensFor, randomId, sha256Hex, sseData, sseEvent, toHex, type HardwareProfile, type JobEnvelope, type ProviderFrame } from '@keeta-compute/protocol';
import { Account } from '@keeta-compute/protocol/keeta';
import { startServer } from '../services/control/src/server.ts';
import { checkEnvelope, checkProviderToken } from '../services/relay/src/relay.ts';
import { postDelivery } from '../services/relay/src/delivery.ts';
import { fxConfigFromEnv } from '../services/fx/src/config.ts';
import { fxAccount, quoteAmount } from '../services/fx/src/server.ts';
import * as cli from '@keeta-compute/cli';
import { addHelperModel, pairHelper, runHelper } from '@keeta-compute/cli';
import type { ModelManager } from '@keeta-compute/provider';
import type { CreditExchange, Ledger } from '@keeta-compute/wallet';
import { GB, fakeModelServer, listen, macAgent as makeMacAgent, readBody, until } from './support/harness.ts';
import { FakeLedger, newTokenAddress } from './support/ledger.ts';

const RELAY_SECRET = 'relay-secret-for-tests';
const ROUTER_SECRET = 'router-secret-for-tests';
const MODEL = 'llama-3.2-3b';
/* What `npm run credits:create` makes: the credit token, and the FX account holding its supply. */
const CREDITS = newTokenAddress();
const FX_SEED = toHex(crypto.getRandomValues(new Uint8Array(32)));
const FX = fxAccount(FX_SEED).publicKeyString.get();
/* keeta.ai's settlement account (SETTLEMENT_SEED in production). */
const SETTLEMENT = Account.fromSeed(Account.generateRandomSeed({ asString: true }), 0).publicKeyString.get();

/* ------------------------------------------------ relay emulation */

interface RelayRun {
	res: ServerResponse;
	jobId: string;
	/** App jobs: the text forwarded so far, for the delivery record (as in services/relay/src/channel.ts). */
	delivered: string | null;
	attesting: Promise<void> | null;
}

/** Stands in for the Worker + Durable Object, using the Worker's own checks; test:worker runs the real one. */
class RelayEmulator {
	readonly sockets = new Map<string, FakeSocket>();
	lastEnvelope: JobEnvelope | null = null;
	private readonly pending = new Map<string, RelayRun>();
	readonly server = createServer((req, res) => void this.handle(req, res));
	url = '';
	controlUrl = '';

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
		const run = this.pending.get(frame.id);
		if (!run) {
			return;
		}
		if (frame.type === 'chunk') {
			if (run.delivered !== null) {
				run.delivered += chunkText(frame.data);
			}
			run.res.write(sseData(frame.data));
		} else if (frame.type === 'receipt') {
			this.pending.delete(frame.id);
			/* Record the delivery before the buyer sees the receipt. */
			void this.attest(run).then(() => run.res.end(sseEvent('keeta.receipt', frame.receipt)));
		} else {
			this.pending.delete(frame.id);
			run.res.end(sseEvent('keeta.error', { code: frame.code, message: frame.message }));
			void this.attest(run);
		}
	}

	/** Report the hash of the text forwarded for an app job to the control plane, once, with the Worker's own poster. */
	private attest(run: RelayRun): Promise<void> {
		if (run.delivered === null) {
			return Promise.resolve();
		}
		const delivered = run.delivered;
		run.attesting ??= (async () => {
			await postDelivery({ controlUrl: this.controlUrl, routerSecret: ROUTER_SECRET, jobId: run.jobId, outputHash: await sha256Hex(delivered), maxOutputTokens: maxOutputTokensFor(delivered) });
		})();
		return run.attesting;
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
		const entry: RelayRun = { res, jobId: envelope.ticket.ticket.jobId, delivered: envelope.ticket.ticket.paymentMode === 'escrow' ? '' : null, attesting: null };
		this.pending.set(id, entry);
		/* Like the Durable Object: a buyer hanging up cancels the job on the provider, and what was forwarded is still recorded. */
		res.on('close', () => {
			if (this.pending.delete(id)) {
				socket.deliver(JSON.stringify({ type: 'cancel', id }));
				void this.attest(entry);
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

const linux128: HardwareProfile = { os: 'linux', osVersion: 'Ubuntu 24.04', chip: 'NVIDIA H100', memoryBytes: 128 * GB, freeDiskBytes: 2000 * GB };

const macAgent = (dataDir: string, ledger: Ledger, exchange: CreditExchange) => makeMacAgent(dataDir, { ledger, exchange, WebSocketImpl: FakeSocket as unknown as typeof WebSocket });

/* -------------------------------------------------------------- test */

test('a buyer buys credits with a stablecoin, escrows each job at ticket time, and the relay record settles it on the ledger', async (t) => {
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

	/* The ledger: credits:create minted the supply to the FX account, which sells credits for stablecoins and buys them back at the FX service's prices. */
	const ledger = new FakeLedger();
	ledger.mint(FX, CREDITS, 1_000n * ONE_CREDIT);
	const fxConfig = fxConfigFromEnv({ FX_SEED, TEST_CREDIT_TOKEN: CREDITS });
	const exchange = ledger.exchange(FX, (request) => quoteAmount(fxConfig, request));
	/* KUSD once it is pinned for the test network, USDC until then: both trade one to one with credits. */
	const stablecoin = availableAssets('test')[0]!;

	const control = await startServer({
		port: 0,
		env: {
			COORDINATOR_SEED: Account.generateRandomSeed({ asString: true }) as string,
			RELAY_SECRET,
			ROUTER_SECRET,
			RELAY_URL: relay.url,
			ALLOW_SMALL_PROVIDERS: 'true',
			TEST_CREDIT_TOKEN: CREDITS,
			TEST_FX_ACCOUNT: FX
		},
		verifyPayment: ledger.verifier(),
		settlement: ledger.settlement(SETTLEMENT),
		creditBalanceOf: async ({ account, token }) => ledger.balanceOf(account, token)
	});
	cleanups.push(() => control.server.close());
	relay.controlUrl = control.url;

	const init = (nodePublicKey: string, machineName: string) => ({ network: 'test', controlUrl: control.url, relayUrl: relay.url, nodePublicKey, appVersion: 'test', machineName });
	const paidOut = (label: string, jobId: string, timeoutMs?: number) =>
		until(label, async () => {
			const job = await control.store.getJob(jobId);
			return job?.settlement?.blockHash ? job : null;
		}, timeoutMs);

	/* Provider Mac: wallet from passkey entropy, one model, providing on. */
	const provider = macAgent(tmp('provider'), ledger, exchange);
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
	const providerEntropy = toHex(crypto.getRandomValues(new Uint8Array(32)));
	const { operator } = await provider.rpc['wallet.setOperator']!({ entropy: providerEntropy });
	assert.match(operator, /^keeta_/);
	await until('the Mac provider to come online', async () => (await provider.rpc['provider.status']!({})).state === 'online');
	const macKey = (await provider.rpc['agent.state']!({})).nodeKey as string;
	assert.ok(relay.sockets.has(macKey));

	/* Buyer Mac: buys credits with a stablecoin through the FX provider, into the agent budget its endpoint spends from. */
	const buyer = macAgent(tmp('buyer'), ledger, exchange);
	cleanups.push(() => buyer.app.shutdown());
	await buyer.rpc['agent.initialize']!(init(buyer.nodePublicKey, 'Laptop'));
	const buyerEntropy = toHex(crypto.getRandomValues(new Uint8Array(32)));
	const { operator: buyerOperator } = await buyer.rpc['wallet.setOperator']!({ entropy: buyerEntropy });
	const spendKey = (await buyer.rpc['wallet.refresh']!({})).spend as string;
	ledger.mint(buyerOperator, stablecoin.address, 5_000_000n);
	const priced = await buyer.rpc['wallet.creditQuote']!({ side: 'buy', amount: '2000000', stablecoin: stablecoin.symbol });
	assert.equal(priced.amount, '2000000', `${stablecoin.symbol} buys credits one to one`);
	const bought = await buyer.rpc['wallet.buyCredits']!({ entropy: buyerEntropy, amount: '2000000', with: stablecoin.symbol });
	assert.deepEqual([bought.paid, bought.credits, Boolean(bought.budgetBlockHash)], ['2000000', '2000000', true]);
	assert.equal(ledger.balanceOf(buyerOperator, stablecoin.address), 3_000_000n);
	assert.equal(ledger.balanceOf(FX, stablecoin.address), 2_000_000n, 'the FX account took the stablecoin');
	const buyerWallet = await buyer.rpc['wallet.refresh']!({});
	assert.equal(buyerWallet.creditsAvailable, true);
	assert.equal(buyerWallet.balances.spend.credits, '2000000', 'the credits are in the agent budget, read from the ledger');
	assert.equal(buyerWallet.balances.operator.stablecoins[stablecoin.symbol], '3000000');
	const buyerStatus = await buyer.rpc['buyer.status']!({});

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
	const buyerJob = async (jobId: string) => (await buyer.rpc['buyer.status']!({})).recentJobs.find((j: { jobId: string }) => j.jobId === jobId) as { status: string; amount: string } | undefined;

	const first = await complete();
	assert.equal(first.body.choices[0]!.message.content, 'Hello from Keeta');
	assert.equal(first.body.usage.completion_tokens, 3);

	const paidFirst = await paidOut('the first job to be paid out', first.jobId);
	assert.equal(paidFirst.status, 'paid');
	assert.equal(paidFirst.settlement!.reason, 'delivered');
	assert.equal(paidFirst.nodeKey, macKey);
	assert.equal(paidFirst.payTo, operator);
	/* At ticket time the budget escrowed the job's maximum cost in credits with the settlement account. */
	const escrows = ledger.sendsFor(first.jobId, spendKey);
	assert.equal(escrows.length, 1);
	assert.deepEqual([escrows[0]!.to, escrows[0]!.token, escrows[0]!.amount, escrows[0]!.block], [SETTLEMENT, CREDITS, maxJobCost(paidFirst.price, paidFirst), paidFirst.escrow!.blockHash]);
	/* The relay's record matched the receipt: one block pays the provider 3 base units (12 in at 0.10/M + 3 out at 0.40/M, rounded up) and returns the rest. */
	const firstPayout = ledger.sendsFor(first.jobId, SETTLEMENT);
	assert.deepEqual(firstPayout.map((s) => [s.to, s.amount, s.block]), [
		[operator, 3n, paidFirst.settlement!.blockHash],
		[spendKey, escrows[0]!.amount - 3n, paidFirst.settlement!.blockHash]
	]);
	await until('the buyer to see the first job paid', async () => {
		await buyer.rpc['buyer.settle']!({});
		return (await buyerJob(first.jobId))?.status === 'paid';
	});
	assert.equal((await buyer.rpc['buyer.status']!({})).spentToday, '3', 'the spend limit counts what was billed, not the escrow');

	/* Replaying a ticket that already ran is refused by the provider. */
	const replay = await fetch(`${relay.url}/v1/jobs/${first.jobId}/run`, { method: 'POST', body: JSON.stringify(relay.lastEnvelope) });
	assert.match(await replay.text(), /ticket_used/);

	/* A request over the per-request limit is refused before anything is escrowed, and its quote handed back. */
	await buyer.rpc['buyer.setPolicy']!({ perRequestMax: '1' });
	const tooDear = await fetch(`${buyerStatus.endpoint}/chat/completions`, {
		method: 'POST',
		headers: { authorization: `Bearer ${buyerStatus.token}`, 'content-type': 'application/json' },
		body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'Say hello' }], max_tokens: 4000 })
	});
	assert.equal(tooDear.status, 402);
	const [cancelled] = await control.store.listJobsByBuyer(spendKey, 1);
	assert.equal(cancelled!.status, 'expired', 'the quote is handed back');
	assert.equal(ledger.sendsFor(cancelled!.jobId, spendKey).length, 0, 'nothing was escrowed');
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
	/* Follow-up runs (the app, the wallet timer) overlap the hang-up; the job is still escrowed once and paid out once. */
	const paidHungUp = await until('the hung-up job to be paid out', async () => {
		await Promise.all([1, 2, 3].map(() => buyer.rpc['buyer.settle']!({})));
		const job = await control.store.getJob(hungUpJob);
		return job?.settlement?.blockHash ? job : null;
	}, 20_000);
	assert.equal(paidHungUp.status, 'paid');
	assert.equal(paidHungUp.settlement!.reason, 'delivered', 'the relay recorded the text it forwarded before the hang-up');
	assert.equal(paidHungUp.receipt!.receipt.finishReason, 'cancelled');
	assert.equal(paidHungUp.receipt!.receipt.outputTokens, 1, 'billed only for the one piece delivered');
	const hungUpBill = BigInt(paidHungUp.receipt!.receipt.amount);
	assert.equal(ledger.sendsFor(hungUpJob, spendKey).length, 1, 'one escrow send per job');
	const hungUpPayout = ledger.sendsFor(hungUpJob, SETTLEMENT);
	assert.equal(new Set(hungUpPayout.map((s) => s.block)).size, 1, 'one payout block per job');
	assert.equal(hungUpPayout.find((s) => s.to === operator)!.amount, hungUpBill);
	assert.equal(hungUpPayout.find((s) => s.to === spendKey)!.amount, ledger.sendsFor(hungUpJob, spendKey)[0]!.amount - hungUpBill, 'the rest of the escrow comes back');
	await until('the buyer to record the hung-up job as paid', async () => {
		await Promise.all([1, 2, 3].map(() => buyer.rpc['buyer.settle']!({})));
		return (await buyerJob(hungUpJob))?.status === 'paid';
	});
	assert.equal((await buyer.rpc['buyer.status']!({})).spentToday, (3n + hungUpBill).toString(), 'counted once');

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
	const paidSecond = await paidOut('the helper job to be paid out', second.jobId);
	assert.equal(paidSecond.nodeKey, helperKey);
	assert.equal(ledger.sendsFor(second.jobId, SETTLEMENT).find((s) => s.to === operator)?.amount, 3n, 'helpers earn for the Mac operator');
	assert.deepEqual((await control.store.getProvider(helperKey))!.stats, { completed: 1, failed: 0, tokensOut: 3 }, 'the control plane keeps job counts, not earnings');

	/* The operator's earnings are the settlement account's payouts to it, read from the ledger; cashing out sells them for a stablecoin. */
	const earned = ledger.sends.filter((s) => s.from === SETTLEMENT && s.to === operator).reduce((sum, s) => sum + s.amount, 0n);
	assert.equal(earned, 6n + hungUpBill);
	await provider.rpc['wallet.refresh']!({});
	assert.equal((await provider.rpc['provider.status']!({})).earnedTotal, earned.toString());
	const cashedOut = await provider.rpc['wallet.sellCredits']!({ entropy: providerEntropy, amount: earned.toString(), to: stablecoin.symbol });
	assert.equal(cashedOut.received, earned.toString(), `credits cash out to ${stablecoin.symbol} one to one`);
	assert.equal(ledger.balanceOf(operator, CREDITS), 0n);
	assert.equal(ledger.balanceOf(operator, stablecoin.address), earned);

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
			exchangeFor: () => exchange,
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
	const paidThird = await paidOut('the Linux job to be paid out', third.jobId);
	assert.equal(paidThird.nodeKey, linuxKey);
	assert.equal(paidThird.payTo, linuxOperator);
	assert.equal(ledger.sendsFor(third.jobId, SETTLEMENT).find((s) => s.to === linuxOperator)?.amount, 3n, 'the Linux node is paid to its own operator');

	/* The Linux node buys too: credits bought from the CLI into its own budget, escrowed by its own endpoint. */
	const linuxBuyer = linuxNode.state().buyer!;
	const linuxSpend = linuxNode.state().wallet?.spend ?? (await linuxNode.refreshWallet()).spend;
	ledger.mint(linuxOperator, stablecoin.address, 2_000_000n);
	await cli.walletBuyCredits({ dataDir: linuxDir, amount: '1', with: stablecoin.symbol }, io);
	assert.equal(ledger.balanceOf(linuxSpend, CREDITS), ONE_CREDIT);
	assert.ok(out.some((line) => line.startsWith('Bought 1')), out.join('\n'));
	const boughtJob = await fetch(`${linuxBuyer.endpoint}/chat/completions`, {
		method: 'POST',
		headers: { authorization: `Bearer ${linuxBuyer.token}`, 'content-type': 'application/json' },
		body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'Say hello' }], max_tokens: 64 })
	});
	assert.equal(boughtJob.status, 200);
	const linuxJob = boughtJob.headers.get('x-keeta-job')!;
	await paidOut('the Linux node\'s job to be paid out', linuxJob);
	assert.equal(ledger.sendsFor(linuxJob, linuxSpend).length, 1, 'escrowed from the Linux budget');

	/* Wallet commands use the encrypted wallet; a wrong passphrase moves nothing. */
	const sendsBefore = ledger.sends.length;
	await cli.walletFundBudget({ dataDir: linuxDir, amount: '0.5', asset: stablecoin.symbol }, io);
	const funded = ledger.sends.at(-1)!;
	assert.deepEqual([funded.from, funded.to, funded.amount, funded.token], [linuxOperator, linuxSpend, 500_000n, stablecoin.address]);
	await assert.rejects(cli.walletSend({ dataDir: linuxDir, to: operator, amount: '0.1', asset: stablecoin.symbol }, { ...io, passphrase: async () => 'not the passphrase' }), /wrong passphrase/);
	assert.equal(ledger.sends.length, sendsBefore + 1);
});
