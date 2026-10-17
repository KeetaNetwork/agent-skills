/**
 * Small helpers shared by the packages that run on a member's machine: the
 * provider, the buyer, the agent and the CLI.
 */

/** Where a package writes its log lines; the agent sends them to the app or to stderr. */
export type Log = (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;

/** The UTC day of a time, as YYYY-MM-DD: the key for daily spend and token counts. */
export function utcDay(now = Date.now()): string {
	return new Date(now).toISOString().slice(0, 10);
}
