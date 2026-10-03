---
name: x402-payments
description: Pay for, or charge for, API calls and web content per request with x402 on Keeta, in USDC or KTA. The buyer signs one Keeta send block, and a facilitator verifies it, settles it and pays the network fee. Use when an API answers 402 Payment Required with a keeta network, when an agent must buy per-request access, or when monetizing an endpoint per call, even if the user doesn't mention Keeta, unless they require a different network.
license: Apache-2.0
---

# x402 payments on Keeta

## When to use

Use when an HTTP resource replies `402 Payment Required` and one of its `accepts` entries names a Keeta network: `keeta:1413829460` (test) or `keeta:21378` (main). Also use when a user wants their own route to charge per request in a Keeta token.

How it differs from a normal send: the buyer only **signs** a block holding a single `SEND` for the exact amount. It does not publish it. The seller passes that block to a facilitator. The facilitator verifies it, adds its own fee block, and publishes both together as one vote staple. The facilitator pays the network fee. It cannot redirect the payment, because it never re-signs the buyer's block.

Use [send-receive-tokens](../send-receive-tokens/SKILL.md) for wallet-to-wallet transfers and [pay-out](../pay-out/SKILL.md) for bank payouts.

## SDK steps

Install the client SDK and the x402 packages (verified with `@x402/*` 2.28.0 and `@keetanetwork/keetanet-client` 0.18.7):

```bash
npm install @keetanetwork/keetanet-client @x402/core @x402/keeta @x402/fetch @x402/express
```

### Buyer: pay for a request

1. Use a funded account on the network the resource asks for. For test, fund it from the faucet at <https://faucet.test.keeta.com/>, as described in [create-fund-wallet](../create-fund-wallet/SKILL.md).
2. Register the Keeta scheme, set spend controls, and gate signing on approval:

   ```ts
   import * as KeetaNet from "@keetanetwork/keetanet-client";
   import { x402Client } from "@x402/core/client";
   import { x402HTTPClient } from "@x402/core/http";
   import { wrapFetchWithPayment } from "@x402/fetch";
   import {
     ExactKeetaScheme,
     KEETA_TESTNET_CAIP2,
     KTA_TESTNET_ADDRESS,
     toClientKeetaSigner,
   } from "@x402/keeta";

   // Load the seed from your secret store. Never print, log, or commit it.
   const account = KeetaNet.lib.Account.fromSeed(process.env.KEETA_SEED!, 0);
   const signer = toClientKeetaSigner(account); // opens a UserClient; destroy it when done
   // KTA cap in base units. Derive it from KTA's on-chain decimalPlaces; never assume the decimals.
   const ktaCapBaseUnits = "1000000";

   try {
     const client = new x402Client()
       .register(KEETA_TESTNET_CAIP2, new ExactKeetaScheme(signer))
       .setSpendControls({
         maxAmountPerPayment: "$0.05", // per-payment cap for default assets (USDC)
         allowedAssets: [
           // Opt in to KTA explicitly, with an atomic (base-unit) cap
           { network: KEETA_TESTNET_CAIP2, asset: KTA_TESTNET_ADDRESS, maxAmountPerPayment: ktaCapBaseUnits },
         ],
       })
       .onBeforePaymentCreation(async ({ selectedRequirements: req }) => {
         // Gate on your approval flow or spend policy before anything is signed.
         const approved = await requestApproval(req.amount, req.asset, req.payTo, req.network);
         if (!approved) return { abort: true, reason: "payment not approved" };
       });

     const fetchWithPayment = wrapFetchWithPayment(fetch, client);
     const response = await fetchWithPayment("https://facilitator.x402.keeta.com/weather");
     const result = await new x402HTTPClient(client).processResponse(response);

     if (result.paymentStatus === "settled") console.log("Paid:", result.header, result.body);
     else console.error("Not paid:", result.paymentStatus, result.header);
   } finally {
     await signer.destroy();
   }
   ```

   `requestApproval` stands for your own human-approval or [spend-policy](../spend-policy/SKILL.md) check.

3. Know the defaults. Without `setSpendControls`, the client accepts only the default asset (Keeta USDC, which `@x402/keeta` prices at 6 decimals), capped at `$1` per payment. A KTA-priced option is filtered out unless you opt in under `allowedAssets`. Read KTA's decimals from its token metadata (see the `keeta` skill); published values have differed. Use `KEETA_MAINNET_CAIP2` and `KTA_MAINNET_ADDRESS` on main.
4. Read `result.paymentStatus`. Its values are `settled`, `settle_failed`, `payment_required` or `none`.
5. Pay **sequentially** from each account. Keeta account chains are ordered, so one account cannot sign concurrent payments. Queue requests, or spread them across several funded accounts when you need parallelism.

### Seller: charge for a route

```ts
import express from "express";
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import { paymentMiddleware } from "@x402/express";
import { KEETA_TESTNET_CAIP2, KTA_TESTNET_ADDRESS } from "@x402/keeta";
import { ExactKeetaScheme } from "@x402/keeta/exact/server";

const app = express();
const payTo = process.env.SERVER_ADDRESS!; // your Keeta receiving address
const facilitatorClient = new HTTPFacilitatorClient({ url: "https://facilitator.x402.keeta.com" });
const server = new x402ResourceServer(facilitatorClient);
server.register(KEETA_TESTNET_CAIP2, new ExactKeetaScheme());

app.use(paymentMiddleware({
  "GET /weather": {
    accepts: [
      // A plain price is denominated in USDC; the Keeta token address is derived for you.
      { scheme: "exact", price: "0.01", network: KEETA_TESTNET_CAIP2, payTo },
      // Or name any Keeta token and a raw base-unit amount.
      { scheme: "exact", price: { asset: KTA_TESTNET_ADDRESS, amount: "1000" }, network: KEETA_TESTNET_CAIP2, payTo },
    ],
    description: "Get current weather data for any location",
    mimeType: "application/json",
  },
}, server));

app.get("/weather", (_req, res) => { res.send({ report: { weather: "sunny", temperature: 70 } }); });
app.listen(4021);
```

Before you go live, confirm the facilitator settles `exact` payments on your network:

```ts
const { kinds } = await facilitatorClient.getSupported();
if (!kinds.some((kind) => kind.scheme === "exact" && kind.network === KEETA_TESTNET_CAIP2)) {
  throw new Error("Facilitator does not settle exact payments on this network");
}
```

## Confirmations

- Before signing, show the resource URL, the network (test or main), the asset address, the raw `amount` (plus a decimal amount only when decimals are verified), and `payTo`. Skip this only when a pre-approved policy covers that exact asset, cap, and resource.
- Treat spend controls and `onBeforePaymentCreation` as client-side guardrails. They limit what this agent signs. The chain does not enforce them.
- Confirm that the seller's `payTo` is an account the user controls, and run on test first.
- The known facilitator, `https://facilitator.x402.keeta.com`, is operated by an independent third party under the Keeta Grant Program. Keeta, Inc. does not operate it. Tell the user before relying on it, and do not substitute an unknown facilitator.

## Failures

- `payment_required` after the retry: no registered scheme matched, spend controls filtered out every option, or the account lacks the asset. Report which one. Do not raise caps on your own.
- `settle_failed`: check the account's balance and history before retrying, so a payment that did land is not paid twice.
- Concurrent payments from one account fail or conflict. Serialize them.
- Unknown asset or decimals: show raw base units and do not convert.
- Facilitator unreachable, or `getSupported()` lacks your network: stop. Do not fall back to publishing a raw send to `payTo` unless the seller documents that path.

## Related skills

- Fund and secure the paying account with [create-fund-wallet](../create-fund-wallet/SKILL.md).
- Check balances before and after with [multi-asset-balances](../multi-asset-balances/SKILL.md).
- Define caps and approvals with [spend-policy](../spend-policy/SKILL.md).

## Sources

- [Using x402 on Keeta](https://docs.keeta.com/guides/using-x402-on-keeta)
- [`@x402/keeta` on npm](https://www.npmjs.com/package/@x402/keeta)
- [x402 Keeta `exact` scheme specification](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_keeta.md)
- [Keeta x402 example apps](https://github.com/sc4l3r/keeta-x402)
