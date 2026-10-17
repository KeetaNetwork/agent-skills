/**
 * Keeta Compute Credits for one live run on the test network, made the way
 * the deploy steps make them. The suite has one credit token: the funding
 * account issued it on the first run (as `npm run credits:create` does) and
 * keeps its supply, and each run sends its share to a fresh FX account. The
 * FX service swaps it for test USDC from that account on a local port
 * (`npm run fx:start`), published in the FX account's metadata so the anchor
 * resolver finds it (`npm run fx:publish`), and a fresh settlement account
 * stands in for the control plane's (SETTLEMENT_SEED). Every account is
 * tracked, so the sweep returns their credits, USDC and KTA to the funding
 * account.
 *
 * Plain http is allowed for the FX service on the test network only.
 */

import * as KeetaNet from '@keetanetwork/keetanet-client';
import { CREDIT_TICKER, ONE_CREDIT, toHex } from '@keeta-compute/protocol';
import { Account } from '@keeta-compute/protocol/keeta';
import { fxConfigFromEnv } from '../../services/fx/src/config.ts';
import { createCreditToken, publishFxMetadata } from '../../services/fx/src/ledger.ts';
import { createFxServer, stopFxServer } from '../../services/fx/src/server.ts';
import { freePort, type Scratch } from '../support/harness.ts';
import { NETWORK, type Funder, type KeetaAccount } from './support.ts';

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

/** What one run's FX account starts with. */
const SUPPLY = 1_000n * ONE_CREDIT;
/** The supply issued once, which the sweep keeps returning to the funding account. */
const ISSUED_SUPPLY = 1_000_000_000n * ONE_CREDIT;

type UserClientAccount = Parameters<typeof KeetaNet.UserClient.fromNetwork>[1];

/**
 * The suite's credit token: of the tokens with the credit ticker, the one the
 * funding account holds most of. The funding account issues it on the first
 * run, or if it ever holds less than a run needs.
 */
export async function liveCreditToken(funder: Funder): Promise<string> {
	return funder.withClient(async (client) => {
		let found: { token: string; balance: bigint } | null = null;
		for (const { token, balance } of await client.allBalances()) {
			if (balance < SUPPLY || (found && balance <= found.balance)) {
				continue;
			}
			const address = token.publicKeyString.get();
			const { info } = await client.client.getAccountInfo(address);
			if (info.name === CREDIT_TICKER) {
				found = { token: address, balance };
			}
		}
		if (found) {
			return found.token;
		}
		const token = await createCreditToken(client, { fx: funder.address, supply: ISSUED_SUPPLY });
		console.log(`issued the live suite's credit token ${token}; later runs reuse it`);
		return token;
	});
}

export async function startCredits(funder: Funder, scratch: Scratch, options: { serveFx?: boolean } = {}): Promise<LiveCredits> {
	const fxSeed = toHex(crypto.getRandomValues(new Uint8Array(32)));
	const fx = funder.track(Account.fromSeed(fxSeed, 0));
	const settlementSeed = toHex(crypto.getRandomValues(new Uint8Array(32)));
	const settlement = funder.track(Account.fromSeed(settlementSeed, 0));
	/* The FX account publishes its metadata and swaps, the settlement account its payouts. */
	await funder.fundKta([fx, settlement].map((account) => account.publicKeyString.get()));

	const token = await liveCreditToken(funder);
	await funder.fund(fx.publicKeyString.get(), token, SUPPLY);
	console.log(`credit token ${token}, run supply in FX account ${fx.publicKeyString.get()}, settlement account ${settlement.publicKeyString.get()}`);

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
