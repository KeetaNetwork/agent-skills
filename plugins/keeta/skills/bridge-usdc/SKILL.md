---
name: bridge-usdc
description: Discover current Asset Movement support before using the documented Arbitrum inbound or Base Sepolia USDC corridors.
---

# Bridge USDC through Asset Movement anchors

## When to use

Use when a provider discovered through `KeetaAnchor.AssetMovement.Client` advertises one of these source-backed corridors:

- **test, inbound conversion:** Arbitrum Sepolia USDC contract `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d` on chain ID `421614` → Keeta test USD `keeta_any4zllibya6fum3lsoimxmnmeo57nklxlh4c6d6xosfacarfaa3knkiprkmm`.
- **test, inbound forwarding:** Base Sepolia USDC contract `0x036CbD53842c5426634e7929541eC2318f3dCF7e` on chain ID `84532` → Keeta test USDC `keeta_apna75yhhvnv4ei7ape55hndk4yepno7a7i2mhtiwahiygixjcnmvswxhnmnk`.
- **test, outbound transfer:** the same Keeta test USDC token → Base Sepolia chain ID `84532`, to an approved EVM recipient.

The Arbitrum flow converts Circle USDC into Keeta USD. The Base flows move the Keeta USDC asset between Keeta and Base Sepolia. They are different asset mappings and operations.

Do not use a documented corridor as evidence that a provider is currently available. On 2026-09-18, `@keetanetwork/anchor` `0.0.97` with `@keetanetwork/keetanet-client` `0.18.4` connected to Keeta test network ID `1413829460`, but every corridor lookup failed with `No valid root metadata found`; no provider or operation was returned.

## SDK steps

1. Connect with `KeetaAnchor.KeetaNet.UserClient.fromNetwork('test', account)`.
2. Construct `new KeetaAnchor.AssetMovement.Client(userClient)`.
3. Call `getProvidersForTransfer(...)` with one exact corridor.

   Arbitrum USDC → Keeta USD uses an asset pair:

   ```ts
   const providers = await assetMovementClient.getProvidersForTransfer({
     asset: {
       from: 'evm:0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
       to: Account.fromPublicKeyString(
         'keeta_any4zllibya6fum3lsoimxmnmeo57nklxlh4c6d6xosfacarfaa3knkiprkmm'
       )
     },
     from: { type: 'chain', chain: { type: 'evm', chainId: 421614n } },
     to: {
       type: 'chain',
       chain: { type: 'keeta', networkId: userClient.network }
     }
   });
   ```

   Base Sepolia → Keeta USDC uses the single Keeta USDC token, not an `evm:` asset pair:

   ```ts
   const providers = await assetMovementClient.getProvidersForTransfer({
     asset: 'keeta_apna75yhhvnv4ei7ape55hndk4yepno7a7i2mhtiwahiygixjcnmvswxhnmnk',
     from: { type: 'chain', chain: { type: 'evm', chainId: 84532n } },
     to: {
       type: 'chain',
       chain: { type: 'keeta', networkId: userClient.network }
     }
   });
   ```

4. Stop if discovery returns no provider or errors. For each result, call `await provider.isOperationSupported('createPersistentForwarding')` for inbound persistent addresses or `await provider.isOperationSupported('initiateTransfer')` for outbound transfers, and stop unless it returns `true`. That check confirms the provider exposes the operation endpoint. Also inspect the matching source rail in `provider.serviceInfo.supportedAssets` and require its `supportedOperations` metadata to advertise the same operation.
5. Review the provider ID, legal terms, fees, limits, rails, and account actions before selecting it. The public Arbitrum guide does not identify the operator. Public Base examples hardcode `DEV2` for demo only — never hardcode `DEV2` or any example provider ID; select only from the current discovery results after the operation checks above.

## Inbound persistent deposit

For either documented inbound corridor, require `createPersistentForwarding` support, then call `provider.createPersistentForwardingAddress(...)` with the corridor's asset and locations. Confirm the returned address and its EVM network before asking the user to send USDC.

Arbitrum uses the USDC-to-USD asset pair:

```ts
const deposit = await provider.createPersistentForwardingAddress({
  account: userAccount,
  asset: {
    from: 'evm:0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
    to: Account.fromPublicKeyString(
      'keeta_any4zllibya6fum3lsoimxmnmeo57nklxlh4c6d6xosfacarfaa3knkiprkmm'
    )
  },
  sourceLocation: { type: 'chain', chain: { type: 'evm', chainId: 421614n } },
  destinationLocation: {
    type: 'chain',
    chain: { type: 'keeta', networkId: userClient.network }
  },
  destinationAddress: userAccount.publicKeyString.get()
});
```

Base Sepolia keeps the same field shape but uses asset `keeta_apna75yhhvnv4ei7ape55hndk4yepno7a7i2mhtiwahiygixjcnmvswxhnmnk`, source chain ID `84532n`, and the Keeta test destination. The example identifies `0x036CbD53842c5426634e7929541eC2318f3dCF7e` as the corresponding Base Sepolia USDC contract.

Monitor a created address with `provider.listTransactions(...)`, then verify the destination balance or `userClient.history()`.

## Outbound to Base Sepolia

This is not the reverse of the Arbitrum USDC-to-USD conversion. The public example covers only Keeta test USDC → Base Sepolia:

1. Discover with asset `keeta_apna75yhhvnv4ei7ape55hndk4yepno7a7i2mhtiwahiygixjcnmvswxhnmnk`, Keeta test as `from`, and EVM chain ID `84532` as `to`.
2. Call `await provider.isOperationSupported('initiateTransfer')` and stop unless it returns `true`; also require a matching source rail that advertises `initiateTransfer`.
3. Validate the EVM recipient as `0x`-prefixed and exactly 42 characters; stop if it fails.
4. Require a non-zero balance of that exact Keeta USDC token before calling `initiateTransfer`. Do not fund this flow with Arbitrum-credited Keeta USD `keeta_any4zllibya6fum3lsoimxmnmeo57nklxlh4c6d6xosfacarfaa3knkiprkmm`.
5. Call `provider.initiateTransfer(...)` with the approved EVM recipient and base-unit value.
6. Follow the returned instruction. The current example expects `KEETA_SEND`, then `userClient.send(anchorAccount, amount, usdcTokenAccount, instruction.external)` where `usdcTokenAccount` is that Keeta USDC token.
7. Monitor with `provider.getTransferStatus(...)`.

Do not infer an Arbitrum outbound path or a main-network Base path from this test-only example.

## Main-network gap

Arbitrum mainnet chain ID `42161` and Circle USDC contract `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` agree across the guide and example, but the Keeta USD token does not:

- guide: `keeta_amnkge74xitii5dsobstldatv3irmyimujfjotftx7plaaaseam4bntb7wnna`
- current `keetanet-examples`: `keeta_aonxxqry6rknxyb6c5q2ybxk2gt776xlchhcohhyla5kqvinnaduevuxyx3tc`

Do not create or fund a main-network address until resolver discovery and authoritative token metadata identify one exact token.

## LayerZero boundary

The LayerZero announcement says Keeta Stablecoins are intended to be transferable across Keeta, Ethereum, Solana, and Base through the OFT standard, and that LayerZero is being integrated as an anchor. It does not publish USDC contracts, Keeta token IDs, network environments, directions, Asset Movement operations, or a working client example.

A private LayerZero reference implementation (not a public install path) is a Keeta-less external-chain peer bridge. Its tests include Base mainnet chain ID `8453` and Arbitrum One chain ID `42161`, but enabled deployment legs are environment-selected and remain unknown. It implements an Asset Movement provider that the public client can discover; it is neither an inbound transfer to Keeta nor an outbound transfer from Keeta.

Do not label the public Base Sepolia USDC examples or their demo `DEV2` provider as LayerZero.

## Other reference anchors

These are private reference implementations, not public install paths:

- A private Bridge.xyz anchor implements inbound and outbound Asset Movement relative to Keeta. Base is required by its configuration. Its committed example configures Base Sepolia chain ID `84532` and Ethereum Sepolia chain ID `11155111`; Arbitrum appears only in its supported-chain type list, so active Arbitrum support is not proven.
- A private HopNow anchor is an outbound payout path to a US bank account. Its EVM bridge configuration uses Base Sepolia chain ID `84532` with USDC on test and Base mainnet chain ID `8453` with USDC or USDT on main; test also allows a Solana devnet USDC hop. It uses `new KeetaAnchor.AssetMovement.Client(...)` to discover the intermediate bridge. It is not the direct wallet-funding corridor in this skill.
- Bridge.xyz and LayerZero implement provider sides of the same Asset Movement protocol. HopNow both implements a payout provider and consumes another Asset Movement provider. None identifies the unnamed operator for the public Arbitrum USDC → Keeta USD guide.

## Confirmations

- Confirm test vs main, direction, chain ID, EVM contract, Keeta token, destination, provider, fees, limits, rails, and KYC status.
- Require human approval before any external-wallet transfer.
- Re-display the persistent address or outbound recipient and network; an address for one chain must not be reused on another.

## Failures

- Resolver metadata unavailable, no provider, or required operation missing: stop.
- KYC-share-needed or user-action-needed errors: complete only the typed actions, then retry discovery/status.
- Wrong network, token contract, or destination: do not send.
- Conflicting token IDs: stop and resolve against provider metadata.
- Pending transaction: monitor status; do not duplicate the deposit or transfer.

## Related skills

- Use [complete-kyc](../complete-kyc/SKILL.md) or [complete-kyb](../complete-kyb/SKILL.md) first.
- Use [discover-resolve-anchors](../discover-resolve-anchors/SKILL.md) to review the provider.
- Use [multi-asset-balances](../multi-asset-balances/SKILL.md) to reconcile Keeta USD for Arbitrum inbound and Keeta USDC for Base flows.

## Sources

- [Fiat Deposit From USDC](https://docs.keeta.com/guides/fiat-deposit-from-usdc)
- [Arbitrum USDC → Keeta USD example](https://github.com/KeetaNetwork/keetanet-examples/blob/main/src/anchor/asset-movement-fiat-deposit-from-crypto.ts)
- [Base Sepolia USDC → Keeta USDC example](https://github.com/KeetaNetwork/keetanet-examples/blob/main/src/anchor/asset-movement-evm-inbound.ts)
- [Keeta USDC → Base Sepolia example](https://github.com/KeetaNetwork/keetanet-examples/blob/main/src/anchor/asset-movement-evm-outbound.ts)
- [Asset Movement client](https://github.com/KeetaNetwork/anchor/blob/main/src/services/asset-movement/client.ts)
- [Asset Movement operation metadata](https://github.com/KeetaNetwork/anchor/blob/main/src/services/asset-movement/common.ts)
- [Keeta and LayerZero announcement](https://layerzero.network/blog/keeta-and-layerzero-bring-tokenized-bank-deposits) — scope-only evidence for the LayerZero boundary; not a corridor implementation source
