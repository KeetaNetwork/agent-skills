/**
 * Byte layouts that get signed. Every signature in the system is a Keeta
 * account signature (Account.sign) over one of these messages, so a provider
 * key can be a Secure Enclave P-256 key, a software secp256k1 key, or a key
 * from any Keeta wallet.
 */

import { canonicalJSON, hmacSha256Hex, sha256Hex, utf8 } from './canonical.ts';
import type { JobTicket, NetworkName, Receipt } from './index.ts';

export interface Signer {
	/** Keeta public key string (keeta_…). */
	readonly publicKey: string;
	/** Returns a hex signature as produced by Keeta Account.sign(). */
	sign(message: Uint8Array): Promise<string>;
}

export type Verifier = (publicKey: string, message: Uint8Array, signatureHex: string) => boolean;

export const REQUEST_HEADERS = {
	key: 'x-kc-key',
	timestamp: 'x-kc-ts',
	nonce: 'x-kc-nonce',
	signature: 'x-kc-sig'
} as const;

export async function requestMessage(method: string, path: string, timestamp: number, nonce: string, body: string): Promise<Uint8Array> {
	const bodyHash = await sha256Hex(body);
	return utf8(['keeta-compute-request-v1', method.toUpperCase(), path, String(timestamp), nonce, bodyHash].join('\n'));
}

/** Headers for an authenticated control-plane or relay request. */
export async function signRequest(signer: Signer, method: string, path: string, body: string, now = Date.now()): Promise<Record<string, string>> {
	const nonceBytes = new Uint8Array(12);
	crypto.getRandomValues(nonceBytes);
	const nonce = Array.from(nonceBytes, (b) => b.toString(16).padStart(2, '0')).join('');
	const signature = await signer.sign(await requestMessage(method, path, now, nonce, body));
	return {
		[REQUEST_HEADERS.key]: signer.publicKey,
		[REQUEST_HEADERS.timestamp]: String(now),
		[REQUEST_HEADERS.nonce]: nonce,
		[REQUEST_HEADERS.signature]: signature
	};
}

export function receiptMessage(receipt: Receipt): Uint8Array {
	return utf8(`keeta-compute-receipt-v1\n${canonicalJSON(receipt)}`);
}

export function ticketMessage(ticket: JobTicket): Uint8Array {
	return utf8(`keeta-compute-ticket-v1\n${canonicalJSON(ticket)}`);
}

export function ticketMacInput(ticket: JobTicket): string {
	return `keeta-compute-relay-v1\n${ticket.jobId}\n${ticket.nodeKey}\n${ticket.expiresAt}`;
}

export function ticketMac(secret: string, ticket: JobTicket): Promise<string> {
	return hmacSha256Hex(secret, ticketMacInput(ticket));
}

/** The buyer's paying key authorizes this exact request for this job. */
export async function jobAuthMessage(jobId: string, request: unknown): Promise<Uint8Array> {
	return utf8(`keeta-compute-job-v1\n${jobId}\n${await sha256Hex(canonicalJSON(request))}`);
}

/**
 * Proof that the operator controls the payout account a node advertises.
 * Signed once at onboarding with the passkey-backed operator key.
 */
export function operatorLinkMessage(args: { nodeKey: string; payTo: string; network: NetworkName; issuedAt: number }): Uint8Array {
	return utf8(`keeta-compute-link-v1\n${canonicalJSON(args)}`);
}

/** Master install approves a Linux helper claim. */
export function pairingApprovalMessage(args: { pairingId: string; helperNodeKey: string; masterNodeKey: string; payTo: string }): Uint8Array {
	return utf8(`keeta-compute-pairing-v1\n${canonicalJSON(args)}`);
}

/** Token a provider presents to the relay to open its job channel. */
export function providerRelayToken(secret: string, nodeKey: string, expiresAt: number): Promise<string> {
	return hmacSha256Hex(secret, `keeta-compute-provider-v1\n${nodeKey}\n${expiresAt}`);
}
