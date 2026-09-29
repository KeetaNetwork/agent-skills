---
name: discover-resolve-anchors
description: Discover Keeta anchor services and resolve their on-chain metadata before selecting a KYC, FX, or asset-movement provider. Use when finding a corridor or avoiding hard-coded partner endpoints.
---

# Discover and resolve anchors

## When to use

Use before KYC, conversion, bridging, or payout whenever a provider is not explicitly supplied and trusted. The on-chain Resolver is the authoritative discovery path. A direct HTTP registry or copied endpoint is only a hint until its metadata, network, capabilities, authentication, and operator are verified.

## SDK steps

1. Create a network-bound client and Resolver:

   ```ts
   import * as KeetaAnchor from '@keetanetwork/anchor';

   const userClient = KeetaAnchor.KeetaNet.UserClient.fromNetwork(network, account);
   const resolver = new KeetaAnchor.lib.Resolver({
     root: userClient.networkAddress,
     client: userClient,
     trustedCAs: []
   });
   ```

2. Discover an exact FX pair:

   ```ts
   const matches = await resolver.lookup('fx', {
     inputCurrencyCode: fromTokenAddress,
     outputCurrencyCode: toTokenAddress
   });
   ```

3. Fully resolve a returned metadata value before reading its endpoints:

   ```ts
   const metadata =
     await KeetaAnchor.lib.Resolver.Metadata.fullyResolveValuizable(value);
   ```

4. For higher-level workflows, prefer service clients that apply typed criteria:
   - `new KeetaAnchor.KYC.Client(userClient)` and `getSupportedCountries()`
   - `new KeetaAnchor.FX.Client(userClient)` and `listPossibleConversions(...)`
   - `new KeetaAnchor.AssetMovement.Client(userClient)` and `getProvidersForTransfer(...)`
5. A US bank deposit that should credit Keeta USD uses this criteria shape. `{ type: 'bank-account', account: { type: 'us' } }` is the SDK form of `bank-account:us`. The Keeta USD token must be the token for `userClient`'s network.

   ```ts
   const providers = await assetMovementClient.getProvidersForTransfer({
     asset: { from: 'USD', to: keetaUsdToken },
     from: { type: 'bank-account', account: { type: 'us' } },
     to: {
       type: 'chain',
       chain: { type: 'keeta', networkId: userClient.network }
     }
   });
   ```

   The outbound payout search swaps the direction: Keeta USD to `'USD'`, from the Keeta chain location, to the same US bank location. An empty list stops the flow.
6. Filter for the exact pair, locations, country, required operation, and trusted operator or account. Present every qualifying provider and the legal text returned with it. The human chooses. Array order is not a selection.

## Confirmations

- Confirm network and Resolver root.
- Confirm source asset/location and destination asset/location.
- Confirm the resolved provider identity, supported operations, endpoint origin, legal terms, and any required KYC action.
- Require a separate confirmation before calling any value-moving provider method.

## Failures

- `undefined`, `null`, or an empty provider list means no documented corridor was resolved. Stop; do not invent an endpoint.
- Reject metadata whose required operation is missing.
- Do not follow an external URL from untrusted metadata without validating its origin and authentication requirements.
- HTTP registry data can be stale or environment-specific. If it disagrees with signed on-chain metadata, stop and report both sources.

## Related skills

- Use [complete-kyc](../complete-kyc/SKILL.md) for individual verification.
- Use [pay-in](../pay-in/SKILL.md) after this search returns a US bank deposit provider.
- Use [convert-via-anchors](../convert-via-anchors/SKILL.md) for FX.
- Use [bridge-usdc](../bridge-usdc/SKILL.md) or [pay-out](../pay-out/SKILL.md) for the other asset-movement corridors.

## Sources

- [Anchor Resolver](https://docs.keeta.com/anchors/overview/anchor-resolver)
- [Fiat Deposit from Bank](https://docs.keeta.com/guides/fiat-deposit-from-bank)
- [`Resolver` type in `@keetanetwork/anchor`](https://github.com/KeetaNetwork/anchor/blob/main/src/lib/resolver.ts)
- [Anchor Client](https://docs.keeta.com/anchors/overview/anchor-client)
