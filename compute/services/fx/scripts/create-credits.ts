/**
 * Create Keeta Compute Credits on the TEST network, mint the supply to the
 * keeta.ai FX account, and pin both in packages/protocol/src/credit-pins.ts.
 *
 *   FX_SEED=<fx account seed> [CREDITS_ISSUER_SEED=<owner seed>] [CREDITS_SUPPLY=1000000] npm run credits:create
 *
 * The issuer (CREDITS_ISSUER_SEED, or the FX account itself) owns the token
 * and needs test KTA for the fee. The main network is refused: keeta.ai
 * issues credits there separately, and its pin stays empty until then.
 */

import { fileURLToPath } from 'node:url';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import { CREDIT_DECIMALS, ONE_CREDIT, parseAmount } from '@keeta-compute/protocol';
import { Account } from '@keeta-compute/protocol/keeta';
import { createCreditToken, writePinsFile } from '../src/ledger.ts';
import { CREDIT_PINS } from '../../../packages/protocol/src/credit-pins.ts';

const network = process.env.FX_NETWORK?.trim() || 'test';
if (network !== 'test') {
	throw new Error('credits:create runs on the test network only; main-network credits are issued by keeta.ai separately');
}
const fxSeed = process.env.FX_SEED?.trim();
if (!fxSeed || !/^[0-9a-fA-F]{64}$/.test(fxSeed)) {
	throw new Error('FX_SEED must be the FX account seed, 64 hex characters');
}
if (CREDIT_PINS.test && !process.env.CREDITS_REPLACE) {
	throw new Error(`credits are already pinned on the test network (${CREDIT_PINS.test.token}); set CREDITS_REPLACE=1 to create a new token`);
}
const issuerSeed = process.env.CREDITS_ISSUER_SEED?.trim() || fxSeed;
const supply = process.env.CREDITS_SUPPLY?.trim() ? parseAmount(process.env.CREDITS_SUPPLY.trim(), CREDIT_DECIMALS) : 1_000_000n * ONE_CREDIT;

const fx = Account.fromSeed(fxSeed, 0).publicKeyString.get();
const issuer = Account.fromSeed(issuerSeed, 0);
const client = KeetaNet.UserClient.fromNetwork('test', issuer as Parameters<typeof KeetaNet.UserClient.fromNetwork>[1]);
try {
	const token = await createCreditToken(client, { fx, supply });
	const file = fileURLToPath(new URL('../../../packages/protocol/src/credit-pins.ts', import.meta.url));
	writePinsFile(file, 'CREDIT_PINS', { ...CREDIT_PINS, test: { token, decimals: CREDIT_DECIMALS, fx } });
	console.log(`Created Keeta Compute Credits ${token} on the test network, owned by ${issuer.publicKeyString.get()}.`);
	console.log(`Minted ${supply / ONE_CREDIT} credits to the FX account ${fx}, and pinned both in ${file}.`);
	console.log('Next: start the FX service and publish its metadata (npm run fx:publish), then deploy the control plane.');
} finally {
	await client.destroy();
}
