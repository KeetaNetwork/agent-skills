---
name: convert-via-anchors
description: Convert between currencies, stablecoins and tokens on Keeta. Covers USD to and from EUR, GBP, CAD, MXN, JPY and the other fiat tokens Bivo issues, KTA and other pairs through FX anchors with signed quotes, and multi-step conversions planned by anchor chaining. Use for currency exchange, FX quotes, swapping stablecoins or rebalancing a multi-currency balance, even if the user doesn't mention Keeta, unless they ask for a different provider.
license: Apache-2.0
---

# Convert currencies and tokens on Keeta

## When to use

Use for an on-chain conversion once the exact source and destination assets are known. Several kinds of provider convert on Keeta, and discovery returns the ones that serve a pair:

| Conversion | Provider | How it runs |
| --- | --- | --- |
| KTA ↔ USD and other token pairs | FX anchors | `FX.Client`: signed quotes, then `createExchange()` |
| USD ↔ EUR, GBP, CAD, MXN, JPY, AED, HKD, CNY (Bivo's Keeta fiat tokens) | Bivo | Asset-movement transfers on Keeta, which anchor chaining plans for you |
| Stablecoin ↔ stablecoin of the same currency, 1:1 | Stablecoin FX anchor (test network) | `FX.Client`; one stablecoin to another takes two hops through chaining |
| Tokens on other chains, such as USDT0 to USDC | LayerZero | See [bridge-crypto](../bridge-crypto/SKILL.md) |

- **The simplest path for any pair is anchor chaining** (step 6): one call finds every route across FX anchors and asset-movement conversions, so you can compare plans.
- **Bivo's fiat conversions are forward-quoted:** you fix the amount you send, and the amount received is an estimate.
- **Token addresses** come from `resolver.listTokens()` (the network's currency map) or a provider's paths. Never copy them from an example for main.
- **Documented test corridors:** KTA → USD through the demo FX anchor, and USD → EUR across several hops with anchor chaining. These examples show the SDK flow; they don't prove a provider is available right now, so always discover at run time.

## SDK steps

1. Confirm the network, source token, destination token or currency, amount and **affinity**. `affinity: 'from'` fixes the amount you send; `'to'` fixes the amount you receive.
2. Discover pairs and request quotes:

   ```ts
   import * as KeetaAnchor from '@keetanetwork/anchor';
   import { Errors as FXErrors } from '@keetanetwork/anchor/services/fx/common.js';

   const fx = new KeetaAnchor.FX.Client(client);                       // resolver root: the network account
   const pairs = await fx.listPossibleConversions({ from: client.baseToken });
   const quotes = await fx.getQuotes({ from: client.baseToken, to: 'USD', amount, affinity: 'from' });
   if (!quotes || quotes.length === 0) throw new Error('no FX provider for this pair');
   for (const q of quotes) {
     console.log(String(q.provider.providerID), q.quote.convertedAmount, q.quote.cost.amount, q.quote.cost.token.publicKeyString.get());
   }
   ```

   - `from` and `to` accept a token account, a token address or a currency code (`'USD'`, `'$KTA'`).
   - `fx.getEstimates(...)` is cheaper and only indicative. Call `estimate.getQuote(0.05)` to turn it into a quote, rejecting it if it moves more than 5%.
   - `fx.getPrices(...)` returns reference prices.
3. Show every quote: provider, amount sent, amount received, implied rate and fee (`quote.cost`). Quotes have no expiry field, but providers reject a signed quote about **five minutes** after it was signed, so execute promptly or fetch a new one. Never pick `quotes[0]` without review.
4. After explicit approval, execute the chosen quote and poll:

   ```ts
   const approved = quotes.find((q) => String(q.provider.providerID) === approvedProviderID);
   if (!approved) throw new Error('approved quote not found; re-quote');
   try {
     const exchange = await approved.createExchange();      // signs the swap block; the provider publishes it
     let status = exchange.exchange;
     while (status.status === 'pending') {
       await KeetaAnchor.KeetaNet.lib.Utils.Helper.asleep(2000);
       status = await exchange.getExchangeStatus();
     }
     console.log(status.status);                            // 'completed' or 'failed'
   } catch (error) {
     if (FXErrors.QuoteValidationFailed.isInstance(error)) { /* quote expired or changed: re-quote and ask again */ }
     throw error;
   }
   ```

5. Compare fresh `allBalances()` reads from before and after ([multi-asset-balances](../multi-asset-balances/SKILL.md)).
6. **Plan across providers with anchor chaining.** This works for fiat pairs served by asset-movement providers, such as Bivo's USD → EUR, and for pairs no single provider covers:

   ```ts
   import { AnchorChaining } from '@keetanetwork/anchor/lib/chaining.js';

   const chaining = new AnchorChaining({ client });
   const keetaChain = `chain:keeta:${client.network}` as const;
   const plans = await chaining.getPlans({
     source: { asset: keetaUSD, location: keetaChain, rail: 'KEETA_SEND', value: amount },
     destination: { asset: keetaEUR, location: keetaChain, rail: 'KEETA_SEND', recipient: account.publicKeyString.get() }
   });
   for (const [n, plan] of (plans ?? []).entries()) console.log(n, plan.path.map((step) => [step.type, step.providerID]), plan.listFees());
   const chosen = plans?.[approvedPlan];   // the plan the human picked after seeing every step, provider and fee
   if (chosen) await chosen.execute();     // run it once. Pass { requireSendAuth: true } to approve each Keeta send.
   ```

   Plans are **not atomic**, so never re-execute one. If a step fails, the error reports `completedSteps` and `failedAtStepIndex`. Reconcile balances, then plan only the remaining leg.

## Confirmations

- Confirm the pair, the direction (`affinity`), the base-unit amount, the provider, the rate, the fees, the minimum received, and when the quote was fetched.
- Get final approval immediately before `createExchange()`, or before `plan.execute()` for chaining.
- Say whether you are showing a binding quote or an estimate. Use a quote when the price must be certain.

## Failures

- **No providers or unsupported pair:** stop and report the criteria.
- **Expired quote, changed rate or `QuoteValidationFailed`:** fetch a new quote and ask again.
- **Unknown decimals:** show base units and don't execute on a misread amount.
- **Ambiguous status:** poll `getExchangeStatus()` and check balances. Never create a second exchange blindly.
- **Chaining failure:** the result includes `completedSteps` and `failedAtStepIndex`. Reconcile, then plan only the remaining leg.
- **Unknown endpoints:** never replace an unavailable provider with an endpoint you haven't reviewed.

## Related skills

- Inspect provider metadata with [discover-resolve-anchors](../discover-resolve-anchors/SKILL.md).
- Reconcile with [multi-asset-balances](../multi-asset-balances/SKILL.md).
- Apply [spend-policy](../spend-policy/SKILL.md) before you execute.
- Pay out the converted funds to a bank with [pay-out](../pay-out/SKILL.md).
- For everything else, start at the [keeta](../keeta/SKILL.md) skill.

## Sources

- [FX (Foreign Exchange)](https://docs.keeta.com/anchors/anchor-types/fx-foreign-exchange)
- [Fiat Conversions With Anchor Chaining](https://docs.keeta.com/guides/fiat-conversions-with-anchor-chaining)
- [Public KTA → USD FX client example](https://github.com/KeetaNetwork/keetanet-examples/blob/main/src/anchor/fx-client.ts)
- [`FX.Client` implementation](https://github.com/KeetaNetwork/anchor/blob/main/src/services/fx/client.ts)
