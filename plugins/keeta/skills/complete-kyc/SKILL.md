---
name: complete-kyc
description: Verify a person's identity (KYC) once on Keeta and reuse it across providers. Discover the KYC provider (OneFootprint), start the hosted verification that the person completes, attach the resulting certificate to their account with consent, and share only the attributes a provider asks for, such as Bivo or Bridge.xyz (including Bridge's terms-of-service step). Use when someone must verify their identity to get a bank account, receive deposits, pay out or bridge, or when a provider raises KYCShareNeeded, even if they don't mention Keeta.
license: Apache-2.0
---

# Complete KYC through an anchor

## When to use

Use when an individual's account needs a reusable Keeta KYC certificate, or when an asset-movement provider raises `KYCShareNeeded` or `AdditionalKYCNeeded`. For a company, use [complete-kyb](../complete-kyb/SKILL.md).

- **Verify once, reuse everywhere.** The certificate is issued under Keeta's KYC root, and providers such as Bivo and Bridge.xyz accept it. One verification serves many providers, and each one receives only the attributes it asks for. Some add a step of their own, such as Bridge's terms of service.
- **Provider.** OneFootprint verifies individuals on Keeta and needs a country code. The test network also has a basic demo provider, and lists OneFootprint as `Footprint`. Select only from what discovery returns.
- **The person does the identity steps.** They complete them in the provider's hosted page. An agent never fills in identity answers or uploads documents for them.

| Provider asking | Typical attributes | Extra step |
| --- | --- | --- |
| Bivo (bank accounts, payouts, cards) | name, date of birth, address, phone, email, ID document details | Review is asynchronous, often under an hour. Then add the provider's certificate and grant `SEND_ON_BEHALF` on the USD token, with approval. |
| Bridge.xyz (USDC and EURC bank transfers, other EVM chains) | name, date of birth, address (with state in the US), tax ID (SSN in the US) | The person accepts Bridge's terms of service at `tosFlow.url` |

## SDK steps

1. Confirm the environment, the account, the country, the provider's privacy terms, and the attributes the person is willing to disclose.
2. Discover providers and start a verification:

   ```ts
   import * as KeetaAnchor from '@keetanetwork/anchor';

   const kyc = new KeetaAnchor.KYC.Client(client);
   const countries = await kyc.getSupportedCountries('individual');      // empty: no KYC provider on this network
   const providers = await kyc.createVerification({
     countryCodes: ['US'],
     account,
     entityType: 'individual',
     redirectURL: 'https://example.com/kyc-done'                         // optional
   });
   const provider = providers.find((candidate) => candidate.id === approvedProviderID);
   if (!provider) throw new Error('approved provider not offered for this request');
   const verification = await provider.startVerification();
   console.log('Open in a browser:', verification.webURL.toString());
   ```

   Treat `webURL` as a bearer link: give it only to the person being verified. Persist `verification.providerID` and `verification.id`, so you can resume later with `kyc.getVerificationStatus(providerID, { id, account, countryCodes, entityType })`.
3. Poll with backoff until there is a result:

   ```ts
   const status = await verification.getVerificationStatus();     // pass | fail | incomplete | pending | error
   const certs = await verification.getCertificates();
   if (!certs.ok) await KeetaAnchor.KeetaNet.lib.Utils.Helper.asleep(certs.retryAfter);
   ```

   - `pending` with `requiresManualVerification` means a reviewer is involved, which can take a while.
   - `fail` is final.
4. Inspect each certificate's issuer, subject, validity and intermediates. Then, **with consent**, attach it on-chain:

   ```ts
   if (certs.ok) {
     for (const { certificate, intermediates } of certs.results) {
       const cert = new KeetaAnchor.lib.Certificates.Certificate(certificate.toPEM(), { subjectKey: account });
       const bundle = intermediates ? new KeetaAnchor.KeetaNet.lib.Utils.Certificate.CertificateBundle([...intermediates]) : null;
       await client.modifyCertificate(KeetaAnchor.KeetaNet.lib.Block.AdjustMethod.ADD, cert, bundle);
     }
   }
   ```

5. Verify with `await client.getCertificates()`.
6. When an asset-movement provider raises `KYCShareNeeded`, share exactly `error.neededAttributes` with `error.shareWithPrincipals`. Use `SharableCertificateAttributes.fromCertificate(...)`, `grantAccess(principal)` and `provider.shareKYCAttributes({ account, attributes })`. The full code is in the [identity reference](../keeta/references/identity.md).
   - **Terms of service.** If the error carries `tosFlow` (Bridge.xyz does), the person opens `tosFlow.url` and accepts the terms. Then pass the signed agreement ID that page returns: `provider.shareKYCAttributes({ account, attributes, tosAgreement: { id } })`. The page hands the ID (`signedAgreementId`) to the app that embeds it. If you can't embed the page and receive the ID, stop. Never invent one.
   - **Pending review.** Sharing can return while review is still pending. After that, `AdditionalKYCNeeded` means "wait and retry" or "a person must finish `toCompleteFlow.url`".

## Confirmations

- Get consent before you open the provider URL, attach a certificate or share attributes.
- Show the provider, country, requested attributes, recipients (principals), certificate issuer and environment.
- Treat terms-of-service and additional-action URLs as separate approval steps.

## Failures

- **No provider for the country or entity type:** stop. Don't use a remembered endpoint.
- **`pending`, `incomplete` or manual review:** report the status and retry guidance. Don't claim the person is verified.
- **`fail`, `error`, or an expired or rejected certificate:** don't attach or share it.
- **`AdditionalKYCNeeded`:** the person completes `toCompleteFlow.url`, then you retry.
- **Personal data:** keep it out of logs, prompts, source files and on-chain `external` fields. Decrypted certificate attributes stay local.

## Related skills

- Inspect providers with [discover-resolve-anchors](../discover-resolve-anchors/SKILL.md).
- Verify a legal entity with [complete-kyb](../complete-kyb/SKILL.md).
- After identity steps are done, continue with [receive-bank-deposits](../receive-bank-deposits/SKILL.md), [pay-out](../pay-out/SKILL.md), [card-payments](../card-payments/SKILL.md) or [bridge-crypto](../bridge-crypto/SKILL.md).

## Sources

- [Add KYC Certificate](https://docs.keeta.com/guides/add-kyc-certificate)
- [Share KYC Attributes](https://docs.keeta.com/guides/share-kyc-attributes)
- [`KYC.Client` implementation](https://github.com/KeetaNetwork/anchor/blob/main/src/services/kyc/client.ts)
