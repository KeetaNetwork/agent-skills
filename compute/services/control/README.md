# @keeta-compute/control

The Keeta Compute control plane: provider registry, scheduler, escrow quotes and checks, tickets, receipts, settlement from keeta.ai's settlement account, router quotes for the public API, and pairing of Linux helpers. It runs as a Firebase HTTPS function backed by Firestore (`src/index.ts`, with a scheduled `sweep`), or as a local Node server with an in-memory store (`src/server.ts`).

Firestore keeps routing state and Keeta block hashes, never balances: escrows, payouts and refunds are read from and published to the Keeta ledger, and a payout is found on the ledger before it is ever sent again.

- `src/service.ts`: the rules (scheduling, quotes, the credit balance check, escrow verification, settlement decisions).
- `src/http.ts`: the HTTP API and its signed-request checks.
- `src/config.ts`: settings from the environment, the ledger verifier and the settlement account.
- `src/store.ts`, `src/firestore-store.ts`: the in-memory and Firestore stores.

Settings: `COORDINATOR_SEED`, `RELAY_SECRET`, `ROUTER_SECRET` and `SETTLEMENT_SEED` (secrets); `RELAY_URL`, `NETWORKS` (default `test`), `ALLOW_SMALL_PROVIDERS`, `TEST_CREDIT_TOKEN` and `TEST_FX_ACCOUNT` (a test-network credit token before its pin lands), `FALLBACK_PAY_TO` and `FALLBACK_MODELS` (the optional OpenRouter fallback for the public router), and `REQUIRE_BUYER_BALANCE=false` to skip the ledger balance read in local development. Deploy steps are in [`compute/README.md`](../../README.md#deploy).

## Develop

From `compute/`:

```bash
npm test -w @keeta-compute/control
npm run typecheck -w @keeta-compute/control
npm run dev -w @keeta-compute/control      # local server; see compute/README.md for the settings
```
