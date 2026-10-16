/**
 * Canonical JSON and hashing helpers. Signatures are always computed over
 * canonical bytes so that every party (Swift app, agent, control plane,
 * relay) derives the same message.
 */

/** JSON with object keys sorted recursively and no insignificant whitespace. */
export function canonicalJSON(value: unknown): string {
	return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
	if (typeof value === 'bigint') {
		return value.toString();
	}
	if (Array.isArray(value)) {
		return value.map(sortValue);
	}
	if (value !== null && typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value as Record<string, unknown>).sort()) {
			const entry = (value as Record<string, unknown>)[key];
			if (entry === undefined) {
				continue;
			}
			out[key] = sortValue(entry);
		}
		return out;
	}
	return value;
}

const encoder = new TextEncoder();

export function utf8(text: string): Uint8Array<ArrayBuffer> {
	return encoder.encode(text) as Uint8Array<ArrayBuffer>;
}

export function toHex(bytes: Uint8Array | ArrayBuffer): string {
	const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	let out = '';
	for (const byte of view) {
		out += byte.toString(16).padStart(2, '0');
	}
	return out;
}

export function fromHex(hex: string): Uint8Array {
	if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
		throw new Error('invalid hex');
	}
	const out = new Uint8Array(hex.length / 2);
	for (let i = 0; i < out.length; i++) {
		out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	}
	return out;
}

/** SHA-256 using WebCrypto, available in Node 22, Workers and Bun. */
export async function sha256(data: Uint8Array | string): Promise<Uint8Array> {
	const bytes = typeof data === 'string' ? utf8(data) : data;
	const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
	return new Uint8Array(digest);
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
	return toHex(await sha256(data));
}

export function randomId(prefix: string, bytes = 16): string {
	const raw = new Uint8Array(bytes);
	crypto.getRandomValues(raw);
	return `${prefix}_${toHex(raw)}`;
}

/** Constant-time comparison of two equal-length strings. */
export function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) {
		return false;
	}
	let diff = 0;
	for (let i = 0; i < a.length; i++) {
		diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return diff === 0;
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
	const key = await crypto.subtle.importKey('raw', utf8(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	const mac = await crypto.subtle.sign('HMAC', key, utf8(message));
	return toHex(new Uint8Array(mac));
}
