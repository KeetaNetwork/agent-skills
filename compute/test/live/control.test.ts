/**
 * Live: the control plane as `startServer` runs it, with the ledger payment
 * verifier and balance reader from config.ts reading the Keeta test network.
 * The control unit tests own the job state machine with a stubbed ledger;
 * these tests own what only real blocks and balances can show. They cover
 * pay-after-receipt app jobs; when app payments move to prepaid credits,
 * replace them rather than extend them.
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { jobCost, operatorLinkMessage, receiptMessage, type Offer, type Receipt, type SignedTicket, type Signer } from '@keeta-compute/protocol';
import { Account, accountSigner } from '@keeta-compute/protocol/keeta';
import { startServer } from '../../services/control/src/server.ts';
import { ControlClient, ControlError } from '../../agent/src/control-client.ts';
import { KeetaLedger } from '../../agent/src/ledger.ts';
import { GB } from '../support/harness.ts';
import { Funder, NETWORK, USDC, announceSkip, freshAccount, skipLive, type KeetaAccount } from './support.ts';

announceSkip();

const MODEL = 'llama-3.2-3b';
/* 1 USDC in and 4 USDC out per million tokens: the receipt below owes 300 base units. */
const PRICE = { inputPerMillion: '1000000', outputPerMillion: '4000000' };

let funder: Funder;
let control: Awaited<ReturnType<typeof startServer>>;
let api: ControlClient;
let node: Signer;
let operator: string;
let buyerAccount: KeetaAccount;
let buyer: Signer;

before(async () => {
	if (skipLive) {
		return;
	}
	funder = await Funder.open();
	control = await startServer({
		port: 0,
		/* No ledger overrides: the verifier and balance reader are the production ones. */
		env: { COORDINATOR_SEED: Account.generateRandomSeed({ asString: true }) as string, RELAY_SECRET: 'live-relay-secret', ROUTER_SECRET: 'live-router-secret', RELAY_URL: 'http://127.0.0.1:1' }
	});
	api = new ControlClient(control.url);

	node = accountSigner(freshAccount());
	const operatorSigner = accountSigner(freshAccount());
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
	const offer: Offer = { modelId: MODEL, weightsHash: 'c'.repeat(64), runtime: { kind: 'mlx', build: 'live' }, price: PRICE, access: { mode: 'public', allow: [] }, contextLength: 8192 };
	await api.post(node, '/v1/providers/heartbeat', { status: 'online', offers: [offer], load: { active: 0, capacity: 4 } });

	buyerAccount = funder.track(freshAccount());
	buyer = accountSigner(buyerAccount);
});

after(async () => {
	control?.server.close();
	control?.server.closeAllConnections();
	await funder?.sweep();
});

const createJob = (signer: Signer) => api.post<{ ticket: SignedTicket }>(signer, '/v1/jobs', { network: NETWORK, model: MODEL, maxInputTokens: 200, maxOutputTokens: 100 });

test('a pay-later buyer is admitted only with funds on the ledger', { skip: skipLive }, async () => {
	const unfunded = accountSigner(freshAccount());
	const refused = await createJob(unfunded).catch((error: ControlError) => error);
	assert.ok(refused instanceof ControlError);
	assert.equal(refused.status, 402, refused.message);

	/* 200 in at 1/M + 100 out at 4/M: the job may cost up to 600 base units. */
	await funder.fundUsdc(buyer.publicKey, 5_000n);
	const { ticket } = await createJob(buyer);
	assert.equal(ticket.ticket.payTo, operator);
});

test('a job is marked paid only for a block that pays it: wrong recipient, reference or amount are refused', { skip: skipLive, timeout: 300_000 }, async () => {
	await funder.fundKta([buyer.publicKey]);
	const { ticket } = await createJob(buyer);
	const jobId = ticket.ticket.jobId;
	const receipt: Receipt = {
		v: 1,
		jobId,
		network: NETWORK,
		nodeKey: node.publicKey,
		payTo: operator,
		buyer: buyer.publicKey,
		modelId: MODEL,
		weightsHash: 'c'.repeat(64),
		runtime: { kind: 'mlx', build: 'live' },
		inputTokens: 100,
		outputTokens: 50,
		price: ticket.ticket.price,
		amount: jobCost(ticket.ticket.price, { inputTokens: 100, outputTokens: 50 }).toString(),
		asset: USDC.address,
		startedAt: Date.now(),
		finishedAt: Date.now(),
		outputHash: 'd'.repeat(64),
		finishReason: 'stop'
	};
	const due = BigInt(receipt.amount);
	assert.equal(due, 300n);
	await api.post(node, `/v1/jobs/${jobId}/receipt`, { receipt: { receipt, signature: await node.sign(receiptMessage(receipt)) } });

	/* Sends as a buyer agent makes them: from its own account, with the job id as the reference. */
	const ledger = new KeetaLedger(NETWORK);
	const send = (to: string, amount: bigint, reference: string) => ledger.send(buyerAccount, to, amount, 'usdc', reference);
	const pay = (blockHash: string) => api.post<{ job: { status: string; payment?: { verified: boolean } } }>(buyer, `/v1/jobs/${jobId}/payment`, { blockHash });
	const refusal = (blockHash: string) => pay(blockHash).then(() => assert.fail('the payment was accepted'), (error: ControlError) => error);
	const elsewhere = await send(funder.address, due, jobId);
	assert.equal((await refusal(elsewhere)).status, 402, 'paid to another account');

	const otherReference = await send(operator, due, 'job_some_other_job');
	assert.equal((await refusal(otherReference)).status, 402, 'carries another job id');

	const short = await send(operator, due - 1n, jobId);
	assert.equal((await refusal(short)).status, 402, 'one base unit short');

	/* A hash the ledger does not know yet is held as pending, not refused. */
	const unknown = await pay('F'.repeat(64));
	assert.equal(unknown.job.status, 'completed');
	assert.equal(unknown.job.payment?.verified, false);

	const exact = await send(operator, due, jobId);
	const paid = await pay(exact);
	assert.equal(paid.job.status, 'paid');
	assert.equal(paid.job.payment?.verified, true);
	assert.equal((await control.store.getProvider(node.publicKey))!.stats.earned, receipt.amount);
	/* The operator received the right payment and the misdirected ones, nothing else. */
	assert.equal(await funder.balance(operator, 'usdc'), due + (due - 1n) + due);
});
