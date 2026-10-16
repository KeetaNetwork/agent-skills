/**
 * How the live app tests fund a buyer and decide that a job settled. A
 * buyer's operator account gets test USDC and buys this run's Keeta Compute
 * Credits with it through the FX service (the agent's anchor-SDK client
 * against services/fx, on the test network), straight into the agent budget.
 * The buyer agent escrows each job's maximum cost from that budget with the
 * settlement account at ticket time, and the control plane pays it out in
 * one block once the relay's delivery record settles it: the provider's bill
 * to its operator, the rest back to the budget.
 */

import assert from 'node:assert/strict';
import type { JobRecord } from '@keeta-compute/protocol';
import { until } from '../support/harness.ts';
import type { Stack } from './stack.ts';
import { USDC, type Funder } from './support.ts';

export interface AppBuyer {
	rpc: Record<string, (params: unknown) => Promise<any>>;
	/** The operator's passkey entropy; buying credits needs it, as in the app. */
	entropy: string;
	operator: string;
	/** The agent budget key the local endpoint escrows from. */
	spend: string;
}

/** Credits a buyer starts with: plenty for a few small jobs (each escrows well under 0.001 credits). */
export const BUYER_CREDITS = 20_000n;

function creditsOf(stack: Stack): string {
	assert.ok(stack.credits, 'start the stack with credits for app jobs');
	return stack.credits.token;
}

/** Buy credits with test USDC from the buyer's operator account, into its agent budget. */
export async function fundAppBuyer(funder: Funder, stack: Stack, buyer: AppBuyer): Promise<void> {
	const token = creditsOf(stack);
	await funder.fundUsdc(buyer.operator, BUYER_CREDITS);
	/* The operator signs the swap and the move to the budget; the budget signs each escrow. */
	await funder.fundKta([buyer.operator, buyer.spend]);
	const priced = await buyer.rpc['wallet.creditQuote']!({ side: 'buy', amount: BUYER_CREDITS.toString(), stablecoin: USDC.symbol });
	const bought = await buyer.rpc['wallet.buyCredits']!({ entropy: buyer.entropy, amount: BUYER_CREDITS.toString(), with: USDC.symbol, maxPay: priced.limit });
	assert.equal(bought.credits, BUYER_CREDITS.toString());
	assert.equal(bought.paid, BUYER_CREDITS.toString(), 'USDC buys credits one to one');
	assert.ok(bought.budgetBlockHash, 'the credits moved into the agent budget');
	await until('the credits to reach the agent budget', async () => (await funder.balance(buyer.spend, token)) >= BUYER_CREDITS, 60_000, 1_000);
	assert.ok((await funder.balance(stack.credits!.fx.publicKeyString.get(), 'usdc')) >= BUYER_CREDITS, 'the FX account took the USDC');
}

/**
 * Start watching an operator's and a buyer's credits; the returned function
 * waits for a job to be paid out and checks, on the ledger, that the
 * operator received exactly the bill and the buyer's escrow came back less
 * the bill.
 */
export async function watchSettlement(stack: Stack, funder: Funder, operator: string, buyerSpend: string): Promise<(jobId: string, timeoutMs?: number) => Promise<JobRecord>> {
	const token = creditsOf(stack);
	const [operatorBefore, buyerBefore] = await Promise.all([funder.balance(operator, token), funder.balance(buyerSpend, token)]);
	return async (jobId, timeoutMs = 120_000) => {
		const job = await until(
			`job ${jobId} to be paid out`,
			async () => {
				/* Settle what is due the way the control plane's sweeper does, without waiting for it. */
				await stack.control.service.sweep();
				const current = await stack.control.store.getJob(jobId);
				return current?.settlement?.blockHash ? current : null;
			},
			timeoutMs,
			1_000
		);
		assert.equal(job.payTo, operator);
		assert.equal(job.status, 'paid');
		assert.equal(job.settlement!.reason, 'delivered', "the receipt matched the relay's record");
		assert.ok(job.escrow?.blockHash, 'escrowed on the ledger before the ticket');
		const billed = BigInt(job.receipt!.receipt.amount);
		assert.ok(billed > 0n);
		await until('the payout to show on the ledger', async () => (await funder.balance(operator, token)) >= operatorBefore + billed, 60_000, 1_000);
		assert.equal(await funder.balance(operator, token), operatorBefore + billed, "the operator's credits went up by exactly the bill");
		assert.equal(await funder.balance(buyerSpend, token), buyerBefore - billed, "the buyer's budget paid the bill and got the rest of the escrow back");
		return job;
	};
}
