/**
 * The relay's delivery record for an app job: the hash of the text it
 * forwarded, posted to the control plane. A dispute over the provider's
 * receipt is decided by this record, so it is retried until the control
 * plane accepts it rather than dropped on the first failure.
 */

export const DELIVERY_RETRY_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000];

export async function postDelivery(
	options: { controlUrl: string; routerSecret: string; jobId: string; outputHash: string; maxOutputTokens: number },
	fetchImpl: typeof fetch = fetch,
	delays: number[] = DELIVERY_RETRY_DELAYS_MS
): Promise<boolean> {
	const url = `${options.controlUrl}/v1/relay/jobs/${encodeURIComponent(options.jobId)}/delivery`;
	const body = JSON.stringify({ outputHash: options.outputHash, maxOutputTokens: options.maxOutputTokens });
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
