/**
 * The provider loop (plan §5.3): register, heartbeat with offers, hold an
 * outbound connection to the relay, and run jobs the control plane ticketed
 * for this node — after independently re-checking every ticket.
 */

import {
	HEARTBEAT_INTERVAL_MS,
	canonicalJSON,
	findAsset,
	chunkText,
	findCatalogModel,
	assertChatRequest,
	jobAuthMessage,
	jobCost,
	maxOutputTokensFor,
	promptTokenBound,
	receiptMessage,
	sha256Hex,
	ticketMessage,
	usableModelMemory,
	type HardwareProfile,
	type JobEnvelope,
	type Offer,
	type ProviderFrame,
	type ProviderKind,
	type Receipt,
	type RelayFrame,
	type SignedReceipt,
	type Signer,
	type Log,
	type Verifier,
	utcDay
} from '@keeta-compute/protocol';
import { ControlError, type ControlClient } from '@keeta-compute/protocol/client';
import type { JobSummary, ProviderStatus } from '@keeta-compute/protocol/rpc';
import type { MlxRuntime } from '@keeta-compute/runtime-mlx';
import { streamChat, type Backend } from '@keeta-compute/runtime-openai';
import type { PromptCount } from '@keeta-compute/tokens';
import { idleSeconds, onBattery } from './hardware.ts';
import type { ModelManager, StoredModel } from './models/manager.ts';
import type { ProviderStore } from './store.ts';

export interface ProviderDeps {
	store: ProviderStore;
	control: ControlClient;
	node: Signer;
	verify: Verifier;
	models: ModelManager;
	runtime: MlxRuntime | null;
	kind: ProviderKind;
	hardware: () => HardwareProfile | null;
	/** Registration fields beyond the basics (mac, linux: payTo + link proof). Null when not ready (no wallet yet). */
	registration: () => Record<string, unknown> | null;
	log: Log;
	onJob: (job: JobSummary) => void;
	onChange: () => void;
	/**
	 * What the operator earned, read from the ledger (the settlement
	 * account's payouts to it); zero where nothing reads it, as on a helper,
	 * whose earnings land in its master's wallet.
	 */
	earnings?: () => { today: string; total: string };
	WebSocketImpl?: typeof WebSocket;
	/** Counts a prompt exactly with its model's pinned tokenizer; without it (or a pin), prompts are sized by their bytes. */
	countPrompt?: PromptCount;
	/** Testing: skip battery/idle probes. */
	localConditions?: () => Promise<{ onBattery: boolean; idleSeconds: number }>;
}

type ProviderState = ProviderStatus['state'];

export class Provider {
	private timer: ReturnType<typeof setTimeout> | null = null;
	private socket: WebSocket | null = null;
	private relay: { url: string; token: string; expiresAt: number } | null = null;
	private coordinatorKey: string | null = null;
	private registeredKey: string | null = null;
	private eligible = true;
	private state: ProviderState = 'offline';
	private readonly active = new Map<string, AbortController>();
	/** Running jobs the buyer hung up on (the relay's cancel), as opposed to this node stopping. */
	private readonly hungUp = new Set<string>();
	/** Job ids already run or running, until shortly after their tickets expire. */
	private readonly claimed = new Map<string, number>();
	private readonly pendingReceipts: SignedReceipt[] = [];
	/* Stopped until start(), so a poke on a provider that was never started (CLI one-shot commands) stays offline. */
	private stopped = true;
	private reconnectDelay = 1000;
	/** The credit token app tickets are paid in, from the heartbeat. */
	private creditToken: string | null = null;

	constructor(private readonly deps: ProviderDeps) {}

	get status(): ProviderStatus {
		const s = this.deps.store.state;
		const day = utcDay();
		const earned = this.deps.earnings?.() ?? { today: '0', total: '0' };
		return {
			policy: s.provider,
			state: this.state,
			activeJobs: this.active.size,
			earnedToday: earned.today,
			earnedTotal: earned.total,
			tokensServedToday: s.tokensByDay[day] ?? 0,
			recentJobs: s.jobs.filter((j) => j.role === 'provider').slice(0, 50)
		};
	}

	start(): void {
		this.stopped = false;
		void this.tick();
	}

	stop(): void {
		this.stopped = true;
		if (this.timer) {
			clearTimeout(this.timer);
		}
		this.socket?.close();
		this.socket = null;
		for (const controller of this.active.values()) {
			controller.abort();
		}
	}

	/** Re-evaluate now (policy or offers changed). */
	poke(): void {
		if (this.timer) {
			clearTimeout(this.timer);
		}
		void this.tick();
	}

	private setState(state: ProviderState) {
		if (state !== this.state) {
			this.state = state;
			this.deps.onChange();
		}
	}

	private async localState(): Promise<ProviderState> {
		const policy = this.deps.store.state.provider;
		if (!policy.enabled) {
			return 'paused';
		}
		if (!this.eligible) {
			return 'not-eligible';
		}
		const conditions = this.deps.localConditions ? await this.deps.localConditions() : { onBattery: await onBattery(), idleSeconds: await idleSeconds() };
		if (policy.pauseOnBattery && conditions.onBattery) {
			return 'on-battery';
		}
		if (policy.schedule.mode === 'hours') {
			const hour = new Date().getHours();
			const start = policy.schedule.startHour ?? 0;
			const end = policy.schedule.endHour ?? 24;
			const inside = start <= end ? hour >= start && hour < end : hour >= start || hour < end;
			if (!inside) {
				return 'outside-schedule';
			}
		}
		/* The operator is back: stop taking jobs now, as the other schedules do. A running job still finishes (readyOffers keeps its model up). */
		if (policy.schedule.mode === 'idle' && conditions.idleSeconds < (policy.schedule.idleMinutes ?? 10) * 60) {
			return 'outside-schedule';
		}
		if (!this.deps.models.models.some((m) => m.offer.offered)) {
			return 'no-offers';
		}
		return 'online';
	}

	/** Offered models that are ready to serve, starting MLX servers as memory allows. */
	private async readyOffers(serve: boolean): Promise<Offer[]> {
		const offers: Offer[] = [];
		const hardware = this.deps.hardware();
		let memoryLeft = hardware ? usableModelMemory(hardware) : Number.POSITIVE_INFINITY;
		const offered = this.deps.models.models.filter((m) => m.offer.offered);
		for (const model of offered) {
			const catalog = findCatalogModel(model.modelId);
			let build: string;
			let kind: Offer['runtime']['kind'];
			if (model.backend) {
				kind = 'openai-compatible';
				build = `openai-compatible ${new URL(model.backend.baseUrl).host}`;
			} else {
				if (!this.deps.runtime) {
					continue;
				}
				const needs = catalog?.memoryBytes ?? model.sizeBytes * 1.2;
				if (needs > memoryLeft) {
					this.deps.runtime.stop(model.modelId);
					continue;
				}
				if (!serve) {
					/* A model server stays up while jobs run, and stops at the first heartbeat after they finish. */
					if (this.active.size === 0) {
						this.deps.runtime.stop(model.modelId);
					}
					continue;
				}
				try {
					await this.deps.runtime.start(model.modelId, model.path);
				} catch (error) {
					this.deps.log('warn', `could not start ${model.modelId}: ${(error as Error).message}`);
					continue;
				}
				memoryLeft -= needs;
				kind = 'mlx';
				build = await this.deps.runtime.runtimeBuild();
			}
			const policy = this.deps.store.state.provider;
			offers.push({
				modelId: model.modelId,
				weightsHash: model.weightsHash,
				runtime: { kind, build },
				price: model.offer.price,
				access: model.offer.access ?? policy.access,
				contextLength: model.contextLength ?? catalog?.contextLength ?? 8192
			});
		}
		return offers;
	}

	private async tick(): Promise<void> {
		if (this.stopped) {
			return;
		}
		try {
			await this.beat();
		} catch (error) {
			this.deps.log('warn', `provider heartbeat failed: ${(error as Error).message}`);
			if (error instanceof ControlError && error.status === 404) {
				this.registeredKey = null;
			}
			if (this.state === 'online' || this.state === 'connecting') {
				this.setState('offline');
			}
		} finally {
			if (!this.stopped) {
				this.timer = setTimeout(() => void this.tick(), HEARTBEAT_INTERVAL_MS);
			}
		}
	}

	/** Register (or re-register after a change) with the control plane. Null when there is no wallet yet. */
	async register(): Promise<{ eligible: boolean } | null> {
		const registration = this.deps.registration();
		const hardware = this.deps.hardware();
		if (!registration || !hardware) {
			return null;
		}
		await this.ensureRegistered(registration, hardware);
		return { eligible: this.eligible };
	}

	private async ensureRegistered(registration: Record<string, unknown>, hardware: HardwareProfile): Promise<void> {
		const { store, control, node } = this.deps;
		const registrationKey = canonicalJSON({ registration, network: store.state.network, name: store.state.machineName });
		if (this.registeredKey === registrationKey) {
			return;
		}
		const result = await control.post<{ eligible: boolean }>(node, '/v1/providers/register', {
			network: store.state.network,
			kind: this.deps.kind,
			name: store.state.machineName,
			hardware,
			...registration
		});
		this.eligible = result.eligible;
		this.registeredKey = registrationKey;
	}

	private async beat(): Promise<void> {
		const { store, control, node } = this.deps;
		const registration = this.deps.registration();
		const hardware = this.deps.hardware();
		if (!registration || !hardware) {
			this.setState(store.state.provider.enabled ? 'not-eligible' : 'paused');
			return;
		}
		if (!this.coordinatorKey) {
			const config = await control.get<{ coordinatorKey: string }>(null, '/v1/config');
			this.coordinatorKey = config.coordinatorKey;
		}
		await this.ensureRegistered(registration, hardware);
		const local = await this.localState();
		const offers = await this.readyOffers(local === 'online');
		const online = local === 'online' && offers.length > 0;
		const result = await control.post<{ status: string; eligible: boolean; relayUrl: string; relayToken: string; relayTokenExpiresAt: number; creditToken?: string | null }>(node, '/v1/providers/heartbeat', {
			status: online ? 'online' : 'paused',
			offers,
			access: store.state.provider.access,
			load: { active: this.active.size, capacity: store.state.provider.maxConcurrentJobs }
		});
		this.eligible = result.eligible;
		this.creditToken = result.creditToken ?? null;
		this.relay = { url: result.relayUrl, token: result.relayToken, expiresAt: result.relayTokenExpiresAt };
		await this.flushReceipts();
		if (online) {
			this.ensureSocket();
			this.setState(this.socket?.readyState === 1 ? 'online' : 'connecting');
		} else {
			this.setState(!this.eligible ? 'not-eligible' : local === 'online' ? 'no-offers' : local);
			if (this.active.size === 0) {
				this.socket?.close();
				this.socket = null;
			}
		}
	}

	private ensureSocket(): void {
		if (this.socket || !this.relay) {
			return;
		}
		const WS = this.deps.WebSocketImpl ?? WebSocket;
		const base = this.relay.url.replace(/^http/, 'ws');
		const url = `${base}/v1/provider/connect?nodeKey=${encodeURIComponent(this.deps.node.publicKey)}&exp=${this.relay.expiresAt}&token=${this.relay.token}`;
		const socket = new WS(url);
		this.socket = socket;
		socket.addEventListener('open', () => {
			this.reconnectDelay = 1000;
			this.deps.log('info', 'connected to the relay');
			this.setState('online');
		});
		socket.addEventListener('message', (event) => {
			void this.onFrame(String(event.data));
		});
		const closed = () => {
			if (this.socket !== socket) {
				return;
			}
			this.socket = null;
			if (this.stopped || this.state !== 'online') {
				return;
			}
			this.setState('connecting');
			setTimeout(() => {
				if (!this.stopped) {
					this.ensureSocket();
				}
			}, this.reconnectDelay);
			this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
		};
		socket.addEventListener('close', closed);
		socket.addEventListener('error', closed);
	}

	private send(frame: ProviderFrame): void {
		if (this.socket?.readyState === 1) {
			this.socket.send(JSON.stringify(frame));
		}
	}

	private async onFrame(raw: string): Promise<void> {
		let frame: RelayFrame;
		try {
			frame = JSON.parse(raw) as RelayFrame;
		} catch {
			return;
		}
		if (frame.type === 'ping') {
			this.send({ type: 'pong' });
		} else if (frame.type === 'cancel') {
			if (this.active.has(frame.id)) {
				this.hungUp.add(frame.id);
			}
			this.active.get(frame.id)?.abort();
		} else if (frame.type === 'job') {
			await this.runJob(frame.id, frame.envelope);
		}
	}

	/** Every check the node makes itself before running anything (plan §5.5 step 3, §6.2). */
	async checkJob(envelope: JobEnvelope): Promise<{ model: StoredModel; promptTokens: number | null } | { error: string; code: string }> {
		const state = this.deps.store.state;
		const signed = envelope?.ticket;
		const ticket = signed?.ticket;
		if (!ticket || !this.coordinatorKey || !this.deps.verify(this.coordinatorKey, ticketMessage(ticket), signed.coordinatorSig)) {
			return { code: 'invalid_ticket', error: 'ticket is not signed by the coordinator' };
		}
		if (ticket.nodeKey !== this.deps.node.publicKey || ticket.network !== state.network) {
			return { code: 'invalid_ticket', error: 'ticket is for another node or network' };
		}
		if (ticket.expiresAt < Date.now()) {
			return { code: 'ticket_expired', error: 'ticket expired' };
		}
		/* App jobs are paid in credits (escrowed with keeta.ai); router jobs in a pinned stablecoin, paid to this node's operator. */
		const assetOk = ticket.paymentMode === 'escrow' ? Boolean(this.creditToken) && ticket.asset === this.creditToken : ticket.paymentMode === 'prepaid' && Boolean(findAsset(state.network, ticket.asset));
		if (!assetOk) {
			return { code: 'invalid_ticket', error: 'ticket asset is not the credit token or a pinned stablecoin' };
		}
		const model = this.deps.models.installed(ticket.modelId);
		if (!model || !model.offer.offered) {
			return { code: 'model_not_offered', error: `${ticket.modelId} is not offered here` };
		}
		if (model.offer.price.inputPerMillion !== ticket.price.inputPerMillion || model.offer.price.outputPerMillion !== ticket.price.outputPerMillion) {
			return { code: 'price_changed', error: 'the price changed since the ticket was issued' };
		}
		const access = model.offer.access ?? state.provider.access;
		if (access.mode === 'allowlist' && (ticket.paymentMode !== 'escrow' || !access.allow.includes(ticket.buyer))) {
			return { code: 'not_allowed', error: 'this provider only serves listed buyers' };
		}
		if (ticket.paymentMode === 'escrow') {
			if (!envelope.buyerSig || !this.deps.verify(ticket.buyer, await jobAuthMessage(ticket.jobId, envelope.request), envelope.buyerSig)) {
				return { code: 'invalid_buyer_signature', error: 'the request is not signed by the paying key' };
			}
		}
		if (envelope.request.model !== ticket.modelId) {
			return { code: 'invalid_request', error: 'request model does not match the ticket' };
		}
		/* The ticket prices at most maxInputTokens; refuse a larger prompt rather than prefill it unpaid. */
		try {
			assertChatRequest(envelope.request);
		} catch (error) {
			return { code: 'invalid_request', error: (error as Error).message };
		}
		/* With a pinned tokenizer the node counts the prompt exactly, the way the buyer priced it; otherwise it sizes it by its bytes. */
		let promptTokens: number | null;
		try {
			promptTokens = this.deps.countPrompt ? await this.deps.countPrompt(ticket.modelId, envelope.request, { localDir: model.path }) : null;
		} catch (error) {
			return { code: 'model_failed', error: `could not load the ${ticket.modelId} tokenizer to count the prompt: ${(error as Error).message}` };
		}
		if ((promptTokens ?? promptTokenBound(envelope.request)) > ticket.maxInputTokens) {
			return { code: 'invalid_request', error: 'the prompt is larger than the ticket allows' };
		}
		if (this.state !== 'online' || this.active.size >= state.provider.maxConcurrentJobs) {
			return { code: 'busy', error: 'provider is not taking jobs right now' };
		}
		return { model, promptTokens };
	}

	private async backendFor(model: StoredModel): Promise<Backend> {
		if (model.backend) {
			return model.backend;
		}
		if (!this.deps.runtime) {
			throw new Error('no runtime');
		}
		return this.deps.runtime.start(model.modelId, model.path);
	}

	private async runJob(id: string, envelope: JobEnvelope): Promise<void> {
		const ticket = envelope.ticket?.ticket;
		/* A ticket runs once: claim its job id before any await so a replay or a duplicate delivery is refused. */
		const jobId = typeof ticket?.jobId === 'string' ? ticket.jobId : null;
		if (jobId && this.claimed.has(jobId)) {
			this.send({ type: 'error', id, code: 'ticket_used', message: 'this ticket was already used' });
			return;
		}
		if (jobId) {
			this.claimed.set(jobId, typeof ticket.expiresAt === 'number' ? ticket.expiresAt : Date.now());
			for (const [claimedId, expiresAt] of this.claimed) {
				if (expiresAt < Date.now() - 60_000) {
					this.claimed.delete(claimedId);
				}
			}
		}
		let checked = await this.checkJob(envelope);
		/* Re-check capacity with no await before taking the slot, so concurrent deliveries cannot both pass. */
		if (!('error' in checked) && this.active.size >= this.deps.store.state.provider.maxConcurrentJobs) {
			checked = { code: 'busy', error: 'provider is not taking jobs right now' };
		}
		if ('error' in checked) {
			this.deps.log('warn', `rejected job ${ticket?.jobId ?? '?'}: ${checked.error}`);
			this.send({ type: 'error', id, code: checked.code, message: checked.error });
			if (ticket?.jobId && ticket.nodeKey === this.deps.node.publicKey) {
				/* Free the slot the scheduler reserved for this ticket. */
				await this.deps.control.post(this.deps.node, `/v1/jobs/${ticket.jobId}/fail`, { error: checked.error }).catch(() => undefined);
			}
			return;
		}
		const { model, promptTokens } = checked;
		const controller = new AbortController();
		this.active.set(id, controller);
		const startedAt = Date.now();
		const summary: JobSummary = {
			jobId: ticket.jobId,
			role: 'provider',
			modelId: ticket.modelId,
			counterparty: ticket.buyer,
			inputTokens: 0,
			outputTokens: 0,
			amount: '0',
			status: 'running',
			at: startedAt
		};
		this.deps.onJob(summary);
		/* What the buyer has actually been sent, so a cancelled job can still be billed for it. */
		let delivered = '';
		let deliveredChunks = 0;
		const bill = async (usage: { inputTokens: number; outputTokens: number; text: string; finishReason: string }) => {
			const inputTokens = Math.min(usage.inputTokens, ticket.maxInputTokens);
			/* Never bill more output than the delivered text can hold; the buyer refuses such receipts. */
			const outputTokens = Math.min(usage.outputTokens, ticket.maxOutputTokens, maxOutputTokensFor(usage.text));
			const amount = jobCost(ticket.price, { inputTokens, outputTokens });
			const runtimeBuild = model.backend ? `openai-compatible ${new URL(model.backend.baseUrl).host}` : await this.deps.runtime!.runtimeBuild();
			const receipt: Receipt = {
				v: 1,
				jobId: ticket.jobId,
				network: ticket.network,
				nodeKey: this.deps.node.publicKey,
				payTo: ticket.payTo,
				buyer: ticket.buyer,
				modelId: ticket.modelId,
				weightsHash: model.weightsHash,
				runtime: { kind: model.backend ? 'openai-compatible' : 'mlx', build: runtimeBuild },
				inputTokens,
				outputTokens,
				price: ticket.price,
				amount: amount.toString(),
				asset: ticket.asset,
				startedAt,
				finishedAt: Date.now(),
				outputHash: await sha256Hex(usage.text),
				finishReason: usage.finishReason
			};
			const signed: SignedReceipt = { receipt, signature: await this.deps.node.sign(receiptMessage(receipt)) };
			this.send({ type: 'receipt', id, receipt: signed });
			this.pendingReceipts.push(signed);
			void this.flushReceipts();
			this.deps.store.update((s) => {
				const day = utcDay();
				s.tokensByDay[day] = (s.tokensByDay[day] ?? 0) + outputTokens;
			});
			this.deps.onJob({ ...summary, inputTokens, outputTokens, amount: amount.toString(), status: 'completed', at: Date.now() });
		};
		try {
			const requested = envelope.request.max_completion_tokens ?? envelope.request.max_tokens ?? ticket.maxOutputTokens;
			const result = await streamChat(await this.backendFor(model), envelope.request, {
				networkModelId: ticket.modelId,
				maxOutputTokens: Math.min(requested, ticket.maxOutputTokens),
				signal: controller.signal,
				onChunk: (data) => {
					const piece = chunkText(data);
					if (piece) {
						delivered += piece;
						deliveredChunks += 1;
					}
					this.send({ type: 'chunk', id, data });
				}
			});
			/* A server that reports no usage leaves the prompt to an estimate; the exact count replaces it when there is one. */
			const inputTokens = result.exactUsage || promptTokens === null ? result.inputTokens : promptTokens;
			await bill({ ...result, inputTokens, finishReason: controller.signal.aborted ? 'cancelled' : result.finishReason });
		} catch (error) {
			if (controller.signal.aborted && delivered) {
				/*
				 * The buyer hung up after receiving text: bill what was sent instead of
				 * failing the job unpaid. The model's prompt count only arrives at the end
				 * of the stream, and the prompt was already read in full, so the input is
				 * billed at the exact count, or without a pinned tokenizer at the bound the
				 * ticket priced and the buyer escrowed; an estimate would let a dense
				 * prompt (CJK, say) pay for a fraction of its tokens.
				 */
				await bill({ inputTokens: promptTokens ?? promptTokenBound(envelope.request), outputTokens: deliveredChunks, text: delivered, finishReason: 'cancelled' }).catch((billError: Error) =>
					this.deps.log('warn', `could not bill cancelled job ${ticket.jobId}: ${billError.message}`)
				);
				return;
			}
			if (this.hungUp.has(id)) {
				/* The buyer hung up before any text: not this node's failure. The relay recorded when, and the escrow settles from that record. */
				this.deps.onJob({ ...summary, status: 'failed', error: 'cancelled by the buyer', at: Date.now() });
				return;
			}
			const message = controller.signal.aborted ? 'stopped on this node' : (error as Error).message;
			this.send({ type: 'error', id, code: 'model_failed', message });
			this.deps.onJob({ ...summary, status: 'failed', error: message, at: Date.now() });
			try {
				await this.deps.control.post(this.deps.node, `/v1/jobs/${ticket.jobId}/fail`, { error: message });
			} catch {
				/* the control plane expires it */
			}
		} finally {
			this.active.delete(id);
			this.hungUp.delete(id);
			this.deps.onChange();
		}
	}

	private async flushReceipts(): Promise<void> {
		while (this.pendingReceipts.length > 0) {
			const signed = this.pendingReceipts[0]!;
			try {
				await this.deps.control.post(this.deps.node, `/v1/jobs/${signed.receipt.jobId}/receipt`, { receipt: signed });
			} catch (error) {
				if (error instanceof ControlError && error.status === 409) {
					/* Already filed, or the job settled without it. */
				} else if (error instanceof ControlError && error.status >= 400 && error.status < 500) {
					this.deps.log('warn', `control plane refused receipt ${signed.receipt.jobId}: ${error.message}`);
				} else {
					return; /* retry on the next heartbeat */
				}
			}
			this.pendingReceipts.shift();
		}
	}
}
