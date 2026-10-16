/**
 * The buyer side (plan §6.1): an OpenAI-compatible endpoint on localhost for
 * agents on this Mac. Each request is scheduled by the control plane, sent
 * through the relay to a provider, and paid from the agent budget with a
 * direct send to the provider once its signed receipt arrives (plan §6.3).
 * Spend limits are enforced here; the network does not enforce them.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
	NETWORKS,
	ValidationError,
	aggregateCompletion,
	assertChatRequest,
	estimateTokens,
	jobAuthMessage,
	jobCost,
	maxJobCost,
	promptText,
	readRelayEvents,
	receiptMessage,
	requestedMaxTokens,
	timingSafeEqual,
	type ChatCompletionRequest,
	type JobEnvelope,
	type NetworkModel,
	type RelayEvent,
	type SignedReceipt,
	type SignedTicket,
	type Signer,
	type Verifier
} from '@keeta-compute/protocol';
import { ControlError, type ControlClient } from './control-client.ts';
import type { Ledger, SerialQueue } from './ledger.ts';
import type { Log } from './runtime/mlx.ts';
import type { BuyerStatus, JobSummary } from './rpc/types.ts';
import { today, type StateStore, type UnpaidReceipt } from './state.ts';

type Account = Parameters<Ledger['send']>[0];

export interface BuyerDeps {
	store: StateStore;
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
			spentToday: s.spentByDay[today()] ?? '0',
			unpaid: s.unpaid.length,
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

	close(): void {
		this.server?.close();
		this.server = null;
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
					data: models.map((m) => ({ id: m.id, object: 'model', owned_by: 'keeta-compute', keeta: { name: m.name, providers: m.providers, lowestPrice: m.lowestPrice, contextLength: m.contextLength } }))
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
				const status = error.status === 503 ? 503 : error.status === 402 ? 402 : 502;
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

	private async complete(body: ChatCompletionRequest, res: ServerResponse, signal: AbortSignal): Promise<void> {
		const { store, control, spend } = this.deps;
		const policy = store.state.buyer;
		const network = store.state.network;
		if (policy.allowedModels.length && !policy.allowedModels.includes(body.model)) {
			throw new HttpError(403, 'model_not_allowed', `${body.model} is not in this Mac's allowed models`);
		}
		const maxOutputTokens = requestedMaxTokens(body);
		const maxInputTokens = estimateTokens(promptText(body));

		const { ticket } = await control.post<{ ticket: SignedTicket; relayUrl: string }>(spend, '/v1/jobs', {
			network,
			model: body.model,
			maxInputTokens,
			maxOutputTokens,
			maxPrice: policy.maxPrice,
			...(policy.allowedProviders.length ? { allowedProviders: policy.allowedProviders } : {})
		});
		const t = ticket.ticket;
		const maxCost = maxJobCost(t.price, { maxInputTokens, maxOutputTokens });
		const spentToday = BigInt(store.state.spentByDay[today()] ?? '0');
		if (maxCost > BigInt(policy.perRequestMax)) {
			throw new HttpError(402, 'spend_limit', `this request could cost up to ${maxCost} base units, above the per-request limit of ${policy.perRequestMax}; lower max_tokens or raise the limit in the app`);
		}
		if (spentToday + maxCost > BigInt(policy.dailyMax)) {
			throw new HttpError(402, 'spend_limit', 'the daily spend limit set in the app would be exceeded');
		}

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
			throw new HttpError(502, 'provider_unavailable', 'the provider could not take the job; nothing was charged');
		}
		const summary: JobSummary = { jobId: t.jobId, role: 'buyer', modelId: t.modelId, counterparty: t.payTo, inputTokens: 0, outputTokens: 0, amount: '0', status: 'running', at: Date.now() };
		this.deps.onJob(summary);

		let receipt: SignedReceipt | undefined;
		const capture = async function* (events: AsyncIterable<RelayEvent>): AsyncGenerator<RelayEvent> {
			for await (const event of events) {
				if (event.type === 'receipt') {
					receipt = event.receipt;
				}
				yield event;
			}
		};
		const events = capture(readRelayEvents(upstream.body));

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
				return json(res, 502, { error: { code: 'provider_failed', message: `${result.error}; nothing was charged` } });
			}
			json(res, 200, result.completion, { 'x-keeta-job': t.jobId });
		}

		if (!receipt) {
			this.deps.onJob({ ...summary, status: 'failed', error: 'no receipt', at: Date.now() });
			return;
		}
		const problem = this.checkReceipt(ticket, receipt, maxCost);
		if (problem) {
			this.deps.log('warn', `not paying job ${t.jobId}: ${problem}`);
			this.deps.onJob({ ...summary, status: 'failed', error: problem, at: Date.now() });
			return;
		}
		const unpaid: UnpaidReceipt = { jobId: t.jobId, network, payTo: t.payTo, amount: receipt.receipt.amount, asset: t.asset, receipt, attempts: 0 };
		store.update((s) => s.unpaid.push(unpaid));
		store.addToDay('spentByDay', BigInt(receipt.receipt.amount));
		this.deps.onJob({ ...summary, inputTokens: receipt.receipt.inputTokens, outputTokens: receipt.receipt.outputTokens, amount: receipt.receipt.amount, status: 'completed', at: Date.now() });
		void this.pay(unpaid);
	}

	checkReceipt(ticket: SignedTicket, signed: SignedReceipt, maxCost: bigint): string | null {
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
		const amount = jobCost(t.price, { inputTokens: r.inputTokens, outputTokens: r.outputTokens });
		if (r.amount !== amount.toString() || amount > maxCost) {
			return 'receipt amount does not match the price';
		}
		return null;
	}

	/** Pay one receipt from the agent budget, then report it. Payments from one account are serialized. */
	private pay(unpaid: UnpaidReceipt): Promise<boolean> {
		const { ledger, queue, store, control, spend, spendAccount } = this.deps;
		return queue.run(spend.publicKey, async () => {
			try {
				let blockHash = unpaid.blockHash;
				if (!blockHash) {
					blockHash = await ledger.send(spendAccount, unpaid.payTo, BigInt(unpaid.amount), 'usdc', unpaid.jobId);
					store.update((s) => {
						const entry = s.unpaid.find((u) => u.jobId === unpaid.jobId);
						if (entry) {
							entry.blockHash = blockHash;
						}
					});
				}
				await control.post(spend, `/v1/jobs/${unpaid.jobId}/payment`, { blockHash, receipt: unpaid.receipt });
				store.update((s) => {
					s.unpaid = s.unpaid.filter((u) => u.jobId !== unpaid.jobId);
					const job = s.jobs.find((j) => j.jobId === unpaid.jobId && j.role === 'buyer');
					if (job) {
						job.status = 'paid';
					}
				});
				const job = store.state.jobs.find((j) => j.jobId === unpaid.jobId && j.role === 'buyer');
				if (job) {
					this.deps.onJob(job);
				}
				return true;
			} catch (error) {
				this.deps.log('warn', `payment for ${unpaid.jobId} failed: ${(error as Error).message}`);
				store.update((s) => {
					const entry = s.unpaid.find((u) => u.jobId === unpaid.jobId);
					if (entry) {
						entry.attempts += 1;
						entry.lastError = (error as Error).message;
					}
				});
				return false;
			}
		});
	}

	async settle(): Promise<{ paid: number; failed: number }> {
		let paid = 0;
		let failed = 0;
		for (const unpaid of [...this.deps.store.state.unpaid]) {
			if (unpaid.network !== this.deps.store.state.network) {
				continue;
			}
			if (await this.pay(unpaid)) {
				paid++;
			} else {
				failed++;
			}
		}
		return { paid, failed };
	}

	/** The asset buyers pay in, for display. */
	get asset() {
		return NETWORKS[this.deps.store.state.network].settlementAsset;
	}
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
	res.writeHead(status, { 'content-type': 'application/json', ...headers });
	res.end(JSON.stringify(body));
}
