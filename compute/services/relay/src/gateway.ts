/**
 * The x402 payment gateway, connected on first use. Connecting asks the
 * facilitator what it supports; a failed attempt is not kept, so the next
 * paid request tries again instead of the Worker failing until it restarts.
 * Requests that need no payment check (model list, quotes) never connect.
 */

import type { PaymentGateway } from './router.ts';

export function lazyGateway(connect: () => Promise<PaymentGateway>): PaymentGateway {
	let pending: Promise<PaymentGateway> | undefined;
	const ready = () =>
		(pending ??= connect().catch((error: unknown) => {
			pending = undefined;
			throw error;
		}));
	return {
		async verify(payload, requirements) {
			return (await ready()).verify(payload, requirements);
		},
		async settle(payload, requirements) {
			return (await ready()).settle(payload, requirements);
		}
	};
}
