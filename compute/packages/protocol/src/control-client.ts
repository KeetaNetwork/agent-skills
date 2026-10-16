/**
 * Signed HTTP client for the control plane, used by providers, buyers and
 * the CLI. Each request is signed by a Keeta account (signRequest).
 */

import { signRequest, type Signer } from './index.ts';

export class ControlError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
		readonly retryAfterSeconds?: number
	) {
		super(message);
	}
}

export class ControlClient {
	constructor(
		private readonly baseUrl: string,
		private readonly fetchImpl: typeof fetch = fetch
	) {}

	async request<T>(signer: Signer | null, method: string, path: string, body?: unknown): Promise<T> {
		const rawBody = body === undefined ? '' : JSON.stringify(body);
		const pathOnly = path.split('?')[0]!;
		const headers: Record<string, string> = { 'content-type': 'application/json' };
		if (signer) {
			Object.assign(headers, await signRequest(signer, method, pathOnly, rawBody));
		}
		let response: Response;
		try {
			response = await this.fetchImpl(`${this.baseUrl}${path}`, { method, headers, ...(rawBody ? { body: rawBody } : {}) });
		} catch (error) {
			throw new ControlError(0, 'network', `control plane unreachable: ${(error as Error).message}`);
		}
		const text = await response.text();
		let json: unknown = null;
		try {
			json = text ? JSON.parse(text) : null;
		} catch {
			json = null;
		}
		if (!response.ok) {
			const error = (json as { error?: { code?: string; message?: string } } | null)?.error;
			const retry = Number(response.headers.get('retry-after'));
			throw new ControlError(response.status, error?.code ?? 'error', error?.message ?? `control plane returned ${response.status}`, Number.isFinite(retry) ? retry : undefined);
		}
		return json as T;
	}

	get<T>(signer: Signer | null, path: string) {
		return this.request<T>(signer, 'GET', path);
	}

	post<T>(signer: Signer | null, path: string, body: unknown) {
		return this.request<T>(signer, 'POST', path, body);
	}
}
