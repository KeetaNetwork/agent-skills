---
name: pay-out
description: Pay out from Keeta to an external bank account through an asset-movement anchor. Discover a provider for the corridor, check account readiness (KYC), initiate the transfer, fund its KEETA_SEND instruction exactly, and poll to completion. Use for fiat payouts such as Keeta USD to a US bank account.
---

# Pay out to a bank account

## When to use

Use after the recipient is validated and any required identity onboarding is done.

- **Documented corridor:** **test network, Keeta USD → USD at a US bank account**, through the asset-movement provider that discovery returns.
- **Source token:** test Keeta USD, `keeta_any4zllibya6fum3lsoimxmnmeo57nklxlh4c6d6xosfacarfaa3knkiprkmm`.
- **Destination:** asset `USD`, location `bank-account:us`.

The public guide does not name the operator. Treat this corridor as illustrative until discovery returns a provider and a human approves it. On main, resolve the source token from resolver metadata (`resolver.lookupToken('USD')`), never from an example.

## SDK steps

1. Confirm the environment, source token and balance (and KTA for fees), the amount, the recipient's ownership and bank details, the fees and the provider's terms.
2. Discover providers that can initiate this transfer:

   ```ts
   import * as KeetaAnchor from '@keetanetwork/anchor';
   import { Errors, type RecipientResolved } from '@keetanetwork/anchor/services/asset-movement/common.js';

   const am = new KeetaAnchor.AssetMovement.Client(client);
   const keeta = { type: 'chain', chain: { type: 'keeta', networkId: client.network } } as const;
   const usBank = { type: 'bank-account', account: { type: 'us' } } as const;
   const providers = await am.getProvidersForTransfer({ asset: { from: keetaUsdToken, to: 'USD' }, from: keeta, to: usBank });
   const capable = [];
   for (const p of providers ?? []) if (await p.isOperationSupported('initiateTransfer')) capable.push(p);
   // Show each provider's ID and p.getLegalDisclaimers(), then use the one the human approves.
   ```

3. Check readiness, and complete only the typed actions, with consent:

   ```ts
   const provider = capable.find((p) => String(p.providerID) === approvedProviderID);
   if (!provider) throw new Error('approved provider not available');
   const readiness = await provider.getAccountStatus({ account });
   if (readiness.actionRequired) {
     for (const e of readiness.errors) {
       if (Errors.KYCShareNeeded.isInstance(e)) { /* share e.neededAttributes with e.shareWithPrincipals (complete-kyc) */ }
       if (Errors.UserActionNeeded.isInstance(e)) {
         const builder = client.initBuilder();
         Errors.UserActionNeeded.addOperationsToBuilder(e.actionsNeeded, builder);   // review, then publish with approval
       }
     }
   }
   ```

4. Build the recipient locally, and never log the account or routing numbers:

   ```ts
   const recipient: RecipientResolved = {
     type: 'bank-account', accountType: 'us',
     accountNumber, routingNumber, accountTypeDetail: 'checking',
     accountOwner: { type: 'individual', firstName, lastName },
     accountAddress: { line1, city, subdivision, postalCode, country: 'US' }
   };
   ```

5. Optionally preview fees and instructions with `provider.simulateTransfer({ asset, from: { location: keeta }, to: { location: usBank }, value })`.
6. Initiate the transfer, then fund **exactly** the `KEETA_SEND` instruction after final approval:

   ```ts
   const transfer = await provider.initiateTransfer({
     account, asset: { from: keetaUsdToken, to: 'USD' },
     from: { location: keeta }, to: { location: usBank, recipient }, value: amount
   });
   const instruction = transfer.instructions.find((i) => i.type === 'KEETA_SEND');
   if (!instruction || instruction.type !== 'KEETA_SEND') throw new Error('no KEETA_SEND instruction');
   // Show sendToAddress, tokenAddress, value, external and assetFee; get approval; then:
   await client.send(instruction.sendToAddress, BigInt(instruction.value), instruction.tokenAddress, instruction.external);
   ```

7. Poll until the transfer completes, respecting the provider's pacing:

   ```ts
   for (;;) {
     const { transaction } = await transfer.getTransferStatus();
     if (KeetaAnchor.lib.isCompletedTransferStatus(transaction.status)) break;   // 'COMPLETE'
     await KeetaAnchor.KeetaNet.lib.Utils.Helper.asleep(5000);
   }
   ```

   Only `COMPLETE` is a standardized status. Report other statuses verbatim as provider-specific strings.

## Confirmations

- Confirm the provider's identity, the recipient's name, masked bank details, amount, currency, fees (`assetFee`), expected delivery and terms.
- Immediately before funding, confirm `sendToAddress`, the token, `value` and `external`.
- Get human approval for any new recipient, and again if the quote or instruction changes.

## Failures

- **No provider, or no provider supporting `initiateTransfer`:** stop.
- **`KYCShareNeeded`, `AdditionalKYCNeeded` or `UserActionNeeded`:** present and complete only the typed action, with consent.
- **Mismatched instruction:** never fund an instruction whose amount, token, provider, recipient or `external` differs from the approved transfer.
- **Ambiguous funding or status:** reconcile with `history({ depth })` and `getTransferStatus()` before retrying. Never send the funding twice.
- **Bank details:** keep them out of logs, prompts, commits and on-chain metadata. The `external` value is the provider's reference, not a place for personal data.

## Related skills

- Complete identity steps first: [complete-kyc](../complete-kyc/SKILL.md) or [complete-kyb](../complete-kyb/SKILL.md).
- Review providers with [discover-resolve-anchors](../discover-resolve-anchors/SKILL.md).
- Apply [spend-policy](../spend-policy/SKILL.md) before initiating and before funding.
- To convert first (for example EUR → USD) and then pay out, see anchor chaining in the [anchors reference](../keeta/references/anchors.md).

## Sources

- [Fiat Withdraw to Bank](https://docs.keeta.com/guides/fiat-withdraw-to-bank)
- [Full withdrawal example](https://github.com/KeetaNetwork/keetanet-examples/blob/main/src/anchor/asset-movement-fiat-withdraw-to-bank.ts)
- [Asset Movement client](https://github.com/KeetaNetwork/anchor/blob/main/src/services/asset-movement/client.ts)
