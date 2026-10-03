---
name: card-payments
description: Push money to a debit card in about a minute with Visa Direct, or fund a Keeta balance from a debit card, through Bivo on Keeta where available. The card is linked once through a secure card-entry screen and the provider's card vault, so agents never see card numbers. Use when a user wants to cash out to their debit card, get paid out to a card, or top up from a card, even if they don't mention Keeta, unless they ask for a different provider.
license: Apache-2.0
---

# Card payments with Visa Direct

## When to use

Use when money moves between a Keeta balance and **the user's own debit card**:

| Direction | Rail | What happens | Typical time |
| --- | --- | --- | --- |
| **Push to card** (payout) | `CARD_PUSH` | Visa Direct sends money from the user's Keeta balance to their debit card | About a minute |
| **Pull from card** (funding) | `CARD_PULL` | The user's card is charged, and the amount is credited to their Keeta USD balance | A few minutes |

- **Provider:** Bivo Inc. (NMLS #2572288), a licensed money transmitter, provides card transfers on Keeta through Visa Direct. The user completes Bivo onboarding first (KYC, as in [receive-bank-deposits](../receive-bank-deposits/SKILL.md)).
- **Own cards only:** a linked card belongs to the user's own profile, so pay only cards the user owns. To pay someone else, use [pay-out](../pay-out/SKILL.md) to their bank account, or [send-receive-tokens](../send-receive-tokens/SKILL.md) to their Keeta address.
- **Who can use it:** individuals onboarded with Bivo, paying their own card. Bivo's newer listing doesn't onboard residents of the EU or Texas.
- **Card currencies** include USD, EUR, GBP, CAD, MXN, JPY, AUD, CNY, HKD, SGD, AED, ILS, DKK, NZD, ZAR, THB, INR and NGN.
- **Availability** of card rails, currencies and pairs varies by account and network. Discovery shows what this account can use.

## Card data rules

- **Never** ask for, display, store, log, or forward a card number, expiry date or security code: not in chat, files, prompts, logs, `external` fields or on-chain metadata.
- Card details are entered only in a **secure card-entry screen the user controls**. That screen posts the card straight to the provider's card vault, and the provider returns a token. Keeta and the agent only ever see the last four digits.
- Card linking needs a PCI-compliant card-entry screen, fed by the provider's session. Keeta's wallet will offer one, but it isn't live yet; until then the screen has to be in the user's own app. Never ask the user to type card details anywhere else. Without such a screen, linking a new card isn't possible through the agent; cards already linked can still be used.
- Keep `session.data`, the card-entry session token, out of chat and logs. Pass it only to the secure screen.
- Refer to a card only by its last four digits (`cardNumberEnding` on the obfuscated address).
- The SDK has a raw `card` address type, but providers reject raw card numbers. Always pay a linked card by its template ID.

## SDK steps

1. Confirm that the user has finished onboarding with the provider ([complete-kyc](../complete-kyc/SKILL.md)), the network, and the direction.
2. Discover providers with card rails:

   ```ts
   import * as KeetaAnchor from '@keetanetwork/anchor';

   const am = new KeetaAnchor.AssetMovement.Client(client);
   const keeta = `chain:keeta:${client.network}` as const;
   const providers = await am.getProvidersForTransfer({ from: keeta, rail: 'CARD_PUSH' }) ?? [];
   for (const p of providers) console.log(String(p.providerID), p.getLegalDisclaimers());
   const provider = providers.find((p) => String(p.providerID) === approvedProviderID);
   if (!provider) throw new Error('card payouts are not available to this account on this network');
   ```

   - Card paths normally use the location `bank-account:card`; some USD corridors list card payouts under `bank-account:us`. Use the location and currency pairs from the provider's paths (`provider.serviceInfo.supportedAssets`).
   - For funding, discover with `{ from: 'bank-account:card', to: keeta, rail: 'CARD_PULL' }`.
3. **Link a card once,** through the secure screen, then list the linked cards:

   ```ts
   const session = await provider.initiatePersistentForwardingTemplate({ account, asset: 'USD', location: 'bank-account:card' });
   // Pass session.id and session.data to the secure card-entry screen. The user's device sends the card to the provider's vault,
   // and the screen completes the link with provider.createPersistentForwardingTemplate({ account, id: session.id, data }).
   console.log('Card linking session expires at', session.expiresAt);

   const { templates } = await provider.listForwardingAddressTemplates({ account, location: ['bank-account:card'] });
   for (const t of templates) console.log(t.id, t.address);   // obfuscated: last four digits and the owner's name only
   ```

   Sessions are single-use and expire. If one expires, start a new session.
4. **Push to the card.** Quote first, then initiate and fund the `KEETA_SEND` instruction exactly:

   ```ts
   const card = { type: 'persistent-address-template' as const, persistentAddressTemplateId: templateId };
   const pushAsset = { from: usdToken, to: 'EUR' as const };   // the Keeta token you pay from → the card's currency
   const quote = await provider.simulateTransfer({ account, asset: pushAsset, from: { location: keeta }, to: { location: 'bank-account:card' }, value: amount, allowedRails: ['CARD_PUSH'] });
   console.log(quote.instructions.map((i) => [i.type, i.assetFee, i.totalReceiveAmount]));
   const push = await provider.initiateTransfer({
     account, asset: pushAsset, from: { location: keeta },
     to: { location: 'bank-account:card', recipient: card }, value: amount, allowedRails: ['CARD_PUSH']
   });
   const send = push.instructions.find((i) => i.type === 'KEETA_SEND');
   if (!send || send.type !== 'KEETA_SEND') throw new Error('no KEETA_SEND instruction');
   // Show the card's last four digits, the amount, fees and estimated amount received; get approval; then:
   await client.send(send.sendToAddress, BigInt(send.value), send.tokenAddress, send.external);
   ```

5. **Fund from the card.** Card funding is same-currency: a USD charge credits the Keeta USD token.

   ```ts
   const fundAsset = { from: 'USD' as const, to: usdToken };
   const pull = await provider.initiateTransfer({
     account, asset: fundAsset,
     from: { location: 'bank-account:card', source: card },
     to: { location: keeta, recipient: account.publicKeyString.get() },
     value: cents, allowedRails: ['CARD_PULL']
   });
   const charge = pull.instructions.find((i) => i.type === 'CARD_PULL');
   if (!charge || charge.type !== 'CARD_PULL') throw new Error('no CARD_PULL instruction');
   // After the user approves the charge amount and fees:
   const status = await pull.executeTransfer({ instruction: { type: 'CARD_PULL', pullFrom: charge.pullFrom } });
   console.log(status.transaction.status);
   ```

6. Poll `getTransferStatus()` until `KeetaAnchor.lib.isCompletedTransferStatus(status)` is true. Report other statuses verbatim. A pull stays `PENDING` until it is submitted, then moves to `PROCESSING`.
7. To unlink a card, call `provider.deactivatePersistentForwardingTemplate({ id, account })`. This also removes the card from the provider.

## Confirmations

- Show the card's last four digits, the amount, the currency, the fees and the estimated amount received, and get approval before every push or charge.
- Push-to-card payouts are generally irreversible once sent.
- Get approval before starting a card-linking session, and tell the user where they will enter their card.

## Failures

- **No provider with card rails:** card transfers aren't available to this account on this network. Offer a bank payout instead ([pay-out](../pay-out/SKILL.md)).
- **`KYCShareNeeded`, `AdditionalKYCNeeded` or `UserActionNeeded`:** complete onboarding first, with consent.
- **Expired session:** start a new linking session. Never reuse one.
- **Declined charge or payout:** report the provider's message. Don't retry with a different card without the user's approval.
- **Someone pastes card details into the chat:** don't repeat, store or use them. Ask the user to link the card through the secure screen instead.

## Related skills

- Bank payouts in about 50 countries: [pay-out](../pay-out/SKILL.md).
- Bank deposits and Bivo onboarding: [receive-bank-deposits](../receive-bank-deposits/SKILL.md).
- For everything else, start at the [keeta](../keeta/SKILL.md) skill.

## Sources

- [Asset Movement client: templates, initiateTransfer and executeTransfer](https://github.com/KeetaNetwork/anchor/blob/main/src/services/asset-movement/client.ts)
- [Asset movement types: card rails and pull instructions](https://github.com/KeetaNetwork/anchor/blob/main/src/services/asset-movement/common.ts)
- [Bivo licenses](https://www.bivocash.com/licenses/)
