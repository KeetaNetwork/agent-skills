/**
 * Live: the agent's ledger adapter (agent/src/ledger.ts KeetaLedger) on the
 * Keeta test network, checked against the control plane's own payment
 * verifier. Unit tests cannot cover this: they never reach a ledger.
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { Account } from '@keeta-compute/protocol/keeta';
import { KeetaLedger } from '../../agent/src/ledger.ts';
import { ledgerPaymentVerifier } from '../../services/control/src/config.ts';
import { until } from '../support/harness.ts';
import { Funder, NETWORK, USDC, announceSkip, freshAccount, skipLive, type KeetaAccount } from './support.ts';

announceSkip();

const ledger = new KeetaLedger(NETWORK);
let funder: Funder;
let payer: KeetaAccount;
let payee: KeetaAccount;

before(async () => {
	if (skipLive) {
		return;
	}
	funder = await Funder.open();
	payer = funder.track(freshAccount());
	payee = funder.track(freshAccount());
	await funder.fundUsdc(payer.publicKeyString.get(), 2_000n);
	await funder.fundKta([payer.publicKeyString.get()]);
});

after(async () => {
	await funder?.sweep();
});

let usdcSent = 0n;
let ktaSent = 0n;

test('KeetaLedger sends USDC and KTA, and the control plane verifier confirms each block', { skip: skipLive }, async () => {
	const verify = ledgerPaymentVerifier();
	const to = payee.publicKeyString.get();
	const from = payer.publicKeyString.get();

	usdcSent = 1_500n;
	const usdcHash = await ledger.send(payer, to, usdcSent, 'usdc', 'job_live_usdc');
	assert.match(usdcHash, /^[0-9A-Fa-f]{64}$/);
	assert.equal(await verify({ network: NETWORK, blockHash: usdcHash.toUpperCase(), from, to, asset: USDC.address, minAmount: usdcSent, reference: 'job_live_usdc' }), 'confirmed');

	ktaSent = funder.ktaUnit / 1000n;
	const ktaHash = await ledger.send(payer, to, ktaSent, 'kta', 'job_live_kta');
	assert.equal(await verify({ network: NETWORK, blockHash: ktaHash, from, to, asset: funder.kta, minAmount: ktaSent, reference: 'job_live_kta' }), 'confirmed');

	/* A send to a token address is refused before anything is published. */
	await assert.rejects(ledger.send(payer, USDC.address, 1n, 'usdc'), /token address/);
});

test('KeetaLedger reads balances of a signing account and of a public-key-only account', { skip: skipLive }, async () => {
	const payeeByKey = Account.fromPublicKeyString(payee.publicKeyString.get() as Parameters<typeof Account.fromPublicKeyString>[0]);
	assert.equal(payeeByKey.hasPrivateKey, false);
	assert.deepEqual(await ledger.balances(payeeByKey), { usdc: usdcSent, kta: ktaSent }, 'the operator is read by public key, as the app reads it');

	const own = await ledger.balances(payer);
	assert.equal(own.usdc, await funder.balance(payer.publicKeyString.get(), 'usdc'));
	assert.equal(own.kta, await funder.balance(payer.publicKeyString.get(), 'kta'));
});

test('KeetaLedger.requestTestFunds gets test KTA from the faucet', { skip: skipLive, timeout: 300_000 }, async () => {
	const fresh = funder.track(freshAccount()).publicKeyString.get();
	assert.match(await ledger.requestTestFunds(fresh), /test KTA/);
	/* The faucet pays in batches; poll the ledger rather than trusting the reply. */
	await until('the faucet to pay out', async () => (await funder.balance(fresh, 'kta')) > 0n, 240_000, 5_000);
});
