# Keeta Compute

A marketplace for AI inference capacity, settled on Keeta. Providers sell spare capacity running open-weight models: Apple Silicon Macs through the macOS app, and Linux GPU machines through the same agent on the command line. Buyers pay with Keeta stablecoins, KUSD first, then KEUR, KJPY, KMXN, KCAD, KAED, KGBP and USDC. In the app and the CLI they buy Keeta Compute Credits with them and pay for each request from credits escrowed on the Keeta ledger. Anyone else calls the public router and pays each request with x402.

Status: test-network preview. Nothing here touches Keeta mainnet unless an operator selects it in the app, and the control plane only enables `test` unless `NETWORKS` says otherwise.

## Pay with Keeta stablecoins

- **Keeta Compute Credits** are a token on the Keeta ledger: one credit is one US dollar, with 6 decimals. Prices, spend limits, escrows and earnings are all in credits. The token is pinned per network in `packages/protocol/src/credit-pins.ts`: `npm run credits:create` makes it on the test network, and the main-network pin stays empty until keeta.ai issues credits there.
- **The FX provider** (`services/fx`) is keeta.ai's FX account running a Keeta anchor FX service. The account holds the credit supply and swaps credits both ways with every pinned stablecoin. KUSD and USDC trade one to one; the other stablecoins trade at the rate source's US dollar rate with a spread (50 basis points by default). The service is published in the FX account's metadata, so clients find it through the anchor resolver.
- **Stablecoins** are pinned per network in `packages/protocol/src/asset-pins.ts` by `npm run assets:pin`, which resolves each `$K` code (`$KUSD`, `$KEUR`, …) through the network's anchor resolver and reads the token's decimals from the ledger. USDC is built in (the addresses `@x402/keeta` ships). Until a stablecoin is pinned it is listed but not offered.
- **In the app and the CLI** a buyer picks a stablecoin (KUSD by default) and buys credits into the agent budget: `wallet.buyCredits`, the Mac app's Buy credits sheet, or `keeta-compute-agent wallet buy-credits 5 --with KUSD`. Providers cash credits out the same way: `wallet.sellCredits`, Cash out in the app, or `wallet sell-credits AMOUNT --to KUSD`. The user confirms an estimate and a limit 0.5% past it (`wallet.creditQuote`); the swap checks the FX provider's signed quote against that limit before signing and swaps nothing past it.
- **On the public router** the x402 quote asks for KUSD when it is pinned on the network and USDC until then, at the offer's credit price (one US dollar per credit), paid to keeta.ai's settlement account, which pays the provider once the job is billed.
- **The network fee** is 0.25% of what each job bills (`NETWORK_FEE_BPS` in `packages/protocol/src/pricing.ts`), rounded up to the token's smallest unit. Buyers pay the listed price and providers receive 99.75% of it; the fee stays in the settlement account. It applies to app jobs and router jobs alike, and not to the no-show fee.

Every balance is read from the ledger. The control plane keeps no balances, amounts owed or earnings: a provider's earnings are the settlement account's sends to its operator, read from the operator's history on the ledger.

## Layout

Each part is its own npm package with its own README and tests, and uses the others only by package name (`@keeta-compute/...`), never by a relative path. Any of them can move to its own repository with the packages it depends on published.

| Path | What it is |
| --- | --- |
| `packages/protocol` | `@keeta-compute/protocol`: shared types, model catalog, hardware tiers, pricing, signed message formats, validation, Keeta key helpers, the stablecoin and credit pins, the control-plane client (`/client`) and the app-to-agent RPC contract (`/rpc`). `catalog.json` is generated from it. |
| `packages/runtime-openai` | `@keeta-compute/runtime-openai`: streams a chat completion from a local OpenAI-compatible server (mlx_lm.server, llama.cpp, vLLM, SGLang) and returns what a receipt needs. |
| `packages/runtime-mlx` | `@keeta-compute/runtime-mlx`: the MLX runtime for Apple Silicon. A pinned uv and Python with hash-locked mlx-lm, and one `mlx_lm.server` per offered model on 127.0.0.1. |
| `packages/tokens` | `@keeta-compute/tokens`: counts a request's prompt tokens exactly with the model's pinned tokenizer and chat template, so buyers price the real prompt and providers cannot bill more input than it has. |
| `packages/wallet` | `@keeta-compute/wallet`: node, budget and operator keys, the encrypted Linux wallet file with its recovery phrase, ledger sends and balances, and credit swaps through the FX provider. |
| `packages/provider` | `@keeta-compute/provider`: the provider loop (registration, heartbeats, the relay WebSocket, ticket checks, jobs, receipts), hardware probes, and the model manager that downloads and hash-verifies catalog models. Holds the `catalog:pin` script. |
| `packages/buyer` | `@keeta-compute/buyer`: the local OpenAI-compatible endpoint. It quotes each request, escrows its maximum cost in credits, streams the answer through the relay and checks the receipt. |
| `packages/agent` | `@keeta-compute/agent`: wires the wallet, provider and buyer together behind the JSON-RPC contract the macOS app drives, and keeps the node's saved state. |
| `packages/cli` | `@keeta-compute/cli`: the `keeta-compute-agent` binary. The macOS app bundles it and runs `app`. On Linux it is a full node with its own encrypted wallet, or a `helper` paired with one. |
| `services/control` | Control plane on Firebase (Functions + Firestore): provider registry, scheduler, escrow quotes and checks, tickets, receipts, settlement from the settlement account, router quotes, pairing of Linux helpers to a Mac or Linux master. |
| `services/relay` | Cloudflare Worker: the provider relay (one Durable Object per node, outbound WebSocket from the provider) that posts a delivery record for each app job, and the public OpenAI-compatible router paid with x402. |
| `services/fx` | keeta.ai's FX provider: swaps the Keeta stablecoins and USDC with credits, plus the `assets:pin`, `credits:create` and `fx:publish` scripts. |
| `macos` | The SwiftUI app: onboarding, passkey wallet, Buy credits and Cash out, Secure Enclave node key, models, provide, use, fleet. It runs the agent from `packages/cli`. |
| `test/e2e.test.ts` | Runs control, a relay emulation, two Macs, a paired helper and a Linux CLI node in one process with real signatures and an in-memory ledger: credits bought through an exchange, escrows priced with an exact prompt count, payouts and cash-outs, and a provider refusing a ticket priced below the prompt. |
| `test/worker.test.ts` | Runs the real relay Worker under `wrangler dev` (workerd, local Durable Objects) with a provider on a real WebSocket. No network needed. |
| `test/live/` | The live suite: everything above against the Keeta test network, the real relay Worker, a real FX service and the real x402 facilitator. See [Live tests](#live-tests). |

Docs for users live in `site/compute/` and are published at https://keeta.ai/compute.

## How an app job flows

1. **Quote.** The buyer's agent asks for a job (`POST /v1/jobs`), signed by its budget key. The scheduler picks a live provider with a free slot that offers the model within the buyer's price, context and allowlist limits, and, when the buyer lists providers to use (`allowedProviders`, node keys or payout addresses, at most 100), is one of them. The quote does not hold the slot. The request carries the job's token limits: the output limit the caller asked for, and an input limit of the prompt's exact token count plus a small margin (16 tokens and 1%), counted with the model's pinned tokenizer and chat template (`packages/tokens`). A model with no pinned tokenizer is limited by the prompt's size in bytes instead. The answer is an escrow quote, not a ticket: the credits to escrow (`maxCost`: the job's maximum cost from the price and the token limits, and never less than the 0.001-credit no-show fee), the credit token, the settlement account and an expiry 60 seconds out. Before quoting, the control plane reads the buyer's credit balance from the ledger: the buyer's quotes still waiting for escrow, this one included, must fit in that balance together, or the request gets HTTP 402. A buyer has at most 4 quotes waiting and 8 jobs in flight (quotes and tickets not yet run); past that it gets HTTP 429. The buyer's agent sends its spend ceiling (`maxCost`, the lower of its per-request limit and what is left of its daily limit, where the escrows of its requests not billed yet count as spent), so providers whose escrow would be above it are skipped instead of quoted for a job it would refuse.
2. **Escrow.** The agent sends `maxCost` credits from the budget to keeta.ai's settlement account, with the job id as the send's reference, and reports the block (`POST /v1/jobs/:id/escrow`). It makes one escrow send per job: the block is stored before it is reported, and a retry or a follow-up reports that block again instead of sending another. The control plane reads the block from the ledger. It must be signed by the buyer and send at least `maxCost` of the credit token to the settlement account with this job's reference. A block the ledger does not show yet is pending; one that does not escrow the job gets HTTP 402. A confirmed escrow returns the ticket, signed by the coordinator key and MACed for the relay, and the ticket takes a slot on the provider: holding a provider always has credits behind it. If the quoted provider filled up or went offline in the meantime, the ticket goes to another provider that fits the same request (price ceiling, allowlist, context) and whose escrow is no larger; if none has a free slot, the escrow is refunded in full and the buyer gets HTTP 409 `no_provider`. An escrow that lands after the quote expired, or after the buyer cancelled the quote, is refunded in full. A request that gives up before its escrow is confirmed cancels the quote first, so a late confirmation is refunded rather than ticketed.
3. **Run.** The buyer sends the ticket, the request and its own signature over the request to the relay (`POST /v1/jobs/:id/run`). The relay checks the MAC and forwards the job down the provider's WebSocket. A ticket runs once at a time: posting it again while it runs, or until its delivery record is posted, gets HTTP 409 `ticket_used` and never reaches the provider, which itself refuses a ticket it already ran. Prompts pass through memory only; nothing stores them. If the provider is not connected, the relay answers HTTP 503 and records that with the control plane (`POST /v1/relay/jobs/:id/provider-offline`), so the buyer, who showed up, owes no no-show fee.
4. **Receipt.** The provider re-checks the ticket (coordinator signature, its own key, expiry, model, price, allowlist, buyer signature), counts the prompt with the same pinned tokenizer and refuses a ticket whose input limit is below that count (counting takes time in proportion to the prompt, so a node with no free slot, or a request whose size bound is more than 16 times its ticket's input limit plus 65,536, is refused before it is counted), streams tokens from its local model server, and signs a receipt with token counts, price, amount and the weights hash. Input is billed at the model server's own count; when the server reports none, at the exact count, or for a model with no pinned tokenizer at the prompt's size bound the ticket priced. It is never billed past the ticket's input limit, which the control plane enforces too. If the buyer hangs up mid-answer, the provider still bills the text it sent, with input at the exact count. A job runs for at most 10 minutes (`MAX_JOB_MS`): then the provider stops the model and bills the text it sent (finish reason `length`), so every job settles before its ticket lapses.
5. **Delivery record.** The relay posts a hash of the text it forwarded (answers, reasoning and refusals, and the name and arguments of each tool call, so a tool call is billed like an answer of the same length) and the job's output limit (`POST /v1/relay/jobs/:id/delivery`, `services/relay/src/delivery.ts`), with when the buyer brought the ticket and, if the buyer hung up before any text was forwarded, when. If the buyer hangs up, the relay tells the provider to stop and waits for its receipt before posting the record, still counting the text the provider sent until the cancel reached it (for at most 5 seconds, `HANG_UP_GRACE_MS`), so the record and the receipt cover the same text. It retries until the control plane takes it. The first record stands.
6. **Settlement.** The relay's record decides how the escrow is paid out, in one block from the settlement account that references the job:
   - The receipt matches the record (same output hash, and no more output tokens than that text can hold): the provider's operator gets the bill less the network fee, the buyer's budget gets the rest of the escrow, and the fee stays in the settlement account.
   - The receipt bills other text: everything back to the buyer, and the dispute counts against the provider.
   - A receipt with no record yet waits up to a minute for it (the relay retries for about 15 seconds), then everything goes back to the buyer. A record that arrives later changes nothing.
   - The provider fails the job, or the ticket lapses (15 minutes) without a receipt after the buyer brought it to the relay (there is a delivery record, or the relay found the provider offline): everything goes back to the buyer.
   - A ticket holds one of the provider's slots, so it must be used promptly (`NO_SHOW_WINDOW_MS`, 10 seconds): brought to the relay within 10 seconds of being issued, and not hung up on within 10 seconds of arriving before any text comes back. A ticket the relay never saw (the buyer's app quit, the relay could not be reached) or one hung up on that early is a no-show: the provider's operator gets the no-show fee of 0.001 credits (`NO_SHOW_FEE`) and the buyer the rest. A ticket brought late that then runs pays the fee on top of its bill. A buyer that waited longer than the window for text gets everything back, and the stall counts against the provider. The buyer's agent counts the fee against its daily limit.

Payouts are idempotent on the ledger. Before publishing, the settlement account searches its own history for a block that references the job (back to the escrow time); the job record keeps that block's hash and nothing else about the money. An attempt is leased for 5 minutes, so a crash between publishing and recording is found on the ledger and never paid twice. The amount comes from the escrow block on the ledger, not from the job record.

The public router (`api.keeta.ai`) prepays instead: it answers with HTTP 402 carrying the quote in KUSD (USDC until KUSD is pinned), verifies the x402 payment, and sends the job to the provider. The provider checks the ticket, reserves a slot and replies `accepted` without running anything. The router then settles the payment and tells the relay to start the job (an accepted job not started within 30 seconds is dropped). Verify only simulates the signed send, so nothing runs until the payment has settled. The payment goes to the settlement account with the job id in the send (`extra.external` in the x402 requirements), in the stablecoin; credits are not involved. Once the provider's receipt bills the job, one block from the settlement account pays the operator the bill (never more than the prepayment) less the network fee and sends the rest back to the payer. Before settling, the router records the payer's signed block with the control plane (`POST /v1/router/jobs/:id/paying`), which refuses a block the payout could not count (another destination or stablecoin, less than the prepayment, or no job id as the send's reference), so such a payment is never settled. After settling, it reports the settlement (`/settled`; the x402 `transaction` names the vote staple holding the block). If that report is lost, the sweep finds the recorded block on the ledger and settles it as the report would have, which refunds it if the job has since failed. The payer is the block's own account, so a facilitator whose verify does not name the payer still works. The payout reads the block from the ledger first, so the router's word alone moves nothing. A provider that is offline, busy or refuses the ticket is never paid, and a job that fails after the start, or draws no receipt within 15 minutes of its ticket, is refunded in full. Without a settlement account (`SETTLEMENT_SEED` unset) the payment goes straight to the provider instead. A fallback job settles to keeta.ai's own account before keeta.ai calls OpenRouter. When no provider can take a router request and a fallback is configured for that model, the control plane quotes it to keeta.ai's own account instead and the router runs it on OpenRouter. The route stays on the control plane's job record; the quote and the response carry nothing that names OpenRouter (chunks are rebuilt in the plain OpenAI shape), and there is no provider receipt.

## What the control plane stores

Firestore holds routing state and Keeta block hashes, never balances.

- **Jobs**: who, what and where (buyer, node, operator, model, price, limits, network, credit token), the buyer's price ceiling and allowed providers from the quote request, status and timestamps (`quoteExpiresAt`, `ticketIssuedAt`, `handedBackAt`, `providerOfflineAt`, `completedAt`), the provider's signed receipt (its signed fields and signature only, at most 8 KB), the relay's delivery record, `escrow {blockHash, at}` and `settlement {reason, decidedAt, attemptAt, blockHash, sentAt, error}`. `payoutDue` marks a job the sweep still has to pay out. Router jobs also keep the x402 payment's block hash, `routerPayer` and `prepaidAmount` (the amount on the signed ticket).
- **Providers**: registration, offers and allowlists (at most 1000 addresses per node in total: its own list once, plus the lists of models that set their own), heartbeat and load, and the scheduler's counters (`completed`, `failed`, `tokensOut`, `disputed`; a router job counts as completed only once the router reports its payment). No earnings.
- **Pairings** of Linux helpers, **nonces** of signed requests, and a per-buyer lock that caps how many quotes and jobs a buyer has in flight.

Spend limits are kept by the agent on the buyer's machine, not by the control plane.

## Keys

- **Operator wallet**: derived from 32 bytes of entropy, read as a 24-word mnemonic and used as a Keeta passphrase. On a Mac the entropy is a passkey PRF output (no seed phrase) and is never stored. On a Linux node it is random, shown once as the recovery phrase, and kept in `operator-wallet.json` (0600) encrypted with scrypt and AES-256-GCM under the user's passphrase. Holds stablecoins, buys and cashes out credits, receives earnings and funds the agent budget.
- **Node key**: P-256 in the Secure Enclave on a Mac (a 0600 file on a Linux node or helper). Signs receipts and requests; holds no funds.
- **Agent budget**: a local key holding only the credits the operator moved into it. Local agents escrow from it, within per-request and daily limits.
- **Settlement account** (keeta.ai, `SETTLEMENT_SEED`): receives escrows and router payments, publishes payouts and refunds, and keeps the network fee. It needs KTA for fees.
- **FX account** (keeta.ai, `FX_SEED`): holds the credit supply and the stablecoins it takes in, and fills swaps. It needs KTA for fees.

## Develop

```bash
cd compute
npm ci
npm run typecheck
npm test              # every package's own tests
npm run test:e2e
npm run test:worker   # the relay Worker in workerd; no Cloudflare account needed
```

Run the control plane locally with an in-memory store. App jobs need a credit token and a settlement account; on the test network `TEST_CREDIT_TOKEN` (and `TEST_FX_ACCOUNT`) name a token before its pin lands:

```bash
COORDINATOR_SEED=$(node -e "import('@keetanetwork/keetanet-client').then(k=>console.log(k.lib.Account.generateRandomSeed({asString:true})))") \
RELAY_SECRET=dev ROUTER_SECRET=dev ALLOW_SMALL_PROVIDERS=true \
SETTLEMENT_SEED=<64 hex> TEST_CREDIT_TOKEN=keeta_... TEST_FX_ACCOUNT=keeta_... \
node --import tsx services/control/src/server.ts
```

The control plane reads each buyer's credit balance from the Keeta ledger before it quotes. `REQUIRE_BUYER_BALANCE=false` skips that read for local development without network access; deployments leave it unset.

Run the FX service on the test network (fixed test rates unless `FX_TEST_RATES` or `FX_RATE_SOURCE` is set):

```bash
FX_SEED=<64 hex> FX_NETWORK=test FX_PORT=8788 FX_PUBLIC_URL=http://127.0.0.1:8788 npm run fx:start
```

Try the Linux CLI against the control plane with a throwaway data directory (`run` also needs a relay; see `services/relay`):

```bash
export KEETA_COMPUTE_HOME=$(mktemp -d) KEETA_COMPUTE_PASSPHRASE=dev-passphrase
node --import tsx packages/cli/src/main.ts init --control http://127.0.0.1:8787
node --import tsx packages/cli/src/main.ts wallet
node --import tsx packages/cli/src/main.ts wallet buy-credits 1 --with KUSD
```

Build the agent binaries with the [bun](https://bun.sh) pinned in `package.json` (`npm ci` installs it), then check one with its self-test:

```bash
npm run build:mac -w @keeta-compute/cli          # bundled into the app by macos/
npm run build:linux-x64 -w @keeta-compute/cli
npm run build:linux-arm64 -w @keeta-compute/cli
packages/cli/dist/linux-x64/keeta-compute-agent self-test
KEETA_COMPUTE_AGENT_BINARY=packages/cli/dist/linux-x64/keeta-compute-agent npm run test:agent-binary
```

The binaries land in `packages/cli/dist/`. `self-test` initializes the agent as the app does, without the network, and checks that a fixed passkey output still gives the same wallet account; `test:agent-binary` drives a binary over stdin and stdout the way the app does.

## Live tests

`npm run test:live` runs `test/live/*.test.ts` one file at a time against the **Keeta test network**. Only the model is a fake (an OpenAI-compatible server that answers "Hello from Keeta"), unless `LIVE_MODEL_URL` points at a real one. `KEETA_LIVE_SKIP=1` skips every live test.

The suite has one credit token (`test/live/credits.ts`): the funding account issued it on the first run, the way `credits:create` does, keeps its supply and reuses it. Each run sends its share to a fresh FX account, serves the FX service on a local port with its metadata published, and uses a fresh settlement account for the control plane. The sweep returns the credits along with the USDC and KTA.

| File | What only the network can show |
| --- | --- |
| `ledger.test.ts` | The agent's `KeetaLedger` publishes stablecoin and KTA sends that the control plane's verifier confirms with the amount they carry; it reads balances of a signing account and of a public-key-only account (how the app reads the operator), and what one account sent another (how the app reads earnings); `requestTestFunds` gets KTA from the faucet. |
| `control.test.ts` | The control plane from `startServer` with the production escrow verifier and settlement account: a job is ticketed only against a block that escrows it, not one sent to another account, with another job id, or one base unit short, and an unknown block stays pending; a matched receipt and relay record pay out in one block (the operator gets the bill less the network fee, the buyer the rest of the escrow, and the settlement account keeps the fee), which the settlement account finds in its own history; a provider failure refunds the whole escrow. |
| `app.test.ts` | The relay Worker under `wrangler dev` pointing at a local control plane: the buyer agent buys credits with test USDC through the FX service; a Mac-style provider (`AgentApp`) and a Linux node driven by the real CLI (`init`, `models add`, `provide --on`, `run`) each serve it through the Worker; each job is escrowed before its ticket and paid out from the relay's record, and the ledger shows the operator up by the bill less the network fee and the buyer down by the bill. A buyer hanging up mid-answer pays for the text the relay attests it forwarded and gets the rest back. The provider's earnings are read from the ledger and cashed out to USDC. |
| `router.test.ts` | A client with only `@x402/fetch` and the Keeta exact scheme calls `POST /v1/chat/completions` on the Worker, gets 402, pays the run's settlement account in the router's stablecoin through the real facilitator (`https://facilitator.x402.keeta.com`), and gets the completion with the provider's signed receipt; the settlement account then pays the operator the bill less the network fee, returns the rest of the prepayment to the payer and keeps the fee; replaying the payment header is refused and moves no money. |

Each run creates fresh accounts, tops them up from the funding account with a few cents of test USDC (KTA for fees comes from the faucet, or from the funding account when the faucet is slow), and sends the stablecoins and KTA left at the end back. It prints the funding account's address and balances first, and stops with a clear message if it holds less than 0.10 test USDC. A run spends well under one cent.

How the app tests fund a buyer and decide that a job settled lives in `test/live/payments.ts`.

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

1. Test USDC (`keeta_aosjk5tgpgxr3qazd2abxyhj4srqua5c3xgz4lmgxuyrrwzryiqng4vacgwai`, the test network's `$USDC`) comes from Circle's test-USDC faucet (faucet.circle.com) bridged by the test network's EVM anchor. `npm run live:deposit-address` prints a Base Sepolia address that forwards USDC to the account; it is currently `0x160fa8576b17f8b9c80106eaba060c48108427b2`, for Circle's Base Sepolia USDC (`0x036CbD53842c5426634e7929541eC2318f3dCF7e`). 1 test USDC covers hundreds of runs.
2. KTA for fees: `curl -sS -X POST https://faucet.test.keeta.com/ -H 'Content-Type: application/x-www-form-urlencoded' --data "address=keeta_aabpcmdf36xopdmazjtbjlhh4zoyfg7pscd2avvcs3fcflpcica5wqeh375fmci&amount=10"`. 20 KTA or more is comfortable.
3. Once KUSD is pinned on the test network, the router quotes in it, so the account also needs a little test KUSD for `router.test.ts`.

### In CI

`.github/workflows/compute-live.yml` runs the suite on manual dispatch, and nightly and on pull requests that touch `compute/` unless the repository variable `COMPUTE_LIVE` is `false`. Set it to `false` to pause those runs, for example while the test account is being refilled. It spends from the fixed test account above and reads no repository secrets, since a branch pushed to the repository can rewrite the workflow. `KEETA_TESTNET_SEED` and `KEETA_TESTNET_PASSPHRASE` are for local runs only. Pull requests from forks don't run it. A concurrency group keeps two runs from spending the funding account at once. A manual run with `model: llama` starts llama.cpp's server container with Qwen2.5 0.5B (about 400 MB from Hugging Face) and runs the same suite against it.

## Deploy

Nothing is deployed by CI. Each step below is run by hand by someone with access, test network first.

1. **Stablecoins**: `npm run assets:pin` (or `npm run assets:pin -- test`) resolves KUSD, KEUR, KJPY, KMXN, KCAD, KAED and KGBP through each network's anchor resolver and writes `packages/protocol/src/asset-pins.ts`. It only reads the ledger. Review the diff and commit it.
2. **Credit token** (test network): `FX_SEED=<fx seed> npm run credits:create` creates Keeta Compute Credits, mints the supply (1,000,000 credits, or `CREDITS_SUPPLY`) to the FX account and writes the token and the FX account into `packages/protocol/src/credit-pins.ts`. The issuer (`CREDITS_ISSUER_SEED`, or the FX account) needs test KTA. Commit the pin. The main network is refused; its pin stays empty until keeta.ai issues credits there.
3. **Catalog pins**: `npm run catalog:pin` (needs huggingface.co) pins each catalog model to its current Hugging Face commit, the weights hash those files produce and the SHA-256 of its tokenizer files, in `packages/protocol/src/catalog-pins.ts`. Review the diff and commit it. A pinned model installs only from that commit and only with that hash, its prompts are counted exactly with that tokenizer, and the main network refuses catalog models that are not pinned.
4. **FX service**: run `npm run fx:start` behind HTTPS with `FX_SEED`, `FX_NETWORK`, `FX_PORT` and `FX_PUBLIC_URL` (the main network also needs `FX_RATE_SOURCE`, an https endpoint answering `{"EUR": "1.08", ...}` in US dollars per unit; each currency is quoted only inside its fixed range and within 2% of its last rate, see the FX README; `FX_SPREAD_BPS` sets the spread). Then `FX_SEED=... FX_PUBLIC_URL=https://fx.keeta.ai npm run fx:publish` publishes the service in the FX account's metadata; run it again whenever the URL or the pinned stablecoins change. The FX account needs KTA, and stablecoins to pay out cash-outs.
5. **Control plane** (Firebase project with Firestore in native mode):
   - Set secrets: `firebase functions:secrets:set COORDINATOR_SEED RELAY_SECRET ROUTER_SECRET SETTLEMENT_SEED`. Fund the settlement account with KTA for fees. App jobs stay off on a network until it has a credit token and `SETTLEMENT_SEED` is set.
   - Before the test-network credit pin lands, the `TEST_CREDIT_TOKEN` and `TEST_FX_ACCOUNT` parameters name the token and FX account; the main network only ever uses its pin.
   - `cd services/control && npm run build && firebase deploy --only functions,firestore,hosting`. The build bundles the function, with the workspace packages inlined, into `dist/` next to a manifest that lists only its public npm dependencies, which is what Firebase installs. The scheduled `sweep` function settles jobs whose background settlement did not finish. A job it cannot settle or pay is logged and retried on the next run, without holding up the jobs after it. It lists app jobs apart from router jobs and expires router quotes nobody paid only after the app jobs, so no number of unpaid quotes delays a refund.
   - Point `control.keeta.ai` at the Hosting site; `/v1/**` rewrites to the `api` function.
6. **Relay and router** (Cloudflare):
   - `cd services/relay && wrangler secret put RELAY_SECRET && wrangler secret put ROUTER_SECRET`.
   - Set `CONTROL_URL`, `NETWORK` and `FACILITATOR_URL` in `wrangler.toml`, then `wrangler deploy`.
   - `RELAY_SECRET` must match the control plane's; it signs provider connect tokens and ticket MACs. `ROUTER_SECRET` authenticates the relay's delivery records and the router's calls.
   - Optional fallback: set `FALLBACK_PAY_TO` (keeta.ai's receiving address) and `FALLBACK_MODELS` (JSON: model id → `{"route": "<OpenRouter slug>", "price": {...}, "contextLength": N}`, prices in credits) on the control plane, and `wrangler secret put OPENROUTER_API_KEY` on the worker. Price each model above its OpenRouter cost. Leaving `FALLBACK_MODELS` empty keeps the fallback off.
7. **Linux CLI**: build the binaries and attach them to a GitHub release (`keeta-compute-agent-linux-x64`, `...-linux-arm64`). Then set `VERSION`, `SHA256_X64` and `SHA256_ARM64` in `site/compute/install-helper.sh` to that tag and the binaries' SHA-256 through a reviewed PR; the installer refuses anything else, so a replaced release asset is never installed.
8. **macOS app**: see `macos/README.md` for signing, notarization and the associated domain needed by passkeys.
