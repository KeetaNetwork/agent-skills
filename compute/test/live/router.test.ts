/**
 * Live: the public router (POST /v1/chat/completions on the relay Worker)
 * paid with real x402 on the Keeta test network. A client with no Keeta
 * Compute software, only @x402/fetch and the Keeta exact scheme, gets a 402,
 * signs a send of the router's stablecoin (KUSD once it is pinned, test USDC
 * until then) from a fresh account, and the facilitator settles it to
 * keeta.ai's settlement account. Once the provider's receipt bills the job,
 * the control plane pays the operator the bill less the 0.25% network fee
 * and returns the rest to the payer. The funding account must hold that
 * stablecoin. The router unit tests own the flow with a stubbed gateway; this
 * file owns what only the real facilitator and ledger show.
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { decodePaymentResponseHeader, wrapFetchWithPayment, x402Client } from '@x402/fetch';
import { ExactKeetaScheme, KEETA_TESTNET_CAIP2, toClientKeetaSigner } from '@x402/keeta';
import { CREDIT_DECIMALS, defaultAsset, formatAmount, networkFee, providerShare, receiptMessage, rescaleAmount, type SignedReceipt } from '@keeta-compute/protocol';
import { verifyKeetaSignature } from '@keeta-compute/protocol/keeta';
import { Scratch, until } from '../support/harness.ts';
import { Funder, NETWORK, announceSkip, freshAccount, skipLive, type KeetaAccount } from './support.ts';
import { FACILITATOR_URL, MODEL, startStack, type Stack } from './stack.ts';

announceSkip();

/** What the router quotes x402 payments in. */
const ASSET = defaultAsset(NETWORK);
/* A hundredth of a credit's worth: far more than one small completion costs. */
const PAYER_FUNDS = rescaleAmount(10_000n, CREDIT_DECIMALS, ASSET.decimals);
const scratch = new Scratch();
let funder: Funder;
let stack: Stack;
let payer: KeetaAccount;

before(async () => {
	if (skipLive) {
		return;
	}
	/* Say plainly when the facilitator, not this code, is the problem. */
	const { kinds } = await new HTTPFacilitatorClient({ url: FACILITATOR_URL }).getSupported();
	console.log(`facilitator ${FACILITATOR_URL} supports: ${kinds.map((k) => `${k.scheme}@${k.network}`).join(', ')}`);
	assert.ok(
		kinds.some((k) => k.scheme === 'exact' && k.network === KEETA_TESTNET_CAIP2),
		`the facilitator does not settle exact payments on ${KEETA_TESTNET_CAIP2}; the public router cannot be paid on the test network`
	);
	funder = await Funder.open();
	const held = await funder.balance(funder.address, ASSET.address);
	assert.ok(held >= PAYER_FUNDS, `the funding account ${funder.address} holds ${formatAmount(held, ASSET.decimals)} test ${ASSET.symbol}, which the router quotes in; it needs at least ${formatAmount(PAYER_FUNDS, ASSET.decimals)}`);
	stack = await startStack(scratch, { settlement: { funder } });
	payer = funder.track(freshAccount());
	/* x402 payers need no KTA: the facilitator pays the network fee. */
	await funder.fund(payer.publicKeyString.get(), ASSET.address, PAYER_FUNDS);
});

after(async () => {
	await scratch.cleanup();
	await funder?.sweep();
});

const body = JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'Say hello' }], max_tokens: 32 });

let paymentHeader = '';
/** What the first job billed, in the stablecoin's base units. */
let billed = 0n;

test('an x402 client pays the router in its stablecoin and gets the completion with the provider receipt; the operator is paid its share on the ledger', { skip: skipLive, timeout: 300_000 }, async () => {
	const operator = stack.mac.operator;
	const settlementAccount = stack.settlement!;
	const payerAddress = payer.publicKeyString.get();
	const [before, payerBefore, settlementBefore] = (await Promise.all([operator, payerAddress, settlementAccount].map((address) => funder.balance(address, ASSET.address)))) as [bigint, bigint, bigint];
	const signer = toClientKeetaSigner(payer);
	let quoted = '';
	try {
		/* The router's test stablecoin is not in @x402's default assets, so a client opts in to it, as the router docs show. */
		const client = new x402Client()
			.register(KEETA_TESTNET_CAIP2, new ExactKeetaScheme(signer))
			.setSpendControls({ allowedAssets: [{ network: KEETA_TESTNET_CAIP2, asset: ASSET.address, maxAmountPerPayment: PAYER_FUNDS.toString() }] });
		/* Watch the wire: the 402 quote, and the payment header the client sends back. */
		const watched: typeof fetch = async (input, init) => {
			const request = new Request(input, init);
			paymentHeader = request.headers.get('payment-signature') ?? request.headers.get('x-payment') ?? paymentHeader;
			const response = await fetch(request);
			if (response.status === 402) {
				const required = JSON.parse(atob(response.headers.get('payment-required')!)) as { accepts: Array<{ amount: string; payTo: string; asset: string; extra: { jobId: string; external?: string } }> };
				assert.equal(required.accepts[0]!.payTo, settlementAccount, 'the quote pays the settlement account');
				assert.equal(required.accepts[0]!.extra.external, required.accepts[0]!.extra.jobId, 'and the send names the job');
				assert.equal(required.accepts[0]!.asset, ASSET.address, `the router quotes in ${ASSET.symbol}`);
				quoted = required.accepts[0]!.amount;
			}
			return response;
		};
		const response = await wrapFetchWithPayment(watched, client)(`${stack.worker.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
		const text = await response.text();
		assert.equal(response.status, 200, `${text}\n--- wrangler output ---\n${stack.worker.output()}`);
		assert.ok(paymentHeader, 'the client paid');
		assert.ok(BigInt(quoted) > 0n);

		const completion = JSON.parse(text) as { choices: Array<{ message: { content: string } }> };
		if (stack.model.fake) {
			assert.equal(completion.choices[0]!.message.content, 'Hello from Keeta');
		}
		const settlement = decodePaymentResponseHeader(response.headers.get('payment-response')!);
		assert.equal(settlement.success, true);
		assert.equal(settlement.payer, payer.publicKeyString.get());

		const receipt = JSON.parse(atob(response.headers.get('x-keeta-receipt')!)) as SignedReceipt;
		assert.ok(verifyKeetaSignature(stack.mac.nodeKey, receiptMessage(receipt.receipt), receipt.signature), 'the receipt is signed by the provider node');
		assert.equal(receipt.receipt.payTo, operator);

		const job = await until('the router to report the settlement', async () => {
			const current = await stack.control.store.getJob(receipt.receipt.jobId);
			return current?.routerPayer ? current : null;
		});
		assert.equal(job.routerPayer, payerAddress);
		assert.equal(job.prepaidAmount, quoted);
		billed = rescaleAmount(BigInt(receipt.receipt.amount), CREDIT_DECIMALS, ASSET.decimals);
		assert.ok(billed > 0n && billed <= BigInt(quoted), 'the receipt bills at most what was prepaid');
		const paid = await until(
			'the settlement account to pay the job out',
			async () => {
				/* Settle what is due the way the control plane's sweeper does, without waiting for it. */
				await stack.control.service.sweep();
				const current = await stack.control.store.getJob(job.jobId);
				return current?.settlement?.blockHash ? current : null;
			},
			120_000,
			1_000
		);
		assert.deepEqual([paid.status, paid.settlement!.reason], ['paid', 'delivered']);
	} finally {
		await signer.destroy();
	}
	await until('the payout to show on the ledger', async () => (await funder.balance(operator, ASSET.address)) >= before + providerShare(billed), 60_000, 1_000);
	assert.equal(await funder.balance(operator, ASSET.address), before + providerShare(billed), 'the operator received the bill less the network fee');
	assert.equal(await funder.balance(payerAddress, ASSET.address), payerBefore - billed, 'the payer paid the bill and got the rest of its prepayment back');
	assert.equal(await funder.balance(settlementAccount, ASSET.address), settlementBefore + networkFee(billed), 'the settlement account kept the network fee');
});

test('a replayed x402 payment header is refused and moves no money', { skip: skipLive, timeout: 120_000 }, async () => {
	assert.ok(paymentHeader, 'needs the payment from the previous test');
	const operator = stack.mac.operator;
	const before = await funder.balance(operator, ASSET.address);
	const payerBefore = await funder.balance(payer.publicKeyString.get(), ASSET.address);
	const replay = await fetch(`${stack.worker.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', 'payment-signature': paymentHeader }, body });
	const text = await replay.text();
	assert.notEqual(replay.status, 200, text);
	assert.equal(replay.headers.get('payment-response'), null, 'nothing was settled');
	/* Give a wrongly published send time to land before checking that none did. */
	await new Promise((r) => setTimeout(r, 5_000));
	assert.equal(await funder.balance(operator, ASSET.address), before);
	assert.equal(await funder.balance(payer.publicKeyString.get(), ASSET.address), payerBefore);
});
