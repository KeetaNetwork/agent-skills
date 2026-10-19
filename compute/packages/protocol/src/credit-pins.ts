/**
 * The Keeta Compute Credits token per network. Written by
 * `npm run credits:create` (needs the Keeta network), which creates the
 * token on the test network, mints its supply to the keeta.ai FX account and
 * records both here.
 *
 * Null means credits do not exist on that network yet: the control plane
 * refuses app jobs there, and clients show credits as unavailable. The main
 * network stays null until keeta.ai issues the token there.
 */

import type { NetworkName } from './constants.ts';

export interface CreditPin {
	/** Token address of Keeta Compute Credits. */
	token: string;
	/** Decimal places from the token's metadata; always CREDIT_DECIMALS. */
	decimals: number;
	/** The keeta.ai FX account that sells and buys credits; its account info publishes the FX service. */
	fx: string;
}

export const CREDIT_PINS: Record<NetworkName, CreditPin | null> = {
	"test": null,
	"main": null
};
