# Add KYC certificate

Canonical page: https://docs.keeta.com/guides/add-kyc-certificate

Example: https://github.com/KeetaNetwork/keetanet-examples/blob/main/src/anchor/kyc-client.ts

Status strings: https://github.com/KeetaNetwork/anchor/blob/main/src/services/kyc/status.ts

The guide discovers KYC anchors through the Resolver, starts verification with the provider whose id is `Footprint`, and attaches the returned certificate.

```ts
const kycClient = new KeetaAnchor.KYC.Client(userClient);
const providers = await kycClient.createVerification({
  countryCodes: ['US'],
  account: userAccount
});
const provider = providers.find((candidate) => candidate.id === 'Footprint');
const verification = await provider.startVerification();
const certificates = await verification.getCertificates();
```

`getCertificates()` returns `{ ok: true, results }` or `{ ok: false, retryAfter, reason }`. The example waits on `retryAfter` while `ok` is false, then re-wraps each certificate with `subjectKey` set to the user account and calls `userClient.modifyCertificate(AdjustMethod.ADD, cert, intermediates)`. It checks `cert.checkValid()` and reads the on-chain set with `userClient.client.getAllCertificates(userAccount)`.

`verification.getVerificationStatus()` returns `status` from `pass`, `fail`, `incomplete`, `pending`, and `error`, plus optional `requiresManualVerification`.
