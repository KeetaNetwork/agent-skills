/**
 * Prices are integer base units of Keeta Compute Credits (one credit is one
 * US dollar, 6 decimals) per million tokens.
 * All arithmetic is bigint; nothing is converted through floating point.
 */

import { PRICE_UNIT_TOKENS } from './constants.ts';

export interface Price {
	inputPerMillion: string;
	outputPerMillion: string;
}

export interface Usage {
	inputTokens: number;
	outputTokens: number;
}

function ceilDiv(a: bigint, b: bigint): bigint {
	return (a + b - 1n) / b;
}

/** Amount owed for a job, in base units, rounded up, at least 1 for any work. */
export function jobCost(price: Price, usage: Usage): bigint {
	const raw = BigInt(usage.inputTokens) * BigInt(price.inputPerMillion) + BigInt(usage.outputTokens) * BigInt(price.outputPerMillion);
	if (raw === 0n) {
		return usage.inputTokens + usage.outputTokens > 0 ? 1n : 0n;
	}
	return ceilDiv(raw, PRICE_UNIT_TOKENS);
}

/** The most a job can cost given its token limits; used for quotes and caps. */
export function maxJobCost(price: Price, limits: { maxInputTokens: number; maxOutputTokens: number }): bigint {
	return jobCost(price, { inputTokens: limits.maxInputTokens, outputTokens: limits.maxOutputTokens });
}

/** Format base units as a decimal string, e.g. 1234567n with 6 decimals → "1.234567". */
export function formatAmount(amount: bigint, decimals: number): string {
	const negative = amount < 0n;
	const abs = negative ? -amount : amount;
	const base = 10n ** BigInt(decimals);
	const whole = abs / base;
	const fraction = (abs % base).toString().padStart(decimals, '0').replace(/0+$/, '');
	return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

/** Parse a decimal string into base units. Rejects more precision than the asset has. */
export function parseAmount(text: string, decimals: number): bigint {
	const match = /^(\d+)(?:\.(\d+))?$/.exec(text.trim());
	if (!match) {
		throw new Error(`invalid amount: ${text}`);
	}
	const fraction = match[2] ?? '';
	if (fraction.length > decimals) {
		throw new Error(`amount has more than ${decimals} decimal places`);
	}
	return BigInt(match[1] ?? '0') * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
}

/** Rough token estimate for quoting before the provider tokenizes (4 chars ≈ 1 token, rounded up generously). */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 3) + 8;
}
