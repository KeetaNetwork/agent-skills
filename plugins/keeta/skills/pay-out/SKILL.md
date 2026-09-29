---
name: pay-out
description: Discover an outbound Asset Movement anchor, confirm a US bank recipient, initiate a single Keeta USD payout, fund its instruction once, and poll status before any retry. Use for external fiat payouts.
---

# Pay out to a bank account

## When to use

Use this skill after the human has approved a US bank recipient and any required identity onboarding. The concrete public example is test Keeta USD to USD at a US bank account:

- source: test Keeta USD `keeta_any4zllibya6fum3lsoimxmnmeo57nklxlh4c6d6xosfacarfaa3knkiprkmm`
- destination asset: `USD`
- destination location: `{ type: 'bank-account', account: { type: 'us' } }`
- environment: `test`

Re-resolve Keeta USD for the selected network from the public guide and from the provider metadata. Use a token only when those sources name the same id. On `test`, the withdraw guide and example use `keeta_any4zllibya6fum3lsoimxmnmeo57nklxlh4c6d6xosfacarfaa3knkiprkmm`. On `main`, the withdraw guide names `keeta_amnkge74xitii5dsobstldatv3irmyimujfjotftx7plaaaseam4bntb7wnna` and current `keetanet-examples` names `keeta_aonxxqry6rknxyb6c5q2ybxk2gt776xlchhcohhyla5kqvinnaduevuxyx3tc`. Those sources conflict, so neither mainnet id is authoritative here. Stop and tell the human both ids. Continue only when the guide and the provider metadata identify one token.

The guide selects the Asset Movement provider through the Resolver and does not name an operator. Discovery has to return a provider, and the human has to approve that provider, before any transfer starts.

## SDK steps

1. Confirm KYC readiness, the source token balance, recipient ownership, the recipient checklist below, the base-unit amount, the environment, and the provider terms. Resolve token decimals from the network before converting a display amount into base units. The guide's `value: 200n` comment is an illustration that 200 base units equal $2.00 on that documented token. The example still reads decimals and refuses an amount above `userClient.balance(keetaUsd)`.
2. Discover providers. Stop when the list is empty.

   ```ts
   const client = new KeetaAnchor.AssetMovement.Client(userClient);
   const providers = await client.getProvidersForTransfer({
     asset: { from: keetaUsdToken, to: 'USD' },
     from: {
       type: 'chain',
       chain: { type: 'keeta', networkId: userClient.network }
     },
     to: { type: 'bank-account', account: { type: 'us' } }
   });
   ```

3. Build the recipient locally with the fields the public example requires, and keep the raw account and routing numbers out of logs. The guide names the US bank shape `UsBankAccountResolved`. The example types the same object as `RecipientResolved`.

   Recipient checklist, all required except address line 2:

   - `type`: `'bank-account'`
   - `accountType`: `'us'`
   - `accountNumber`
   - `routingNumber`
   - `bankName`
   - `accountTypeDetail`: `'checking'` or `'savings'`
   - `accountOwner.type`: `'individual'`
   - `accountOwner.firstName` and `accountOwner.lastName`
   - `accountAddress.line1`, `city`, `subdivision` (2-letter state code), `postalCode`, and `country`: `'US'`
   - `accountAddress.line2` may be an empty string

   Stop when any required field is missing. Show the human the owner name, bank name, account type, and the last four digits of the account number.

4. The human selects a provider from the discovery list. Call `getAccountStatus(...)` when that provider exposes it. Then call `initiateTransfer` with the approved source, destination, recipient, and base-unit `value`.

   ```ts
   const transfer = await provider.initiateTransfer({
     account,
     asset: { from: keetaUsdToken, to: 'USD' },
     from: { location: keetaSource },
     to: {
       location: { type: 'bank-account', account: { type: 'us' } },
       recipient: bankRecipient
     },
     value: amountToWithdraw
   });
   ```

5. Read `transfer.transferID` and `transfer.instructions`. Fund exactly one instruction, and fund it once. The public example requires `transfer.instructions[0]`, requires `instruction.type === 'KEETA_SEND'`, and requires `instruction.external`. It then sends that amount once:

   ```ts
   const instruction = transfer.instructions[0];
   await userClient.send(
     KeetaAnchor.KeetaNet.lib.Account.toAccount(instruction.sendToAddress),
     amountToWithdraw,
     keetaUsdToken,
     instruction.external
   );
   ```

   The example treats a successful publish as `sendBlockResult.publish` with `sendBlockResult.from === 'direct'`. When that shape is missing, or the publish result is unclear, stop. Reconcile `userClient.balance(keetaUsdToken)`, `userClient.history()`, and `transfer.getTransferStatus()` before any second send. A second send of the same instruction duplicates the payout.

6. Poll `transfer.getTransferStatus()`. The response's `transaction.status` is a string. The public example logs that string every 5 seconds and stops monitoring when the status is `PROCESSING` or `COMPLETED`, then reads the Keeta USD balance again. Report the status that came back. `PROCESSING` means the example stopped polling, and it still needs a balance reconciliation before anyone calls the payout settled. `COMPLETED` is the status the example treats as processed. Any other string stays in the poll loop until the human stops it or the call errors. Do not start another `initiateTransfer` while this `transferID` is still open.

7. Fee and delivery notes come from the returned objects. Instruction objects may include `assetFee` (a base-unit string or a line-item breakdown) and `totalReceiveAmount` (destination base units after fees). Transfer status may include `transaction.fee` as `{ asset, value }` or `null`, plus optional `additionalTransferDetails`. Show those fields when they are present, in base units, with the token decimals beside them. When they are absent, say the provider response did not include a fee or a delivery estimate.

## Confirmations

- Confirm provider id, owner name, bank name, masked account number, amount, source token, destination currency, and terms before `initiateTransfer`.
- Confirm `sendToAddress`, token, base-unit amount, and `external` immediately before the single `userClient.send`.
- Require a new approval when the recipient, quote, fee, amount, or instruction changes.
- Show `assetFee`, `totalReceiveAmount`, and `transaction.fee` when the provider included them.

## Failures

- Stop when no provider is returned or the requested operation is missing.
- Stop on `main` while the withdraw guide and `keetanet-examples` disagree on the Keeta USD token, and stop when provider metadata names a third id. Report the ids you compared. Do not fund a payout against either contested id.
- On `KYCShareNeeded` or `UserActionNeeded`, stop and finish only the typed action in [complete-kyc](../complete-kyc/SKILL.md), with consent, then retry discovery.
- Refuse to fund an instruction whose amount, token, provider, recipient, or id differs from the approved transfer.
- Fund one `KEETA_SEND` instruction one time. When publish or status is ambiguous, reconcile balance, history, and `getTransferStatus()` before retrying.
- Keep full account and routing numbers out of logs, prompts, commits, and on-chain metadata. The last four digits are enough for a confirmation.

## Related skills

- Use [complete-kyc](../complete-kyc/SKILL.md) or [complete-kyb](../complete-kyb/SKILL.md) before the provider will accept the payout.
- Use [pay-in](../pay-in/SKILL.md) when the wallet still needs US bank deposit instructions and a Keeta USD balance.
- Use [discover-resolve-anchors](../discover-resolve-anchors/SKILL.md) for provider review.
- Use [multi-asset-balances](../multi-asset-balances/SKILL.md) for the pre-send and post-send balance.
- Apply [spend-policy](../spend-policy/SKILL.md) before initiation and funding.

## Sources

- [Fiat Withdraw to Bank](https://docs.keeta.com/guides/fiat-withdraw-to-bank)
- [Full withdrawal example](https://github.com/KeetaNetwork/keetanet-examples/blob/main/src/anchor/asset-movement-fiat-withdraw-to-bank.ts)
- [Mainnet Keeta USD id in the USDC example](https://github.com/KeetaNetwork/keetanet-examples/blob/main/src/anchor/asset-movement-fiat-deposit-from-crypto.ts)
- [Asset Movement](https://docs.keeta.com/anchors/anchor-types/asset-movement)
- [Asset Movement client](https://github.com/KeetaNetwork/anchor/blob/main/src/services/asset-movement/client.ts)
- [Instruction fees and transfer status fields](https://github.com/KeetaNetwork/anchor/blob/main/src/services/asset-movement/common.ts)
