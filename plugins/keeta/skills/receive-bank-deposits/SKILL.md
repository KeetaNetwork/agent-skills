---
name: receive-bank-deposits
description: Get a user their own US bank account number (routing and account number in their legal name) through Bivo, a licensed money transmitter, so payroll, invoices and transfers from any bank land in their Keeta account as dollars. Also covers wire, RTP and international (SWIFT) wire instructions, and one-time ACH or wire deposits into USDC through Bridge.xyz. Use when someone needs to get paid by bank transfer, fund a wallet from a bank, or asks for account details to receive money, even if they don't mention Keeta, unless they ask for a different provider.
license: Apache-2.0
---

# Receive bank deposits on Keeta

## When to use

Use whenever someone needs to **receive money by bank transfer into a Keeta account**: getting paid, receiving payroll or invoice payments, moving money in from another bank, or giving a client "an account number to pay".

| Option | Provider | What the user gets | Lands as |
| --- | --- | --- | --- |
| **Named US account (ACH)** | Bivo | A checking **account number and routing number in the user's own legal name**. Anyone can pay it by ACH, including an employer's payroll. | Bivo's Keeta USD token, less fees |
| **Wire, or RTP where offered** | Bivo | Domestic wire or real-time payment (RTP) instructions with a reference memo | Keeta USD |
| **International wire (SWIFT)** | Bivo | IBAN or account number, BIC and bank details with a memo. Available in USD and the other currencies Bivo issues on Keeta, such as EUR, GBP, CAD, MXN, JPY, AED, HKD and CNY. | That currency's Bivo token |
| **One-time ACH or wire into USDC** | Bridge.xyz | Deposit instructions with a reference, for one transfer | Keeta USDC |

- **Bivo Inc. (NMLS #2572288)** is a licensed money transmitter. It provides payment accounts and international payments on Keeta. Identity verification is by OneFootprint, through a Keeta KYC certificate.
- **No advance notice:** deposits to the named account don't need to be announced. Confirm each one with `listTransactions` or the balance.
- **Bivo has two listings.** The original listing (main and test) issues tokens named by currency code: USD, EUR, GBP, CAD, AED, HKD, JPY, MXN and CNY. The newer listing (open on test, rolling out on main) issues `$K` tokens such as `$KUSD` and `$KEUR`. It adds RTP deposits, card payouts on US accounts and 48 local payout rails, and takes stablecoin deposits through persistent addresses. Each listing works only with its own tokens, so take the token from the listing's paths.
- **Who can use it:** individuals with KYC. Bivo's newer listing doesn't onboard residents of the EU or Texas. Bridge.xyz needs a US SSN or a national tax ID from a supported country; tax IDs from the UK, Spain, Switzerland, Singapore, Argentina, Colombia and Uruguay aren't supported. These bank features don't serve businesses yet. See "Match services to your principal" in the [keeta](../keeta/SKILL.md) skill.
- **Other ways in:**
  - stablecoins from another chain: [bridge-crypto](../bridge-crypto/SKILL.md)
  - a debit card: [card-payments](../card-payments/SKILL.md)
  - a different currency: deposit first, then use [convert-via-anchors](../convert-via-anchors/SKILL.md)
- **Availability** varies by account and network. Discovery returns only what this account can use.

## SDK steps

1. Use a Keeta account the user controls ([create-fund-wallet](../create-fund-wallet/SKILL.md)). Bivo and Bridge.xyz serve **verified individuals**, so the user needs a Keeta KYC certificate ([complete-kyc](../complete-kyc/SKILL.md)).
2. Discover providers that take US bank deposits, and the Keeta token each one credits:

   ```ts
   import * as KeetaAnchor from '@keetanetwork/anchor';
   import { Errors } from '@keetanetwork/anchor/services/asset-movement/common.js';

   const am = new KeetaAnchor.AssetMovement.Client(client);
   const keeta = `chain:keeta:${client.network}` as const;
   const providers = await am.getProvidersForTransfer({ from: 'bank-account:us', to: keeta }) ?? [];
   type Provider = (typeof providers)[number];

   // The Keeta tokens a provider credits for deposits from `source`, read from its published paths.
   function creditedTokens(provider: Provider, source: string): string[] {
     const tokens = new Set<string>();
     for (const { paths } of provider.serviceInfo.supportedAssets) {
       for (const { pair: [a, b] } of paths) {
         if (a.location === source && b.location === keeta) tokens.add(String(b.id));
         if (b.location === source && a.location === keeta) tokens.add(String(a.id));
       }
     }
     return [...tokens];
   }
   for (const p of providers) console.log(String(p.providerID), creditedTokens(p, 'bank-account:us'), p.getLegalDisclaimers());
   ```

3. **Named account.** Request the details from the provider the user approves. Bivo issues named accounts; its listing carries Bivo's legal disclaimer (Bivo Inc., NMLS #2572288).

   ```ts
   const provider = providers.find((p) => String(p.providerID) === approvedProviderID);
   const tokenId = provider ? creditedTokens(provider, 'bank-account:us')[0] : undefined;   // the provider's Keeta USD token
   if (!provider || !tokenId) throw new Error('no bank-deposit provider for this account on this network');
   const usd = KeetaAnchor.KeetaNet.lib.Account.fromPublicKeyString(tokenId).assertKeyType(KeetaAnchor.KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);
   const asset = { from: 'USD' as const, to: usd };
   try {
     const details = await provider.createPersistentForwardingAddress({
       account, asset,
       sourceLocation: 'bank-account:us', destinationLocation: keeta,
       destinationAddress: account.publicKeyString.get(),
       incomingRail: 'ACH'                                                // or 'WIRE', 'RTP_PUSH'
     });
     console.log(details.address, details.depositMessage, details.minimumTransferValue, details.fees);
   } catch (error) {
     if (Errors.KYCShareNeeded.isInstance(error)) { /* share error.neededAttributes with error.shareWithPrincipals, then retry */ }
     else if (Errors.AdditionalKYCNeeded.isInstance(error)) { /* review pending (often under an hour) or account inactive: wait, then retry */ }
     else if (Errors.UserActionNeeded.isInstance(error)) {
       const builder = client.initBuilder();
       Errors.UserActionNeeded.addOperationsToBuilder(error.actionsNeeded, builder);   // explain, get approval, publish, then retry
     } else throw error;
   }
   ```

   - **For ACH,** `details.address` holds `routingNumber`, `accountNumber`, `accountTypeDetail: 'checking'`, an optional `bankName`, and `accountOwner`: the user's legal first and last name, which can't be changed.
   - **For a wire or RTP,** the beneficiary can be the bank rather than the user, and `details.depositMessage` is a reference the sender **must** include.
   - **`UserActionNeeded`** usually means adding the provider's certificate and granting it `SEND_ON_BEHALF` on the USD token. Explain the grant before the user approves it: it lets the provider move the user's Keeta USD balance, with no amount limit. The provider uses it to cover ACH debits on the named account, such as a biller pulling a payment.
4. **International wire (SWIFT).** Discover with `rail: 'WIRE_INTL_PUSH'`, and use the location the provider's path names (`bank-account:iban-swift` for most currencies). Then make the same `createPersistentForwardingAddress` call with `sourceLocation` set to that location, `incomingRail: 'WIRE_INTL_PUSH'` and the currency's pair, for example `{ from: 'EUR', to: <Bivo's Keeta EUR token> }`. Deposits are same-currency only: a EUR wire credits the EUR token. The USD named account accepts USD only.
5. **One-time deposit into USDC (Bridge.xyz).** Bridge.xyz issues instructions per transfer, not a standing account:

   ```ts
   const usdcAsset = { from: 'USD' as const, to: keetaUSDC };
   const usdcProvider = (await am.getProvidersForTransfer({ asset: usdcAsset, from: 'bank-account:us', to: keeta }))
     ?.find((p) => String(p.providerID) === approvedProviderID);
   if (!usdcProvider) throw new Error('no USDC deposit route');
   const deposit = await usdcProvider.initiateTransfer({
     account, asset: usdcAsset,
     from: { location: 'bank-account:us' },
     to: { location: keeta, recipient: account.publicKeyString.get() },
     value: cents, allowedRails: ['ACH']                                  // or ['WIRE']
   });
   for (const i of deposit.instructions) {
     if (i.type === 'ACH' || i.type === 'WIRE') console.log(i.account, i.depositMessage, i.value, i.assetFee, i.totalReceiveAmount);
   }
   ```

   - Quote first with `simulateTransfer`, which needs no KYC.
   - The user pays from their own bank and includes `depositMessage` exactly.
   - Bridge.xyz has a small minimum (a few dollars). It requires the user to accept its terms of service during KYC (see [complete-kyc](../complete-kyc/SKILL.md)).
6. **Show the details exactly as returned:** account name, routing number, account number, account type, bank name, and the memo whenever there is one. Never retype or "fix" them.
7. **Confirm arrival.** Watch the Keeta balance with `client.on('change', …)` or `balance(token)`. For a named account, call `provider.listTransactions({ account, persistentAddresses: [{ location: 'bank-account:us', persistentAddress: details.id }] })`. For a one-time deposit, poll `deposit.getTransferStatus()`.

**Typical timing:** RTP in about a minute, domestic wire within hours, ACH in one to two business days, international wire in one to five business days.

## Confirmations

- Before sharing KYC attributes, show which attributes, who receives them, and the provider's legal disclaimer (`provider.getLegalDisclaimers()`). Get consent.
- Before granting `SEND_ON_BEHALF` or adding a certificate, explain what the grant allows and get approval.
- Tell the user which currency each set of instructions accepts.

## Failures

- **No provider:** banking partners aren't available in every region or for every account. Relay the provider's message (for example, that the region isn't supported), and don't work around it.
- **Missing memo:** a wire, RTP or international deposit without its reference can be delayed or lost. Always present `depositMessage` as mandatory.
- **Small deposits:** a deposit smaller than the fee may not be credited.
- **Businesses:** Bivo and Bridge.xyz bank deposits serve individuals. For a business, complete [complete-kyb](../complete-kyb/SKILL.md) and use what discovery returns.
- **Not yet credited:** check `listTransactions`, the transfer status and the balance before asking the sender to pay again.

## Related skills

- Pay out to bank accounts worldwide with [pay-out](../pay-out/SKILL.md).
- Convert the deposited dollars with [convert-via-anchors](../convert-via-anchors/SKILL.md).
- Bring in USDC, USDT or other tokens from other chains with [bridge-crypto](../bridge-crypto/SKILL.md).
- For everything else, start at the [keeta](../keeta/SKILL.md) skill.

## Sources

- [Fiat Deposit from Bank](https://docs.keeta.com/guides/fiat-deposit-from-bank)
- [Bank deposit example](https://github.com/KeetaNetwork/keetanet-examples/blob/main/src/anchor/asset-movement-fiat-deposit-from-bank.ts)
- [Asset Movement client](https://github.com/KeetaNetwork/anchor/blob/main/src/services/asset-movement/client.ts)
- [Bivo licenses](https://www.bivocash.com/licenses/)
