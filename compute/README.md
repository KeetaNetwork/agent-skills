# Keeta Compute

A marketplace for AI inference capacity, settled on Keeta. Mac owners install the app, pick models their machine can run, and sell capacity. Buyers (people, local agents, or anyone through the public x402 router) pay per token in USDC. Linux machines run the same agent from the command line: as full nodes with their own wallet that sell and buy like the app, or as helpers in another node's fleet, paid to that node's wallet.

Status: test-network preview. Nothing here touches Keeta mainnet unless an operator selects it in the app, and the control plane only enables `test` unless `NETWORKS` says otherwise.

## Layout

| Path | What it is |
| --- | --- |
| `packages/protocol` | Shared types, model catalog, hardware tiers, pricing, signed message formats, validation, Keeta key helpers. `catalog.json` is generated from it. |
| `services/control` | Control plane on Firebase (Functions + Firestore): provider registry, scheduler, job tickets, receipts, payment checks, pairing of Linux helpers to a Mac or Linux master. |
| `services/relay` | Cloudflare Worker: the provider relay (one Durable Object per node, outbound WebSocket from the provider) and the public OpenAI-compatible router paid with x402. |
| `agent` | The agent daemon. Bundled into the macOS app, where it talks JSON-RPC over stdio, and shipped as the Linux CLI (`src/cli.ts`: a full node with its own encrypted wallet, plus the `helper` satellite mode). Provider loop, local buyer endpoint, budget wallet, model manager. |
| `macos` | The SwiftUI app: onboarding, passkey wallet, Secure Enclave node key, models, provide, use, fleet. |
| `test/e2e.test.ts` | Runs control, a relay emulation, two Macs, a paired helper and a Linux CLI node in one process with real signatures and a fake ledger. |
| `test/worker.test.ts` | Runs the real relay Worker under `wrangler dev` (workerd, local Durable Objects) with a provider on a real WebSocket. No network needed. |
| `test/live/` | The live suite: everything above against the Keeta test network, the real relay Worker and the real x402 facilitator. See [Live tests](#live-tests). |

Docs for users live in `site/compute/` and are published at https://keeta.ai/compute.

## How a job flows

1. The buyer's agent asks the control plane for a job (`POST /v1/jobs`), signed by its budget key. The scheduler picks a live provider that offers the model within the buyer's price, context and allowlist limits, and returns a ticket signed by the coordinator key and MACed for the relay. The budget key must hold enough USDC on the ledger to cover the new job's maximum cost plus every job it still owes for; a fresh key with no funds gets HTTP 402. Local development can turn this off with `REQUIRE_BUYER_BALANCE=false`.
2. The buyer sends the ticket, the request and its own signature over the request to the relay (`POST /v1/jobs/:id/run`). The relay checks the MAC and forwards the job down the provider's WebSocket. Prompts pass through memory only; nothing stores them.
3. The provider re-checks the ticket (coordinator signature, its own key, expiry, model, price, allowlist, buyer signature), streams tokens from its local model server, and signs a receipt with token counts, price, amount and the weights hash.
4. The buyer checks the receipt against the ticket and against the text it received (same output hash, and no more output tokens than that text can hold), pays the provider's operator with a direct Keeta send referencing the job id, and reports the block (with the receipt) to the control plane, which verifies it on the ledger. Buyers with receipts unpaid after 10 minutes cannot start new jobs. The relay records a hash of the text it forwarded for each app job (`POST /v1/relay/jobs/:id/delivery`). A buyer disputes a receipt that bills anything else (`POST /v1/jobs/:id/refuse`), which leaves it unowed and counts against the provider; a receipt matching the relay's record cannot be disputed, so the buyer pays it even if its own copy was cut short by a hang-up. The relay retries that record until the control plane accepts it; a dispute of a receipt with no record yet waits up to a minute for one, and a matching record that arrives after a dispute makes the receipt owed again. Handing back a ticket that has not been receipted yet frees the provider's slot but keeps the job open until the ticket lapses: a provider that already streamed can still file its receipt, and the job's maximum cost stays held against the buyer's balance until then.

If the buyer hangs up mid-answer, the provider still signs a receipt for the text it sent, and the buyer's agent fetches that receipt from the control plane and pays it.

The public router (`api.keeta.ai`) prepays instead: it answers with HTTP 402 carrying the quote, verifies the x402 payment, runs the job, and settles only once the provider has streamed text (for a non-streaming request, only once the whole answer arrived without an error). When no provider can take a router request and a fallback is configured for that model, the control plane quotes it to keeta.ai's own account instead and the router runs it on OpenRouter. The route stays on the control plane's job record; the quote and the response carry nothing that names OpenRouter (chunks are rebuilt in the plain OpenAI shape), and there is no provider receipt.

## Keys

- **Operator wallet**: derived from 32 bytes of entropy, read as a 24-word mnemonic and used as a Keeta passphrase. On a Mac the entropy is a passkey PRF output (no seed phrase) and is never stored. On a Linux node it is random, shown once as the recovery phrase, and kept in `operator-wallet.json` (0600) encrypted with scrypt and AES-256-GCM under the user's passphrase. Receives earnings and funds the agent budget.
- **Node key**: P-256 in the Secure Enclave on a Mac (a 0600 file on a Linux node or helper). Signs receipts and requests; holds no funds.
- **Agent budget**: a local key holding only what the operator moved into it. Local agents spend from it, within per-request and daily limits.

## Develop

```bash
cd compute
npm ci
npm run typecheck
npm test
npm run test:e2e
npm run test:worker   # the relay Worker in workerd; no Cloudflare account needed
```

Run the control plane locally with an in-memory store:

```bash
COORDINATOR_SEED=$(node -e "import('@keetanetwork/keetanet-client').then(k=>console.log(k.lib.Account.generateRandomSeed({asString:true})))") \
RELAY_SECRET=dev ROUTER_SECRET=dev ALLOW_SMALL_PROVIDERS=true \
node --import tsx services/control/src/server.ts
```

Try the Linux CLI against it with a throwaway data directory (`run` also needs a relay; see `services/relay`):

```bash
export KEETA_COMPUTE_HOME=$(mktemp -d) KEETA_COMPUTE_PASSPHRASE=dev-passphrase
node --import tsx agent/src/main.ts init --control http://127.0.0.1:8787
node --import tsx agent/src/main.ts status
```

Build the agent binaries (needs [bun](https://bun.sh)):

```bash
cd agent
npm run build:mac          # bundled into the app by macos/
npm run build:linux-x64
npm run build:linux-arm64
```

## Live tests

`npm run test:live` runs `test/live/*.test.ts` one file at a time against the **Keeta test network**. Only the model is a fake (an OpenAI-compatible server that answers "Hello from Keeta"), unless `LIVE_MODEL_URL` points at a real one. `KEETA_LIVE_SKIP=1` skips every live test.

| File | What only the network can show |
| --- | --- |
| `ledger.test.ts` | The agent's `KeetaLedger` publishes USDC and KTA sends whose block hashes the control plane's ledger verifier confirms; it reads balances of a signing account and of a public-key-only account (how the app reads the operator); `requestTestFunds` gets KTA from the faucet. |
| `control.test.ts` | The control plane from `startServer` with the production ledger verifier and balance reader: an unfunded pay-later buyer gets 402 and a funded one a ticket; a job is marked paid for an exact send, but not for one to another account, with another job id, or one base unit short; an unknown block stays pending. |
| `app.test.ts` | The relay Worker under `wrangler dev` pointing at a local control plane: a Mac-style provider (`AgentApp`) and a Linux node driven by the real CLI (`init`, `models add`, `provide --on`, `run`) each serve the buyer agent through the Worker; the buyer pays each receipt on the ledger, the job is marked paid only once the send is found, and the operator's USDC balance rises by the receipt amount. A buyer hanging up mid-answer pays for the text the relay attests it forwarded. |
| `router.test.ts` | A client with only `@x402/fetch` and the Keeta exact scheme calls `POST /v1/chat/completions` on the Worker, gets 402, pays USDC through the real facilitator (`https://facilitator.x402.keeta.com`), and gets the completion with the provider's signed receipt; the operator receives exactly the quoted amount; replaying the payment header is refused and moves no money. |

Each run creates fresh accounts, tops them up from the funding account with a few cents of USDC (KTA for fees comes from the faucet, or from the funding account when the faucet is slow), and sends what is left back at the end. It prints the funding account's address and balances first, and stops with a clear message if it holds less than 0.10 test USDC. A run spends well under one cent of test USDC.

The payment checks for app jobs (`fundAppBuyer`, `watchSettlement`) live in `test/live/payments.ts`, so they can move to prepaid credits without touching the tests.

### Run it locally

```bash
cd compute
npm ci
npm run test:live                      # spends from the suite's fixed test-network account
# KEETA_TESTNET_SEED=... (or KEETA_TESTNET_PASSPHRASE="24 words") uses another funding account instead
```

Add `KC_TEST_LOG=1` to see the agent and `wrangler dev` logs. The suite refuses to start if `KEETA_LIVE_NETWORK` is set to anything but `test`; it never touches main-network funds.

To use a real model, start an OpenAI-compatible server and point the suite at it, for example llama.cpp:

```bash
docker run -p 8080:8080 ghcr.io/ggml-org/llama.cpp:server \
  --hf-repo Qwen/Qwen2.5-0.5B-Instruct-GGUF --hf-file qwen2.5-0.5b-instruct-q4_k_m.gguf --alias live-model --host 0.0.0.0 --port 8080
LIVE_MODEL_URL=http://127.0.0.1:8080/v1 LIVE_MODEL_NAME=live-model npm run test:live
```

### Fund the account

The suite funds itself from a fixed test-network account whose seed is in `test/live/support.ts`:

`keeta_aabpcmdf36xopdmazjtbjlhh4zoyfg7pscd2avvcs3fcflpcica5wqeh375fmci`

The seed is public on purpose, so anyone can top the account up and run the suite. It must only ever hold test-network coins. The same seed gives the same address on the main network, so never send it real funds; the suite refuses to run anywhere but the test network.

1. Test USDC (`keeta_apna75yhhvnv4ei7ape55hndk4yepno7a7i2mhtiwahiygixjcnmvswxhnmnk`) comes from Circle's test-USDC faucet bridged to the account (see the `bridge-crypto` skill). 1 test USDC covers hundreds of runs.
2. KTA for fees: `curl -sS -X POST https://faucet.test.keeta.com/ -H 'Content-Type: application/x-www-form-urlencoded' --data "address=keeta_aabpcmdf36xopdmazjtbjlhh4zoyfg7pscd2avvcs3fcflpcica5wqeh375fmci&amount=10"`. 20 KTA or more is comfortable.

### In CI

`.github/workflows/compute-live.yml` runs the suite on manual dispatch, and nightly and on pull requests that touch `compute/` once the repository variable `COMPUTE_LIVE` is set to `on` (off until the test account is funded). It spends from the fixed test account above; the optional repository secret `KEETA_TESTNET_SEED` (or `KEETA_TESTNET_PASSPHRASE`) swaps in another. Pull requests from forks don't run it. A concurrency group keeps two runs from spending the funding account at once. A manual run with `model: llama` starts llama.cpp's server container with Qwen2.5 0.5B (about 400 MB from Hugging Face) and runs the same suite against it.

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
   - Optional fallback: set `FALLBACK_PAY_TO` (keeta.ai's receiving address) and `FALLBACK_MODELS` (JSON: model id → `{"route": "<OpenRouter slug>", "price": {...}, "contextLength": N}`) on the control plane, and `wrangler secret put OPENROUTER_API_KEY` on the worker. Price each model above its OpenRouter cost. Leaving `FALLBACK_MODELS` empty keeps the fallback off.
3. **Linux CLI**: build the binaries and attach them to a GitHub release (`keeta-compute-agent-linux-x64`, `...-linux-arm64`). Then set `VERSION`, `SHA256_X64` and `SHA256_ARM64` in `site/compute/install-helper.sh` to that tag and the binaries' SHA-256 through a reviewed PR; the installer refuses anything else, so a replaced release asset is never installed.
4. **macOS app**: see `macos/README.md` for signing, notarization and the associated domain needed by passkeys.
