/**
 * Pairing codes for Linux helpers (plan §5.7): at least 128 bits of entropy,
 * grouped base32 for typing, single use, short lived. The backend only ever
 * stores the code's hash.
 */

import { sha256, sha256Hex } from './canonical.ts';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 symbols, no 0/O/1/I

function encodeBase32(bytes: Uint8Array): string {
	let bits = 0;
	let value = 0;
	let out = '';
	for (const byte of bytes) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			out += ALPHABET[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) {
		out += ALPHABET[(value << (5 - bits)) & 31];
	}
	return out;
}

/** 130 bits: 26 symbols shown as XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-X. */
export function generatePairingCode(): string {
	const bytes = new Uint8Array(17);
	crypto.getRandomValues(bytes);
	const symbols = encodeBase32(bytes).slice(0, 26);
	return symbols.match(/.{1,5}/g)!.join('-');
}

export function normalizePairingCode(code: string): string {
	return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function isValidPairingCode(code: string): boolean {
	const normalized = normalizePairingCode(code);
	return normalized.length === 26 && [...normalized].every((c) => ALPHABET.includes(c));
}

export function pairingCodeHash(code: string): Promise<string> {
	return sha256Hex(`keeta-compute-pairing-code-v1\n${normalizePairingCode(code)}`);
}

/** Short string shown on both machines so the operator can confirm the claim. */
export async function pairingCheckString(nodeKey: string): Promise<string> {
	const digest = await sha256(`keeta-compute-check-v1\n${nodeKey}`);
	const symbols = encodeBase32(digest).slice(0, 6);
	return `${symbols.slice(0, 3)}-${symbols.slice(3)}`;
}
