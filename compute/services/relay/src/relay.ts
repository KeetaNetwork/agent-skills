/**
 * Relay entry points, separated from the Worker glue so they can be tested.
 */

import { providerRelayToken, ticketMac, timingSafeEqual, type JobEnvelope } from '@keeta-compute/protocol';

export function errorJson(status: number, code: string, message: string): Response {
	return Response.json({ error: { code, message } }, { status });
}

/** Check a provider's connect token (minted by the control plane at heartbeat). */
export async function checkProviderToken(secret: string, nodeKey: string | null, exp: string | null, token: string | null, now: number): Promise<string | null> {
	if (!nodeKey || !exp || !token || !/^keeta_[a-z2-7]+$/.test(nodeKey)) {
		return 'nodeKey, exp and token are required';
	}
	const expiresAt = Number(exp);
	if (!Number.isFinite(expiresAt) || expiresAt < now) {
		return 'token expired';
	}
	if (!timingSafeEqual(token, await providerRelayToken(secret, nodeKey, expiresAt))) {
		return 'invalid token';
	}
	return null;
}

/** Check a buyer's job envelope before forwarding it to the provider. */
export async function checkEnvelope(secret: string, jobId: string, envelope: JobEnvelope, now: number): Promise<string | null> {
	const signed = envelope?.ticket;
	if (!signed?.ticket || typeof signed.relayMac !== 'string' || !envelope.request) {
		return 'ticket and request are required';
	}
	if (signed.ticket.jobId !== jobId) {
		return 'ticket is for another job';
	}
	if (signed.ticket.expiresAt < now) {
		return 'ticket expired';
	}
	if (!timingSafeEqual(signed.relayMac, await ticketMac(secret, signed.ticket))) {
		return 'ticket was not issued by the control plane';
	}
	/* Prepaid tickets appear in public 402 quotes; only the router runs them, after the x402 payment verifies. */
	if (signed.ticket.paymentMode !== 'escrow') {
		return 'prepaid jobs run only through the paid API';
	}
	if (typeof envelope.buyerSig !== 'string') {
		return 'buyer signature is required';
	}
	return null;
}
