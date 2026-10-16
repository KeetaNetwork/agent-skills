# Public API router

Status: test-network preview. `https://api.keeta.ai/v1` is the planned production base URL.

The router serves Keeta Compute to clients without the macOS app: servers, other platforms, any HTTP client. It speaks the OpenAI chat API and charges per request with x402 on Keeta, in KUSD (in USDC until KUSD is live on the network). There is no account, API key or invoice: the payment is the authorization.

```text
Base URL: https://api.keeta.ai/v1
```

## Endpoints

### GET /v1/models

Free. Lists models with at least one online provider, plus any model the router can serve through its fallback, in the OpenAI list format. Each entry has an extra `keeta` object: how many providers serve the model, and the lowest price per million input and output tokens in Keeta Compute Credit base units (one credit is one US dollar, with 6 decimals, so `50000` is $0.05).

```json
{
  "object": "list",
  "data": [
    {
      "id": "qwen3-8b",
      "object": "model",
      "keeta": {
        "providers": 3,
        "lowestPrice": { "inputPerMillion": "50000", "outputPerMillion": "100000" }
      }
    }
  ]
}
```

### POST /v1/chat/completions

Paid. OpenAI request and response format; `stream: true` is supported. Set `max_tokens`: it bounds what the request can cost.

## Payment: x402 in Keeta stablecoins

1. Send the request with no payment. The router picks a provider and answers `402 Payment Required` with a `PAYMENT-REQUIRED` header: base64 JSON, x402 version 2.
2. Your client signs one Keeta send block for `amount` to `payTo` and retries the same request with the `PAYMENT-SIGNATURE` header. The block is signed, not published.
3. The router has the x402 facilitator verify the block and settle it on Keeta, then runs the job and returns the completion.

The payment goes straight to the serving provider's address. The router never holds the funds.

Example 402:

```bash
curl -i https://api.keeta.ai/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "qwen3-8b", "messages": [{"role": "user", "content": "Say hello."}], "max_tokens": 256}'
```

```text
HTTP/2 402
content-type: application/json
payment-required: eyJ4NDAyVmVyc2lvbiI6Mi...
```

The `PAYMENT-REQUIRED` header, decoded:

```json
{
  "x402Version": 2,
  "resource": { "url": "https://api.keeta.ai/v1/chat/completions" },
  "accepts": [
    {
      "scheme": "exact",
      "network": "keeta:1413829460",
      "asset": "keeta_<the KUSD token address>",
      "amount": "27",
      "payTo": "keeta_<the serving provider's address>",
      "maxTimeoutSeconds": 60,
      "extra": {
        "jobId": "job_<id>",
        "assetSymbol": "KUSD",
        "model": "qwen3-8b",
        "maxInputTokens": 20,
        "maxOutputTokens": 256,
        "price": { "inputPerMillion": "50000", "outputPerMillion": "100000" }
      }
    }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `network` | `keeta:1413829460` on the test network, `keeta:21378` on the main network |
| `asset` | The KUSD token address on that network, or USDC's until KUSD is live there. `extra.assetSymbol` names it. |
| `amount` | The maximum cost in the asset's base units: estimated input tokens plus `max_tokens`, at the provider's price in credits, one US dollar per credit, rounded up |
| `payTo` | The serving provider's Keeta address |
| `extra` | The job id, the asset's symbol, the model, token limits and price the amount was computed from |

In the example, 20 × 50000 + 256 × 100000 = 26600000, divided by one million and rounded up: 27 base units, or 0.000027 KUSD.

You pay the maximum. Tokens not used are not refunded in this version, so keep `max_tokens` close to what you need.

## When the network is full

When no provider can take a request, keeta.ai may answer it from its own capacity so paid requests still get an answer. keeta.ai turns this on per model and sets its price.

- The 402 quote then shows keeta.ai's own address as `payTo`. Network providers are always tried first.
- You are charged only once text has streamed, as with providers.
- keeta.ai may run these requests through an upstream inference provider. It forwards only the standard chat fields and asks for upstream providers that do not collect prompt data.
- These responses have no provider receipt, because no network provider ran the job.

## Receipts

Every completion served by a network provider carries the provider's signed receipt: model, weights hash, runtime, token counts, price and amount ([fields](https://keeta.ai/compute/protocol.md)).

- Non-streaming: the `X-Keeta-Receipt` response header, base64 JSON `{"receipt": {...}, "signature": "..."}`.
- Streaming: a final server-sent event after the completion chunks:

```text
event: keeta.receipt
data: {"receipt": {...}, "signature": "..."}
```

## TypeScript buyer

Uses the same packages as the [x402-payments skill](https://keeta.ai/skills/x402-payments/SKILL.md) (verified there with `@x402/*` 2.28.0 and `@keetanetwork/keetanet-client` 0.18.7).

```bash
npm install @keetanetwork/keetanet-client @x402/core @x402/keeta @x402/fetch
```

```ts
import * as KeetaNet from "@keetanetwork/keetanet-client";
import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { ExactKeetaScheme, KEETA_TESTNET_CAIP2, toClientKeetaSigner } from "@x402/keeta";

// Load the seed from your secret store. Never print, log or commit it.
const account = KeetaNet.lib.Account.fromSeed(process.env.KEETA_SEED!, 0);
const signer = toClientKeetaSigner(account); // opens a UserClient; destroy it when done
const model = "qwen3-8b";

try {
  const client = new x402Client()
    .register(KEETA_TESTNET_CAIP2, new ExactKeetaScheme(signer))
    .setSpendControls({ maxAmountPerPayment: "$0.05" }) // cap per request
    .onBeforePaymentCreation(async ({ selectedRequirements: req }) => {
      const extra = req.extra as { model?: string; assetSymbol?: string } | undefined;
      const stablecoin = extra?.assetSymbol === "KUSD" || extra?.assetSymbol === "USDC";
      if (req.network !== KEETA_TESTNET_CAIP2 || extra?.model !== model || !stablecoin) {
        return { abort: true, reason: "unexpected payment request" };
      }
    });

  const fetchWithPayment = wrapFetchWithPayment(fetch, client);
  const response = await fetchWithPayment("https://api.keeta.ai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "Say hello." }],
      max_tokens: 256,
    }),
  });
  if (!response.ok) throw new Error(`router answered ${response.status}`);

  const completion = await response.json();
  const header = response.headers.get("X-Keeta-Receipt");
  const receipt = header ? JSON.parse(Buffer.from(header, "base64").toString("utf8")) : undefined;
  console.log(completion.choices[0].message.content, receipt?.receipt.amount);
} finally {
  await signer.destroy();
}
```

- The spend cap and the `onBeforePaymentCreation` check run in your client. The chain does not enforce them.
- Pay sequentially from each account. Keeta account chains are ordered, so one account cannot sign two payments at once. Queue requests, or spread them over several funded accounts when you need parallel requests.
- Fund the paying account with the stablecoin the 402 asks for: KUSD, or USDC where KUSD is not live yet. On the main network use `KEETA_MAINNET_CAIP2` and main-network stablecoins.

## Errors

| Status | Meaning |
| --- | --- |
| 400 | Invalid request: malformed JSON or fields the router does not accept |
| 402 | Payment required, or the payment failed verification or settlement |
| 404 | Unknown model |
| 502 | The provider failed. If it failed before streaming started, the payment is not settled. |
| 503 | No provider is available for the model now. Retry after the `Retry-After` header. |
