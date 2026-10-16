/**
 * Live: the public router (POST /v1/chat/completions on the relay Worker)
 * paid with real x402 on the Keeta test network. A client with no Keeta
 * Compute software, only @x402/fetch and the Keeta exact scheme, gets a 402,
 * signs a send of the router's stablecoin (KUSD once it is pinned, test USDC
 * until then) from a fresh account, and the facilitator settles it to the
 * provider's operator. The funding account must hold that stablecoin. The router unit tests own the flow with a stubbed
 * gateway; this file owns what only the real facilitator and ledger show.
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { decodePaymentResponseHeader, wrapFetchWithPayment, x402Client } from '@x402/fetch';
import { ExactKeetaScheme, KEETA_TESTNET_CAIP2, toClientKeetaSigner } from '@x402/keeta';
import { CREDIT_DECIMALS, defaultAsset, formatAmount, receiptMessage, rescaleAmount, type SignedReceipt } from '@keeta-compute/protocol';
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
	stack = await startStack(scratch);
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

test('an x402 client pays the router in its stablecoin and gets the completion with the provider receipt; the operator is paid on the ledger', { skip: skipLive, timeout: 300_000 }, async () => {
	const operator = stack.mac.operator;
	const before = await funder.balance(operator, ASSET.address);
	const signer = toClientKeetaSigner(payer);
	let quoted = '';
	try {
		const client = new x402Client().register(KEETA_TESTNET_CAIP2, new ExactKeetaScheme(signer));
		/* Watch the wire: the 402 quote, and the payment header the client sends back. */
		const watched: typeof fetch = async (input, init) => {
			const request = new Request(input, init);
			paymentHeader = request.headers.get('payment-signature') ?? request.headers.get('x-payment') ?? paymentHeader;
			const response = await fetch(request);
			if (response.status === 402) {
				const required = JSON.parse(atob(response.headers.get('payment-required')!)) as { accepts: Array<{ amount: string; payTo: string; asset: string }> };
				assert.equal(required.accepts[0]!.payTo, operator, 'the quote pays the provider directly');
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
		assert.equal(job.routerPayer, payer.publicKeyString.get());
		assert.equal(job.prepaidAmount, quoted);
	} finally {
		await signer.destroy();
	}
	await until('the payment to show on the ledger', async () => (await funder.balance(operator, ASSET.address)) >= before + BigInt(quoted), 60_000, 1_000);
	assert.equal(await funder.balance(operator, ASSET.address), before + BigInt(quoted), 'the operator received exactly the quoted amount');
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
