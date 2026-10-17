# Protocol

Status: test-network preview. Version 1 of the formats below; field names match the shared protocol package in the [source repository](https://github.com/KeetaNetwork/agent-skills).

## Identities

Every party is a Keeta public key (`keeta_…`). Every signature is a Keeta account signature (`Account.sign`), hex encoded, so a key can live in the Secure Enclave, in a software keyfile or in any Keeta wallet.

| Key | Held by | Used for |
| --- | --- | --- |
| Node key | Each Mac, Linux node or Linux helper | Signs requests to the network and the receipts for its jobs. Cannot move funds. |
| Payout address (`payTo`) | The operator's wallet (passkey on the Mac, an encrypted wallet file on a Linux node) | Receives every payment for the operator's machines, including paired Linux helpers |
| Buyer key | The paying account (the Agent budget in the app) | Escrows credits for app jobs, or pays the router; is what provider allowlists list |
| Settlement account | keeta.ai | Receives app escrows and pays them out: the provider's bill and the buyer's refund |
| FX account | keeta.ai | Holds the credit supply and swaps credits with the Keeta stablecoins |

At onboarding the operator signs a link message tying each node key to its payout address.

## Signed requests

Calls from apps and helpers to the control plane and relay carry four headers:

| Header | Value |
| --- | --- |
| `x-kc-key` | The caller's Keeta public key |
| `x-kc-ts` | Unix time in milliseconds |
| `x-kc-nonce` | 12 random bytes, hex |
| `x-kc-sig` | Hex signature by `x-kc-key` over the message below |

The signed message is UTF-8, lines joined with `\n`, no trailing newline:

```text
keeta-compute-request-v1
METHOD
PATH
TIMESTAMP
NONCE
sha256hex(body)
```

`METHOD` is upper case, `TIMESTAMP` and `NONCE` are the header values, and the last line is the lowercase hex SHA-256 of the exact body bytes (of the empty string when there is no body). Requests more than 2 minutes from server time are rejected, and nonces are not accepted twice.

Other signed messages use the same pattern, a version line followed by canonical JSON (object keys sorted recursively, no whitespace, undefined fields dropped):

- Receipt: `keeta-compute-receipt-v1\n` + canonical JSON of the receipt.
- Ticket: `keeta-compute-ticket-v1\n` + canonical JSON of the ticket.
- Buyer job authorization: `keeta-compute-job-v1\n` + job id + `\n` + sha256 hex of the canonical JSON of the request.

## Credits and stablecoins

Keeta Compute Credits are a token on the Keeta ledger: one credit is one US dollar, with 6 decimals, so one credit is `1000000` base units. Prices, quotes, receipts and payouts for app jobs are in credits. The token address of each network is published by the control plane (`GET /v1/config`, field `credits`), with the settlement account and the FX account.

Buyers get credits with Keeta stablecoins, in this order: KUSD, KEUR, KJPY, KMXN, KCAD, KAED, KGBP, USDC. keeta.ai's FX account sells and buys credits for each of them as a Keeta anchor FX service, published in the FX account's metadata so the anchor SDK's resolver finds it. KUSD and USDC trade one to one; the others at a US dollar rate with a small spread. `GET /v1/config` also lists the stablecoins of each network (field `assets`) and which are available yet.

Balances are only ever read from the ledger. The network's job records keep the hashes of the escrow and payout blocks, never balances or amounts owed.

## Job lifecycle

1. **Schedule.** The buyer asks the control plane for a provider for a model, with its token limits and optionally the most it will pay (`maxCost`, credit base units) (`POST /v1/jobs`). The scheduler picks an online provider (heartbeat in the last 90 seconds) that offers the model, accepts the buyer, has a free slot and whose escrow is no more than `maxCost`. The request can also name the providers to use (`allowedProviders`: node keys or payout addresses) or to skip (`excludeProviders`), at most 100 of each. A provider's allowlists name at most 1000 buyer keys in total: its own list, plus the lists of models that set their own. A quote does not hold the slot. A buyer has at most 4 quotes waiting for escrow and 8 jobs in flight; past that it gets 429.
2. **Escrow quote.** For an app job the control plane answers with a quote instead of a ticket: `maxCost` (the credits to escrow, in base units: the most the job can cost, and never less than the no-show fee of `1000`, 0.001 credits), the credit `token`, the `settlement` account and `expiresAt`, 60 seconds out.
3. **Escrow.** The buyer sends `maxCost` of the credit token to the settlement account in one Keeta send whose external reference is the job id, and reports the block hash (`POST /v1/jobs/{jobId}/escrow`). The control plane reads the block from the ledger: it must be signed by the buyer and send at least `maxCost` of the credit token to the settlement account with this job's reference. Until the ledger shows the block the answer is `pending`; a block that does not escrow the job gets 402. A buyer escrows each job once, and reports the same block again on a retry. An escrow that arrives after the quote expired or was cancelled is refunded in full.
4. **Ticket.** Once the escrow is confirmed, the control plane signs a ticket for that one job and provider, valid for 60 seconds, and the ticket takes a slot on the provider. If the quoted provider filled up since the quote, the ticket goes to another that fits the same request and whose escrow is no larger; if none has a free slot, the escrow is refunded in full and the answer is 409 `no_provider`. Router jobs get their ticket in the quote and pay with x402 instead ([router](https://keeta.ai/compute/router.md)).
5. **Relay.** The buyer sends the ticket, the request and its job authorization to the relay, which forwards them over the provider's open connection. If the provider is not connected, the relay answers 503 and records that for the job. A ticket that is already running gets 409 `ticket_used`.
6. **Provider.** The provider checks the ticket signature, its own key, the expiry and its allowlist, then runs the model and streams tokens back through the relay.
7. **Signed receipt.** The provider signs a receipt with the actual token counts and the amount. If the buyer hangs up, the provider bills the text it sent.
8. **Delivery record.** For app jobs the relay records a sha256 hash of the text it forwarded and the job's output limit, when the buyer brought the ticket, and when the buyer hung up if that was before any text. After a hang-up the relay tells the provider to stop, and the record also counts the text the provider sent before that reached it, for at most 5 seconds, so it covers what the receipt bills.
9. **Settlement.** The relay's record decides how the escrow is paid out, in one Keeta block from the settlement account whose sends reference the job:
   - The receipt's `outputHash` matches the record and its output tokens fit in that text: `amount` less the network fee to `payTo`, the rest of the escrow back to the buyer. The fee stays in the settlement account.
   - The receipt bills other text: the whole escrow back to the buyer, and the dispute counts against the provider.
   - A receipt with no record yet waits up to a minute for one, then the whole escrow goes back to the buyer.
   - The provider fails the job, or no receipt arrives within 15 minutes of a ticket the buyer brought to the relay: the whole escrow goes back to the buyer.
   - A ticket holds a slot on its provider, so it must be brought to the relay within 10 seconds of being issued and not hung up on within 10 seconds of arriving before any text. A ticket the relay never saw, or hung up on that early, is a no-show: the provider gets the no-show fee, `1000` base units (0.001 credits), and the rest of the escrow goes back to the buyer. A ticket brought late that runs pays the fee on top of its `amount`. A buyer that waited longer than 10 seconds for text gets the whole escrow back.

   Before paying, the settlement account looks for a block of its own that references the job, so a job is never paid out twice.

   Router jobs settle from the x402 payment instead of an escrow. It goes to the settlement account with the job id as the send's external reference. Once the receipt bills the job, one block pays `payTo` the receipt's `amount` in the payment's stablecoin (never more than the prepayment) less the network fee, and sends the rest back to the payer. A job the provider fails, or one with no receipt before its ticket lapses, is refunded in full. The payment block is read from the ledger before anything is paid.
10. **Reputation.** Completed, failed and disputed jobs update the provider's record, which the scheduler reads. A router job counts as completed only once the router has reported its payment.

Structured output is compiled before the first token, so requests are bounded: `response_format` JSON schemas (and tool parameters when a tool call is forced) must be at most 8 KB, nest at most 8 levels and avoid `anyOf`, `oneOf`, `allOf`, `not`, `$ref`, `pattern` and conditionals; `stop` takes at most 4 sequences of 256 bytes. Counting a prompt's tokens takes time in proportion to its size, so a provider refuses a request whose size bound (the one tickets use without a pinned tokenizer) is more than 16 times its ticket's input limit plus 65,536, before counting it.

What providers report is bounded too, so every client can show it: an offer's `contextLength` is at most 16,777,216 tokens, and a machine's `memoryBytes` at most 1 PiB (2^50 bytes). Free disk above 1 PiB is recorded as 1 PiB.

## Tickets

| Field | Meaning |
| --- | --- |
| `v` | `1` |
| `jobId` | Job id |
| `network` | `test` or `main` |
| `nodeKey` | The provider chosen |
| `modelId` | Model id |
| `buyer` | The paying key |
| `maxInputTokens`, `maxOutputTokens` | Token limits for the job. For a catalog model with a pinned tokenizer, the input limit is the prompt's exact token count plus 16 tokens and 1%; the provider recounts the prompt and refuses a ticket below its count. Otherwise it is a bound from the prompt's size. |
| `price` | `{inputPerMillion, outputPerMillion}`, credit base units |
| `asset` | The credit token (app jobs), or the stablecoin the router was paid in |
| `payTo` | Where payment goes |
| `paymentMode` | `escrow` (app) or `prepaid` (router) |
| `prepaidAmount` | Amount already paid, prepaid jobs only |
| `issuedAt`, `expiresAt` | Unix milliseconds |

A signed ticket is `{ticket, coordinatorSig, relayMac}`: `coordinatorSig` is checked by the provider, `relayMac` by the relay.

## Receipts

A signed receipt is `{receipt, signature}`, where `signature` is by `receipt.nodeKey` over the receipt message above. The control plane keeps only those two fields and refuses a signed receipt larger than 8 KB of JSON.

| Field | Meaning |
| --- | --- |
| `v` | `1` |
| `jobId` | Job id from the ticket |
| `network` | `test` or `main` |
| `nodeKey` | The provider's node key, which signs the receipt |
| `payTo` | Where payment goes |
| `buyer` | The paying key |
| `modelId` | Model id |
| `weightsHash` | sha256 over the installed weight files |
| `runtime` | `{kind, build}`: `mlx` or `openai-compatible`, and the runtime name and version, such as `mlx-lm 0.26.0` |
| `inputTokens`, `outputTokens` | Tokens actually processed and generated |
| `price` | `{inputPerMillion, outputPerMillion}`, credit base units |
| `amount` | Credit base units billed, paid from the escrow (app jobs), or consumed of the prepayment (router) |
| `asset` | The ticket's `asset` |
| `startedAt`, `finishedAt` | Unix milliseconds |
| `outputHash` | sha256 of the generated text: each streamed chunk's answer, reasoning and refusal, then the name and arguments of each tool call in it, in stream order. The text itself is never stored. |
| `finishReason` | As in the OpenAI response, such as `stop` or `length` |

To check a receipt: verify the signature with the Keeta SDK against `nodeKey`, then compare `modelId`, `price`, `payTo` and the token limits with your ticket or 402 challenge, and `outputHash` with the sha256 of the text you received.

## Pricing math

Prices are integer credit base units per million tokens. Credits have 6 decimals, so 1 credit (one US dollar) is `1000000` base units and 0.05 credits per million tokens is `50000`. All arithmetic is integer.

```text
raw    = inputTokens × inputPerMillion + outputTokens × outputPerMillion
amount = ceil(raw / 1000000)
```

Any job that processed at least one token costs at least 1 base unit. An escrow quote (`maxCost`) or x402 challenge uses the same formula with `maxInputTokens` and `maxOutputTokens`. The router converts the result to its stablecoin's decimals, one US dollar per credit, rounding up.

The buyer pays `amount`. The network keeps a 0.25% fee from it, and the provider receives the rest:

```text
fee      = ceil(amount × 25 / 10000)
provider = amount − fee
```

The fee applies to app and router jobs alike, and not to the no-show fee. For a router job it is computed on `amount` after conversion to the stablecoin.

Example: 1200 input and 300 output tokens at `50000` / `100000` gives raw = 60000000 + 30000000 = 90000000, so amount = 90 base units (0.00009 credits, or $0.00009).

## On-chain and off-chain

- **On-chain (Keeta Network):** all money and every balance. The credit token, swaps between credits and stablecoins, each app job's escrow to the settlement account and its payout block, and each router payment to the settlement account and its payout block.
- **Off-chain (app backend):** the provider registry (node keys, hardware, offers, prices, access lists, heartbeats), job records (routing state, the receipt, the relay's delivery record, and the hashes of the escrow and payout blocks), pairing records for Linux helpers, and reputation counters. No balances, amounts owed or earnings.
- **Never stored:** prompts and outputs. They pass through the relay to the provider and back. Job records hold the receipt, which holds only the output's hash.
