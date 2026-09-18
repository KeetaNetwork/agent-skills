---
name: bridge-usdc
description: Discover an asset-movement provider and create a persistent address for depositing Arbitrum USDC into Keeta USD. Use for the documented cross-chain wallet funding corridor.
---

# Bridge Arbitrum USDC to Keeta USD

## When to use

Use to fund a Keeta wallet from Arbitrum USDC through a discovered Asset Movement anchor. The concrete documented examples are:

- **test:** Arbitrum Sepolia USDC (`0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d`, chain ID `421614`) → test Keeta USD (`keeta_any4zllibya6fum3lsoimxmnmeo57nklxlh4c6d6xosfacarfaa3knkiprkmm`)
- **main:** Arbitrum USDC (`0xaf88d065e77c8cC2239327C5EDb3A432268e5831`, chain ID `42161`) → main Keeta USD (`keeta_amnkge74xitii5dsobstldatv3irmyimujfjotftx7plaaaseam4bntb7wnna`)

**Anchor-name gap:** the public guide discovers a compatible Asset Movement anchor at runtime but does not name its operator. Treat the corridor as illustrative until Resolver discovery returns and the human approves a provider. No live availability is claimed.

## SDK steps

1. Complete required KYC/KYB and confirm network, chain ID, contracts, destination account, amount, and provider terms.
2. Construct `new KeetaAnchor.AssetMovement.Client(userClient)`.
3. Call `getProvidersForTransfer(...)` with the exact EVM source, Keeta destination, and asset pair shown in the guide.
4. Review providers; then create a deposit address with the approved provider:

   ```ts
   const deposit = await provider.createPersistentForwardingAddress({
     account: userAccount,
     asset: { from: arbitrumUsdcAsset, to: keetaUsdToken },
     sourceLocation: { type: 'chain', chain: { type: 'evm', chainId } },
     destinationLocation: {
       type: 'chain',
       chain: { type: 'keeta', networkId: userClient.network }
     },
     destinationAddress: userAccount.publicKeyString.get()
   });
   ```

5. Confirm `deposit.address` before instructing the user to send USDC from the matching Arbitrum network.
6. Monitor with `provider.listTransactions(...)` and verify with `userClient.history()` or a fresh Keeta USD balance.

## Confirmations

- Confirm test vs main, chain ID, USDC contract, Keeta USD token, destination, provider, fees, limits, and KYC status.
- Require human approval before any external-wallet transfer.
- Re-display the persistent address and network; an address for one chain must not be reused on another.

## Failures

- No discovered provider or missing persistent-forwarding operation: stop.
- KYC-share-needed or user-action-needed errors: complete only the typed actions, then retry discovery/status.
- Wrong network, token contract, or destination: do not send.
- Pending transaction: monitor both anchor status and Keeta history; do not duplicate the deposit.

## Related skills

- Use [complete-kyc](../complete-kyc/SKILL.md) or [complete-kyb](../complete-kyb/SKILL.md) first.
- Use [discover-resolve-anchors](../discover-resolve-anchors/SKILL.md) to review the provider.
- Use [multi-asset-balances](../multi-asset-balances/SKILL.md) to reconcile Keeta USD.

## Sources

- [Fiat Deposit From USDC](https://docs.keeta.com/guides/fiat-deposit-from-usdc)
- [Asset Movement client](https://github.com/KeetaNetwork/anchor/blob/main/src/services/asset-movement/client.ts)
