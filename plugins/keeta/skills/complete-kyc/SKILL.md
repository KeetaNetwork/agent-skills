---
name: complete-kyc
description: Discover a Keeta KYC anchor, start individual verification, poll certificate status, attach a passing certificate, and share only consented attributes. Use when a wallet or anchor requires individual KYC.
---

# Complete KYC through an anchor

## When to use

Use this skill when an individual wallet needs a reusable Keeta KYC certificate, or when pay-in or pay-out returns `KYCShareNeeded` or `UserActionNeeded`. The public guide demonstrates the Footprint sandbox KYC anchor for country `US`. That guide does not establish a production Footprint deployment. Stop when discovery does not return a provider whose id is `Footprint`, and stop when the public KYC client cannot perform `createVerification`, `getCertificates`, and `getVerificationStatus`.

Business verification is [complete-kyb](../complete-kyb/SKILL.md). This skill is for a natural person.

## SDK steps

1. Confirm the environment, the individual account, the country codes, the provider privacy terms, and the attribute names the human is willing to disclose.
2. Discover providers with the KYC client. An empty country list or an empty provider list stops the flow.

   ```ts
   const kycClient = new KeetaAnchor.KYC.Client(userClient);
   const countries = await kycClient.getSupportedCountries();
   const providers = await kycClient.createVerification({
     countryCodes: ['US'],
     account: userAccount
   });
   const provider = providers.find((candidate) => candidate.id === 'Footprint');
   ```

3. Stop when `countries` is empty, when `createVerification` throws `No KYC endpoints found for the given criteria` or `No valid KYC verification endpoints found`, or when no returned provider has id `Footprint`. Report the provider ids that did come back. A remembered Footprint URL is not a substitute for Resolver discovery.
4. Call `provider.startVerification()` and give the human `verification.webURL`. Also show `verification.id`, `verification.providerID`, and `verification.expectedCost` when those fields are present. The human completes the provider page. Leave identity answers and document uploads to that page.
5. Read the certificate lifecycle with `verification.getVerificationStatus()` before attaching anything. The KYC client returns `status` and an optional `requiresManualVerification` flag. Documented status strings are `pass`, `fail`, `incomplete`, `pending`, and `error`.

   - `pending`, or `requiresManualVerification: true`: report the status and wait. The certificate is not ready.
   - `incomplete`: send the human back to the same `webURL`. Verification is unfinished.
   - `fail`: treat this as the documented rejection outcome. Do not attach or share a certificate.
   - `error`: stop and report the status. Do not retry with a different issuer.
   - `pass`: continue to `verification.getCertificates()`.

6. `getCertificates()` returns either `{ ok: true, results }` or `{ ok: false, retryAfter, reason }`. The client uses the not-ready shape when the certificate is not issued yet, including HTTP 404 with reason `Certificate not found`. The public example waits with `KeetaAnchor.KeetaNet.lib.Utils.Helper.asleep(results.retryAfter)` and polls again. A not-ready response is not a rejection.
7. For each result, re-wrap the certificate with the user as `subjectKey` so attributes can be decrypted locally, build the intermediate bundle, and read `cert.checkValid()` as the example does. Attach only a certificate that passes `checkValid()`, and only after the human approves the issuer, subject, validity, and intermediates:

   ```ts
   await userClient.modifyCertificate(
     KeetaAnchor.KeetaNet.lib.Block.AdjustMethod.ADD,
     certificate,
     intermediates
   );
   ```

8. Verify with `userClient.client.getAllCertificates(userAccount)`.
9. When an asset-movement call raises `Errors.KYCShareNeeded`, share attributes only after a separate consent. The error members documented on the share guide are `shareWithPrincipals`, `neededAttributes`, `acceptedIssuers`, and optional `tosFlow`. Show attribute names, principal addresses, accepted issuers, and the terms URL. Open `tosFlow` only with consent. Choose an on-chain certificate whose issuer matches `acceptedIssuers` when that list is present, and stop when none match. Build a container that contains only `neededAttributes`, grant access only to `shareWithPrincipals`, and then call the provider:

   ```ts
   const sharable = await KeetaAnchor.lib.Certificates.SharableCertificateAttributes.fromCertificate(
     certificate,
     intermediateSet,
     neededAttributes
   );
   for (const principal of shareWithPrincipals) {
     await sharable.grantAccess(principal);
   }
   await provider.shareKYCAttributes({
     account,
     attributes: sharable
   });
   ```

10. When the error is `Errors.UserActionNeeded`, show `actionsNeeded` and wait for approval. The share example publishes those operations with the user client builder. `Errors` is the export from `@keetanetwork/anchor/services/asset-movement/common.js`.

    ```ts
    const builder = userClient.initBuilder();
    Errors.UserActionNeeded.addOperationsToBuilder(actionsNeeded, builder);
    await userClient.publishBuilder(builder);
    ```

    Return to pay-in or pay-out only after the share or the user-action block succeeds.

## Confirmations

- Get human consent before opening the provider URL, submitting identity data, attaching a certificate, or sharing attributes.
- Display the provider id, country, requested attribute names, principal addresses, accepted issuers, certificate issuer, status string, and environment.
- Treat a terms URL and a user-action block as their own approval steps.
- Say plainly when status is `pending`, `incomplete`, `fail`, or `error`, and say that no certificate was attached.

## Failures

- Stop when no provider supports the country, when Footprint is absent from the Resolver result, or when the KYC service is missing `createVerification`, `getCertificates`, or `getVerificationStatus`.
- On `pending` or `requiresManualVerification`, report the status and the retry guidance. Verification is not complete.
- On `fail`, `error`, an invalid certificate, or an expired certificate, do not attach or share it.
- On `{ ok: false }` from `getCertificates()`, wait and poll. That response means the certificate is not ready.
- Keep identity values out of logs, prompts, source files, and on-chain external identifiers. Attribute names may be shown. Decrypted values such as a legal name stay on the provider page and inside the encrypted container.
- Stop when a flow needs a business KYB contract. Do not place organization fields into individual KYC.

## Related skills

- Use [discover-resolve-anchors](../discover-resolve-anchors/SKILL.md) to inspect providers.
- Use [complete-kyb](../complete-kyb/SKILL.md) for a legal entity.
- Return to [pay-in](../pay-in/SKILL.md) after share or user-action consent so deposit instructions can be requested again.
- Continue with [pay-out](../pay-out/SKILL.md) when the human is sending Keeta USD to a bank.

## Sources

- [Add KYC Certificate](https://docs.keeta.com/guides/add-kyc-certificate)
- [Share KYC Attributes](https://docs.keeta.com/guides/share-kyc-attributes)
- [KYC client example](https://github.com/KeetaNetwork/keetanet-examples/blob/main/src/anchor/kyc-client.ts)
- [Share KYC example](https://github.com/KeetaNetwork/keetanet-examples/blob/main/src/anchor/kyc-client-sharekyc.ts)
- [`KYC.Client` implementation](https://github.com/KeetaNetwork/anchor/blob/main/src/services/kyc/client.ts)
- [KYC verification status strings](https://github.com/KeetaNetwork/anchor/blob/main/src/services/kyc/status.ts)
