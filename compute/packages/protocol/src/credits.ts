/**
 * Keeta Compute Credits: the token app buyers prepay inference with.
 *
 * People hold Keeta stablecoins (KUSD, KEUR, KJPY, KMXN, KCAD, KAED, KGBP,
 * or USDC) and swap them for credits through the keeta.ai FX provider. One
 * credit is one US dollar, with 6 decimals, so offer prices and job costs
 * are credit base units per million tokens. A buyer escrows a job's maximum
 * cost in credits when it is scheduled; the control plane pays the provider
 * what it billed and refunds the rest. Providers earn credits and swap them
 * back to a stablecoin to cash out.
 */

import { CREDIT_PINS, type CreditPin } from './credit-pins.ts';
import type { NetworkName } from './constants.ts';

export const CREDIT_DECIMALS = 6;

/** The token's ledger name (its ticker) and description, set by `credits:create`. */
export const CREDIT_TICKER = 'KCREDIT';
export const CREDIT_NAME = 'Keeta Compute Prepaid Credits';

/** How amounts in credits are labelled in the apps. */
export const CREDIT_SYMBOL = 'credits';

/** One credit, in base units: one US dollar. */
export const ONE_CREDIT = 10n ** BigInt(CREDIT_DECIMALS);

/** The credit token a network uses, from the pins; null where credits do not exist yet. */
export function pinnedCredits(network: NetworkName): CreditPin | null {
	return CREDIT_PINS[network];
}

/**
 * Credits on one network as the control plane publishes them in /v1/config:
 * the token, the settlement account buyers escrow to, and the FX account
 * that sells and buys credits.
 */
export interface NetworkCredits {
	token: string;
	decimals: number;
	symbol: string;
	name: string;
	/** keeta.ai account app jobs are escrowed to and paid out from. */
	settlement: string;
	/** The FX provider's account (the anchor resolver root that lists it), when known. */
	fx: string | null;
}

/** What `POST /v1/jobs` returns for an app job: escrow this much, then fetch the ticket. */
export interface EscrowQuote {
	jobId: string;
	network: NetworkName;
	/** The most the job can cost, in credit base units; the buyer escrows exactly this. */
	maxCost: string;
	token: string;
	decimals: number;
	/** Send `maxCost` of `token` here with `jobId` as the send's external reference. */
	settlement: string;
	/** The quote holds its provider until then. */
	expiresAt: number;
}
