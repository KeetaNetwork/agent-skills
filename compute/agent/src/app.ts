/**
 * App mode: the agent behind the macOS app, and the engine of the Linux CLI.
 * Implements the RPC contract in rpc/types.ts and wires wallet, provider,
 * buyer, models and fleet together. The macOS app calls `initialize` with its
 * Secure Enclave node key; the CLI passes a software node key in the options
 * and calls `open`.
 */

import {
	LOCAL_API_PORT,
	MIN_PROVIDER_MEMORY_BYTES,
	NETWORKS,
	generatePairingCode,
	hardwareTier,
	operatorLinkMessage,
	pairingApprovalMessage,
	pairingCodeHash,
	type HardwareProfile,
	type NetworkName,
	type PairingRecord,
	type ProviderKind,
	type ProviderRecord,
	type Signer
} from '@keeta-compute/protocol';
import { accountSigner, verifyKeetaSignature } from '@keeta-compute/protocol/keeta';
import { Buyer } from './buyer.ts';
import { ControlClient } from './control-client.ts';
import { detectHardware } from './hardware.ts';
import { enclaveNodeAccount, operatorAccount, spendAccount, type KeetaAccount } from './keys.ts';
import { KeetaLedger, SerialQueue, type Ledger } from './ledger.ts';
import { ModelManager } from './models/manager.ts';
import { Provider } from './provider.ts';
import { RpcError } from './rpc/peer.ts';
import { RPC_ERRORS, type AgentNotifications, type AgentState, type AppToAgent, type FleetHelper, type JobSummary, type WalletState } from './rpc/types.ts';
import { MlxRuntime, type Log } from './runtime/mlx.ts';
import { StateStore } from './state.ts';

export const AGENT_VERSION = '0.1.0';

export interface AppOptions {
	dataDir: string;
	/** macOS: signs with the Secure Enclave node key through the app. */
	signDigest?: (digestHex: string) => Promise<string>;
	/** Linux CLI: a software node key (keys.ts fileAccount) used instead of signDigest. */
	nodeAccount?: KeetaAccount;
	/** What this node registers as with the control plane. Defaults to 'mac'. */
	kind?: Exclude<ProviderKind, 'linux-helper'>;
	notify: <K extends keyof AgentNotifications>(method: K, params: AgentNotifications[K]) => void;
	/** Where log lines go; defaults to stderr. Lines also reach `notify` as event.log. */
	log?: Log;
	ledgerFor?: (network: NetworkName) => Ledger;
	fetchImpl?: typeof fetch;
	WebSocketImpl?: typeof WebSocket;
	buyerPort?: number;
	hardware?: HardwareProfile;
	localConditions?: () => Promise<{ onBattery: boolean; idleSeconds: number }>;
	/** Skip launching the MLX runtime (tests, non-Mac hosts). */
	noRuntime?: boolean;
}

type Params<K extends keyof AppToAgent> = AppToAgent[K]['params'];
type Result<K extends keyof AppToAgent> = Promise<AppToAgent[K]['result']>;

export class AgentApp {
	readonly store: StateStore;
	private readonly queue = new SerialQueue();
	private readonly log: Log;
	private node: KeetaAccount | null = null;
	private nodeSigner: Signer | null = null;
	private hardware: HardwareProfile | null = null;
	private control: ControlClient | null = null;
	private ledger: Ledger | null = null;
	private runtime: MlxRuntime | null = null;
	private models: ModelManager | null = null;
	private provider: Provider | null = null;
	private buyer: Buyer | null = null;
	private spend: KeetaAccount | null = null;
	private wallet: WalletState | null = null;
	private controlReachable = false;
	private walletTimer: ReturnType<typeof setInterval> | null = null;

	constructor(private readonly options: AppOptions) {
		this.store = new StateStore(options.dataDir);
		this.log = (level, message) => {
			if (options.log) {
				options.log(level, message);
			} else {
				process.stderr.write(`[${level}] ${message}\n`);
			}
			if (level !== 'debug') {
				options.notify('event.log', { level, message });
			}
		};
	}

	private requireInit() {
		if (!this.node || !this.nodeSigner || !this.control || !this.models || !this.provider || !this.buyer || !this.spend || !this.ledger) {
			throw new RpcError(RPC_ERRORS.notInitialized, 'call agent.initialize first');
		}
		return { node: this.node, nodeSigner: this.nodeSigner, control: this.control, models: this.models, provider: this.provider, buyer: this.buyer, spend: this.spend, ledger: this.ledger };
	}

	private emitState = () => {
		this.options.notify('event.state', this.state());
	};

	private onJob = (job: JobSummary) => {
		this.store.recordJob(job);
		this.options.notify('event.job', job);
		this.emitState();
	};

	state(): AgentState {
		const link = this.store.state.operatorLinks[this.store.state.network];
		return {
			version: AGENT_VERSION,
			network: this.store.state.network,
			nodeKey: this.nodeSigner?.publicKey ?? null,
			onboarded: Boolean(link),
			controlReachable: this.controlReachable,
			hardware: this.hardware,
			tier: this.hardware ? hardwareTier(this.hardware) : null,
			wallet: this.wallet,
			provider: this.provider?.status ?? null,
			buyer: this.buyer?.status ?? null
		};
	}

	/* ------------------------------------------------------------- lifecycle */

	async initialize(params: Params<'agent.initialize'>): Result<'agent.initialize'> {
		if (params.network !== 'test' && params.network !== 'main') {
			throw new RpcError(RPC_ERRORS.invalidParams, 'network must be test or main');
		}
		this.store.update((s) => {
			s.network = params.network;
			s.controlUrl = params.controlUrl.replace(/\/$/, '');
			s.relayUrl = params.relayUrl.replace(/\/$/, '');
			s.machineName = params.machineName.slice(0, 80) || 'Mac';
		});
		this.node = this.options.nodeAccount ?? enclaveNodeAccount(params.nodePublicKey, this.requireSignDigest());
		await this.setup(true);
		return this.state();
	}

	/**
	 * CLI: start from the settings already in the data directory. With
	 * `online` false nothing connects: the provider loop and the local
	 * endpoint stay off, for one-shot commands such as wallet sends.
	 */
	async open(args: { online: boolean }): Promise<AgentState> {
		if (!this.options.nodeAccount) {
			throw new RpcError(RPC_ERRORS.invalidParams, 'open needs a software node account');
		}
		this.node = this.options.nodeAccount;
		await this.setup(args.online);
		return this.state();
	}

	private requireSignDigest() {
		if (!this.options.signDigest) {
			throw new RpcError(RPC_ERRORS.invalidParams, 'no node signer configured');
		}
		return this.options.signDigest;
	}

	private async setup(online: boolean): Promise<void> {
		this.nodeSigner = accountSigner(this.node!);
		this.hardware = this.options.hardware ?? (await detectHardware(this.options.dataDir));
		if (!this.options.noRuntime && process.platform === 'darwin') {
			this.runtime ??= new MlxRuntime(this.options.dataDir, this.log);
		}
		this.models ??= new ModelManager(this.store, this.options.dataDir, this.runtime, (progress) => {
			this.options.notify('event.installProgress', progress);
			if (progress.phase === 'done' || progress.phase === 'failed') {
				this.provider?.poke();
				this.emitState();
			}
		});
		await this.startNetwork(online);
	}

	private async startNetwork(online = true): Promise<void> {
		this.provider?.stop();
		await this.buyer?.close();
		if (this.walletTimer) {
			clearInterval(this.walletTimer);
		}
		const network = this.store.state.network;
		this.control = new ControlClient(this.store.state.controlUrl, this.options.fetchImpl);
		this.ledger = this.options.ledgerFor?.(network) ?? new KeetaLedger(network);
		this.spend = spendAccount(this.options.dataDir, network);
		const spendSigner = accountSigner(this.spend);
		this.wallet = null;
		this.provider = new Provider({
			store: this.store,
			control: this.control,
			node: this.nodeSigner!,
			verify: verifyKeetaSignature,
			models: this.models!,
			runtime: this.runtime,
			kind: this.options.kind ?? 'mac',
			hardware: () => this.hardware,
			registration: () => {
				const link = this.store.state.operatorLinks[this.store.state.network];
				return link ? { payTo: link.payTo, link: { issuedAt: link.issuedAt, signature: link.signature } } : null;
			},
			log: this.log,
			onJob: this.onJob,
			onChange: this.emitState,
			...(this.options.WebSocketImpl ? { WebSocketImpl: this.options.WebSocketImpl } : {}),
			...(this.options.localConditions ? { localConditions: this.options.localConditions } : {})
		});
		this.buyer = new Buyer({
			store: this.store,
			control: this.control,
			spend: spendSigner,
			spendAccount: this.spend,
			ledger: this.ledger,
			queue: this.queue,
			verify: verifyKeetaSignature,
			log: this.log,
			onJob: this.onJob,
			...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {})
		});
		if (!online) {
			return;
		}
		const port = this.options.buyerPort ?? LOCAL_API_PORT;
		try {
			await this.buyer.listen(port);
		} catch (error) {
			this.log('error', `could not open the local endpoint on port ${port}: ${(error as Error).message}`);
		}
		this.provider.start();
		void this.checkControl();
		void this.refreshWallet().catch(() => undefined);
		this.walletTimer = setInterval(() => void this.refreshWallet().catch(() => undefined), 60_000);
		this.walletTimer.unref?.();
	}

	async checkControl(): Promise<boolean> {
		try {
			await this.control!.get(null, '/v1/config');
			this.controlReachable = true;
		} catch {
			this.controlReachable = false;
		}
		this.emitState();
		return this.controlReachable;
	}

	/** Register with the control plane now (normally the provider loop does it). Null without a wallet. */
	async register(): Promise<{ eligible: boolean } | null> {
		return this.requireInit().provider.register();
	}

	async setNetwork(params: Params<'agent.setNetwork'>): Result<'agent.setNetwork'> {
		if (params.network !== 'test' && params.network !== 'main') {
			throw new RpcError(RPC_ERRORS.invalidParams, 'network must be test or main');
		}
		this.requireInit();
		this.store.update((s) => (s.network = params.network));
		await this.startNetwork();
		return this.state();
	}

	shutdown(): void {
		this.provider?.stop();
		void this.buyer?.close();
		this.runtime?.stopAll();
		if (this.walletTimer) {
			clearInterval(this.walletTimer);
		}
	}

	/* ---------------------------------------------------------------- wallet */

	private linkedOperator(): string {
		const link = this.store.state.operatorLinks[this.store.state.network];
		if (!link) {
			throw new RpcError(RPC_ERRORS.noOperator, 'create your wallet first');
		}
		return link.payTo;
	}

	private async operatorFromEntropy(entropy: string): Promise<KeetaAccount> {
		if (!/^[0-9a-fA-F]{64}$/.test(entropy)) {
			throw new RpcError(RPC_ERRORS.invalidParams, 'entropy must be 32 bytes of hex');
		}
		const account = await operatorAccount(entropy);
		if (account.publicKeyString.get() !== this.linkedOperator()) {
			throw new RpcError(RPC_ERRORS.noOperator, this.options.kind === 'linux' ? 'this wallet is not the operator linked on this machine' : 'this passkey does not belong to the wallet on this Mac');
		}
		return account;
	}

	async setOperator(params: Params<'wallet.setOperator'>): Result<'wallet.setOperator'> {
		const { node } = this.requireInit();
		if (!/^[0-9a-fA-F]{64}$/.test(params.entropy)) {
			throw new RpcError(RPC_ERRORS.invalidParams, 'entropy must be 32 bytes of hex');
		}
		const operator = await operatorAccount(params.entropy);
		const payTo = operator.publicKeyString.get();
		const issuedAt = Date.now();
		const network = this.store.state.network;
		const signature = await accountSigner(operator).sign(operatorLinkMessage({ nodeKey: node.publicKeyString.get(), payTo, network, issuedAt }));
		/* The same passkey yields the same operator account on both networks. */
		this.store.update((s) => {
			for (const n of ['test', 'main'] as const) {
				s.operatorLinks[n] = n === network ? { payTo, network, issuedAt, signature } : s.operatorLinks[n]?.payTo === payTo ? s.operatorLinks[n] : undefined;
			}
		});
		this.provider!.poke();
		void this.refreshWallet().catch(() => undefined);
		this.emitState();
		return { operator: payTo };
	}

	async refreshWallet(): Promise<WalletState> {
		const { spend, ledger } = this.requireInit();
		const network = this.store.state.network;
		const link = this.store.state.operatorLinks[network];
		const asset = NETWORKS[network].settlementAsset;
		const base: WalletState = { operator: link?.payTo ?? null, spend: spend.publicKeyString.get(), balances: this.wallet?.balances ?? null, asset, explorer: NETWORKS[network].explorer };
		try {
			const { Account } = await import('@keeta-compute/protocol/keeta');
			const operatorBalances = link ? await ledger.balances(Account.fromPublicKeyString(link.payTo as never)) : null;
			const spendBalances = await ledger.balances(spend);
			this.wallet = {
				...base,
				balances: {
					operator: operatorBalances ? { usdc: operatorBalances.usdc.toString(), kta: operatorBalances.kta.toString() } : null,
					spend: { usdc: spendBalances.usdc.toString(), kta: spendBalances.kta.toString() }
				}
			};
		} catch (error) {
			this.wallet = { ...base, error: `balances unavailable: ${(error as Error).message}` };
		}
		this.emitState();
		return this.wallet;
	}

	private assertAmount(amount: string): bigint {
		if (!/^\d{1,30}$/.test(amount) || BigInt(amount) <= 0n) {
			throw new RpcError(RPC_ERRORS.invalidParams, 'amount must be a positive integer of base units');
		}
		return BigInt(amount);
	}

	async send(params: Params<'wallet.send'>): Result<'wallet.send'> {
		const { ledger } = this.requireInit();
		const amount = this.assertAmount(params.amount);
		const operator = await this.operatorFromEntropy(params.entropy);
		const blockHash = await this.queue.run(operator.publicKeyString.get(), () => ledger.send(operator, params.to, amount, params.asset, params.memo));
		void this.refreshWallet().catch(() => undefined);
		return { blockHash };
	}

	async fundBudget(params: Params<'wallet.fundBudget'>): Result<'wallet.fundBudget'> {
		const { ledger, spend } = this.requireInit();
		const amount = this.assertAmount(params.amount);
		const operator = await this.operatorFromEntropy(params.entropy);
		const blockHash = await this.queue.run(operator.publicKeyString.get(), () => ledger.send(operator, spend.publicKeyString.get(), amount, params.asset, 'agent-budget'));
		void this.refreshWallet().catch(() => undefined);
		return { blockHash };
	}

	async drainBudget(params: Params<'wallet.drainBudget'>): Result<'wallet.drainBudget'> {
		const { ledger, spend } = this.requireInit();
		const amount = this.assertAmount(params.amount);
		const to = this.linkedOperator();
		const blockHash = await this.queue.run(spend.publicKeyString.get(), () => ledger.send(spend, to, amount, params.asset, 'agent-budget'));
		void this.refreshWallet().catch(() => undefined);
		return { blockHash };
	}

	async requestTestFunds(): Result<'wallet.requestTestFunds'> {
		const { ledger, spend } = this.requireInit();
		if (this.store.state.network !== 'test') {
			return { requested: false, message: 'Test funds are only available on the test network.' };
		}
		const targets = [this.store.state.operatorLinks.test?.payTo, spend.publicKeyString.get()].filter((a): a is string => Boolean(a));
		try {
			let message = '';
			for (const address of targets) {
				message = await ledger.requestTestFunds(address);
			}
			return { requested: true, message };
		} catch (error) {
			return { requested: false, message: (error as Error).message };
		}
	}

	/* -------------------------------------------------------------- hardware */

	async hardwareProfile(): Result<'hardware.profile'> {
		this.hardware = this.options.hardware ?? (await detectHardware(this.options.dataDir));
		const tier = hardwareTier(this.hardware);
		const canProvide = this.hardware.memoryBytes >= MIN_PROVIDER_MEMORY_BYTES;
		return { hardware: this.hardware, tier, canProvide, ...(canProvide ? {} : { reason: 'Macs with less than 32 GB of memory can buy inference but not provide it yet.' }) };
	}

	/* ----------------------------------------------------------------- fleet */

	async createPairing(): Result<'fleet.createPairing'> {
		const { control, nodeSigner } = this.requireInit();
		const code = generatePairingCode();
		const result = await control.post<{ pairingId: string; expiresAt: number }>(nodeSigner, '/v1/pairing', { codeHash: await pairingCodeHash(code) });
		return { pairingId: result.pairingId, code, expiresAt: result.expiresAt };
	}

	async pairingStatus(params: Params<'fleet.pairingStatus'>): Result<'fleet.pairingStatus'> {
		const { control, nodeSigner } = this.requireInit();
		return control.get<PairingRecord>(nodeSigner, `/v1/pairing/${encodeURIComponent(params.pairingId)}`);
	}

	async approvePairing(params: Params<'fleet.approve'>): Result<'fleet.approve'> {
		const { control, nodeSigner } = this.requireInit();
		const pairing = await this.pairingStatus(params);
		if (pairing.status !== 'claimed' || !pairing.claim) {
			throw new RpcError(RPC_ERRORS.invalidParams, `the pairing is ${pairing.status}`);
		}
		const approvalSig = await nodeSigner.sign(pairingApprovalMessage({ pairingId: pairing.pairingId, helperNodeKey: pairing.claim.nodeKey, masterNodeKey: nodeSigner.publicKey, payTo: pairing.payTo }));
		return control.post<{ approved: boolean }>(nodeSigner, `/v1/pairing/${encodeURIComponent(params.pairingId)}/approve`, { approvalSig });
	}

	async rejectPairing(params: Params<'fleet.reject'>): Result<'fleet.reject'> {
		const { control, nodeSigner } = this.requireInit();
		return control.post<{ rejected: boolean }>(nodeSigner, `/v1/pairing/${encodeURIComponent(params.pairingId)}/reject`, {});
	}

	async fleet(): Result<'fleet.list'> {
		const { control, nodeSigner } = this.requireInit();
		const { helpers } = await control.get<{ helpers: ProviderRecord[] }>(nodeSigner, '/v1/fleet');
		return helpers.map(
			(helper): FleetHelper => ({
				nodeKey: helper.nodeKey,
				name: helper.name,
				hardware: helper.hardware,
				tier: helper.tier,
				status: helper.status,
				offers: helper.offers.map((o) => o.modelId),
				earnedTotal: helper.stats.earned,
				lastHeartbeat: helper.lastHeartbeat
			})
		);
	}

	async revoke(params: Params<'fleet.revoke'>): Result<'fleet.revoke'> {
		const { control, nodeSigner } = this.requireInit();
		return control.request<{ revoked: boolean }>(nodeSigner, 'DELETE', `/v1/fleet/${encodeURIComponent(params.nodeKey)}`);
	}

	/* --------------------------------------------------------------- handlers */

	handlers(): Record<keyof AppToAgent, (params: never) => Promise<unknown>> {
		return {
			'agent.initialize': (p: Params<'agent.initialize'>) => this.initialize(p),
			'agent.state': async () => this.state(),
			'agent.setNetwork': (p: Params<'agent.setNetwork'>) => this.setNetwork(p),
			'agent.shutdown': async () => {
				this.shutdown();
				setTimeout(() => process.exit(0), 100).unref?.();
				return { ok: true };
			},
			'wallet.setOperator': (p: Params<'wallet.setOperator'>) => this.setOperator(p),
			'wallet.refresh': () => this.refreshWallet(),
			'wallet.send': (p: Params<'wallet.send'>) => this.send(p),
			'wallet.fundBudget': (p: Params<'wallet.fundBudget'>) => this.fundBudget(p),
			'wallet.drainBudget': (p: Params<'wallet.drainBudget'>) => this.drainBudget(p),
			'wallet.requestTestFunds': () => this.requestTestFunds(),
			'hardware.profile': () => this.hardwareProfile(),
			'models.list': async () => this.requireInit().models.list(this.hardware),
			'models.install': async (p: Params<'models.install'>) => {
				this.requireInit().models.installCatalog(p.modelId, this.hardware);
				return { started: true };
			},
			'models.installCustom': async (p: Params<'models.installCustom'>) => ({ started: true, modelId: this.requireInit().models.installCustom(p.repo, p.name, p.contextLength) }),
			'models.cancelInstall': async (p: Params<'models.cancelInstall'>) => ({ cancelled: this.requireInit().models.cancel(p.modelId) }),
			'models.remove': async (p: Params<'models.remove'>) => {
				const removed = this.requireInit().models.remove(p.modelId);
				this.provider!.poke();
				return { removed };
			},
			'models.setOffer': async (p: Params<'models.setOffer'>) => {
				const model = this.requireInit().models.setOffer(p.modelId, p.offered, p.price, p.access);
				this.provider!.poke();
				this.emitState();
				return model;
			},
			'provider.status': async () => this.requireInit().provider.status,
			'provider.setPolicy': async (p: Params<'provider.setPolicy'>) => {
				const { provider } = this.requireInit();
				this.store.update((s) => {
					s.provider = { ...s.provider, ...p, schedule: { ...s.provider.schedule, ...(p.schedule ?? {}) } };
					s.provider.maxConcurrentJobs = Math.min(8, Math.max(1, Math.floor(s.provider.maxConcurrentJobs)));
				});
				provider.poke();
				this.emitState();
				return provider.status;
			},
			'buyer.status': async () => this.requireInit().buyer.status,
			'buyer.setPolicy': async (p: Params<'buyer.setPolicy'>) => {
				this.store.update((s) => {
					s.buyer = { ...s.buyer, ...p };
				});
				this.emitState();
				return this.requireInit().buyer.status;
			},
			'buyer.rotateToken': async () => {
				this.store.rotateBuyerToken();
				this.emitState();
				return this.requireInit().buyer.status;
			},
			'buyer.networkModels': () => this.requireInit().buyer.networkModels(),
			'buyer.settle': () => this.requireInit().buyer.settle(),
			'fleet.createPairing': () => this.createPairing(),
			'fleet.pairingStatus': (p: Params<'fleet.pairingStatus'>) => this.pairingStatus(p),
			'fleet.approve': (p: Params<'fleet.approve'>) => this.approvePairing(p),
			'fleet.reject': (p: Params<'fleet.reject'>) => this.rejectPairing(p),
			'fleet.list': () => this.fleet(),
			'fleet.revoke': (p: Params<'fleet.revoke'>) => this.revoke(p)
		};
	}
}
