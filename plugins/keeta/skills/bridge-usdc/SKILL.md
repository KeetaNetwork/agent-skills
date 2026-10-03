---
name: bridge-usdc
description: Move USDC between EVM chains and Keeta through asset-movement anchors. Covers the documented test corridors (Arbitrum Sepolia USDC to Keeta USD, Base Sepolia USDC to and from Keeta USDC), persistent deposit addresses, outbound transfers and status monitoring. Use for USDC deposits into Keeta or withdrawals to Base.
---

# Bridge USDC through asset-movement anchors

## When to use

Use when a provider discovered through `KeetaAnchor.AssetMovement.Client` advertises one of these documented **test** corridors:

| Direction | Source | Destination | Operation |
| --- | --- | --- | --- |
| Inbound, converts | Arbitrum Sepolia (chain `421614`) USDC `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d` | Keeta test **USD** `keeta_any4zllibya6fum3lsoimxmnmeo57nklxlh4c6d6xosfacarfaa3knkiprkmm` | `createPersistentForwarding` |
| Inbound, forwards | Base Sepolia (chain `84532`) USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | Keeta test **USDC** `keeta_apna75yhhvnv4ei7ape55hndk4yepno7a7i2mhtiwahiygixjcnmvswxhnmnk` | `createPersistentForwarding` |
| Outbound | Keeta test USDC (same token) | Base Sepolia (chain `84532`), an approved EVM recipient | `initiateTransfer` |

- The Arbitrum flow converts USDC into Keeta USD. The Base flows move Keeta USDC itself. These are different assets, so don't fund one flow with the other's token.
- Test USDC on the EVM side comes from Circle's faucet at <https://faucet.circle.com/>.
- A documented corridor doesn't prove a provider is live right now. Always discover first.

## SDK steps

1. Connect with `KeetaAnchor.KeetaNet.UserClient.fromNetwork('test', account)` and construct `new KeetaAnchor.AssetMovement.Client(client)`.
2. Discover providers for exactly one corridor. Arbitrum USDC → Keeta USD uses an asset **pair**:

   ```ts
   const am = new KeetaAnchor.AssetMovement.Client(client);
   const arbitrumUSDC = 'evm:0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d';
   const keetaUSD = KeetaAnchor.KeetaNet.lib.Account.fromPublicKeyString('keeta_any4zllibya6fum3lsoimxmnmeo57nklxlh4c6d6xosfacarfaa3knkiprkmm')
     .assertKeyType(KeetaAnchor.KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);
   const keeta = { type: 'chain', chain: { type: 'keeta', networkId: client.network } } as const;
   const arbitrum = { type: 'chain', chain: { type: 'evm', chainId: 421614n } } as const;
   const providers = await am.getProvidersForTransfer({ asset: { from: arbitrumUSDC, to: keetaUSD }, from: arbitrum, to: keeta });
   ```

   Base Sepolia → Keeta USDC uses the single Keeta USDC token as `asset`, with `from` set to `{ type: 'chain', chain: { type: 'evm', chainId: 84532n } }`.
3. Keep only providers where `await provider.isOperationSupported('createPersistentForwarding')`, or `'initiateTransfer'` for outbound, returns `true`. Review each provider's ID, `getLegalDisclaimers()`, fees, limits and KYC needs.
   - Public Base examples hardcode a demo provider ID. Never hardcode a provider ID; select from the current discovery results.

### Inbound: a persistent deposit address

```ts
const provider = providers?.find((p) => String(p.providerID) === approvedProviderID);
if (!provider || !(await provider.isOperationSupported('createPersistentForwarding'))) throw new Error('corridor unavailable');
const deposit = await provider.createPersistentForwardingAddress({
  account,
  asset: { from: arbitrumUSDC, to: keetaUSD },
  sourceLocation: arbitrum,
  destinationLocation: keeta,
  destinationAddress: account.publicKeyString.get()
});
console.log('Send Arbitrum Sepolia USDC to', deposit.address);
```

- Show the returned address **and its chain**, and ask the user to send USDC only on that chain. An address for one chain must never be reused on another.
- Monitor with `provider.listTransactions({ account, persistentAddresses: [...] })`, then confirm the credit with `balance(keetaUSD)`, or `balance` of Keeta USDC for Base, or with `history({ depth })`.

### Outbound: Keeta USDC → Base Sepolia

This is not the reverse of the Arbitrum USD conversion; it moves Keeta USDC only.

1. Discover with `asset` set to Keeta test USDC, `from` the Keeta chain, and `to` `{ type: 'chain', chain: { type: 'evm', chainId: 84532n } }`. Require `initiateTransfer`.
2. Validate the EVM recipient: `0x` followed by 40 hex characters, owned by the user. Stop if it fails.
3. Require a sufficient balance of **Keeta USDC**, not Keeta USD.
4. Call `provider.initiateTransfer({ account, asset, from: { location: keeta }, to: { location: base, recipient }, value })`.
5. Fund the `KEETA_SEND` instruction exactly. Narrow it with `instruction.type === 'KEETA_SEND'`, then call `client.send(instruction.sendToAddress, BigInt(instruction.value), instruction.tokenAddress, instruction.external)` after approval.
6. Poll `transfer.getTransferStatus()` until `KeetaAnchor.lib.isCompletedTransferStatus(...)` is true.

### Main network

- **Arbitrum:** the chain ID is `42161`, and the USDC contract is `0xaf88d065e77c8cC2239327C5EDb3A432268e5831`.
- **Base:** the chain ID is `8453`.
- **Keeta mainnet USDC** is `keeta_amnkge74xitii5dsobstldatv3irmyimujfjotftx7plaaaseam4bntb7wnna`, per the network overview and `@x402/keeta`.
- **Conflicting label:** the deposit guide calls that address "Keeta USD", which conflicts with those sources.
- **Before any main-network deposit or withdrawal:** resolve the destination token through the resolver (`resolver.lookupToken(...)` / `listTokens()`) and the provider's own metadata. Stop if the sources disagree.
- **Unannounced corridors:** don't infer an Arbitrum outbound path or any main-network corridor that discovery doesn't return.

LayerZero has publicly announced plans to carry Keeta stablecoins across chains as an anchor. No public corridor or client example exists yet, so don't label any corridor above as LayerZero.

## Confirmations

- Confirm test or main, the direction, the chain ID, the EVM contract, the Keeta token, the destination, the provider, fees, limits, rails and KYC status.
- Require human approval before any transfer from an external wallet, and before funding an outbound instruction.
- Re-display the deposit address or outbound recipient together with its network.

## Failures

- **No provider, or the required operation is missing:** stop. Resolver metadata may also be unavailable on that network.
- **`KYCShareNeeded`, `AdditionalKYCNeeded` or `UserActionNeeded`:** complete only the typed actions, then retry discovery or status.
- **Wrong network, token contract or destination:** don't send.
- **Conflicting token addresses:** stop and resolve them against resolver and provider metadata.
- **Pending transaction:** keep monitoring. Never duplicate a deposit or a transfer.

## Related skills

- Do identity steps first with [complete-kyc](../complete-kyc/SKILL.md) or [complete-kyb](../complete-kyb/SKILL.md) when the provider requires them.
- Review the provider with [discover-resolve-anchors](../discover-resolve-anchors/SKILL.md).
- Reconcile Keeta USD (Arbitrum inbound) and Keeta USDC (Base flows) with [multi-asset-balances](../multi-asset-balances/SKILL.md).

## Sources

- [Fiat Deposit From USDC](https://docs.keeta.com/guides/fiat-deposit-from-usdc)
- [Ethereum VM anchors](https://docs.keeta.com/anchors/anchor-types/asset-movement/ethereum-vm-anchors)
- [Overview: main vs test networks](https://docs.keeta.com/guides/overview-main-vs-test-networks)
- [Arbitrum USDC → Keeta USD example](https://github.com/KeetaNetwork/keetanet-examples/blob/main/src/anchor/asset-movement-fiat-deposit-from-crypto.ts)
- [Base Sepolia USDC → Keeta USDC example](https://github.com/KeetaNetwork/keetanet-examples/blob/main/src/anchor/asset-movement-evm-inbound.ts)
- [Keeta USDC → Base Sepolia example](https://github.com/KeetaNetwork/keetanet-examples/blob/main/src/anchor/asset-movement-evm-outbound.ts)
- [Asset Movement client](https://github.com/KeetaNetwork/anchor/blob/main/src/services/asset-movement/client.ts)
- [Keeta and LayerZero announcement](https://layerzero.network/blog/keeta-and-layerzero-bring-tokenized-bank-deposits)
