# Keeta Compute

A marketplace for AI inference capacity, settled on Keeta. Mac owners install the app, pick models their machine can run, and sell capacity. Buyers (people, local agents, or anyone through the public x402 router) pay per token in USDC. Linux machines join a Mac's fleet as helpers and are paid to the Mac's wallet.

Status: test-network preview. Nothing here touches Keeta mainnet unless an operator selects it in the app, and the control plane only enables `test` unless `NETWORKS` says otherwise.

## Layout

| Path | What it is |
| --- | --- |
| `packages/protocol` | Shared types, model catalog, hardware tiers, pricing, signed message formats, validation, Keeta key helpers. `catalog.json` is generated from it. |
| `services/control` | Control plane on Firebase (Functions + Firestore): provider registry, scheduler, job tickets, receipts, payment checks, Linux helper pairing. |
| `services/relay` | Cloudflare Worker: the provider relay (one Durable Object per node, outbound WebSocket from the provider) and the public OpenAI-compatible router paid with x402. |
| `agent` | The agent daemon. Bundled into the macOS app, where it talks JSON-RPC over stdio, and shipped as the Linux helper CLI. Provider loop, local buyer endpoint, budget wallet, model manager. |
| `macos` | The SwiftUI app: onboarding, passkey wallet, Secure Enclave node key, models, provide, use, fleet. |
| `test/e2e.test.ts` | Runs control, a relay emulation, two Macs and a paired helper in one process with real signatures and a fake ledger. |

Docs for users live in `site/compute/` and are published at https://keeta.ai/compute.

## How a job flows

1. The buyer's agent asks the control plane for a job (`POST /v1/jobs`), signed by its budget key. The scheduler picks a live provider that offers the model within the buyer's price, context and allowlist limits, and returns a ticket signed by the coordinator key and MACed for the relay. The budget key must hold enough USDC on the ledger to cover the new job's maximum cost plus every job it still owes for; a fresh key with no funds gets HTTP 402. Local development can turn this off with `REQUIRE_BUYER_BALANCE=false`.
2. The buyer sends the ticket, the request and its own signature over the request to the relay (`POST /v1/jobs/:id/run`). The relay checks the MAC and forwards the job down the provider's WebSocket. Prompts pass through memory only; nothing stores them.
3. The provider re-checks the ticket (coordinator signature, its own key, expiry, model, price, allowlist, buyer signature), streams tokens from its local model server, and signs a receipt with token counts, price, amount and the weights hash.
4. The buyer checks the receipt against the ticket and against the text it received (same output hash, and no more output tokens than that text can hold), pays the provider's operator with a direct Keeta send referencing the job id, and reports the block (with the receipt) to the control plane, which verifies it on the ledger. Buyers with receipts unpaid after 10 minutes cannot start new jobs.

If the buyer hangs up mid-answer, the provider still signs a receipt for the text it sent, and the buyer's agent fetches that receipt from the control plane and pays it.

The public router (`api.keeta.ai`) prepays instead: it answers with HTTP 402 carrying the quote, verifies the x402 payment, runs the job, and settles only once the provider has streamed text (for a non-streaming request, only once the whole answer arrived without an error).

## Keys

- **Operator wallet**: derived from a passkey PRF output (no seed phrase). Receives earnings and funds the agent budget. Never stored by the app.
- **Node key**: P-256 in the Secure Enclave on a Mac (a 0600 file on a Linux helper). Signs receipts and requests; holds no funds.
- **Agent budget**: a local key holding only what the operator moved into it. Local agents spend from it, within per-request and daily limits.

## Develop

```bash
cd compute
npm ci
npm run typecheck
npm test
npm run test:e2e
```

Run the control plane locally with an in-memory store:

```bash
COORDINATOR_SEED=$(node -e "import('@keetanetwork/keetanet-client').then(k=>console.log(k.lib.Account.generateRandomSeed({asString:true})))") \
RELAY_SECRET=dev ROUTER_SECRET=dev ALLOW_SMALL_PROVIDERS=true \
node --import tsx services/control/src/server.ts
```

Build the agent binaries (needs [bun](https://bun.sh)):

```bash
cd agent
npm run build:mac          # bundled into the app by macos/
npm run build:linux-x64
npm run build:linux-arm64
```

## Deploy

Nothing is deployed by CI. Each step below is run by hand by someone with access.

1. **Control plane** (Firebase project with Firestore in native mode):
   - Set secrets: `firebase functions:secrets:set COORDINATOR_SEED RELAY_SECRET ROUTER_SECRET`.
   - `cd services/control && npm run build && firebase deploy --only functions,firestore,hosting`.
   - Point `control.keeta.ai` at the Hosting site; `/v1/**` rewrites to the `api` function.
2. **Relay and router** (Cloudflare):
   - `cd services/relay && wrangler secret put RELAY_SECRET && wrangler secret put ROUTER_SECRET`.
   - Set `CONTROL_URL`, `NETWORK` and `FACILITATOR_URL` in `wrangler.toml`, then `wrangler deploy`.
   - `RELAY_SECRET` must match the control plane's; it signs provider connect tokens and ticket MACs.
3. **Linux helper**: build the three binaries, attach them to a GitHub release with a `.sha256` file each (`keeta-compute-agent-linux-x64`, `...-linux-arm64`). `site/compute/install-helper.sh` downloads from the latest release.
4. **macOS app**: see `macos/README.md` for signing, notarization and the associated domain needed by passkeys.
