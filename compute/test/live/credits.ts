/**
 * Keeta Compute Credits for one live run on the test network, made the way
 * the deploy steps make them: a fresh credit token with its supply in a
 * fresh FX account (`npm run credits:create`), the FX service swapping it
 * for test USDC from that account on a local port (`npm run fx:start`),
 * published in the FX account's metadata so the anchor resolver finds it
 * (`npm run fx:publish`), and a fresh settlement account for the control
 * plane (SETTLEMENT_SEED). Every account is tracked, so the sweep returns
 * their USDC and KTA to the funding account.
 *
 * Plain http is allowed for the FX service on the test network only.
 */

import * as KeetaNet from '@keetanetwork/keetanet-client';
import { ONE_CREDIT, toHex } from '@keeta-compute/protocol';
import { Account } from '@keeta-compute/protocol/keeta';
import { fxConfigFromEnv } from '../../services/fx/src/config.ts';
import { createCreditToken, publishFxMetadata } from '../../services/fx/src/ledger.ts';
import { createFxServer, stopFxServer } from '../../services/fx/src/server.ts';
import { freePort, type Scratch } from '../support/harness.ts';
import { NETWORK, freshAccount, type Funder, type KeetaAccount } from './support.ts';

export interface LiveCredits {
	token: string;
	/** The FX account: holds the supply and the stablecoins it takes in, fills swaps, roots the resolver. */
	fx: KeetaAccount;
	/** keeta.ai's settlement account: escrows in, payouts and refunds out. */
	settlement: KeetaAccount;
	settlementSeed: string;
	/** The FX service's URL, when it is served. */
	fxUrl: string | null;
	/** What the control plane is deployed with on the test network. */
	env: { TEST_CREDIT_TOKEN: string; TEST_FX_ACCOUNT: string; SETTLEMENT_SEED: string };
}

const SUPPLY = 1_000n * ONE_CREDIT;

type UserClientAccount = Parameters<typeof KeetaNet.UserClient.fromNetwork>[1];

export async function startCredits(funder: Funder, scratch: Scratch, options: { serveFx?: boolean } = {}): Promise<LiveCredits> {
	const issuer = funder.track(freshAccount());
	const fxSeed = toHex(crypto.getRandomValues(new Uint8Array(32)));
	const fx = funder.track(Account.fromSeed(fxSeed, 0));
	const settlementSeed = toHex(crypto.getRandomValues(new Uint8Array(32)));
	const settlement = funder.track(Account.fromSeed(settlementSeed, 0));
	/* The issuer publishes the token, the FX account its metadata and swaps, the settlement account its payouts. */
	await funder.fundKta([issuer, fx, settlement].map((account) => account.publicKeyString.get()));

	const issuerClient = KeetaNet.UserClient.fromNetwork(NETWORK, issuer as UserClientAccount);
	let token: string;
	try {
		token = await createCreditToken(issuerClient, { fx: fx.publicKeyString.get(), supply: SUPPLY });
	} finally {
		await issuerClient.destroy().catch(() => undefined);
	}
	console.log(`credit token ${token}, supply in FX account ${fx.publicKeyString.get()}, settlement account ${settlement.publicKeyString.get()}`);

	let fxUrl: string | null = null;
	if (options.serveFx !== false) {
		const port = await freePort();
		fxUrl = `http://127.0.0.1:${port}`;
		const server = createFxServer(fxConfigFromEnv({ FX_SEED: fxSeed, FX_NETWORK: NETWORK, TEST_CREDIT_TOKEN: token, FX_PORT: String(port), FX_PUBLIC_URL: fxUrl }));
		await server.start();
		scratch.defer(() => stopFxServer(server));
		const fxClient = KeetaNet.UserClient.fromNetwork(NETWORK, fx as UserClientAccount);
		try {
			await publishFxMetadata(fxClient, await server.serviceMetadata());
		} finally {
			await fxClient.destroy().catch(() => undefined);
		}
	}

	return {
		token,
		fx,
		settlement,
		settlementSeed,
		fxUrl,
		env: { TEST_CREDIT_TOKEN: token, TEST_FX_ACCOUNT: fx.publicKeyString.get(), SETTLEMENT_SEED: settlementSeed }
	};
}
