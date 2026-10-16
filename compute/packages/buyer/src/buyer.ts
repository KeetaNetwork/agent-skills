/**
 * The buyer side (plan §6.1): an OpenAI-compatible endpoint on localhost for
 * agents on this Mac. Each request is quoted by the control plane, paid for
 * up front by escrowing its maximum cost in Keeta Compute Credits from the
 * agent budget to keeta.ai's settlement account, then sent through the relay
 * to the provider once the ticket is issued (plan §6.3). The control plane
 * pays the provider what the relay saw delivered and refunds the rest, all
 * on the ledger. Spend limits are enforced here; the network does not
 * enforce them.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
	CREDIT_SYMBOL,
	ValidationError,
	aggregateCompletion,
	assertChatRequest,
	chunkText,
	formatAmount,
	jobAuthMessage,
	jobCost,
	maxJobCost,
	maxOutputTokensFor,
	promptTokenBound,
	readRelayEvents,
	receiptMessage,
	requestedMaxTokens,
	sha256Hex,
	timingSafeEqual,
	type ChatCompletionRequest,
	type EscrowQuote,
	type JobEnvelope,
	type JobRecord,
	type NetworkModel,
	type RelayEvent,
	type SignedReceipt,
	type SignedTicket,
	type Signer,
	type Log,
	type Verifier,
	utcDay
} from '@keeta-compute/protocol';
import { ControlError, type ControlClient } from '@keeta-compute/protocol/client';
import type { BuyerStatus, JobSummary } from '@keeta-compute/protocol/rpc';
import { promptTokenLimit, type PromptCount } from '@keeta-compute/tokens';
import type { Ledger, SerialQueue } from '@keeta-compute/wallet';
import type { BuyerStore, PendingEscrow } from './store.ts';

/** How long to keep reporting an escrow the control plane has not confirmed. */
const ESCROW_REPORT_WINDOW_MS = 24 * 60 * 60_000;
/** Waits between reports while the escrow block is still reaching the ledger. */
const ESCROW_RETRY_MS = [0, 500, 1_000, 2_000, 4_000, 8_000];

/** What the buyer actually received, which a receipt must match. */
export interface Delivery {
	outputHash: string;
	maxOutputTokens: number;
}

async function deliveryOf(text: string): Promise<Delivery> {
	return { outputHash: await sha256Hex(text), maxOutputTokens: maxOutputTokensFor(text) };
}

type Account = Parameters<Ledger['send']>[0];

export interface BuyerDeps {
	store: BuyerStore;
	control: ControlClient;
	/** Signs as the agent budget account; its address is the buyer identity providers allowlist. */
	spend: Signer;
	spendAccount: Account;
	ledger: Ledger;
	queue: SerialQueue;
	verify: Verifier;
	log: Log;
	onJob: (job: JobSummary) => void;
	fetchImpl?: typeof fetch;
	/** Counts a prompt exactly with its model's pinned tokenizer; without it (or a pin), prompts are priced by their size. */
	countPrompt?: PromptCount;
	/** Waits between escrow reports; defaults to ESCROW_RETRY_MS. */
	escrowRetryMs?: number[];
}

class HttpError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string
	) {
		super(message);
	}
}

const encoder = new TextEncoder();

export class Buyer {
	private server: Server | null = null;
	private port = 0;
	/** Jobs whose escrow is being sent now: one escrow per job. */
	private readonly escrowing = new Set<string>();
	/** The follow-up in progress; overlapping calls share it. */
	private following: Promise<{ reported: number; settled: number }> | null = null;

	constructor(private readonly deps: BuyerDeps) {}

	get endpoint(): string {
		return `http://127.0.0.1:${this.port}/v1`;
	}

	get status(): BuyerStatus {
		const s = this.deps.store.state;
		const { token, ...policy } = s.buyer;
		return {
			endpoint: this.endpoint,
			token,
			policy,
			spentToday: s.spentByDay[utcDay()] ?? '0',
			recentJobs: s.jobs.filter((j) => j.role === 'buyer').slice(0, 50)
		};
	}

	listen(port: number): Promise<void> {
		return new Promise((resolve, reject) => {
			const server = createServer((req, res) => void this.handle(req, res));
			server.on('error', reject);
			server.listen(port, '127.0.0.1', () => {
				const address = server.address();
				this.port = typeof address === 'object' && address ? address.port : port;
				this.server = server;
				resolve();
			});
		});
	}

	/** Stops the local endpoint; resolves once the port is free again. */
	close(): Promise<void> {
		const server = this.server;
		this.server = null;
		if (!server) {
			return Promise.resolve();
		}
		return new Promise((resolve) => {
			server.close(() => resolve());
			server.closeAllConnections();
		});
	}

	private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		try {
			/* Browsers send Origin; local agents don't. Refuse web pages calling the endpoint. */
			const origin = req.headers.origin;
			if (origin && origin !== 'null') {
				throw new HttpError(403, 'forbidden', 'browser requests are not accepted');
			}
			const auth = req.headers.authorization ?? '';
			const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
			if (!timingSafeEqual(token, this.deps.store.state.buyer.token)) {
				throw new HttpError(401, 'unauthorized', 'use the API token shown in the Keeta Compute app');
			}
			const url = new URL(req.url ?? '/', 'http://localhost');
			if (req.method === 'GET' && url.pathname === '/v1/models') {
				const models = await this.networkModels();
				return json(res, 200, {
					object: 'list',
					data: models.map((m) => ({
						id: m.id,
						object: 'model',
						owned_by: 'keeta-compute',
						keeta: { name: m.name, providers: m.providers, lowestPrice: m.lowestPrice, priceUnit: 'credit base units per million tokens', contextLength: m.contextLength }
					}))
				});
			}
			if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
				const chunks: Buffer[] = [];
				for await (const chunk of req) {
					chunks.push(chunk as Buffer);
				}
				let body: ChatCompletionRequest;
				try {
					body = assertChatRequest(JSON.parse(Buffer.concat(chunks).toString('utf8')));
				} catch (error) {
					throw new HttpError(400, 'invalid_request', error instanceof ValidationError ? error.message : 'body must be a JSON chat completion request');
				}
				const abort = new AbortController();
				res.on('close', () => abort.abort());
				return await this.complete(body, res, abort.signal);
			}
			throw new HttpError(404, 'not_found', `${req.method} ${url.pathname} is not supported`);
		} catch (error) {
			if (res.headersSent) {
				res.end();
				return;
			}
			if (error instanceof HttpError) {
				return json(res, error.status, { error: { code: error.code, message: error.message, type: error.code } });
			}
			if (error instanceof ControlError) {
				const status = error.status === 503 || error.status === 429 || error.status === 402 ? error.status : 502;
				return json(res, status, { error: { code: error.code, message: error.message, type: error.code } });
			}
			this.deps.log('error', `buyer request failed: ${(error as Error).message}`);
			return json(res, 500, { error: { code: 'internal', message: (error as Error).message } });
		}
	}

	async networkModels(): Promise<NetworkModel[]> {
		const { models } = await this.deps.control.get<{ models: NetworkModel[] }>(null, `/v1/models?network=${this.deps.store.state.network}`);
		const allowed = this.deps.store.state.buyer.allowedModels;
		return allowed.length ? models.filter((m) => allowed.includes(m.id)) : models;
	}

	/**
	 * The most prompt tokens a ticket pays for: the exact count plus a small
	 * margin when the model's tokenizer is pinned, so a provider cannot bill
	 * more input than the prompt has; otherwise the prompt's size bound.
	 */
	private async inputLimit(body: ChatCompletionRequest): Promise<number> {
		const counted = this.deps.countPrompt
			? await this.deps.countPrompt(body.model, body).catch((error: Error) => {
					this.deps.log('warn', `could not count the prompt for ${body.model} (${error.message}); pricing it by its size`);
					return null;
				})
			: null;
		return counted === null ? promptTokenBound(body) : promptTokenLimit(counted);
	}

	private async complete(body: ChatCompletionRequest, res: ServerResponse, signal: AbortSignal): Promise<void> {
		const { store, control, spend } = this.deps;
		const policy = store.state.buyer;
		const network = store.state.network;
		if (policy.allowedModels.length && !policy.allowedModels.includes(body.model)) {
			throw new HttpError(403, 'model_not_allowed', `${body.model} is not in this Mac's allowed models`);
		}
		const maxOutputTokens = requestedMaxTokens(body);
		const maxInputTokens = await this.inputLimit(body);

		const { job, quote } = await control.post<{ job: JobRecord; quote: EscrowQuote; relayUrl: string }>(spend, '/v1/jobs', {
			network,
			model: body.model,
			maxInputTokens,
			maxOutputTokens,
			maxPrice: policy.maxPrice,
			...(policy.allowedProviders.length ? { allowedProviders: policy.allowedProviders } : {})
		});
		let ticket: SignedTicket;
		try {
			this.checkQuote(job, quote, { maxInputTokens, maxOutputTokens });
			ticket = await this.escrow(quote);
		} catch (error) {
			/* Give the quote back so the provider is free at once; an escrow that did go out is refunded. */
			await this.cancel(quote.jobId);
			throw error;
		}
		try {
			return await this.run(body, res, signal, ticket);
		} catch (error) {
			/* Hand the ticket back; the job settles from the relay's record and the rest of the escrow comes back. */
			await this.cancel(quote.jobId);
			throw error;
		}
	}

	/** The quote must be for what was asked, and fit this Mac's spend limits, before any credits move. */
	private checkQuote(job: JobRecord, quote: EscrowQuote, limits: { maxInputTokens: number; maxOutputTokens: number }): void {
		const policy = this.deps.store.state.buyer;
		const maxCost = BigInt(quote.maxCost);
		if (job.jobId !== quote.jobId || job.asset !== quote.token || maxCost !== maxJobCost(job.price, limits)) {
			throw new HttpError(502, 'invalid_quote', 'the control plane quoted a job other than the one requested');
		}
		const credits = (amount: bigint | string) => `${formatAmount(BigInt(amount), quote.decimals)} ${CREDIT_SYMBOL}`;
		if (maxCost > BigInt(policy.perRequestMax)) {
			throw new HttpError(402, 'spend_limit', `this request could cost up to ${credits(maxCost)}, above the per-request limit of ${credits(policy.perRequestMax)}; lower max_tokens or raise the limit in the app`);
		}
		const spentToday = BigInt(this.deps.store.state.spentByDay[utcDay()] ?? '0');
		if (spentToday + maxCost > BigInt(policy.dailyMax)) {
			throw new HttpError(402, 'spend_limit', 'the daily spend limit set in the app would be exceeded');
		}
	}

	/**
	 * Pay at ticket time: send the quote's maximum cost in credits from the
	 * agent budget to the settlement account, referencing the job, then report
	 * the block until the control plane sees it on the ledger and issues the
	 * ticket. One escrow per job: a second call for the same job is refused,
	 * and the send runs in the budget's queue after re-reading the stored
	 * escrows, so a block an earlier run already sent is reported again
	 * instead of sending another.
	 */
	private async escrow(quote: EscrowQuote): Promise<SignedTicket> {
		if (this.escrowing.has(quote.jobId)) {
			throw new HttpError(409, 'escrow_in_progress', `job ${quote.jobId} is already being escrowed`);
		}
		this.escrowing.add(quote.jobId);
		try {
			return await this.escrowOnce(quote);
		} finally {
			this.escrowing.delete(quote.jobId);
		}
	}

	private async escrowOnce(quote: EscrowQuote): Promise<SignedTicket> {
		const { ledger, queue, store, spend, spendAccount } = this.deps;
		let pending: PendingEscrow;
		try {
			pending = await queue.run(spend.publicKey, async () => {
				const sent = store.state.escrows.find((e) => e.jobId === quote.jobId);
				if (sent) {
					return sent;
				}
				const blockHash = await ledger.send(spendAccount, quote.settlement, BigInt(quote.maxCost), quote.token, quote.jobId);
				const entry: PendingEscrow = { jobId: quote.jobId, network: quote.network, blockHash, at: Date.now() };
				store.update((s) => s.escrows.push(entry));
				return entry;
			});
		} catch (error) {
			throw new HttpError(
				402,
				'insufficient_credits',
				`could not escrow ${formatAmount(BigInt(quote.maxCost), quote.decimals)} ${CREDIT_SYMBOL} from the agent budget (${(error as Error).message}); buy credits in the app`
			);
		}
		const ticket = await this.reportEscrow(pending, this.deps.escrowRetryMs ?? ESCROW_RETRY_MS);
		if (!ticket) {
			throw new HttpError(504, 'escrow_pending', 'the escrow has not reached the ledger yet; it is reported again later and refunded, since this request was not run');
		}
		return ticket;
	}

	/**
	 * Report an escrow block until the control plane confirms it: the ticket,
	 * or null while the block is still on its way. A refusal (the quote
	 * expired, so the escrow is refunded, or the block does not escrow the
	 * job) ends it; either way the escrow is no longer pending here.
	 */
	private async reportEscrow(pending: PendingEscrow, delays: number[]): Promise<SignedTicket | null> {
		const { control, spend, store } = this.deps;
		const done = () => store.update((s) => (s.escrows = s.escrows.filter((e) => e.jobId !== pending.jobId)));
		for (const delay of delays) {
			if (delay) {
				await new Promise((resolve) => setTimeout(resolve, delay).unref?.());
			}
			try {
				const result = await control.post<{ ticket?: SignedTicket; pending?: boolean }>(spend, `/v1/jobs/${pending.jobId}/escrow`, { blockHash: pending.blockHash });
				if (result.ticket) {
					done();
					return result.ticket;
				}
			} catch (error) {
				if (error instanceof ControlError && error.status >= 400 && error.status < 500 && error.status !== 429) {
					done();
					throw error;
				}
				this.deps.log('warn', `escrow for ${pending.jobId} not confirmed yet: ${(error as Error).message}`);
			}
		}
		return null;
	}

	private async run(body: ChatCompletionRequest, res: ServerResponse, signal: AbortSignal, ticket: SignedTicket): Promise<void> {
		const { store, spend } = this.deps;
		const t = ticket.ticket;
		const request: ChatCompletionRequest = { ...body, stream: true, stream_options: { include_usage: true } };
		const envelope: JobEnvelope = { ticket, request, buyerSig: await spend.sign(await jobAuthMessage(t.jobId, request)) };
		const fetchImpl = this.deps.fetchImpl ?? fetch;
		const upstream = await fetchImpl(`${store.state.relayUrl}/v1/jobs/${t.jobId}/run`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(envelope),
			signal
		});
		if (!upstream.ok || !upstream.body) {
			throw new HttpError(502, 'provider_unavailable', 'the provider could not take the job; its escrow is refunded');
		}
		const summary: JobSummary = { jobId: t.jobId, role: 'buyer', modelId: t.modelId, counterparty: t.payTo, inputTokens: 0, outputTokens: 0, amount: '0', status: 'running', at: Date.now() };
		this.deps.onJob(summary);

		let receipt: SignedReceipt | undefined;
		/* The text this buyer received, rebuilt exactly as the provider hashes it into the receipt. */
		let delivered = '';
		const capture = async function* (events: AsyncIterable<RelayEvent>): AsyncGenerator<RelayEvent> {
			for await (const event of events) {
				if (event.type === 'receipt') {
					receipt = event.receipt;
				} else if (event.type === 'chunk') {
					delivered += chunkText(event.data);
				}
				yield event;
			}
		};
		const events = capture(readRelayEvents(upstream.body));
		let failure: unknown;

		try {
			if (body.stream) {
				res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-keeta-job': t.jobId });
				for await (const event of events) {
					if (event.type === 'chunk') {
						res.write(encoder.encode(`data: ${JSON.stringify(event.data)}\n\n`));
					} else if (event.type === 'error') {
						res.write(encoder.encode(`data: ${JSON.stringify({ error: { code: event.code, message: event.message } })}\n\n`));
					}
				}
				res.write('data: [DONE]\n\n');
				res.end();
			} else {
				const result = await aggregateCompletion(events, body.model);
				if (result.error && !receipt) {
					this.deps.onJob({ ...summary, status: 'failed', error: result.error, at: Date.now() });
					void this.cancel(t.jobId);
					return json(res, 502, { error: { code: 'provider_failed', message: `${result.error}; the escrow is refunded` } });
				}
				json(res, 200, result.completion, { 'x-keeta-job': t.jobId });
			}
		} catch (error) {
			if (!receipt && !delivered) {
				throw error;
			}
			/* Text already arrived, so the provider bills it from the escrow; record that below, then report the failure. */
			failure = error;
		}
		if (!receipt) {
			if (delivered) {
				/* The caller hung up or the stream broke after text arrived. The relay's record settles it; followUp() reads the outcome. */
				void this.cancel(t.jobId);
				this.deps.onJob({ ...summary, status: 'running', error: 'stream ended early; settling from the relay record', at: Date.now() });
				return this.endAfterFailure(res, failure, signal);
			}
			this.deps.onJob({ ...summary, status: 'failed', error: 'no receipt', at: Date.now() });
			void this.cancel(t.jobId);
			return;
		}
		this.record(ticket, receipt, await deliveryOf(delivered), summary);
		this.endAfterFailure(res, failure, signal);
	}

	/** Answer a caller whose stream broke after its text was billed: an error if nothing was sent yet, else end the stream. */
	private endAfterFailure(res: ServerResponse, failure: unknown, signal: AbortSignal): void {
		if (failure === undefined || signal.aborted || res.writableEnded) {
			return;
		}
		if (!res.headersSent) {
			json(res, 502, { error: { code: 'provider_failed', message: (failure as Error).message } });
		} else {
			res.end();
		}
	}

	/**
	 * Record a receipt. Nothing is paid here: the escrow already covers it,
	 * and the control plane pays the provider only what the relay's delivery
	 * record backs. A receipt that does not bill the text this buyer received
	 * is logged; the relay's record decides it.
	 */
	private record(ticket: SignedTicket, receipt: SignedReceipt, delivery: Delivery, summary: JobSummary): void {
		const r = receipt.receipt;
		const invalid = this.checkReceipt(ticket, receipt, null);
		if (invalid) {
			this.deps.log('warn', `job ${ticket.ticket.jobId}: ${invalid}; the control plane refunds the escrow`);
			this.deps.onJob({ ...summary, status: 'failed', error: invalid, at: Date.now() });
			return;
		}
		const mismatch = this.checkReceipt(ticket, receipt, delivery);
		if (mismatch) {
			this.deps.log('warn', `job ${ticket.ticket.jobId}: ${mismatch}; the relay's delivery record decides the charge`);
		}
		/* Counted against the daily limit as billed; a refund after a mismatch does not give it back. */
		this.deps.store.addToDay('spentByDay', BigInt(r.amount));
		this.deps.onJob({ ...summary, inputTokens: r.inputTokens, outputTokens: r.outputTokens, amount: r.amount, status: 'completed', ...(mismatch ? { error: mismatch } : {}), at: Date.now() });
	}

	/** Problems with a receipt, or null. With `delivery`, it must also bill exactly the text received. */
	checkReceipt(ticket: SignedTicket, signed: SignedReceipt, delivery: Delivery | null): string | null {
		const t = ticket.ticket;
		const r = signed.receipt;
		if (!this.deps.verify(t.nodeKey, receiptMessage(r), signed.signature)) {
			return 'receipt signature does not verify';
		}
		if (r.jobId !== t.jobId || r.nodeKey !== t.nodeKey || r.payTo !== t.payTo || r.buyer !== t.buyer || r.modelId !== t.modelId || r.asset !== t.asset) {
			return 'receipt does not match the ticket';
		}
		if (r.outputTokens > t.maxOutputTokens || r.inputTokens > t.maxInputTokens) {
			return 'receipt exceeds the token limits';
		}
		/* Bind the bill to what arrived: the same text, and no more tokens than that text can hold. */
		if (delivery && r.outputHash !== delivery.outputHash) {
			return 'receipt output does not match the text received';
		}
		if (delivery && r.outputTokens > delivery.maxOutputTokens) {
			return 'receipt bills more output tokens than the text received';
		}
		const amount = jobCost(t.price, { inputTokens: r.inputTokens, outputTokens: r.outputTokens });
		if (r.amount !== amount.toString() || amount > maxJobCost(t.price, t)) {
			return 'receipt amount does not match the price';
		}
		return null;
	}

	/** Give back a quote or ticket this buyer will not use. Best effort: unused tickets also lapse on their own. */
	private async cancel(jobId: string): Promise<void> {
		await this.deps.control.post(this.deps.spend, `/v1/jobs/${jobId}/cancel`, {}).catch(() => undefined);
	}

	/**
	 * Catch up after being offline or after a request ended early: report
	 * escrows the control plane has not confirmed (a ticket issued for one now
	 * is handed back, so it is refunded), and update recent jobs from how
	 * they settled. Overlapping calls (the wallet timer, a hang-up, the app)
	 * share one run, so a job's outcome is counted once.
	 */
	followUp(): Promise<{ reported: number; settled: number }> {
		if (!this.following) {
			this.following = this.followUpOnce().finally(() => {
				this.following = null;
			});
		}
		return this.following;
	}

	private async followUpOnce(): Promise<{ reported: number; settled: number }> {
		const { store, control, spend } = this.deps;
		const network = store.state.network;
		let reported = 0;
		for (const pending of store.state.escrows.filter((e) => e.network === network && !this.escrowing.has(e.jobId))) {
			if (Date.now() - pending.at > ESCROW_REPORT_WINDOW_MS) {
				this.deps.log('warn', `escrow ${pending.blockHash} for ${pending.jobId} was never confirmed; check the settlement account's refunds`);
				store.update((s) => (s.escrows = s.escrows.filter((e) => e.jobId !== pending.jobId)));
				continue;
			}
			try {
				const ticket = await this.reportEscrow(pending, [0]);
				if (ticket) {
					await this.cancel(pending.jobId);
				}
				reported++;
			} catch (error) {
				this.deps.log('info', `escrow for ${pending.jobId}: ${(error as Error).message}`);
				reported++;
			}
		}
		const open = store.state.jobs.filter((j) => j.role === 'buyer' && (j.status === 'running' || j.status === 'completed'));
		if (open.length === 0) {
			return { reported, settled: 0 };
		}
		let jobs: JobRecord[];
		try {
			({ jobs } = await control.get<{ jobs: JobRecord[] }>(spend, '/v1/jobs'));
		} catch (error) {
			this.deps.log('warn', `could not look up how jobs settled: ${(error as Error).message}`);
			return { reported, settled: 0 };
		}
		let settled = 0;
		for (const summary of open) {
			const job = jobs.find((j) => j.jobId === summary.jobId);
			if (!job?.settlement?.blockHash) {
				continue;
			}
			settled++;
			const billed = job.receipt?.receipt;
			if (job.settlement.reason === 'delivered' && billed) {
				if (summary.status === 'running') {
					store.addToDay('spentByDay', BigInt(billed.amount), billed.finishedAt);
				}
				this.deps.onJob({ ...summary, inputTokens: billed.inputTokens, outputTokens: billed.outputTokens, amount: billed.amount, status: 'paid', at: Date.now() });
			} else {
				this.deps.onJob({ ...summary, amount: '0', status: 'failed', error: `refunded (${job.settlement.reason})`, at: Date.now() });
			}
		}
		return { reported, settled };
	}
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
	res.writeHead(status, { 'content-type': 'application/json', ...headers });
	res.end(JSON.stringify(body));
}
