---
name: complete-kyc
description: Verify an individual through a Keeta KYC anchor. Discover a provider, start the hosted verification for a human to complete, poll status, retrieve the certificate, attach it on-chain with consent, and share only requested attributes with anchors. Use when a wallet or an asset-movement provider requires KYC.
---

# Complete KYC through an anchor

## When to use

Use when an individual's account needs a reusable Keeta KYC certificate, or when an asset-movement provider raises `KYCShareNeeded` or `AdditionalKYCNeeded`. For a company, use [complete-kyb](../complete-kyb/SKILL.md).

Providers are runtime metadata. The docs show a test-network sandbox with a Footprint provider and a basic demo provider, but select only from what discovery returns. The person completes identity steps in the provider's hosted page. An agent never fills in identity answers or uploads documents for them.

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
6. When an asset-movement provider raises `KYCShareNeeded`, share exactly `error.neededAttributes` with `error.shareWithPrincipals`. Use `SharableCertificateAttributes.fromCertificate(...)`, `grantAccess(principal)` and `provider.shareKYCAttributes({ account, attributes })`. Full code is in the [identity reference](../keeta/references/identity.md).

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
- After identity steps are done, continue with [pay-out](../pay-out/SKILL.md) or [bridge-usdc](../bridge-usdc/SKILL.md).

## Sources

- [Add KYC Certificate](https://docs.keeta.com/guides/add-kyc-certificate)
- [Share KYC Attributes](https://docs.keeta.com/guides/share-kyc-attributes)
- [`KYC.Client` implementation](https://github.com/KeetaNetwork/anchor/blob/main/src/services/kyc/client.ts)
