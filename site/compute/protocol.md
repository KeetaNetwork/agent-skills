# Protocol

Status: test-network preview. Version 1 of the formats below; field names match the shared protocol package in the [source repository](https://github.com/KeetaNetwork/agent-skills).

## Identities

Every party is a Keeta public key (`keeta_…`). Every signature is a Keeta account signature (`Account.sign`), hex encoded, so a key can live in the Secure Enclave, in a software keyfile or in any Keeta wallet.

| Key | Held by | Used for |
| --- | --- | --- |
| Node key | Each Mac or Linux helper | Signs requests to the network and the receipts for its jobs. Cannot move funds. |
| Payout address (`payTo`) | The operator's wallet (passkey on the Mac) | Receives every payment for the operator's machines, including paired Linux helpers |
| Buyer key | The paying account | Pays providers; is what provider allowlists list |

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

## Job lifecycle

1. **Schedule.** The buyer asks the control plane for a provider for a model, with its token limits. The scheduler picks an online provider (heartbeat in the last 90 seconds) that offers the model, accepts the buyer and has capacity.
2. **Ticket.** The control plane signs a ticket for that one job and provider. It is valid for 60 seconds.
3. **Relay.** The buyer sends the ticket, the request and its job authorization to the relay, which forwards them over the provider's open connection.
4. **Provider.** The provider checks the ticket signature, its own key, the expiry and its allowlist, then runs the model and streams tokens back through the relay.
5. **Signed receipt.** The provider signs a receipt with the actual token counts and the amount.
6. **Payment.** The buyer pays `amount` to `payTo` in the settlement asset: a Keeta send from the app (postpay), or an x402 payment before the job on the [router](https://keeta.ai/compute/router.md) (prepaid). A buyer with a receipt left unpaid for more than 10 minutes is not scheduled again until it pays.
7. **Reputation.** Completed, failed and paid jobs update the provider's record, which the scheduler reads.

## Tickets

| Field | Meaning |
| --- | --- |
| `v` | `1` |
| `jobId` | Job id |
| `network` | `test` or `main` |
| `nodeKey` | The provider chosen |
| `modelId` | Model id |
| `buyer` | The paying key |
| `maxInputTokens`, `maxOutputTokens` | Token limits for the job |
| `price` | `{inputPerMillion, outputPerMillion}`, base units |
| `asset` | Settlement token address (USDC) |
| `payTo` | Where payment goes |
| `paymentMode` | `postpay` (app) or `prepaid` (router) |
| `prepaidAmount` | Amount already paid, prepaid jobs only |
| `issuedAt`, `expiresAt` | Unix milliseconds |

A signed ticket is `{ticket, coordinatorSig, relayMac}`: `coordinatorSig` is checked by the provider, `relayMac` by the relay.

## Receipts

A signed receipt is `{receipt, signature}`, where `signature` is by `receipt.nodeKey` over the receipt message above.

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
| `price` | `{inputPerMillion, outputPerMillion}`, base units |
| `amount` | Base units owed (postpay) or consumed (prepaid) |
| `asset` | Settlement token address |
| `startedAt`, `finishedAt` | Unix milliseconds |
| `outputHash` | sha256 of the generated text. The text itself is never stored. |
| `finishReason` | As in the OpenAI response, such as `stop` or `length` |

To check a receipt: verify the signature with the Keeta SDK against `nodeKey`, then compare `modelId`, `price`, `payTo` and the token limits with your ticket or 402 challenge, and `outputHash` with the sha256 of the text you received.

## Pricing math

Prices are integer base units of the settlement asset per million tokens. USDC has 6 decimals, so 1 USDC is `1000000` base units and 0.05 USDC per million tokens is `50000`. All arithmetic is integer.

```text
raw    = inputTokens × inputPerMillion + outputTokens × outputPerMillion
amount = ceil(raw / 1000000)
```

Any job that processed at least one token costs at least 1 base unit. A quote or x402 challenge uses the same formula with `maxInputTokens` and `maxOutputTokens`.

Example: 1200 input and 300 output tokens at `50000` / `100000` gives raw = 60000000 + 30000000 = 90000000, so amount = 90 base units (0.00009 USDC).

## On-chain and off-chain

- **On-chain (Keeta Network):** payments only. Each payment is an ordinary Keeta send of USDC from the buyer to the provider's payout address.
- **Off-chain (app backend):** the provider registry (node keys, hardware, offers, prices, access lists, heartbeats), job records and receipts, pairing records for Linux helpers, and reputation counters.
- **Never stored:** prompts and outputs. They pass through the relay to the provider and back. Job records hold the receipt, which holds only the output's hash.
