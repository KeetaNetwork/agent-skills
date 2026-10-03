# Anchors: discovery and every service client

Anchors are off-chain services that connect Keeta to the outside world. They publish signed metadata that clients discover through the **resolver**, which is rooted at the network account by default. Every code block here typechecks against `@keetanetwork/anchor` 0.0.100 (`import * as KeetaAnchor from '@keetanetwork/anchor'`). `KeetaAnchor.KeetaNet` re-exports the client SDK.

| Service | Client | What it does |
| --- | --- | --- |
| Asset movement | `KeetaAnchor.AssetMovement.Client` | Moves value between Keeta and external rails: bank deposits and payouts, EVM and other chains |
| FX | `KeetaAnchor.FX.Client` | Quotes and exchanges between Keeta tokens |
| KYC / KYB | `KeetaAnchor.KYC.Client` | Verifies people (`entityType: 'individual'`) and businesses (`'business'`) and issues certificates |
| Username | `KeetaAnchor.Username.Client` | Maps `name$provider` to an account and back |
| Storage | `@keetanetwork/anchor/services/storage/client.js` (default export) | Encrypted object storage tied to an account |
| Notification | `KeetaAnchor.Notification.Client` | Push notifications (FCM) when funds arrive |

**Availability is runtime data.** Which providers, corridors, countries and pairs exist on `test` or `main` changes over time. Always discover at run time. A `null` or empty result means stop: do not fall back to a remembered URL.

## Discover

```ts
const resolver = new KeetaAnchor.lib.Resolver({ root: client.networkAddress, client, trustedCAs: [] });
const tokens = await resolver.listTokens();                 // [{ token: 'keeta_…', currency: 'USD' | '$KTA' | … }]
const usd = await resolver.lookupToken('USD');              // { token, currency } | null
const kycCountries = await resolver.listSupportedKYCCountries('individual');
const fx = await resolver.lookup('fx', { inputCurrencyCode: 'USD', outputCurrencyCode: '$KTA' });
const plain = fx ? await KeetaAnchor.lib.Resolver.Metadata.fullyResolveValuizable(fx) : null; // inspect as JSON
```

- The service clients build this resolver for you (`new KeetaAnchor.FX.Client(client)`).
- Prefer their typed methods (`getQuotes`, `getProvidersForTransfer`, `createVerification`…) over raw `lookup`.
- <https://static.network.keeta.com/metadata/services> mirrors the metadata over HTTP. Treat it as a cache: if it disagrees with the resolver, trust the resolver and report the difference.

## Rules every anchor shares

- **Signed requests.** Requests are signed by the user's account, with about five minutes of allowed clock skew. Keep the system clock accurate.
- **Providers.** Each provider has a `providerID`. Show it, the operator, fees, limits, legal disclaimers (`provider.getLegalDisclaimers()` on asset-movement providers) and terms to the user before choosing one. Never choose by array order alone.
- **Typed errors.** Import them from `@keetanetwork/anchor/services/asset-movement/common.js` (`Errors`) and `@keetanetwork/anchor/lib/error.js`:
  - `KYCShareNeeded`: share `neededAttributes` with `shareWithPrincipals` ([identity.md](identity.md)).
  - `AdditionalKYCNeeded`: a person must finish the provider's flow at `toCompleteFlow.url`.
  - `UserActionNeeded`: on-chain setup. Run `Errors.UserActionNeeded.addOperationsToBuilder(error.actionsNeeded, builder)`, review the operations, then publish.
  - `KeetaAnchorUserValidationError`: invalid fields (`error.fields`).
  - `KeetaAnchorCertificateRequiredError`: the anchor requires a certificate from an accepted issuer.
- **Transfer status.** Only `COMPLETE` is standardized (`KeetaAnchor.lib.isCompletedTransferStatus`). Treat every other status string as provider-specific.

## Asset movement

**Locations:**
- the Keeta chain: `{ type: 'chain', chain: { type: 'keeta', networkId: client.network } }` or `` `chain:keeta:${client.network}` ``
- an EVM chain: `'chain:evm:421614'`
- a US bank account: `{ type: 'bank-account', account: { type: 'us' } }` or `'bank-account:us'`

**Assets:** a Keeta token, a currency code such as `'USD'`, or an EVM contract written `'evm:0x…'`. Pairs are written `{ from, to }`.

**Rails:** the protocol can describe ACH, WIRE, SEPA, PIX, SPEI, FPS, UPI, RTP and many national push rails, ACH debit and card pulls, plus KEETA_SEND, EVM_SEND, EVM_CALL, SOLANA_SEND, BITCOIN_SEND and TRON_SEND. Only the rails that discovered providers advertise are usable.

| Flow | Use |
| --- | --- |
| Keeta → bank payout | the [pay-out](../../pay-out/SKILL.md) skill (`initiateTransfer`, then fund the `KEETA_SEND` instruction exactly) |
| EVM USDC ↔ Keeta | the [bridge-usdc](../../bridge-usdc/SKILL.md) skill (persistent forwarding addresses, outbound transfers) |
| Bank → Keeta deposit | below |
| Preview fees and instructions | `provider.simulateTransfer(...)`, then `simulated.createTransfer({ to: { recipient } })` |

**Bank deposit (on-ramp).** Ask a provider for persistent deposit instructions. The account normally needs KYC first, and the provider must have your attributes:

```ts
const am = new KeetaAnchor.AssetMovement.Client(client);
const usBank = { type: 'bank-account', account: { type: 'us' } } as const;
const keeta = { type: 'chain', chain: { type: 'keeta', networkId: client.network } } as const;
const asset = { from: 'USD' as const, to: keetaUSD };

const providers = await am.getProvidersForTransfer({ asset, from: usBank, to: keeta });
const provider = providers?.[0];        // choose deliberately after showing the options
if (provider && await provider.isOperationSupported('createPersistentForwarding')) {
  const instructions = await provider.createPersistentForwardingAddress({
    account, asset, sourceLocation: usBank, destinationLocation: keeta,
    destinationAddress: account.publicKeyString.get()
  });
  // Show the returned bank details to the user. The deposit arrives as the Keeta USD token.
}
```

- Watch for the credit with `client.on('change', …)` or `balance(keetaUSD)`, or call `provider.listTransactions({ account, persistentAddresses })`.
- Handle `KYCShareNeeded` and `UserActionNeeded` as described above.
- Fiat token amounts are in the smallest currency unit: `200n` USD is $2.00.

## FX

The [convert-via-anchors](../../convert-via-anchors/SKILL.md) skill has the full workflow:

- **Quotes and estimates.** `getQuotes({ from, to, amount, affinity })` returns firm, signed quotes. They have no expiry field, but providers reject one about five minutes after signing, so fetch a new quote rather than reusing an old one. `getEstimates` is cheaper and indicative; `estimate.getQuote(maxDeviation)` turns an estimate into a quote.
- **Prices.** `getPrices({ assets, priceIn })` returns indicative prices.
- **Exchange.** `quote.createExchange()` signs a swap block (send `from`, receive `to`, and send the fee), and the provider publishes it. Poll `getExchangeStatus()` until the status is `completed` or `failed`.

## Several hops (anchor chaining)

Use `AnchorChaining` to convert across providers, for example USD → EUR, or USD → EUR → a bank account:

```ts
import { AnchorChaining } from '@keetanetwork/anchor/lib/chaining.js';

const chaining = new AnchorChaining({ client });
const keetaChain = `chain:keeta:${client.network}` as const;
const request = {
  source: { asset: keetaUSD, location: keetaChain, value: 200n, rail: 'KEETA_SEND' as const },
  destination: { asset: keetaEUR, location: keetaChain, recipient: account.publicKeyString.get(), rail: 'KEETA_SEND' as const }
};
const plans = await chaining.getPlans(request);
const plan = plans?.[0];
if (plan) {
  console.log(plan.path.length, plan.plan.steps.map((step) => step.type));  // show every step, fee and provider first
  const result = await plan.execute();                                    // only after explicit approval
}
```

**A plan is not atomic.** Each step settles on its own. If a step fails, the error reports `completedSteps` and `failedAtStepIndex`. **Never call `execute()` again.** Reconcile balances, then plan only the remaining leg.

## KYC and KYB

Use the [complete-kyc](../../complete-kyc/SKILL.md) skill for a person and [complete-kyb](../../complete-kyb/SKILL.md) for a business. Both run through `KYC.Client.createVerification({ countryCodes, account, entityType })`, then `startVerification()`, which returns a `webURL` that a **human** completes. Poll `getVerificationStatus()`, then call `getCertificates()` and attach the result with `modifyCertificate`. Business providers appear only when `entityType: 'business'` is passed.

## Usernames

```ts
const usernames = new KeetaAnchor.Username.Client(client);
const hit = await usernames.resolve('alice$exampleprovider');     // { account, username, providerID, … } | null
const everywhere = await usernames.resolveMulti('alice');          // { [providerID]: result | null } | null
const mine = await usernames.resolveMulti(client.account);         // account → usernames
const claimed = await usernames.claimUsername('alice$exampleprovider');
```

- Always use the full `name$providerID` form for payments, and confirm the resolved address with the user before you send to it.
- Each provider publishes a pattern (`provider.usernamePattern`, `provider.isUsernameValid(name)`). Lowercase the input yourself.
- To list providers, call `usernames.resolver.lookup('username', {})`.
- A provider may require a certificate before you can claim a name, and may allow only one name per account.

## Encrypted storage

```ts
import KeetaStorageAnchorClient from '@keetanetwork/anchor/services/storage/client.js';

const storage = new KeetaStorageAnchorClient(client);   // not exported from the package root
const provider = (await storage.getProviders())?.[0];
if (provider) {
  const base = `/user/${account.publicKeyString.get()}/`;
  const saved = await provider.put({ path: `${base}notes/hello.txt`, data: Buffer.from('hello'), mimeType: 'text/plain', tags: ['notes'], visibility: 'private' });
  const object = await provider.get({ path: saved.path });          // decrypted locally
  const found = await provider.search({ criteria: { pathPrefix: `${base}notes/` }, pagination: { limit: 20 } });
  const quota = await provider.getQuotaStatus();
}
```

- Objects are encrypted on the client, but **paths, tags, sizes and visibility are plaintext**.
- `visibility: 'public'` lets the anchor decrypt the object and serve it from a signed URL (`session.getPublicUrl(path, { ttl })`).
- Quotas come from provider metadata. Handle quota-exceeded errors.

## Notifications

`KeetaAnchor.Notification.Client` registers a Firebase Cloud Messaging target (`registerTarget({ channel: { type: 'FCM', appId, fcmToken } })`) and a `RECEIVE_FUNDS` subscription (`createSubscription`). It suits mobile apps. Headless agents should use `client.on('change')` instead ([transactions.md](transactions.md)).

## Build your own anchor

`@keetanetwork/anchor` also contains the server side, for example `KeetaNetFXAnchorHTTPServer` from `@keetanetwork/anchor/services/fx/server.js`. The docs pages "Anchor Server" and "Creating an Anchor" explain the business model.

Discovery depends on where the metadata lives:

- **Your own account.** Publish service metadata with `client.setInfo({ …, metadata: KeetaAnchor.lib.Resolver.Metadata.formatMetadata({ version: 1, currencyMap, services }) })`. Clients can then use your account as `root`.
- **The default resolver.** Being found through the network's default resolver requires a listing in the network metadata, which Keeta curates.

<https://github.com/KeetaNetwork/demo-fx-anchor> is a public demo FX anchor.
