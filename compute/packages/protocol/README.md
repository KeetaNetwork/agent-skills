# @keeta-compute/protocol

The contracts every part of Keeta Compute shares. Nothing here does I/O except the control-plane client.

- **Types and records**: offers, jobs, tickets, receipts, relay frames, pairing records (`src/types.ts`, `src/messages.ts`).
- **Catalog**: the curated models (`src/catalog.ts`), their Hugging Face pins with weights and tokenizer hashes (`src/catalog-pins.ts`, written by `npm run catalog:pin`) and hardware tiers. `catalog.json` is exported from it for the site (`npm run catalog:export -w @keeta-compute/protocol`).
- **Money**: prices in Keeta Compute Credits per million tokens, job costs and caps (`src/pricing.ts`); the credit token per network (`src/credits.ts`, `src/credit-pins.ts`); the Keeta stablecoins and USDC (`src/assets.ts`, `src/asset-pins.ts`).
- **Signing**: canonical JSON, signed requests, ticket and receipt messages, and Keeta key helpers (`@keeta-compute/protocol/keeta`).
- **Control-plane client**: `ControlClient`, which signs each request with a Keeta account (`@keeta-compute/protocol/client`).
- **App-to-agent RPC contract**: the JSON-RPC methods and shapes between the macOS app and the agent (`@keeta-compute/protocol/rpc`). The Swift app mirrors it in `macos/Sources/KeetaComputeKit/RPCTypes.swift`.
- **Local helpers**: the `Log` type and `utcDay`, for the packages that run on a member's machine.

Depends on `@keetanetwork/keetanet-client`.

## Develop

From `compute/`:

```bash
npm test -w @keeta-compute/protocol
npm run typecheck -w @keeta-compute/protocol
```
