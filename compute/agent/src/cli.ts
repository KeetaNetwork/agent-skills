/**
 * The Linux CLI: a full node like the macOS app, driven by commands instead
 * of RPC. It reuses AgentApp for everything; the differences are the keys.
 * The node key is a software key in a 0600 file, and the operator comes from
 * this machine's own encrypted wallet (wallet-file.ts) instead of a passkey.
 * It registers as kind 'linux', is paid to its own operator, runs the same
 * local OpenAI-compatible endpoint for agents on this machine, and can pair
 * Linux helpers of its own.
 *
 * Commands that only read or change settings open the app offline: nothing
 * registers as a provider and the local endpoint stays closed until `run`.
 */

import { hostname } from 'node:os';
import { join } from 'node:path';
import {
	CREDIT_DECIMALS,
	CREDIT_SYMBOL,
	LOCAL_API_PORT,
	assertAccess,
	assertKeetaAddress,
	availableAssets,
	formatAmount,
	parseAmount,
	type AccessPolicy,
	type NetworkName,
	type Price
} from '@keeta-compute/protocol';
import { AgentApp, type AppOptions } from './app.ts';
import { KTA_DECIMALS } from './assets.ts';
import { fileAccount } from './keys.ts';
import type { AppToAgent, AssetBalance, InstalledModel } from './rpc/types.ts';
import type { Log } from './runtime/mlx.ts';
import { StateStore } from './state.ts';
import { createWallet, entropyFromPhrase, readWallet, walletPath, withOperatorEntropy } from './wallet-file.ts';

export { KTA_DECIMALS };

export interface CliIO {
	out: (line: string) => void;
	log: Log;
	/** The wallet passphrase; `confirm` asks twice (a new wallet). */
	passphrase: (confirm: boolean) => Promise<string>;
	/** The 24-word recovery phrase, for `init --restore`. */
	recoveryPhrase: () => Promise<string>;
	/** A yes/no question; absent when there is no terminal to ask on. */
	confirm?: (question: string) => Promise<boolean>;
	/** Testing and embedding: passed through to AgentApp. */
	app?: Partial<Pick<AppOptions, 'ledgerFor' | 'exchangeFor' | 'fetchImpl' | 'WebSocketImpl' | 'buyerPort' | 'hardware' | 'localConditions'>>;
	sleep?: (ms: number) => Promise<void>;
}

/** credits, kta, or a stablecoin symbol (KUSD, ..., USDC), as typed. */
type Asset = string;

const defaultSleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** The AgentApp for this data directory, with the software node key and kind 'linux'. */
export async function openNode(dataDir: string, io: CliIO, online: boolean): Promise<AgentApp> {
	const app = new AgentApp({
		dataDir,
		nodeAccount: fileAccount(dataDir, 'node'),
		kind: 'linux',
		notify: () => undefined,
		log: io.log,
		noRuntime: true,
		...io.app
	});
	await app.open({ online });
	return app;
}

/** Call an RPC handler with its contract types. */
function call<K extends keyof AppToAgent>(app: AgentApp, method: K, params: AppToAgent[K]['params']): Promise<AppToAgent[K]['result']> {
	return (app.handlers()[method] as (p: AppToAgent[K]['params']) => Promise<AppToAgent[K]['result']>)(params);
}

async function withApp<T>(dataDir: string, io: CliIO, online: boolean, use: (app: AgentApp) => Promise<T>): Promise<T> {
	const app = await openNode(dataDir, io, online);
	try {
		return await use(app);
	} finally {
		app.shutdown();
	}
}

/** Prices, limits, costs and earnings are in credits: one credit is one US dollar, 6 decimals. */
const credits = (amount: bigint | string) => `${formatAmount(BigInt(amount), CREDIT_DECIMALS)} ${CREDIT_SYMBOL}`;

/** The asset's name as the RPC takes it, and its decimals; stablecoins must be available on the network. */
function assertAsset(store: StateStore, value: string | undefined): { name: string; decimals: number; label: string } {
	const name = (value ?? CREDIT_SYMBOL).trim();
	if (name.toLowerCase() === CREDIT_SYMBOL) {
		return { name: CREDIT_SYMBOL, decimals: CREDIT_DECIMALS, label: CREDIT_SYMBOL };
	}
	if (name.toLowerCase() === 'kta') {
		return { name: 'kta', decimals: KTA_DECIMALS, label: 'KTA' };
	}
	const stablecoin = assertStablecoin(store, name, '--asset');
	return { name: stablecoin.symbol, decimals: stablecoin.decimals, label: stablecoin.symbol };
}

function assertStablecoin(store: StateStore, value: string | undefined, flag: string) {
	const available = availableAssets(store.state.network);
	const stablecoin = value ? available.find((a) => a.symbol === value.trim().toUpperCase()) : available[0];
	if (!stablecoin) {
		throw new Error(
			available.length
				? `${flag} must be ${value ? 'one of ' : ''}${available.map((a) => a.symbol).join(', ')}${value ? '' : ' (none given)'}`
				: `no stablecoin is pinned for the ${store.state.network} network yet; run \`npm run assets:pin\``
		);
	}
	return stablecoin;
}

/** A positive decimal amount in base units of `decimals`. */
function baseUnits(text: string | undefined, decimals: number): string {
	if (!text) {
		throw new Error('an amount is required, e.g. 1.5');
	}
	const amount = parseAmount(text, decimals);
	if (amount <= 0n) {
		throw new Error('the amount must be more than zero');
	}
	return amount.toString();
}

function formatPrice(price: Price): string {
	return `${formatAmount(BigInt(price.inputPerMillion), CREDIT_DECIMALS)} in / ${formatAmount(BigInt(price.outputPerMillion), CREDIT_DECIMALS)} out ${CREDIT_SYMBOL} per million tokens`;
}

function formatBalance(store: StateStore, balance: AssetBalance | null | undefined): string {
	if (!balance) {
		return 'unknown';
	}
	const held = availableAssets(store.state.network)
		.filter((a) => BigInt(balance.stablecoins[a.symbol] ?? '0') > 0n)
		.map((a) => `${formatAmount(BigInt(balance.stablecoins[a.symbol]!), a.decimals)} ${a.symbol}`);
	return [credits(balance.credits), ...held, `${formatAmount(BigInt(balance.kta), KTA_DECIMALS)} KTA`].join(', ');
}

function parsePrice(input: string | undefined, output: string | undefined, fallback: Price): Price {
	return {
		inputPerMillion: input === undefined ? fallback.inputPerMillion : parseAmount(input, CREDIT_DECIMALS).toString(),
		outputPerMillion: output === undefined ? fallback.outputPerMillion : parseAmount(output, CREDIT_DECIMALS).toString()
	};
}

/** `--access public|allowlist --allow KEY,...` as a policy, or undefined when neither is given. */
export function parseAccess(mode: string | undefined, allow: string | undefined): AccessPolicy | undefined {
	if (mode === undefined && allow === undefined) {
		return undefined;
	}
	const keys = (allow ?? '')
		.split(',')
		.map((key) => key.trim())
		.filter(Boolean)
		.map((key, i) => assertKeetaAddress(key, `allow[${i}]`));
	return assertAccess({ mode: mode ?? (keys.length ? 'allowlist' : 'public'), allow: keys });
}

function assertNetwork(value: string): NetworkName {
	if (value !== 'test' && value !== 'main') {
		throw new Error('--network must be test or main');
	}
	return value;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([promise, new Promise<T>((done) => (timer = setTimeout(() => done(fallback), ms)))]);
	} finally {
		clearTimeout(timer);
	}
}

/* ------------------------------------------------------------ config */

export interface ConfigArgs {
	dataDir: string;
	network?: string;
	controlUrl?: string;
	relayUrl?: string;
	name?: string;
}

function applyConfig(store: StateStore, args: ConfigArgs): void {
	store.update((s) => {
		if (args.network) {
			s.network = assertNetwork(args.network);
		}
		if (args.controlUrl) {
			s.controlUrl = args.controlUrl.replace(/\/$/, '');
		}
		if (args.relayUrl) {
			s.relayUrl = args.relayUrl.replace(/\/$/, '');
		}
		if (args.name) {
			s.machineName = args.name.slice(0, 80);
		} else if (s.machineName === 'Mac') {
			s.machineName = hostname().slice(0, 80) || 'Linux';
		}
		/* A server has no battery or keyboard to wait for. */
		s.provider.pauseOnBattery = false;
	});
}

/** Sign the operator link for the current network with the wallet (the CLI's wallet.setOperator). */
async function linkOperator(app: AgentApp, dataDir: string, io: CliIO): Promise<string> {
	const passphrase = await io.passphrase(false);
	const { operator } = await withOperatorEntropy(dataDir, passphrase, (entropy) => call(app, 'wallet.setOperator', { entropy }));
	return operator;
}

async function tryRegister(app: AgentApp, io: CliIO): Promise<void> {
	try {
		const result = await app.register();
		if (result) {
			io.out(`Registered with ${app.store.state.controlUrl}${result.eligible ? '' : ' (this machine is below the provider minimum; it can still buy)'}.`);
		}
	} catch (error) {
		io.out(`Could not reach the control plane (${(error as Error).message}); the node registers when you run it.`);
	}
}

export async function config(args: ConfigArgs, io: CliIO): Promise<void> {
	/* Settings first, so the app opens with the new network's ledger and budget key. */
	applyConfig(new StateStore(args.dataDir), args);
	await withApp(args.dataDir, io, false, async (app) => {
		const s = app.store.state;
		if (readWallet(args.dataDir) && !s.operatorLinks[s.network]) {
			io.out(`Linking your wallet on the ${s.network} network...`);
			await linkOperator(app, args.dataDir, io);
		}
		io.out(`network: ${s.network}`);
		io.out(`control: ${s.controlUrl}`);
		io.out(`relay:   ${s.relayUrl}`);
		io.out(`name:    ${s.machineName}`);
	});
}

/* -------------------------------------------------------------- init */

export interface InitArgs extends ConfigArgs {
	restore?: boolean;
}

export async function init(args: InitArgs, io: CliIO): Promise<{ operator: string; nodeKey: string }> {
	applyConfig(new StateStore(args.dataDir), args);
	const existing = readWallet(args.dataDir);
	if (existing && args.restore) {
		throw new Error(`a wallet already exists at ${walletPath(args.dataDir)}; move it away before restoring another`);
	}
	if (!existing) {
		const entropy = args.restore ? entropyFromPhrase(await io.recoveryPhrase()) : undefined;
		try {
			const passphrase = await io.passphrase(true);
			const { operator, phrase } = await createWallet(args.dataDir, passphrase, entropy ? { entropy } : {});
			io.out(`Created wallet ${walletPath(args.dataDir)} for operator ${operator}.`);
			if (!args.restore) {
				io.out('');
				io.out('Recovery phrase (write it down; it is shown only now):');
				io.out('');
				const words = phrase.split(' ');
				for (let i = 0; i < words.length; i += 6) {
					io.out(`  ${words.slice(i, i + 6).map((word, j) => `${String(i + j + 1).padStart(2)}. ${word.padEnd(9)}`).join(' ')}`);
				}
				io.out('');
				io.out('Anyone with these words controls the wallet. They also work as a Keeta passphrase for the same account.');
			}
		} finally {
			entropy?.fill(0);
		}
	} else {
		io.out(`Using the existing wallet for operator ${existing.operator}.`);
	}
	return withApp(args.dataDir, io, false, async (app) => {
		const operator = await linkOperator(app, args.dataDir, io);
		const nodeKey = app.state().nodeKey!;
		io.out(`Node key ${nodeKey} now earns for ${operator} on the ${app.store.state.network} network.`);
		await tryRegister(app, io);
		io.out('Next: `keeta-compute-agent models add ...` and `keeta-compute-agent provide --on` to sell, then `keeta-compute-agent run`.');
		return { operator, nodeKey };
	});
}

/* ------------------------------------------------------------ status */

export async function status(args: { dataDir: string; json?: boolean }, io: CliIO): Promise<Record<string, unknown>> {
	return withApp(args.dataDir, io, false, async (app) => {
		const s = app.store.state;
		const [reachable, wallet] = await Promise.all([withTimeout(app.checkControl(), 10_000, false), withTimeout(app.refreshWallet(), 15_000, null)]);
		const state = app.state();
		const buyer = state.buyer!;
		/* Offline the endpoint is not listening; show where `run` opens it. */
		const endpoint = `http://127.0.0.1:${io.app?.buyerPort || LOCAL_API_PORT}/v1`;
		const report = {
			nodeKey: state.nodeKey,
			kind: 'linux',
			name: s.machineName,
			network: s.network,
			controlUrl: s.controlUrl,
			relayUrl: s.relayUrl,
			controlReachable: reachable,
			operator: s.operatorLinks[s.network]?.payTo ?? null,
			wallet: readWallet(args.dataDir) ? walletPath(args.dataDir) : null,
			spend: wallet?.spend ?? null,
			balances: wallet?.balances ?? null,
			...(wallet?.error ? { balanceError: wallet.error } : {}),
			hardware: state.hardware,
			tier: state.tier,
			creditsAvailable: wallet?.creditsAvailable ?? false,
			provider: { enabled: s.provider.enabled, maxConcurrentJobs: s.provider.maxConcurrentJobs, access: s.provider.access, earnedTotal: state.provider?.earnedTotal ?? '0' },
			buyer: { endpoint, policy: buyer.policy, spentToday: buyer.spentToday, pendingEscrows: s.escrows.filter((e) => e.network === s.network).length },
			models: s.models.map((m) => ({ modelId: m.modelId, offered: m.offer.offered, price: m.offer.price })),
			helper: s.helper ?? null
		};
		if (args.json) {
			io.out(JSON.stringify(report, null, 2));
			return report;
		}
		io.out(`node      ${report.nodeKey} (${report.name}, ${state.hardware?.chip ?? 'unknown'}, tier ${state.tier ?? '?'})`);
		io.out(`network   ${report.network}`);
		io.out(`control   ${report.controlUrl} (${reachable ? 'reachable' : 'unreachable'})`);
		io.out(`relay     ${report.relayUrl}`);
		io.out(`operator  ${report.operator ?? 'none: run `keeta-compute-agent init`'}`);
		io.out(`budget    ${report.spend ?? '-'}`);
		if (wallet?.balances) {
			io.out(`balances  operator ${formatBalance(app.store, wallet.balances.operator)}; budget ${formatBalance(app.store, wallet.balances.spend)}`);
		} else {
			io.out(`balances  ${wallet?.error ?? 'the ledger did not answer in time'}`);
		}
		if (!report.creditsAvailable) {
			io.out(`credits   not available on the ${s.network} network yet (or the control plane is unreachable); buying inference needs them`);
		}
		io.out(`provide   ${s.provider.enabled ? 'on' : 'off'}, up to ${s.provider.maxConcurrentJobs} job(s), access ${s.provider.access.mode}; earned ${credits(report.provider.earnedTotal)} (paid out on the ledger)`);
		io.out(`buy       ${endpoint} while running (token: keeta-compute-agent token); spent today ${credits(buyer.spentToday)}${report.buyer.pendingEscrows ? `, ${report.buyer.pendingEscrows} escrow(s) still to report` : ''}`);
		io.out(`models    ${s.models.length ? s.models.map((m) => `${m.modelId}${m.offer.offered ? '' : ' (not offered)'}`).join(', ') : 'none'}`);
		if (s.helper) {
			io.out(`helper    paired with ${s.helper.masterNodeKey}; \`helper run\` pays ${s.helper.payTo}`);
		}
		return report;
	});
}

/* ------------------------------------------------------------ wallet */

export async function walletShow(args: { dataDir: string }, io: CliIO): Promise<void> {
	await withApp(args.dataDir, io, false, async (app) => {
		const wallet = await app.refreshWallet();
		io.out(`network   ${app.store.state.network}`);
		io.out(`operator  ${wallet.operator ?? 'none: run `keeta-compute-agent init`'}  ${formatBalance(app.store, wallet.balances?.operator)}`);
		io.out(`budget    ${wallet.spend}  ${formatBalance(app.store, wallet.balances?.spend)}`);
		io.out(`explorer  ${wallet.explorer}`);
		if (wallet.error) {
			io.out(wallet.error);
		}
	});
}

export async function walletSend(args: { dataDir: string; to: string; amount: string; asset?: string; memo?: string }, io: CliIO): Promise<string> {
	return withApp(args.dataDir, io, false, async (app) => {
		const asset = assertAsset(app.store, args.asset);
		const to = assertKeetaAddress(args.to, 'to');
		const amount = baseUnits(args.amount, asset.decimals);
		const passphrase = await io.passphrase(false);
		const { blockHash } = await withOperatorEntropy(args.dataDir, passphrase, (entropy) =>
			call(app, 'wallet.send', { entropy, to, amount, asset: asset.name, ...(args.memo ? { memo: args.memo } : {}) })
		);
		io.out(`Sent ${args.amount} ${asset.label} to ${to}: ${blockHash}`);
		return blockHash;
	});
}

export async function walletFundBudget(args: { dataDir: string; amount: string; asset?: string }, io: CliIO): Promise<string> {
	return withApp(args.dataDir, io, false, async (app) => {
		const asset = assertAsset(app.store, args.asset);
		const amount = baseUnits(args.amount, asset.decimals);
		const passphrase = await io.passphrase(false);
		const { blockHash } = await withOperatorEntropy(args.dataDir, passphrase, (entropy) => call(app, 'wallet.fundBudget', { entropy, amount, asset: asset.name }));
		io.out(`Moved ${args.amount} ${asset.label} into the agent budget: ${blockHash}`);
		return blockHash;
	});
}

export async function walletDrainBudget(args: { dataDir: string; amount: string; asset?: string }, io: CliIO): Promise<string> {
	return withApp(args.dataDir, io, false, async (app) => {
		const asset = assertAsset(app.store, args.asset);
		const { blockHash } = await call(app, 'wallet.drainBudget', { amount: baseUnits(args.amount, asset.decimals), asset: asset.name });
		io.out(`Moved ${args.amount} ${asset.label} from the agent budget back to the operator: ${blockHash}`);
		return blockHash;
	});
}

/**
 * Buy credits with a Keeta stablecoin (KUSD by default) from the operator
 * account through the keeta.ai FX provider, then move them into the agent
 * budget unless `keep` is set.
 */
export async function walletBuyCredits(args: { dataDir: string; amount: string; with?: string; keep?: boolean }, io: CliIO): Promise<{ blockHash: string; budgetBlockHash?: string }> {
	return withApp(args.dataDir, io, false, async (app) => {
		const stablecoin = assertStablecoin(app.store, args.with, '--with');
		const amount = baseUnits(args.amount, CREDIT_DECIMALS);
		const quote = await call(app, 'wallet.creditQuote', { side: 'buy', amount, stablecoin: stablecoin.symbol });
		io.out(`${credits(amount)} costs about ${formatAmount(BigInt(quote.amount), stablecoin.decimals)} ${stablecoin.symbol}.`);
		const passphrase = await io.passphrase(false);
		const result = await withOperatorEntropy(args.dataDir, passphrase, (entropy) => call(app, 'wallet.buyCredits', { entropy, amount, with: stablecoin.symbol, toBudget: !args.keep }));
		io.out(`Bought ${credits(result.credits)} for ${formatAmount(BigInt(result.paid), stablecoin.decimals)} ${stablecoin.symbol}: ${result.blockHash}`);
		if (result.budgetBlockHash) {
			io.out(`Moved them into the agent budget: ${result.budgetBlockHash}`);
		}
		return { blockHash: result.blockHash, ...(result.budgetBlockHash ? { budgetBlockHash: result.budgetBlockHash } : {}) };
	});
}

/** Cash out: sell credits from the operator account for a Keeta stablecoin (KUSD by default). */
export async function walletSellCredits(args: { dataDir: string; amount: string; to?: string }, io: CliIO): Promise<string> {
	return withApp(args.dataDir, io, false, async (app) => {
		const stablecoin = assertStablecoin(app.store, args.to, '--to');
		const amount = baseUnits(args.amount, CREDIT_DECIMALS);
		const quote = await call(app, 'wallet.creditQuote', { side: 'sell', amount, stablecoin: stablecoin.symbol });
		io.out(`${credits(amount)} brings about ${formatAmount(BigInt(quote.amount), stablecoin.decimals)} ${stablecoin.symbol}.`);
		const passphrase = await io.passphrase(false);
		const result = await withOperatorEntropy(args.dataDir, passphrase, (entropy) => call(app, 'wallet.sellCredits', { entropy, amount, to: stablecoin.symbol }));
		io.out(`Sold ${credits(result.credits)} for ${formatAmount(BigInt(result.received), stablecoin.decimals)} ${stablecoin.symbol}: ${result.blockHash}`);
		return result.blockHash;
	});
}

export async function walletTestFunds(args: { dataDir: string }, io: CliIO): Promise<void> {
	await withApp(args.dataDir, io, false, async (app) => {
		const result = await call(app, 'wallet.requestTestFunds', {});
		io.out(result.message);
	});
}

/* ------------------------------------------------------------ models */

function describeModel(store: StateStore, model: InstalledModel & { backend?: { baseUrl: string; servedName: string } }): string {
	const access = model.offer.access ? `${model.offer.access.mode}${model.offer.access.allow.length ? ` (${model.offer.access.allow.length} keys)` : ''}` : 'default';
	return `${model.modelId}  ${model.offer.offered ? 'offered' : 'not offered'}  ${formatPrice(model.offer.price)}  access ${access}${model.backend ? `  ${model.backend.baseUrl} (${model.backend.servedName})` : ''}`;
}

export function modelsList(args: { dataDir: string }, io: CliIO): void {
	const store = new StateStore(args.dataDir);
	if (!store.state.models.length) {
		io.out('No models yet. Add one served by vLLM, llama.cpp or SGLang on this machine with `keeta-compute-agent models add`.');
	}
	for (const model of store.state.models) {
		io.out(describeModel(store, model as Parameters<typeof describeModel>[1]));
	}
}

export async function modelsOffer(
	args: { dataDir: string; modelId: string; offered?: boolean; priceIn?: string; priceOut?: string; access?: string; allow?: string },
	io: CliIO
): Promise<InstalledModel> {
	return withApp(args.dataDir, io, false, async (app) => {
		const current = app.store.state.models.find((m) => m.modelId === args.modelId);
		if (!current) {
			throw new Error(`${args.modelId} is not installed; see \`keeta-compute-agent models list\``);
		}
		const access = args.access === 'default' ? null : parseAccess(args.access, args.allow);
		const model = await call(app, 'models.setOffer', {
			modelId: args.modelId,
			offered: args.offered ?? current.offer.offered,
			price: parsePrice(args.priceIn, args.priceOut, current.offer.price),
			...(access !== undefined ? { access } : {})
		});
		io.out(describeModel(app.store, model));
		return model;
	});
}

export async function modelsRemove(args: { dataDir: string; modelId: string }, io: CliIO): Promise<void> {
	await withApp(args.dataDir, io, false, async (app) => {
		const { removed } = await call(app, 'models.remove', { modelId: args.modelId });
		io.out(removed ? `Removed ${args.modelId}. The weights on disk were left alone.` : `${args.modelId} is not installed.`);
	});
}

/* ---------------------------------------------------- provide and buy */

export async function provide(args: { dataDir: string; enabled?: boolean; maxJobs?: string; access?: string; allow?: string }, io: CliIO): Promise<void> {
	await withApp(args.dataDir, io, false, async (app) => {
		const access = parseAccess(args.access, args.allow);
		const status = await call(app, 'provider.setPolicy', {
			...(args.enabled !== undefined ? { enabled: args.enabled } : {}),
			...(args.maxJobs !== undefined ? { maxConcurrentJobs: Number(args.maxJobs) } : {}),
			...(access ? { access } : {})
		});
		const policy = status.policy;
		io.out(`Providing is ${policy.enabled ? 'on' : 'off'}: up to ${policy.maxConcurrentJobs} job(s) at a time, access ${policy.access.mode}${policy.access.allow.length ? ` (${policy.access.allow.length} keys)` : ''}.`);
		if (policy.enabled) {
			io.out('It takes effect while `keeta-compute-agent run` is running.');
		}
	});
}

export async function buy(args: { dataDir: string; perRequestMax?: string; dailyMax?: string }, io: CliIO): Promise<void> {
	await withApp(args.dataDir, io, false, async (app) => {
		const status = await call(app, 'buyer.setPolicy', {
			...(args.perRequestMax !== undefined ? { perRequestMax: parseAmount(args.perRequestMax, CREDIT_DECIMALS).toString() } : {}),
			...(args.dailyMax !== undefined ? { dailyMax: parseAmount(args.dailyMax, CREDIT_DECIMALS).toString() } : {})
		});
		const policy = status.policy;
		io.out(`Agents on this machine may spend up to ${credits(policy.perRequestMax)} per request and ${credits(policy.dailyMax)} per day.`);
		io.out(`Spent today: ${credits(status.spentToday)}.`);
	});
}

export async function token(args: { dataDir: string; rotate?: boolean }, io: CliIO): Promise<void> {
	await withApp(args.dataDir, io, false, async (app) => {
		const status = args.rotate ? await call(app, 'buyer.rotateToken', {}) : await call(app, 'buyer.status', {});
		io.out(status.token);
	});
}

/* ------------------------------------------------------------- fleet */

/** Create a pairing code for a Linux helper, wait for it to claim the code, and approve on confirmation. */
export async function pair(args: { dataDir: string; pollMs?: number }, io: CliIO): Promise<{ pairingId: string; code: string }> {
	return withApp(args.dataDir, io, false, async (app) => {
		if (!app.store.state.operatorLinks[app.store.state.network]) {
			throw new Error('create the wallet first with `keeta-compute-agent init`');
		}
		await app.register();
		const pairing = await call(app, 'fleet.createPairing', {});
		io.out(`On the helper, run: keeta-compute-agent helper pair ${pairing.code} --control ${app.store.state.controlUrl}`);
		io.out(`The code expires at ${new Date(pairing.expiresAt).toLocaleTimeString()}. Waiting for the helper...`);
		const sleep = io.sleep ?? defaultSleep;
		for (;;) {
			const record = await call(app, 'fleet.pairingStatus', { pairingId: pairing.pairingId });
			if (record.status === 'claimed' && record.claim) {
				io.out(`Helper ${record.claim.descriptor.name} (${record.claim.descriptor.chip}) claimed the code. Check string: ${record.claim.checkString}`);
				if (!io.confirm) {
					io.out(`If the helper shows the same check string, approve it with: keeta-compute-agent fleet approve ${pairing.pairingId}`);
					return pairing;
				}
				if (await io.confirm('Does the helper show the same check string? Approve it?')) {
					await call(app, 'fleet.approve', { pairingId: pairing.pairingId });
					io.out(`Approved. Its earnings go to ${record.payTo}.`);
				} else {
					await call(app, 'fleet.reject', { pairingId: pairing.pairingId });
					io.out('Rejected.');
				}
				return pairing;
			}
			if (record.status !== 'waiting') {
				throw new Error(`the pairing is ${record.status}`);
			}
			await sleep(args.pollMs ?? 2000);
		}
	});
}

export async function fleet(args: { dataDir: string; action: string; target?: string }, io: CliIO): Promise<void> {
	await withApp(args.dataDir, io, false, async (app) => {
		switch (args.action) {
			case 'list': {
				const helpers = await call(app, 'fleet.list', {});
				if (!helpers.length) {
					io.out('No helpers. Pair one with `keeta-compute-agent pair`.');
				}
				for (const helper of helpers) {
					io.out(`${helper.nodeKey}  ${helper.name}  ${helper.status}  ${helper.offers.join(',') || 'no offers'}  ${helper.completed} job(s) completed`);
				}
				return;
			}
			case 'approve':
			case 'reject': {
				if (!args.target) {
					throw new Error(`fleet ${args.action} needs the pairing id`);
				}
				const result = args.action === 'approve' ? await call(app, 'fleet.approve', { pairingId: args.target }) : await call(app, 'fleet.reject', { pairingId: args.target });
				io.out(JSON.stringify(result));
				return;
			}
			case 'revoke': {
				if (!args.target) {
					throw new Error('fleet revoke needs the helper node key');
				}
				await call(app, 'fleet.revoke', { nodeKey: args.target });
				io.out(`Revoked ${args.target}.`);
				return;
			}
			default:
				throw new Error('fleet takes list, approve ID, reject ID or revoke KEY');
		}
	});
}

/* --------------------------------------------------------------- run */

/** Start the provider loop and the local endpoint; the caller stops the returned app. */
export async function run(args: { dataDir: string }, io: CliIO): Promise<AgentApp> {
	const app = await openNode(args.dataDir, io, true);
	const s = app.store.state;
	const buyer = app.state().buyer!;
	if (!s.operatorLinks[s.network]) {
		io.out('No wallet is linked yet, so this node will not provide; run `keeta-compute-agent init` first.');
	}
	io.out(`Node ${app.state().nodeKey} on the ${s.network} network, providing ${s.provider.enabled ? 'on' : 'off'}.`);
	io.out(`Local OpenAI-compatible endpoint: ${buyer.endpoint}`);
	io.out(`Its bearer token is kept in ${join(args.dataDir, 'state.json')}; print it with \`keeta-compute-agent token\`.`);
	return app;
}
