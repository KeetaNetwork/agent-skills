import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NO_SHOW_FEE, escrowAmount, jobCost, receiptMessage, sha256Hex, sseData, sseEvent, utcDay, type Receipt, type SignedTicket } from '@keeta-compute/protocol';
import type { ControlClient } from '@keeta-compute/protocol/client';
import { Account, accountSigner, verifyKeetaSignature } from '@keeta-compute/protocol/keeta';
import { SerialQueue } from '@keeta-compute/wallet';
import { Buyer, type BuyerState, type BuyerStore } from '../src/index.ts';

/** The buyer's saved state, kept in memory: the agent's StateStore keeps the same fields in a file. */
class MemoryBuyerStore implements BuyerStore {
	readonly state: BuyerState = {
		network: 'test',
		relayUrl: 'http://127.0.0.1:1',
		buyer: {
			token: 'kc_test',
			perRequestMax: '250000',
			dailyMax: '5000000',
			allowedModels: [],
			allowedProviders: [],
			maxPrice: { inputPerMillion: '2000000', outputPerMillion: '6000000' }
		},
		escrows: [],
		jobs: [],
		spentByDay: {}
	};

	update(mutate: (state: BuyerState) => void): BuyerState {
		mutate(this.state);
		return this.state;
	}

	addToDay(field: 'spentByDay', amount: bigint, now = Date.now()): void {
		const day = utcDay(now);
		this.state[field][day] = (BigInt(this.state[field][day] ?? '0') + amount).toString();
	}
}

test('the buyer refuses receipts that do not match the ticket', async () => {
	const node = accountSigner(Account.fromSeed(Account.generateRandomSeed({ asString: true }) as string, 0));
	const buyerAccount = Account.fromSeed(Account.generateRandomSeed({ asString: true }) as string, 0);
	const payTo = accountSigner(Account.fromSeed(Account.generateRandomSeed({ asString: true }) as string, 0)).publicKey;
	const price = { inputPerMillion: '100000', outputPerMillion: '400000' };
	const ticket = {
		ticket: { jobId: 'job_1', nodeKey: node.publicKey, payTo, buyer: buyerAccount.publicKeyString.get(), modelId: 'qwen3-8b', asset: 'keeta_asset', price, maxInputTokens: 100, maxOutputTokens: 100 },
		signature: '',
		relayMac: ''
	} as unknown as SignedTicket;
	const base: Receipt = {
		v: 1,
		jobId: 'job_1',
		network: 'test',
		nodeKey: node.publicKey,
		payTo,
		buyer: buyerAccount.publicKeyString.get(),
		modelId: 'qwen3-8b',
		weightsHash: 'a'.repeat(64),
		runtime: { kind: 'mlx', build: 'test' },
		inputTokens: 50,
		outputTokens: 80,
		price,
		amount: jobCost(price, { inputTokens: 50, outputTokens: 80 }).toString(),
		asset: 'keeta_asset',
		startedAt: 1,
		finishedAt: 2,
		outputHash: 'b'.repeat(64),
		finishReason: 'stop'
	};
	const sign = async (receipt: Receipt) => ({ receipt, signature: await node.sign(receiptMessage(receipt)) });
	const buyer = new Buyer({
		store: new MemoryBuyerStore(),
		control: {} as ControlClient,
		spend: accountSigner(buyerAccount),
		spendAccount: buyerAccount,
		ledger: { balances: async () => ({ kta: 0n, tokens: {} }), send: async () => '', received: async () => [], requestTestFunds: async () => '' },
		queue: new SerialQueue(),
		verify: verifyKeetaSignature,
		log: () => undefined,
		onJob: () => undefined
	});
	const delivery = { outputHash: 'b'.repeat(64), maxOutputTokens: 100 };
	assert.equal(buyer.checkReceipt(ticket, await sign(base), delivery), null);
	assert.equal(buyer.checkReceipt(ticket, await sign({ ...base, outputHash: 'c'.repeat(64) }), null), null, 'without the delivery, only the ticket terms are checked');
	assert.match(buyer.checkReceipt(ticket, await sign({ ...base, payTo: node.publicKey }), delivery)!, /does not match/);
	assert.match(buyer.checkReceipt(ticket, await sign({ ...base, asset: 'keeta_other' }), delivery)!, /does not match/, 'billed in another token than the escrow');
	assert.match(buyer.checkReceipt(ticket, await sign({ ...base, outputTokens: 101, amount: '41' }), delivery)!, /token limits/);
	const negative = { inputTokens: -1_000_000_000, outputTokens: 80 };
	assert.match(buyer.checkReceipt(ticket, await sign({ ...base, ...negative, amount: jobCost(price, negative).toString() }), delivery)!, /non-negative integers/, 'a negative count would bill a negative amount');
	assert.match(buyer.checkReceipt(ticket, await sign({ ...base, outputTokens: 1.5 }), delivery)!, /non-negative integers/);
	assert.match(buyer.checkReceipt(ticket, await sign({ ...base, amount: '999' }), delivery)!, /amount/);
	assert.match(buyer.checkReceipt(ticket, { ...(await sign(base)), signature: (await sign({ ...base, inputTokens: 1 })).signature }, delivery)!, /signature/);
	assert.match(buyer.checkReceipt(ticket, await sign(base), { ...delivery, outputHash: 'c'.repeat(64) })!, /text received/);
	assert.match(buyer.checkReceipt(ticket, await sign(base), { ...delivery, maxOutputTokens: 79 })!, /more output tokens/, 'a short answer cannot bill the full cap');
});

test('the buyer escrows a job once, and a follow-up never hands back a job whose escrow it is still confirming', async (t) => {
	const spendAccount = Account.fromSeed(Account.generateRandomSeed({ asString: true }) as string, 0);
	const spend = accountSigner(spendAccount);
	const price = { inputPerMillion: '100000', outputPerMillion: '400000' };
	const sends: Array<{ to: string; amount: bigint; asset: string; reference?: string }> = [];
	const posts: string[] = [];
	let confirmed = false;
	let quoted: { jobId: string; maxCost: bigint; limits: { maxInputTokens: number; maxOutputTokens: number } } | null = null;
	/* The control plane's side: a quote priced from the request, and the escrow pending until `confirmed`. */
	const control = {
		post: async (_signer: unknown, path: string, body: Record<string, number>) => {
			posts.push(path);
			if (path === '/v1/jobs') {
				const limits = { maxInputTokens: body.maxInputTokens!, maxOutputTokens: body.maxOutputTokens! };
				quoted = { jobId: 'job_1', maxCost: escrowAmount(price, limits), limits };
				const job = { jobId: 'job_1', asset: 'keeta_credits', price, ...limits };
				return { job, quote: { jobId: 'job_1', network: 'test', maxCost: quoted.maxCost.toString(), token: 'keeta_credits', decimals: 6, settlement: 'keeta_settlement', expiresAt: Date.now() + 60_000 } };
			}
			if (path === '/v1/jobs/job_1/escrow') {
				const ticket = { jobId: 'job_1', modelId: 'qwen3-8b', payTo: 'keeta_provider', nodeKey: 'keeta_node', price, ...quoted!.limits };
				return confirmed ? { ticket: { ticket, coordinatorSig: '', relayMac: '' } } : { pending: true };
			}
			return {};
		},
		get: async () => ({ jobs: [] })
	} as unknown as ControlClient;
	const store = new MemoryBuyerStore();
	const buyer = new Buyer({
		store,
		control,
		spend,
		spendAccount,
		ledger: {
			balances: async () => ({ kta: 0n, tokens: {} }),
			send: async (_from, to, amount, asset, reference) => {
				sends.push({ to, amount, asset, ...(reference ? { reference } : {}) });
				return 'B'.repeat(64);
			},
			received: async () => [],
			requestTestFunds: async () => ''
		},
		queue: new SerialQueue(),
		verify: verifyKeetaSignature,
		log: () => undefined,
		onJob: () => undefined,
		/* The provider is unreachable, so the job is handed back after its escrow. */
		fetchImpl: (async () => new Response('', { status: 502 })) as typeof fetch,
		escrowRetryMs: [0, 100, 100, 100]
	});
	await buyer.listen(0);
	t.after(() => buyer.close());

	const response = fetch(`${buyer.endpoint}/chat/completions`, {
		method: 'POST',
		headers: { authorization: `Bearer ${store.state.buyer.token}`, 'content-type': 'application/json' },
		body: JSON.stringify({ model: 'qwen3-8b', messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 })
	});
	while (!posts.includes('/v1/jobs/job_1/escrow')) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	/* The escrow is on the ledger now; the wallet timer and the app follow up while the request waits to report it again. */
	confirmed = true;
	const followUps = [buyer.followUp(), buyer.followUp()];
	assert.equal(followUps[0], followUps[1], 'overlapping follow-ups share one run');
	assert.deepEqual(await followUps[0], { reported: 0, settled: 0 }, 'the request in flight reports its own escrow');
	assert.equal(posts.filter((p) => p.endsWith('/cancel')).length, 0, 'a follow-up does not hand back a job that is about to run');

	assert.equal((await response).status, 502);
	assert.deepEqual(sends, [{ to: 'keeta_settlement', amount: quoted!.maxCost, asset: 'keeta_credits', reference: 'job_1' }], 'one escrow send, of the quoted maximum, referencing the job');
	assert.equal(posts.filter((p) => p.endsWith('/cancel')).length, 1, 'handed back once, by the request itself');
	assert.deepEqual(store.state.escrows, [], 'the confirmed escrow is no longer pending');
});

test("a job's spend is counted once when a follow-up and the job's own receipt reach it together, in either order", async (t) => {
	const spendAccount = Account.fromSeed(Account.generateRandomSeed({ asString: true }) as string, 0);
	const spend = accountSigner(spendAccount);
	const price = { inputPerMillion: '100000', outputPerMillion: '400000' };
	const store = new MemoryBuyerStore();
	const deferred = <T>() => {
		let resolve!: (value: T) => void;
		const promise = new Promise<T>((done) => (resolve = done));
		return { promise, resolve };
	};
	let jobs = 0;
	const tickets = new Map<string, Record<string, unknown>>();
	/* The provider streams "Hello", then sends its receipt when the test lets it: 12 in + 3 out bills 3 base units. */
	const receiptGates = new Map<string, ReturnType<typeof deferred<void>>>();
	const outputHash = await sha256Hex('Hello');
	const receiptFor = (jobId: string) => {
		const ticket = tickets.get(jobId)!;
		const receipt: Receipt = {
			v: 1,
			jobId,
			network: 'test',
			nodeKey: ticket.nodeKey as string,
			payTo: ticket.payTo as string,
			buyer: spend.publicKey,
			modelId: 'qwen3-8b',
			weightsHash: 'a'.repeat(64),
			runtime: { kind: 'mlx', build: 'test' },
			inputTokens: 12,
			outputTokens: 3,
			price,
			amount: jobCost(price, { inputTokens: 12, outputTokens: 3 }).toString(),
			asset: 'keeta_credits',
			startedAt: 1,
			finishedAt: Date.now(),
			outputHash,
			finishReason: 'stop'
		};
		return { receipt, signature: '' };
	};
	const settledJob = (jobId: string) => ({ jobId, receipt: receiptFor(jobId), settlement: { blockHash: 'S'.repeat(64), reason: 'delivered' } });
	/* How the control plane answers a follow-up's job lookup; the test decides when. */
	let jobsReply = deferred<{ jobs: unknown[] }>();
	const control = {
		post: async (_signer: unknown, path: string, body: Record<string, number>) => {
			if (path === '/v1/jobs') {
				const jobId = `job_${++jobs}`;
				const limits = { maxInputTokens: body.maxInputTokens!, maxOutputTokens: body.maxOutputTokens! };
				tickets.set(jobId, { jobId, modelId: 'qwen3-8b', payTo: 'keeta_provider', nodeKey: 'keeta_node', buyer: spend.publicKey, asset: 'keeta_credits', price, ...limits });
				const job = { jobId, asset: 'keeta_credits', price, ...limits };
				return { job, quote: { jobId, network: 'test', maxCost: escrowAmount(price, limits).toString(), token: 'keeta_credits', decimals: 6, settlement: 'keeta_settlement', expiresAt: Date.now() + 60_000 } };
			}
			const escrowed = /^\/v1\/jobs\/(job_\d+)\/escrow$/.exec(path);
			if (escrowed) {
				return { ticket: { ticket: tickets.get(escrowed[1]!), coordinatorSig: '', relayMac: '' } };
			}
			return {};
		},
		get: async () => jobsReply.promise
	} as unknown as ControlClient;
	const buyer = new Buyer({
		store,
		control,
		spend,
		spendAccount,
		ledger: { balances: async () => ({ kta: 0n, tokens: {} }), send: async () => 'B'.repeat(64), received: async () => [], requestTestFunds: async () => '' },
		queue: new SerialQueue(),
		verify: () => true,
		log: () => undefined,
		/* As the agent does: the latest state of each job, in the store. */
		onJob: (job) =>
			store.update((s) => {
				const index = s.jobs.findIndex((j) => j.jobId === job.jobId && j.role === job.role);
				if (index >= 0) {
					s.jobs[index] = job;
				} else {
					s.jobs.unshift(job);
				}
			}),
		fetchImpl: (async (url: string) => {
			const jobId = /\/v1\/jobs\/(job_\d+)\/run$/.exec(url)![1]!;
			const gate = deferred<void>();
			receiptGates.set(jobId, gate);
			const body = new ReadableStream<Uint8Array>({
				async start(controller) {
					controller.enqueue(sseData({ id: 'c1', choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: 'stop' }] }));
					await gate.promise;
					controller.enqueue(sseEvent('keeta.receipt', receiptFor(jobId)));
					controller.close();
				}
			});
			return new Response(body, { status: 200 });
		}) as typeof fetch
	});
	await buyer.listen(0);
	t.after(() => buyer.close());

	const request = () =>
		fetch(`${buyer.endpoint}/chat/completions`, {
			method: 'POST',
			headers: { authorization: `Bearer ${store.state.buyer.token}`, 'content-type': 'application/json' },
			body: JSON.stringify({ model: 'qwen3-8b', messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 })
		});
	const statusOf = (jobId: string) => store.state.jobs.find((j) => j.jobId === jobId)?.status;
	const spent = () => store.state.spentByDay[utcDay()] ?? '0';
	const waitFor = async (what: string, done: () => boolean) => {
		for (let i = 0; i < 400 && !done(); i++) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		assert.ok(done(), `timed out waiting for ${what}`);
	};

	/* The wallet timer's follow-up reads the running job and waits on the control plane; the receipt arrives meanwhile and is counted. */
	const first = request();
	await waitFor('the first job to run', () => statusOf('job_1') === 'running');
	const following = buyer.followUp();
	receiptGates.get('job_1')!.resolve();
	assert.equal((await first).status, 200);
	await waitFor('the first receipt to be recorded', () => statusOf('job_1') === 'completed');
	assert.equal(spent(), '3');
	jobsReply.resolve({ jobs: [settledJob('job_1')] });
	assert.deepEqual(await following, { reported: 0, settled: 1 });
	assert.equal(statusOf('job_1'), 'paid');
	assert.equal(spent(), '3', 'the follow-up does not count again what the receipt counted');

	/* The other way round: a follow-up reads the job settled (and counts it) before its receipt reaches the request. */
	const second = request();
	await waitFor('the second job to run', () => statusOf('job_2') === 'running');
	jobsReply = deferred();
	jobsReply.resolve({ jobs: [settledJob('job_1'), settledJob('job_2')] });
	assert.deepEqual(await buyer.followUp(), { reported: 0, settled: 1 });
	assert.equal(statusOf('job_2'), 'paid');
	assert.equal(spent(), '6');
	receiptGates.get('job_2')!.resolve();
	assert.equal((await second).status, 200);
	/* Long enough for the request to record its receipt, which hashes the text first. */
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal(statusOf('job_2'), 'paid', 'a late receipt does not reopen a settled job');
	assert.equal(spent(), '6', 'the late receipt does not count the job again');
});

test('the daily spend counts what each escrow paid, on the day the job ran here, whatever receipt the provider streamed', async (t) => {
	const spendAccount = Account.fromSeed(Account.generateRandomSeed({ asString: true }) as string, 0);
	const spend = accountSigner(spendAccount);
	const price = { inputPerMillion: '100000', outputPerMillion: '400000' };
	const store = new MemoryBuyerStore();
	const outputHash = await sha256Hex('Hello');
	const tickets = new Map<string, Record<string, unknown>>();
	/* The usage each job's streamed receipt claims; the receipt the provider files with the control plane bills 12 in + 3 out (3 base units) and says it finished at the epoch. */
	const streamed = new Map<string, { inputTokens: number; outputTokens: number }>();
	let nextStreamed = { inputTokens: 12, outputTokens: 3 };
	const receiptFor = (jobId: string, usage: { inputTokens: number; outputTokens: number }, finishedAt: number) => {
		const ticket = tickets.get(jobId)!;
		const receipt: Receipt = {
			v: 1,
			jobId,
			network: 'test',
			nodeKey: ticket.nodeKey as string,
			payTo: ticket.payTo as string,
			buyer: spend.publicKey,
			modelId: 'qwen3-8b',
			weightsHash: 'a'.repeat(64),
			runtime: { kind: 'mlx', build: 'test' },
			...usage,
			price,
			amount: jobCost(price, usage).toString(),
			asset: 'keeta_credits',
			startedAt: 0,
			finishedAt,
			outputHash,
			finishReason: 'stop'
		};
		return { receipt, signature: '' };
	};
	const control = {
		post: async (_signer: unknown, path: string, body: Record<string, number>) => {
			if (path === '/v1/jobs') {
				const jobId = `job_${tickets.size + 1}`;
				const limits = { maxInputTokens: body.maxInputTokens!, maxOutputTokens: body.maxOutputTokens! };
				tickets.set(jobId, { jobId, modelId: 'qwen3-8b', payTo: 'keeta_provider', nodeKey: 'keeta_node', buyer: spend.publicKey, asset: 'keeta_credits', price, ...limits });
				streamed.set(jobId, nextStreamed);
				return { job: { jobId, asset: 'keeta_credits', price, ...limits }, quote: { jobId, network: 'test', maxCost: escrowAmount(price, limits).toString(), token: 'keeta_credits', decimals: 6, settlement: 'keeta_settlement', expiresAt: Date.now() + 60_000 } };
			}
			const escrowed = /^\/v1\/jobs\/(job_\d+)\/escrow$/.exec(path);
			if (escrowed) {
				return { ticket: { ticket: tickets.get(escrowed[1]!), coordinatorSig: '', relayMac: '' } };
			}
			return {};
		},
		get: async () => ({
			jobs: [...tickets.keys()].map((jobId) => ({ jobId, receipt: receiptFor(jobId, { inputTokens: 12, outputTokens: 3 }, 0), settlement: { blockHash: 'S'.repeat(64), reason: 'delivered' } }))
		})
	} as unknown as ControlClient;
	const buyer = new Buyer({
		store,
		control,
		spend,
		spendAccount,
		ledger: { balances: async () => ({ kta: 0n, tokens: {} }), send: async () => 'B'.repeat(64), received: async () => [], requestTestFunds: async () => '' },
		queue: new SerialQueue(),
		verify: () => true,
		log: () => undefined,
		onJob: (job) =>
			store.update((s) => {
				const index = s.jobs.findIndex((j) => j.jobId === job.jobId);
				if (index >= 0) {
					s.jobs[index] = job;
				} else {
					s.jobs.unshift(job);
				}
			}),
		/* The provider streams "Hello" and a receipt claiming `streamed` usage, signed with its own key. */
		fetchImpl: (async (url: string) => {
			const jobId = /\/v1\/jobs\/(job_\d+)\/run$/.exec(url)![1]!;
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(sseData({ id: 'c1', choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: 'stop' }] }));
					controller.enqueue(sseEvent('keeta.receipt', receiptFor(jobId, streamed.get(jobId)!, Date.now())));
					controller.close();
				}
			});
			return new Response(body, { status: 200 });
		}) as typeof fetch
	});
	await buyer.listen(0);
	t.after(() => buyer.close());

	const jobOf = (jobId: string) => store.state.jobs.find((j) => j.jobId === jobId);
	const spent = () => store.state.spentByDay[utcDay()] ?? '0';
	const recorded = async (jobId: string) => {
		for (let i = 0; i < 400 && jobOf(jobId)?.status === 'running' && !jobOf(jobId)?.error; i++) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
	};
	const request = async () => {
		const response = await fetch(`${buyer.endpoint}/chat/completions`, {
			method: 'POST',
			headers: { authorization: `Bearer ${store.state.buyer.token}`, 'content-type': 'application/json' },
			body: JSON.stringify({ model: 'qwen3-8b', messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 })
		});
		assert.equal(response.status, 200);
		return response.headers.get('x-keeta-job')!;
	};

	/* A streamed receipt with a negative count prices a negative amount: it is not counted, and the job waits for its settlement. */
	nextStreamed = { inputTokens: -1_000_000_000, outputTokens: 3 };
	const negative = await request();
	await recorded(negative);
	assert.equal(spent(), '0', 'the day\'s spend never goes down');
	assert.equal(jobOf(negative)?.status, 'running');
	assert.match(jobOf(negative)!.error!, /non-negative integers/);

	/* A streamed receipt billing less than the one the control plane pays is counted, then topped up to what was paid. */
	nextStreamed = { inputTokens: 0, outputTokens: 0 };
	const cheap = await request();
	await recorded(cheap);
	assert.equal(jobOf(cheap)?.status, 'completed');
	assert.equal(spent(), '0');

	/* The control plane paid each provider 3 base units from the escrow, on a receipt that says it finished in 1970: both count today. */
	assert.deepEqual(await buyer.followUp(), { reported: 0, settled: 2 });
	assert.deepEqual([jobOf(negative)?.status, jobOf(cheap)?.status], ['paid', 'paid']);
	assert.equal(spent(), '6');
	assert.deepEqual(Object.keys(store.state.spentByDay), [utcDay()], 'nothing is filed under the provider\'s own dates');
});

test('a ticket that never reaches the relay settles as a no-show the daily limit counts, and a leftover escrow is refunded rather than ticketed', async (t) => {
	const spendAccount = Account.fromSeed(Account.generateRandomSeed({ asString: true }) as string, 0);
	const spend = accountSigner(spendAccount);
	const price = { inputPerMillion: '100000', outputPerMillion: '400000' };
	const store = new MemoryBuyerStore();
	const posts: string[] = [];
	let settled: unknown[] = [];
	const control = {
		post: async (_signer: unknown, path: string, body: Record<string, number>) => {
			posts.push(path);
			if (path === '/v1/jobs') {
				const limits = { maxInputTokens: body.maxInputTokens!, maxOutputTokens: body.maxOutputTokens! };
				const job = { jobId: 'job_1', asset: 'keeta_credits', price, ...limits };
				return { job, quote: { jobId: 'job_1', network: 'test', maxCost: escrowAmount(price, limits).toString(), token: 'keeta_credits', decimals: 6, settlement: 'keeta_settlement', expiresAt: Date.now() + 60_000 } };
			}
			if (path === '/v1/jobs/job_1/escrow') {
				return { ticket: { ticket: { jobId: 'job_1', modelId: 'qwen3-8b', payTo: 'keeta_provider', nodeKey: 'keeta_node', price, maxInputTokens: 100, maxOutputTokens: 16 }, coordinatorSig: '', relayMac: '' } };
			}
			if (path === '/v1/jobs/job_old/escrow') {
				return { pending: true };
			}
			return {};
		},
		get: async () => ({ jobs: settled })
	} as unknown as ControlClient;
	const buyer = new Buyer({
		store,
		control,
		spend,
		spendAccount,
		ledger: { balances: async () => ({ kta: 0n, tokens: {} }), send: async () => 'B'.repeat(64), received: async () => [], requestTestFunds: async () => '' },
		queue: new SerialQueue(),
		verify: () => true,
		log: () => undefined,
		onJob: (job) =>
			store.update((s) => {
				const index = s.jobs.findIndex((j) => j.jobId === job.jobId);
				if (index >= 0) {
					s.jobs[index] = job;
				} else {
					s.jobs.unshift(job);
				}
			}),
		/* The relay cannot be reached. */
		fetchImpl: (async () => {
			throw new TypeError('fetch failed');
		}) as typeof fetch
	});
	await buyer.listen(0);
	t.after(() => buyer.close());

	const response = await fetch(`${buyer.endpoint}/chat/completions`, {
		method: 'POST',
		headers: { authorization: `Bearer ${store.state.buyer.token}`, 'content-type': 'application/json' },
		body: JSON.stringify({ model: 'qwen3-8b', messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 })
	});
	assert.equal(response.status, 502);
	assert.equal(((await response.json()) as { error: { code: string } }).error.code, 'relay_unreachable');
	assert.ok(posts.includes('/v1/jobs/job_1/cancel'), 'the ticket is handed back');
	assert.match(store.state.jobs[0]!.error!, /relay could not be reached; settling the escrow/, 'the job is kept so its settlement is read later');

	/* At the lapse the control plane pays the provider the no-show fee from the escrow and refunds the rest. */
	settled = [{ jobId: 'job_1', ticketIssuedAt: Date.now(), settlement: { reason: 'no-show', noShow: true, decidedAt: Date.now(), blockHash: 'S'.repeat(64) } }];
	/* An escrow whose request gave up before its ticket: the quote is given back before the block is reported again. */
	store.update((s) => s.escrows.push({ jobId: 'job_old', network: 'test', blockHash: 'C'.repeat(64), at: Date.now() }));
	posts.length = 0;
	assert.deepEqual(await buyer.followUp(), { reported: 1, settled: 1 });
	assert.deepEqual(posts, ['/v1/jobs/job_old/cancel', '/v1/jobs/job_old/escrow'], 'cancelled first, so a late confirmation is refunded in full');
	assert.equal(store.state.jobs[0]!.status, 'failed');
	assert.match(store.state.jobs[0]!.error!, /no-show fee/);
	assert.equal(store.state.jobs[0]!.amount, NO_SHOW_FEE.toString());
	assert.equal(store.state.spentByDay[utcDay()], NO_SHOW_FEE.toString(), 'the fee counts against the daily limit');
});
