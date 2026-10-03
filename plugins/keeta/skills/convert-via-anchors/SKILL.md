---
name: convert-via-anchors
description: Convert between Keeta tokens through FX anchors. Discover pairs, compare signed quotes (or estimates), get approval, execute the exchange, poll its status and reconcile balances. Use for multi-currency swaps such as KTA to USD or USD to EUR, including multi-hop conversions through anchor chaining.
---

# Convert via FX anchors

## When to use

Use for an on-chain conversion once the exact source and destination assets are known.

- **Documented corridor:** **test network, KTA → USD**, through the FX anchor that discovery returns (the public example uses the test-network demo FX anchor).
- **Multi-hop:** the docs also show **test network USD → EUR** across several hops with anchor chaining.

These examples show the SDK flow. They don't prove that a provider is available right now, so always discover at run time.

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
6. When no single provider covers the pair, use `AnchorChaining`, as in the [anchors reference](../keeta/references/anchors.md). Plans are **not atomic**, so never re-execute one.

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

## Sources

- [FX (Foreign Exchange)](https://docs.keeta.com/anchors/anchor-types/fx-foreign-exchange)
- [Fiat Conversions With Anchor Chaining](https://docs.keeta.com/guides/fiat-conversions-with-anchor-chaining)
- [Public KTA → USD FX client example](https://github.com/KeetaNetwork/keetanet-examples/blob/main/src/anchor/fx-client.ts)
- [`FX.Client` implementation](https://github.com/KeetaNetwork/anchor/blob/main/src/services/fx/client.ts)
