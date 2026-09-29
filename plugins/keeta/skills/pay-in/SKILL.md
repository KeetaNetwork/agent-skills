---
name: pay-in
description: Discover an Asset Movement provider for inbound US bank deposits that credit Keeta USD, call createPersistentForwardingAddress, and show only the deposit instructions the provider returns. Use when a wallet needs standing bank deposit instructions.
---

# Pay in from a US bank

## When to use

Use this skill when a person needs reusable instructions to send USD from a US bank account so the credit lands as Keeta USD. Complete individual KYC and any requested attribute share before asking for deposit instructions. This skill covers the public inbound corridor from the Fiat Deposit from Bank guide. It does not send a Keeta transaction and it does not register a payout recipient.

Bind `UserClient` to an explicit `test` or `main` network. The guide's illustrative tokens are:

- test Keeta USD `keeta_any4zllibya6fum3lsoimxmnmeo57nklxlh4c6d6xosfacarfaa3knkiprkmm`
- main Keeta USD `keeta_amnkge74xitii5dsobstldatv3irmyimujfjotftx7plaaaseam4bntb7wnna`

Re-resolve the token for the selected network from the guide or from provider metadata. A token id from the other network is a stop.

## SDK steps

1. Confirm the network, the Keeta account, that the human wants US bank deposit instructions, and that KYC sharing for this provider is already approved or still to be done.
2. Discover providers with the documented location shape. The source location `{ type: 'bank-account', account: { type: 'us' } }` is the SDK form of `bank-account:us`.

   ```ts
   import * as KeetaAnchor from '@keetanetwork/anchor';
   import { Errors } from '@keetanetwork/anchor/services/asset-movement/common.js';

   const Account = KeetaAnchor.KeetaNet.lib.Account;
   const assetMovementClient = new KeetaAnchor.AssetMovement.Client(userClient);
   const keetaUsd = Account.fromPublicKeyString(keetaUsdToken);
   const usBankSource = { type: 'bank-account', account: { type: 'us' } } as const;
   const keetaDestination = {
     type: 'chain',
     chain: { type: 'keeta', networkId: userClient.network }
   } as const;
   const assetPair = { from: 'USD' as const, to: keetaUsd };

   const providers = await assetMovementClient.getProvidersForTransfer({
     asset: assetPair,
     from: usBankSource,
     to: keetaDestination
   });
   ```

3. Stop when `providers` is missing or empty. List every returned provider id, the legal terms present on that provider, and the supported operations. The human chooses the provider. An empty list means this corridor is not currently discoverable.
4. On the chosen provider, call `await provider.isOperationSupported('createPersistentForwarding')`. The operation name matches the `createPersistentForwarding` endpoint used by `createPersistentForwardingAddress`. Stop when the call returns `false`.
5. After the human approves that provider, request the persistent forwarding address with the same asset and locations:

   ```ts
   const depositInfo = await provider.createPersistentForwardingAddress({
     account,
     asset: assetPair,
     sourceLocation: usBankSource,
     destinationLocation: keetaDestination,
     destinationAddress: account.publicKeyString.get()
   });
   ```

6. Show the user the returned object. The public client types this result as persistent forwarding address details: optional `id`, `address`, optional `depositMessage`, optional `asset`, `sourceLocation`, `destinationLocation`, `destinationAddress`, `outgoingRail`, `incomingRail`, `minimumTransferValue`, and `fees`. Render only members that are present. When `address` is itself an object, render only the members on that object. Leave out any routing number, account number, memo, or rail the provider did not return.
7. Tell the human to pay from their own bank using those instructions. This skill does not submit an ACH or wire.
8. After the human says the bank payment was sent, reconcile before claiming credit. Read `await userClient.balance(keetaUsd)` and compare it with the balance taken before the payment. `await userClient.history()` is the documented alternative for seeing account changes. `userClient.on('change', ...)` is the documented listener with a polling fallback. Report the observed balance and whether history shows a new credit. A missing credit means the bank payment is still outstanding.

## Confirmations

- Confirm `test` or `main`, the Keeta USD token, and the public destination address before discovery.
- Confirm the chosen provider id and any terms the provider object exposes before `createPersistentForwardingAddress`.
- Show deposit instructions to the human who must make the bank payment. Repeat the destination address next to those instructions.
- Ask again before sharing KYC attributes or publishing a user-action block. Those steps belong to complete-kyc.

## Failures

- Stop when discovery returns no provider, throws, or the chosen provider does not support `createPersistentForwarding`.
- When `Errors.KYCShareNeeded.isInstance(error)` or `Errors.UserActionNeeded.isInstance(error)` is true, stop this request and hand the error to [complete-kyc](../complete-kyc/SKILL.md). The share error carries `shareWithPrincipals`, `neededAttributes`, `acceptedIssuers`, and an optional `tosFlow`. The user-action error carries `actionsNeeded`. Retry `createPersistentForwardingAddress` only after that skill finishes the consented step.
- Stop when the returned object is empty or omits `address`. Ask the provider flow again after the human reconfirms the provider. Do not fill in bank fields from memory or from a payout recipient.
- Keep account numbers, routing numbers, and identity attributes out of logs, source files, and on-chain identifiers. The human-facing confirmation is the only place those returned instruction fields belong.
- When the balance and history do not show the credit, report the last balance and wait. Do not create a second forwarding address for the same provider and asset unless the human asks for a replacement and the previous instructions are visibly unusable.

## Related skills

- Start with [create-fund-wallet](../create-fund-wallet/SKILL.md) when the account does not exist yet.
- Hand identity errors to [complete-kyc](../complete-kyc/SKILL.md). Business verification stays in [complete-kyb](../complete-kyb/SKILL.md) and stops when no public KYB contract exists.
- Use [discover-resolve-anchors](../discover-resolve-anchors/SKILL.md) when the human wants the Resolver metadata behind a provider id.
- Read the settled credit with [multi-asset-balances](../multi-asset-balances/SKILL.md).
- Continue to [pay-out](../pay-out/SKILL.md) only after the human asks to send Keeta USD to a bank.
- Apply [spend-policy](../spend-policy/SKILL.md) before any later value movement. Obtaining deposit instructions is not a Keeta send.

## Sources

- [Fiat Deposit from Bank](https://docs.keeta.com/guides/fiat-deposit-from-bank)
- [Bank deposit example](https://github.com/KeetaNetwork/keetanet-examples/blob/main/src/anchor/asset-movement-fiat-deposit-from-bank.ts)
- [Asset Movement](https://docs.keeta.com/anchors/anchor-types/asset-movement)
- [Asset Movement client](https://github.com/KeetaNetwork/anchor/blob/main/src/services/asset-movement/client.ts)
- [Persistent forwarding address details](https://github.com/KeetaNetwork/anchor/blob/main/src/services/asset-movement/common.ts)
