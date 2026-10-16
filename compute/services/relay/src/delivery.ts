/**
 * The relay's records for an app job, posted to the control plane: the
 * delivery record (the hash of the text it forwarded, when the buyer brought
 * the ticket, and when it hung up if nothing was forwarded), which decides
 * how the job's escrow is settled (the provider is paid only for a receipt
 * that matches it, plus the no-show fee for a ticket not used promptly), and
 * the record that the provider was offline when the buyer brought its
 * ticket, which spares the buyer the no-show fee. Each is
 * retried until the control plane accepts it rather than dropped on the
 * first failure.
 */

export const DELIVERY_RETRY_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000];

interface RecordTarget {
	controlUrl: string;
	routerSecret: string;
	jobId: string;
}

export async function postDelivery(
	options: RecordTarget & { outputHash: string; maxOutputTokens: number; presentedAt?: number; abandonedAt?: number },
	fetchImpl: typeof fetch = fetch,
	delays: number[] = DELIVERY_RETRY_DELAYS_MS
): Promise<boolean> {
	const { controlUrl: _url, routerSecret: _secret, jobId: _job, ...record } = options;
	return postRecord(options, 'delivery', record, fetchImpl, delays);
}

export async function postProviderOffline(options: RecordTarget, fetchImpl: typeof fetch = fetch, delays: number[] = DELIVERY_RETRY_DELAYS_MS): Promise<boolean> {
	return postRecord(options, 'provider-offline', {}, fetchImpl, delays);
}

async function postRecord(options: RecordTarget, kind: string, record: Record<string, unknown>, fetchImpl: typeof fetch, delays: number[]): Promise<boolean> {
	const url = `${options.controlUrl}/v1/relay/jobs/${encodeURIComponent(options.jobId)}/${kind}`;
	const body = JSON.stringify(record);
	for (const delay of [0, ...delays]) {
		if (delay) {
			await new Promise((resolve) => setTimeout(resolve, delay));
		}
		const response = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-router-secret': options.routerSecret }, body }).catch(() => null);
		if (response?.ok) {
			return true;
		}
		/* A 4xx other than a rate limit will not change on retry. */
		if (response && response.status >= 400 && response.status < 500 && response.status !== 429) {
			return false;
		}
	}
	return false;
}
