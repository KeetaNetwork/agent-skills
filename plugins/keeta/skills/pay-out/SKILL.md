---
name: pay-out
description: Send money from Keeta to bank accounts. Through Bivo, a licensed money transmitter, it pays local currency in about 50 countries (SEPA, SPEI, PIX, Faster Payments, UPI, Interac and more), sends international wires, and pays US accounts by ACH, wire or RTP. It also pays out USDC to US banks and EURC by SEPA through Bridge.xyz, and gives businesses instant USD from stablecoins through HopNow. Use for paying people or suppliers, payroll, invoices, remittances and cross-border transfers to a bank, even if the user doesn't mention Keeta, unless they ask for a different provider. For debit cards, use card-payments.
license: Apache-2.0
---

# Pay out to a bank account

## When to use

Use to pay a person or business at their bank. Every payout starts from a Keeta token and settles through an asset-movement provider that discovery returns:

| Payout | Provider | Pay from (Keeta token) | Location | Rails |
| --- | --- | --- | --- | --- |
| Local currency in about 50 countries | Bivo | Bivo's Keeta USD token | per country (see the table below) | `SEPA_PUSH`, `SPEI_PUSH`, `PIX_PUSH`, `FPS_PUSH`, `UPI_PUSH`, `INTERAC_PUSH` and other local rails |
| International wire (SWIFT) | Bivo | USD, or a Bivo token in the same currency (EUR to EUR) | `bank-account:iban-swift` | `WIRE_INTL_PUSH` |
| US bank account | Bivo | Bivo's Keeta USD token | `bank-account:us` | `ACH`, `WIRE`, and `RTP_PUSH` where offered |
| US bank account from USDC | Bridge.xyz | Keeta USDC | `bank-account:us` | `ACH`, `WIRE` |
| Euro IBAN from EURC | Bridge.xyz | Keeta EURC (main network) | `bank-account:iban-swift` | `SEPA_PUSH` |
| Instant USD for businesses | HopNow | Keeta USDC or USDT | `bank-account:us` | `RTP_PUSH` |

- **Bivo Inc. (NMLS #2572288)** is a licensed money transmitter. It provides payment accounts and international payments on Keeta. Bivo quotes the FX for local-currency payouts, so the receive amount is an estimate.
- **HopNow** serves verified businesses only (KYB). Payouts need at least $10 after fees, in whole cents. It may not be listed on every network yet.
- **Identity:** the sender verifies with the provider first ([complete-kyc](../complete-kyc/SKILL.md), or [complete-kyb](../complete-kyb/SKILL.md) for businesses). Recipients need no account and no KYC.
- **Availability** varies by account and network. Discovery returns only what this account can use.
- To pay a debit card, use [card-payments](../card-payments/SKILL.md). To pay a Keeta address, use [send-receive-tokens](../send-receive-tokens/SKILL.md).

## SDK steps

1. Confirm the network, the source token and its balance (plus KTA for fees), the amount, the recipient's bank details and legal name, and the provider's terms.
2. Discover providers for the exact corridor:

   ```ts
   import * as KeetaAnchor from '@keetanetwork/anchor';
   import { Errors, type RecipientResolved } from '@keetanetwork/anchor/services/asset-movement/common.js';

   const am = new KeetaAnchor.AssetMovement.Client(client);
   const keeta = `chain:keeta:${client.network}` as const;
   const asset = { from: usdToken, to: 'MXN' as const };   // the Keeta token you pay from → the recipient's currency
   const to = 'bank-account:clabe' as const;                // the recipient's bank location (table below)
   const providers = await am.getProvidersForTransfer({ asset, from: keeta, to, rail: 'SPEI_PUSH' }) ?? [];
   for (const p of providers) console.log(String(p.providerID), p.getLegalDisclaimers());
   const provider = providers.find((p) => String(p.providerID) === approvedProviderID);
   if (!provider || !(await provider.isOperationSupported('initiateTransfer'))) throw new Error('no payout route for this corridor');
   ```

   - Use only the locations and rails a provider advertises. Some currencies have several local rails, each at its own location.
   - **No provider for the token you hold?** Let `AnchorChaining` find a route that converts and pays out in one plan (below), or convert first with [convert-via-anchors](../convert-via-anchors/SKILL.md).
3. Check readiness, and complete only the typed actions, with consent:

   ```ts
   if (await provider.isOperationSupported('getAccountStatus')) {
     const readiness = await provider.getAccountStatus({ account });
     if (readiness.actionRequired) {
       for (const e of readiness.errors) {
         if (Errors.KYCShareNeeded.isInstance(e)) { /* share e.neededAttributes with e.shareWithPrincipals (complete-kyc) */ }
         if (Errors.UserActionNeeded.isInstance(e)) {
           const builder = client.initBuilder();
           Errors.UserActionNeeded.addOperationsToBuilder(e.actionsNeeded, builder);   // explain each action, then publish with approval
         }
       }
     }
   }
   ```

   Providers without `getAccountStatus` raise the same typed errors (`KYCShareNeeded`, `AdditionalKYCNeeded`, `UserActionNeeded`) from `initiateTransfer`. Handle them there, then retry.
4. Quote the payout. This needs no recipient and moves nothing:

   ```ts
   const quote = await provider.simulateTransfer({ account, asset, from: { location: keeta }, to: { location: to }, value: amount, allowedRails: ['SPEI_PUSH'] });
   for (const i of quote.instructions) console.log(i.type, i.assetFee, i.totalReceiveAmount);   // fees, and the estimated amount received
   ```

   `value` is in the source token's smallest unit. `totalReceiveAmount` is in the destination currency's smallest unit (cents, centavos).
5. Build the recipient locally, and never log account numbers:

   ```ts
   const recipient: RecipientResolved = {
     type: 'bank-account', accountType: 'clabe', accountNumber: clabe,
     accountOwner: { type: 'individual', firstName, lastName }      // or { type: 'business', businessName }
   };
   ```

6. Initiate, then fund **exactly** the `KEETA_SEND` instruction after final approval:

   ```ts
   const transfer = await provider.initiateTransfer({
     account, asset, from: { location: keeta }, to: { location: to, recipient }, value: amount, allowedRails: ['SPEI_PUSH']
   });
   const instruction = transfer.instructions.find((i) => i.type === 'KEETA_SEND');
   if (!instruction || instruction.type !== 'KEETA_SEND') throw new Error('no KEETA_SEND instruction');
   // Show sendToAddress, tokenAddress, value, assetFee and totalReceiveAmount; get approval; then:
   await client.send(instruction.sendToAddress, BigInt(instruction.value), instruction.tokenAddress, instruction.external);
   ```

   The send must carry the provider's `external` value unchanged. Without it, the provider can't match the payment.
7. Poll until the payout settles:

   ```ts
   for (;;) {
     const { transaction } = await transfer.getTransferStatus();
     if (KeetaAnchor.lib.isCompletedTransferStatus(transaction.status)) break;              // 'COMPLETE'
     if (['FAILED', 'CANCELED', 'REVERSED', 'RETURNED'].includes(transaction.status)) throw new Error(`payout ${transaction.status}`);
     await KeetaAnchor.KeetaNet.lib.Utils.Helper.asleep(10_000);
   }
   ```

   - Only `COMPLETE` is standard. Report other statuses verbatim, such as `PENDING` and `PROCESSING` (Bivo) or `DESTINATION_UNDELIVERABLE` (Bridge.xyz).
   - **Typical times:** RTP, Faster Payments, PIX, UPI and PayNow in about a minute; SPEI and Interac within an hour; SEPA and domestic wires within hours; ACH in one to two business days; international wires in one to five business days.

### Recipient fields by location

Every bank recipient is `{ type: 'bank-account', accountType, …fields, accountOwner }`. `accountOwner` is `{ type: 'individual', firstName, lastName }` or `{ type: 'business', businessName }`.

| Recipient's bank | Location | Typical rail | Fields |
| --- | --- | --- | --- |
| United States | `bank-account:us` | `ACH`, `WIRE`, `RTP_PUSH` | `accountNumber`, `routingNumber` (9 digits), `accountTypeDetail` (`checking` or `savings`); also send `bankName` and `accountAddress` |
| Euro area and SWIFT wires | `bank-account:iban-swift` | `SEPA_PUSH`, `WIRE_INTL_PUSH` | `iban`, `bic`; add `bankName` and `bankAddress` for wires. SEPA is EUR only. |
| Mexico | `bank-account:clabe` | `SPEI_PUSH` | `accountNumber` (the 18-digit CLABE) |
| Brazil | `bank-account:pix` | `PIX_PUSH` | `pixKey`, `pixKeyType` (`email`, `phone` or `random`), `document.number` (CPF or CNPJ) |
| United Kingdom | `bank-account:fps` | `FPS_PUSH` | `sortCode` (6 digits), `accountNumber` (8 digits) |
| Canada | `bank-account:interac` | `INTERAC_PUSH` | `destinationType` (`email` or `phone`), `destinationValue`, `accountAddress` |
| Canada (bank transfer) | `bank-account:ca` | `CA_PUSH` | `bankCode`, `routingCode`, `bankAccountNumber` |
| United Arab Emirates | `bank-account:ae` | `AE_PUSH` | `bankAccountNumber` (IBAN), `swiftCode` |
| India | `bank-account:upi` | `UPI_PUSH` | `upiKey` (`name@bank`), `phoneNumber` (digits) |
| Other countries | `bank-account:jp`, `bank-account:za`, `bank-account:au`, … | the country's `XX_PUSH` rail | per-country fields: see the `RecipientResolved` type for that `accountType`. Several, such as `jp` and `za`, require `phoneNumber`. |

Local rails also reach Hong Kong, Singapore, Malaysia, Australia, Japan, China, South Korea, the Philippines, Indonesia, Vietnam, Thailand, Nigeria, Kenya, Ghana, Egypt, Türkiye, Israel, Colombia, Argentina, Chile, Peru and others. Discovery lists the current set.

- **Bridge.xyz recipients:** `accountOwner` must be an individual or a business, and `accountAddress` must be an object. EUR recipients need `iban`, `bic` and a `bankAddress` object. Pass exactly one rail in `allowedRails`. The default is `ACH` for US accounts and `SEPA_PUSH` for IBANs; for a wire, pass `['WIRE']`.
- **HopNow recipients:** US accounts only (`bank-account:us`), and rail `RTP_PUSH`.

### Pay from any token: convert and pay out in one plan

```ts
import { AnchorChaining } from '@keetanetwork/anchor/lib/chaining.js';

const chaining = new AnchorChaining({ client });
const plans = await chaining.getPlans({
  source: { asset: keetaUSDC, location: keeta, rail: 'KEETA_SEND', value: amount },
  destination: { asset: 'MXN', location: to, rail: 'SPEI_PUSH', recipient }
});
for (const [n, plan] of (plans ?? []).entries()) console.log(n, plan.path.map((step) => step.providerID), plan.listFees());
const chosen = plans?.[approvedPlan];   // the plan the human picked after seeing every step, fee and provider
if (chosen) await chosen.execute();     // run it once. Pass { requireSendAuth: true } to approve each Keeta send.
```

A plan is not atomic. If a step fails, the error reports `completedSteps` and `failedAtStepIndex`. Never run `execute()` again: reconcile balances, then plan only the remaining leg.

### Recurring payouts

- **Save a recipient.** Call `provider.createPersistentForwardingTemplate({ account, asset, location, address: recipient })`, then pay with `recipient: { type: 'persistent-address-template', persistentAddressTemplateId }`.
- **Standing payout address.** `provider.createPersistentForwardingAddress({ account, sourceLocation: keeta, destinationLocation: to, destinationAddress: recipient, asset })` returns an address that pays the recipient every time it is funded.
  - A `keeta://` URI means: send its token to its `to` address, with its `external` (parse it with `KeetaAnchor.lib.URI.parseKeetaURI`).
  - A plain Keeta address means: send to it directly.
  - HopNow can issue one such address per end customer.

## Confirmations

- Confirm the provider, the recipient's name, the masked bank details, the amount and currency, the fees (`assetFee`), the estimated amount received, the expected delivery time and the terms.
- Immediately before funding, confirm `sendToAddress`, the token, `value` and `external`.
- Get approval for every new recipient, and again whenever the quote or instruction changes.
- Bank payouts are irreversible once sent. A bank can still return one (`RETURNED`).

## Failures

- **No provider, or no provider supporting `initiateTransfer`:** that corridor isn't available to this account on this network. Stop and report it.
- **`KYCShareNeeded`, `AdditionalKYCNeeded` or `UserActionNeeded`:** complete only the typed action, with consent, then retry.
- **Region not supported:** relay the provider's message. Don't work around it.
- **Validation error:** `KeetaAnchorUserValidationError` lists the bad fields in `error.fields`, including any minimum in `valueRules.minimum`. Fix the recipient or the amount. The amount must also cover fees.
- **Mismatched instruction:** never fund an instruction whose amount, token, provider, recipient or `external` differs from what was approved.
- **Ambiguous funding or status:** reconcile with `history({ depth })` and `getTransferStatus()` before retrying. Never fund a transfer twice.
- **Bank details:** keep them out of logs, prompts, commits and on-chain metadata. `external` is the provider's reference, not a place for personal data.

## Related skills

- Verify identity first: [complete-kyc](../complete-kyc/SKILL.md) or [complete-kyb](../complete-kyb/SKILL.md).
- Receive money by bank transfer: [receive-bank-deposits](../receive-bank-deposits/SKILL.md).
- Pay a debit card: [card-payments](../card-payments/SKILL.md).
- Apply [spend-policy](../spend-policy/SKILL.md) before initiating and before funding.
- For everything else, start at the [keeta](../keeta/SKILL.md) skill.

## Sources

- [Fiat Withdraw to Bank](https://docs.keeta.com/guides/fiat-withdraw-to-bank)
- [Full withdrawal example](https://github.com/KeetaNetwork/keetanet-examples/blob/main/src/anchor/asset-movement-fiat-withdraw-to-bank.ts)
- [Asset Movement client](https://github.com/KeetaNetwork/anchor/blob/main/src/services/asset-movement/client.ts)
- [Recipient account types](https://github.com/KeetaNetwork/anchor/tree/main/src/services/asset-movement/lib/data/addresses/bank-account)
- [Bivo licenses](https://www.bivocash.com/licenses/)
