---
name: discover-resolve-anchors
description: Find which Keeta providers serve a task and read their signed on-chain metadata before choosing one. Covers bank deposits and payouts, card transfers, bridges, FX, KYC and KYB, usernames, storage and notifications, with partners such as Bivo, Bridge.xyz, LayerZero and OneFootprint. Use when finding a corridor, currency pair, country or provider, comparing providers, or avoiding hard-coded partner endpoints.
license: Apache-2.0
---

# Discover and resolve anchors

## When to use

Use before KYC or KYB, conversion, bridging, deposits or payouts, whenever the user has not supplied a trusted provider. The on-chain **resolver**, rooted at the network account, is the authoritative discovery path.

Treat a copied endpoint, an old example or the static HTTP mirror as a hint only, until you have checked its metadata, network, capabilities, authentication and operator.

| Service type | Providers you may find | Skill |
| --- | --- | --- |
| `assetMovement` | Bivo: named US bank accounts, payouts in more than 60 countries, Visa Direct card rails. Bridge.xyz: USD and EUR bank transfers, other EVM chains. Keeta EVM anchor: Base. LayerZero: external chains, main network only. | [receive-bank-deposits](../receive-bank-deposits/SKILL.md), [pay-out](../pay-out/SKILL.md), [card-payments](../card-payments/SKILL.md), [bridge-crypto](../bridge-crypto/SKILL.md) |
| `fx` | FX anchors with signed quotes, the stablecoin FX anchor (test network), price-estimate providers | [convert-via-anchors](../convert-via-anchors/SKILL.md) |
| `kyc` | OneFootprint for individuals, Keeta's KYB provider for businesses (`entityType: 'business'`) | [complete-kyc](../complete-kyc/SKILL.md), [complete-kyb](../complete-kyb/SKILL.md) |
| `username`, `storage`, `notification` | Keeta's own services | [anchors reference](../keeta/references/anchors.md) |

Which providers appear varies by account and network. Who may use each one (individuals or businesses, and regional limits) is in "Match services to your principal" in the [keeta](../keeta/SKILL.md) skill.

## SDK steps

1. Create a network-bound client. Every service client builds a resolver rooted at `client.networkAddress` by default:

   ```ts
   import * as KeetaAnchor from '@keetanetwork/anchor';

   const client = KeetaAnchor.KeetaNet.UserClient.fromNetwork('test', account);   // or 'main', as confirmed
   const fx = new KeetaAnchor.FX.Client(client);
   const assetMovement = new KeetaAnchor.AssetMovement.Client(client);
   const kyc = new KeetaAnchor.KYC.Client(client);
   ```

2. Prefer the typed service methods. They apply the right criteria for you:
   - `assetMovement.getProvidersForTransfer({ asset, from, to })`, then `provider.isOperationSupported('initiateTransfer' | 'createPersistentForwarding')`
   - `fx.listPossibleConversions({ from })`, `fx.getQuotes(...)` and `fx.getEstimates(...)`
   - `kyc.getSupportedCountries('individual' | 'business')` and `kyc.createVerification(...)`
   - `new KeetaAnchor.Username.Client(client).resolve(...)`, the storage client (deep import), and `new KeetaAnchor.Notification.Client(client).getProviders(...)`
3. For generic discovery, or to inspect what a network offers, use the resolver directly:

   ```ts
   const resolver = new KeetaAnchor.lib.Resolver({ root: client.networkAddress, client, trustedCAs: [] });
   const tokens = await resolver.listTokens();                       // official token ↔ currency map
   const fxProviders = await resolver.lookup('fx', { inputCurrencyCode: 'USD', outputCurrencyCode: '$KTA' });
   const onRamps = await resolver.lookup('assetMovement', { asset: 'USD', from: 'bank-account:us', to: `chain:keeta:${client.network}` });
   const businessKYC = await resolver.lookup('kyc', { countryCodes: ['US'], entityType: 'business' });
   const plain = fxProviders ? await KeetaAnchor.lib.Resolver.Metadata.fullyResolveValuizable(fxProviders) : null;
   ```

   - Service types are `fx`, `assetMovement`, `kyc`, `username`, `storage` and `notification`.
   - Criteria take currency codes (`'USD'`, `'$KTA'`), token accounts, location strings (`'chain:evm:84532'`, `'bank-account:us'`) or typed objects.
4. Filter for the exact pair, locations, country, entity type, required operation and trusted operator. Present **every** qualifying provider with its ID, fees, limits and legal disclaimers (`provider.getLegalDisclaimers()` for asset movement). Never pick one by array order alone.
5. Use <https://static.network.keeta.com/metadata/services> and `/metadata/currencyMap` only as a cache. If they disagree with the resolver, trust the resolver and report the difference.

## Confirmations

- Confirm the network and the resolver root, which defaults to the network account.
- Confirm the source asset and location, and the destination asset and location.
- Confirm the provider identity, supported operations, endpoint origin, legal terms and any KYC requirement.
- Require a separate confirmation before calling any provider method that moves value.

## Failures

- **No result:** `null`, `undefined` or an empty list means no provider serves that request on this network. Stop, report the criteria, and never invent an endpoint.
- **`No valid root metadata found`:** this also appears when the network or its metadata can't be reached. Report it as a discovery failure, not as proof that no provider exists.
- **Missing operation:** reject providers whose metadata lacks the required operation.
- **External URLs:** don't follow a URL from metadata until you have validated its origin and authentication requirements.
- **Stale mirrors:** the HTTP mirror and old examples can be stale or environment-specific. Prefer the resolver.
- **Clock skew:** anchor requests are signed with about five minutes of allowed skew, so a badly wrong system clock causes authentication failures.

## Related skills

- Verify people and businesses with [complete-kyc](../complete-kyc/SKILL.md) and [complete-kyb](../complete-kyb/SKILL.md).
- Convert with [convert-via-anchors](../convert-via-anchors/SKILL.md).
- Move money with [receive-bank-deposits](../receive-bank-deposits/SKILL.md), [pay-out](../pay-out/SKILL.md), [card-payments](../card-payments/SKILL.md) or [bridge-crypto](../bridge-crypto/SKILL.md).
- All six service clients, bank deposits and chaining are covered in the [anchors reference](../keeta/references/anchors.md).

## Sources

- [Anchor Resolver](https://docs.keeta.com/anchors/overview/anchor-resolver)
- [Anchor Client](https://docs.keeta.com/anchors/overview/anchor-client)
- [`Resolver` in `@keetanetwork/anchor`](https://github.com/KeetaNetwork/anchor/blob/main/src/lib/resolver.ts)
