---
name: convert-via-anchors
description: Discover FX providers, obtain and review signed quotes, execute a Keeta token conversion, and reconcile balances. Use for multi-currency swaps through Keeta FX anchors.
---

# Convert via FX anchors

## When to use

Use for an on-chain conversion after the exact source and destination assets are known. The public example corridor is **test network KTA → USD through the Test Network Demo FX Anchor**. This documents SDK shape, not current provider availability. HopNow is not identified in the public Keeta org or current public docs reviewed for this pack; do not invent a HopNow URL or claim its corridor is active.

## SDK steps

1. Confirm network, source token, destination token/currency, amount, and amount affinity.
2. Construct the client and discover supported pairs:

   ```ts
   const fxClient = new KeetaAnchor.FX.Client(userClient, {
     root: userClient.networkAddress
   });
   const pairs = await fxClient.listPossibleConversions({
     from: userClient.baseToken
   });
   ```

3. For the documented illustrative test corridor, request KTA-to-USD quotes:

   ```ts
   const offers = await fxClient.getQuotes({
     from: userClient.baseToken.publicKeyString.get(),
     to: 'USD',
     amount,
     affinity: 'from'
   });
   ```

4. Stop if no offers resolve. For every offer, show provider identity, quote amounts, rate, fees, expiry, and legal disclaimers available in the returned data. Do not choose `offers[0]` without review.
5. Re-fetch an expired or stale quote with `offer.refetch()`. After explicit approval, call:

   ```ts
   const exchange = await approvedOffer.createExchange();
   ```

6. Use the returned exchange status method when needed and compare fresh `userClient.allBalances()` reads before and after.

## Confirmations

- Confirm pair, direction (`affinity`), base-unit amount, provider, rate, fees, minimum received, and expiry.
- Require a final approval immediately before `createExchange()`.
- Make clear whether the offer is a binding quote or an estimate; obtain a quote when the workflow requires price certainty.

## Failures

- No providers or unsupported pair: stop and report the Resolver criteria.
- Expired quote or changed rate: re-quote and ask again.
- Unknown decimals: show base units and do not execute.
- Ambiguous exchange status: poll the documented status and balances; never blindly create a second exchange.
- Never replace an unavailable named provider with an unreviewed endpoint.

## Related skills

- Use [discover-resolve-anchors](../discover-resolve-anchors/SKILL.md) to inspect provider metadata.
- Use [multi-asset-balances](../multi-asset-balances/SKILL.md) to reconcile.
- Apply [spend-policy](../spend-policy/SKILL.md) before execution.

## Sources

- [FX (Foreign Exchange)](https://docs.keeta.com/anchors/anchor-types/fx-foreign-exchange)
- [Public KTA → USD FX client example](https://github.com/KeetaNetwork/keetanet-examples/blob/main/src/anchor/fx-client.ts)
- [`FX.Client` implementation](https://github.com/KeetaNetwork/anchor/blob/main/src/services/fx/client.ts)
