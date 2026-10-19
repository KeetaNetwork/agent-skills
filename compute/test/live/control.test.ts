/**
 * Live: the control plane as `startServer` runs it, with the escrow verifier
 * and the settlement account from config.ts on the Keeta test network, and
 * this run's Keeta Compute Credits (credits.ts). The control unit tests own
 * the settlement decisions on real blocks kept in memory; these tests own
 * what only the ledger can show: an escrow read from a published block, the
 * settlement account's payout block landing with the right amounts, and the
 * settlement account's own history finding that block, which is what keeps
 * a job from being paid twice.
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { NO_SHOW_FEE, jobCost, networkFee, operatorLinkMessage, providerShare, receiptMessage, type EscrowQuote, type JobRecord, type Offer, type Receipt, type SignedTicket, type Signer } from '@keeta-compute/protocol';
import { Account, accountSigner } from '@keeta-compute/protocol/keeta';
import { startServer } from '../../services/control/src/server.ts';
import { ledgerSettlement } from '../../services/control/src/config.ts';
import { ControlClient, ControlError } from '@keeta-compute/protocol/client';
import { KeetaLedger } from '@keeta-compute/wallet';
import { GB, Scratch, until } from '../support/harness.ts';
import { startCredits, type LiveCredits } from './credits.ts';
import { Funder, NETWORK, announceSkip, freshAccount, skipLive, type KeetaAccount } from './support.ts';

announceSkip();

const MODEL = 'llama-3.2-3b';
/* 1 credit in and 4 credits out per million tokens: the receipt below bills 300 base units. */
const PRICE = { inputPerMillion: '1000000', outputPerMillion: '4000000' };
const ROUTER_SECRET = 'live-router-secret';
const BUYER_CREDITS = 10_000n;

const scratch = new Scratch();
const ledger = new KeetaLedger(NETWORK);
let funder: Funder;
let credits: LiveCredits;
let settlement: string;
let control: Awaited<ReturnType<typeof startServer>>;
let api: ControlClient;
let node: Signer;
let operator: string;
let buyerAccount: KeetaAccount;
let buyer: Signer;
let offer: Offer;

/* The node heartbeats as the agent does (every 30 s), so it stays schedulable however slow the test network is (PROVIDER_STALE_MS). */
const beat = () => api.post(node, '/v1/providers/heartbeat', { status: 'online', offers: [offer], load: { active: 0, capacity: 4 } });

before(async () => {
	if (skipLive) {
		return;
	}
	funder = await Funder.open();
	/* The credit token, the FX account holding its supply, and the settlement account; no FX service is needed here. */
	credits = await startCredits(funder, scratch, { serveFx: false });
	settlement = credits.settlement.publicKeyString.get();
	control = await startServer({
		port: 0,
		/* No ledger overrides: the escrow verifier and the settlement account are the production ones. */
		env: { COORDINATOR_SEED: Account.generateRandomSeed({ asString: true }) as string, RELAY_SECRET: 'live-relay-secret', ROUTER_SECRET, RELAY_URL: 'http://127.0.0.1:1', ...credits.env }
	});
	api = new ControlClient(control.url);

	node = accountSigner(freshAccount());
	/* Payouts land here; the sweep brings them back. */
	const operatorSigner = accountSigner(funder.track(freshAccount()));
	operator = operatorSigner.publicKey;
	const issuedAt = Date.now();
	const link = await operatorSigner.sign(operatorLinkMessage({ nodeKey: node.publicKey, payTo: operator, network: NETWORK, issuedAt }));
	await api.post(node, '/v1/providers/register', {
		network: NETWORK,
		kind: 'mac',
		name: 'live',
		hardware: { os: 'macos', osVersion: '15.4', chip: 'Apple M4 Max', memoryBytes: 64 * GB, freeDiskBytes: 500 * GB },
		payTo: operator,
		link: { issuedAt, signature: link }
	});
	offer = { modelId: MODEL, weightsHash: 'c'.repeat(64), runtime: { kind: 'mlx', build: 'live' }, price: PRICE, access: { mode: 'public', allow: [] }, contextLength: 8192 };
	await beat();

	/* The buyer holds credits as if it had bought them: sent from the FX account, which holds the supply. */
	buyerAccount = funder.track(freshAccount());
	buyer = accountSigner(buyerAccount);
	await funder.fundKta([buyer.publicKey]);
	await ledger.send(credits.fx, buyer.publicKey, BUYER_CREDITS, credits.token, 'keeta-compute live test');
	await until('the buyer to hold credits', async () => (await creditsOf(buyer.publicKey)) === BUYER_CREDITS, 60_000, 1_000);
});

after(async () => {
	control?.server.close();
	control?.server.closeAllConnections();
	await scratch.cleanup();
	await funder?.sweep();
});

/** An account's credits, read with the funding account's client. */
const creditsOf = (address: string) => funder.balance(address, credits.token);

const quote = async () => {
	await beat();
	const { job, quote: q } = await api.post<{ job: JobRecord; quote: EscrowQuote }>(buyer, '/v1/jobs', { network: NETWORK, model: MODEL, maxInputTokens: 200, maxOutputTokens: 100 });
	assert.equal(job.status, 'quoted');
	return q;
};
/* Sends as the buyer agent makes them: from its own account, in credits, with the job id as the reference. */
const send = (to: string, amount: bigint, reference: string) => ledger.send(buyerAccount, to, amount, credits.token, reference);
const reportEscrow = (jobId: string, blockHash: string) => api.post<{ pending?: boolean; ticket?: SignedTicket }>(buyer, `/v1/jobs/${jobId}/escrow`, { blockHash });

/** Report an escrow block until the control plane finds it on the ledger; resolves to the ticket. */
async function ticketFor(jobId: string, blockHash: string): Promise<SignedTicket> {
	return until(
		`the escrow of ${jobId} to be read from the ledger`,
		async () => {
			await beat();
			return (await reportEscrow(jobId, blockHash)).ticket ?? null;
		},
		60_000,
		1_000
	);
}

/** Wait for the settlement account's payout block for a job, sweeping as the control plane's sweeper does. */
async function paidOut(jobId: string): Promise<JobRecord> {
	return until(
		`job ${jobId} to be paid out`,
		async () => {
			await control.service.sweep();
			const job = await control.store.getJob(jobId);
			return job?.settlement?.blockHash ? job : null;
		},
		120_000,
		1_000
	);
}

test('a job is quoted only to a buyer holding its cost in credits, and ticketed only against a block that escrows it with the settlement account', { skip: skipLive, timeout: 300_000 }, async () => {
	const q = await quote();
	assert.equal(q.token, credits.token, 'quoted in this run\'s credit token');
	assert.equal(q.settlement, settlement);
	const due = BigInt(q.maxCost);
	/* 200 in at 1/M + 100 out at 4/M is 600, raised to the no-show fee every escrow covers. */
	assert.equal(due, NO_SHOW_FEE);
	assert.equal(due, 1_000n);
	const refusal = (blockHash: string) => reportEscrow(q.jobId, blockHash).then(() => assert.fail('the escrow was accepted'), (error: ControlError) => error);

	/* A key holding no credits gets no quote: the control plane reads its balance from the ledger first. */
	const empty = accountSigner(freshAccount());
	const unfunded = await api.post(empty, '/v1/jobs', { network: NETWORK, model: MODEL, maxInputTokens: 200, maxOutputTokens: 100 }).then(() => assert.fail('an account with no credits was quoted'), (error: ControlError) => error);
	assert.equal(unfunded.status, 402);

	const elsewhere = await send(funder.address, due, q.jobId);
	assert.equal((await refusal(elsewhere)).status, 402, 'sent to another account');
	const otherReference = await send(settlement, due, 'job_some_other_job');
	assert.equal((await refusal(otherReference)).status, 402, 'carries another job id');
	const short = await send(settlement, due - 1n, q.jobId);
	assert.equal((await refusal(short)).status, 402, 'one base unit short');

	/* A hash the ledger does not know yet is held as pending, not refused. */
	assert.equal((await reportEscrow(q.jobId, 'F'.repeat(64))).pending, true);
	/* The quote lives a minute; give it back rather than race it. */
	await api.post(buyer, `/v1/jobs/${q.jobId}/cancel`, {});

	const fresh = await quote();
	const exact = await send(settlement, BigInt(fresh.maxCost), fresh.jobId);
	const ticket = await ticketFor(fresh.jobId, exact);
	assert.equal(ticket.ticket.paymentMode, 'escrow');
	assert.equal(ticket.ticket.asset, credits.token);
	assert.equal(ticket.ticket.payTo, operator);
	assert.equal((await control.store.getJob(fresh.jobId))!.escrow!.blockHash, exact);
	/* What reached the settlement account and escrowed nothing stays there; it is not a balance anyone is owed. */
	assert.equal(await creditsOf(settlement), due + (due - 1n) + due);
});

test('a matched receipt and relay record settle the escrow in one payout block, which the settlement account finds in its own history', { skip: skipLive, timeout: 300_000 }, async () => {
	const settlementBefore = await creditsOf(settlement);
	const buyerBefore = await creditsOf(buyer.publicKey);
	const q = await quote();
	const ticket = await ticketFor(q.jobId, await send(settlement, BigInt(q.maxCost), q.jobId));

	const usage = { inputTokens: 100, outputTokens: 50 };
	const receipt: Receipt = {
		v: 1,
		jobId: q.jobId,
		network: NETWORK,
		nodeKey: node.publicKey,
		payTo: operator,
		buyer: buyer.publicKey,
		modelId: MODEL,
		weightsHash: 'c'.repeat(64),
		runtime: { kind: 'mlx', build: 'live' },
		...usage,
		price: ticket.ticket.price,
		amount: jobCost(ticket.ticket.price, usage).toString(),
		asset: ticket.ticket.asset,
		startedAt: Date.now(),
		finishedAt: Date.now(),
		outputHash: 'd'.repeat(64),
		finishReason: 'stop'
	};
	const bill = BigInt(receipt.amount);
	assert.equal(bill, 300n);
	await api.post(node, `/v1/jobs/${q.jobId}/receipt`, { receipt: { receipt, signature: await node.sign(receiptMessage(receipt)) } });
	/* The relay's record of what it forwarded, as services/relay/src/delivery.ts posts it. */
	const recorded = await fetch(`${control.url}/v1/relay/jobs/${q.jobId}/delivery`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'x-router-secret': ROUTER_SECRET },
		body: JSON.stringify({ outputHash: receipt.outputHash, maxOutputTokens: 100 })
	});
	assert.equal(recorded.status, 200, await recorded.text());

	const job = await paidOut(q.jobId);
	assert.equal(job.status, 'paid');
	assert.equal(job.settlement!.reason, 'delivered');
	/* 0.25% of 300, rounded up: the provider receives 299. */
	await until('the payout to show on the ledger', async () => (await creditsOf(operator)) === providerShare(bill), 60_000, 1_000);
	assert.equal(await creditsOf(buyer.publicKey), buyerBefore - bill, 'the buyer paid the bill and got the rest of its escrow back');
	assert.equal(await creditsOf(settlement), settlementBefore + networkFee(bill), 'the settlement account kept the network fee and paid out the rest of the escrow');

	/* The record that keeps the job from being paid again is the block on the ledger, not a field in the store. */
	const own = ledgerSettlement(credits.settlementSeed);
	assert.equal(await own.findPayout({ network: NETWORK, token: credits.token, jobId: q.jobId, since: job.escrow!.at }), job.settlement!.blockHash);
	assert.equal(await own.findPayout({ network: NETWORK, token: credits.token, jobId: 'job_never_paid', since: job.escrow!.at - 60_000 }), null);
});

test('a provider failure returns the whole escrow to the buyer', { skip: skipLive, timeout: 300_000 }, async () => {
	const settlementBefore = await creditsOf(settlement);
	const operatorBefore = await creditsOf(operator);
	const buyerBefore = await creditsOf(buyer.publicKey);
	const q = await quote();
	await ticketFor(q.jobId, await send(settlement, BigInt(q.maxCost), q.jobId));
	await api.post(node, `/v1/jobs/${q.jobId}/fail`, { error: 'out of memory' });

	const job = await paidOut(q.jobId);
	assert.equal(job.status, 'failed');
	assert.equal(job.settlement!.reason, 'failed');
	await until('the refund to show on the ledger', async () => (await creditsOf(buyer.publicKey)) === buyerBefore, 60_000, 1_000);
	assert.equal(await creditsOf(operator), operatorBefore);
	assert.equal(await creditsOf(settlement), settlementBefore);
});
