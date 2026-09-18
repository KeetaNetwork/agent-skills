---
name: complete-kyc
description: Discover a Keeta KYC anchor, start individual identity verification, retrieve its certificate, and attach approved certificates on-chain. Use when a wallet or anchor requires KYC.
---

# Complete KYC through an anchor

## When to use

Use when an individual wallet needs a reusable Keeta KYC certificate or an asset-movement provider requests KYC attributes. The public guide demonstrates the **Footprint sandbox KYC anchor** for country `US`; it does not establish Footprint production availability. Signzy is not named by the current public SDK guide, so do not substitute Signzy endpoints.

## SDK steps

1. Confirm the environment, individual account, country codes, provider privacy terms, and attributes the user is willing to disclose.
2. Discover providers with the KYC client:

   ```ts
   const kycClient = new KeetaAnchor.KYC.Client(userClient);
   const countries = await kycClient.getSupportedCountries();
   const providers = await kycClient.createVerification({
     countryCodes: ['US'],
     account: userAccount
   });
   const provider = providers.find(candidate => candidate.id === 'Footprint');
   ```

3. If the approved provider exists, call `provider.startVerification()` and open its returned `verification.webURL` for the human to complete. Never automate identity answers or document submission.
4. Poll only with `verification.getVerificationStatus()` or retrieve with `verification.getCertificates()`. Respect `retryAfter` when the result is not ready.
5. Inspect the certificate issuer, subject, validity, intermediates, and requested on-chain disclosure. With explicit approval, follow the documented certificate wrapping flow and attach using:

   ```ts
   await userClient.modifyCertificate(
     KeetaAnchor.KeetaNet.lib.Block.AdjustMethod.ADD,
     certificate,
     intermediates
   );
   ```

6. Verify with `userClient.client.getAllCertificates(userAccount)`.
7. If an asset-movement provider raises a KYC-share-needed error, select only requested attributes, create `SharableCertificateAttributes.fromCertificate(...)`, grant access only to `shareWithPrincipals`, and call `provider.shareKYCAttributes(...)` after confirmation.

## Confirmations

- Get human consent before opening the provider URL, submitting identity data, attaching a certificate, or sharing attributes.
- Display provider, country, requested attributes, recipients/principals, certificate issuer, and environment.
- Treat terms-of-service and additional-user-action URLs as separate approval steps.

## Failures

- If no provider supports the country, stop.
- If Footprint is not returned by Resolver discovery, do not use a remembered endpoint.
- On pending/manual review, report status and retry guidance; do not claim verification.
- On rejected or expired certificates, do not attach or share them.
- Keep PII out of logs, prompts, source files, and on-chain external identifiers.

## Related skills

- Use [discover-resolve-anchors](../discover-resolve-anchors/SKILL.md) to inspect providers.
- Use [complete-kyb](../complete-kyb/SKILL.md) for a legal entity.
- Continue with [pay-out](../pay-out/SKILL.md) after the required identity actions are complete.

## Sources

- [Add KYC Certificate](https://docs.keeta.com/guides/add-kyc-certificate)
- [Share KYC Attributes](https://docs.keeta.com/guides/share-kyc-attributes)
- [`KYC.Client` implementation](https://github.com/KeetaNetwork/anchor/blob/main/src/services/kyc/client.ts)
