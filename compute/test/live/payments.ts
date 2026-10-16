/**
 * How the live app tests fund a buyer and decide that a job settled. Today an
 * app job is paid after its receipt: the buyer agent sends USDC from its
 * budget key to the provider's operator, and the control plane marks the job
 * paid once it finds that send on the ledger. App payments are moving to a
 * prepaid credit token; when that lands, only this file should change.
 */

import assert from 'node:assert/strict';
import type { JobRecord } from '@keeta-compute/protocol';
import { until } from '../support/harness.ts';
import type { Stack } from './stack.ts';
import type { Funder } from './support.ts';

/** Give a buyer agent's budget key enough to buy a few small jobs and pay the network fees. */
export async function fundAppBuyer(funder: Funder, budgetAddress: string): Promise<void> {
	await funder.fundUsdc(budgetAddress, 20_000n);
	await funder.fundKta([budgetAddress]);
}

/**
 * Start watching an operator's balance; the returned function waits for a
 * job to settle and checks the operator was paid exactly what it billed.
 */
export async function watchSettlement(stack: Stack, funder: Funder, operator: string): Promise<(jobId: string, timeoutMs?: number) => Promise<JobRecord>> {
	const before = await funder.balance(operator, 'usdc');
	return async (jobId, timeoutMs = 120_000) => {
		const job = await until(
			`job ${jobId} to be paid`,
			async () => {
				/* Confirm pending payments the way the control plane's sweeper does, without waiting a minute for it. */
				await stack.control.service.sweep();
				const current = await stack.control.store.getJob(jobId);
				return current?.status === 'paid' ? current : null;
			},
			timeoutMs,
			1_000
		);
		assert.equal(job.payTo, operator);
		assert.equal(job.payment?.verified, true, 'paid only after the payment was found on the ledger');
		const billed = BigInt(job.receipt!.receipt.amount);
		assert.ok(billed > 0n);
		assert.equal(await funder.balance(operator, 'usdc'), before + billed, "the operator's on-ledger balance went up by the billed amount");
		return job;
	};
}
