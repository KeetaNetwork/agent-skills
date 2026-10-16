import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as KeetaAnchor from '@keetanetwork/anchor';
import { SwapLimitError, pickQuote, swapLimit, type SwapOrder } from '../src/index.ts';
import { fxClient } from '../src/fx.ts';

const quotes = (...amounts: bigint[]) => amounts.map((convertedAmount, i) => ({ id: i, quote: { convertedAmount } }));
const order = (affinity: 'from' | 'to', limit: bigint): SwapOrder => ({ fx: 'keeta_fx', from: 'keeta_a', to: 'keeta_b', affinity, amount: 1_000_000n, limit });

test('the confirmed limit is the estimate moved 0.5% against the user, rounded so the limit never crosses the estimate', () => {
	assert.equal(swapLimit({ affinity: 'to' }, 1_000_000n), 1_005_000n, 'buying: pay at most 0.5% more');
	assert.equal(swapLimit({ affinity: 'from' }, 1_000_000n), 995_000n, 'selling: receive at least 0.5% less');
	assert.equal(swapLimit({ affinity: 'to' }, 1n), 2n, 'a buy limit rounds up, never below the estimate');
	assert.equal(swapLimit({ affinity: 'from' }, 1n), 0n, 'a sale limit rounds down, never above the estimate');
});

test('a buy takes the cheapest quote and refuses one above what the operator confirmed', () => {
	assert.equal(pickQuote(quotes(1_004_000n, 1_001_000n, 1_003_000n), order('to', 1_005_000n)).id, 1);
	assert.equal(pickQuote(quotes(1_005_000n), order('to', 1_005_000n)).id, 0, 'exactly the limit is fine');
	assert.throws(() => pickQuote(quotes(1_005_001n, 1_010_000n), order('to', 1_005_000n)), (error: Error) => error instanceof SwapLimitError && /more than the 1005000 you confirmed/.test(error.message));
});

test('a sale takes the quote paying most and refuses one below what the operator confirmed', () => {
	assert.equal(pickQuote(quotes(990_000n, 996_000n, 995_500n), order('from', 995_000n)).id, 1);
	assert.throws(() => pickQuote(quotes(994_999n), order('from', 995_000n)), (error: Error) => error instanceof SwapLimitError && /less than the 995000 you confirmed/.test(error.message));
	assert.throws(() => pickQuote([], order('from', 995_000n)), /does not trade this pair/);
});

test('an estimate needs no wallet: the FX client is built with a throwaway key, and a swap with the wallet itself', async () => {
	const Account = KeetaAnchor.KeetaNet.lib.Account;
	const random = () => Account.fromSeed(Account.generateRandomSeed({ asString: true }), 0);
	const fx = random().publicKeyString.get();

	const estimate = fxClient('test', null, fx);
	assert.equal(estimate.user.account.hasPrivateKey, true, 'the SDK refuses a client without a signer');
	const another = fxClient('test', null, fx);
	assert.notEqual(another.user.account.publicKeyString.get(), estimate.user.account.publicKeyString.get(), 'a fresh key each time');

	const wallet = random();
	const swap = fxClient('test', wallet as never, fx);
	assert.equal(swap.user.account.publicKeyString.get(), wallet.publicKeyString.get(), 'swaps are signed by the wallet');
	await Promise.all([estimate, another, swap].map(({ user }) => user.destroy()));
});
