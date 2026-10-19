/**
 * Wrangler bundles the Keeta SDK's browser build (through @x402/keeta), and
 * that build reads `window.crypto` as it loads. Workers have no `window`, so
 * without this the Worker throws before it serves anything. index.ts imports
 * this module first so it runs before the SDK loads.
 */
const scope = globalThis as unknown as { window?: unknown };
scope.window ??= globalThis;

export {};
