# Share KYC attributes

Canonical page: https://docs.keeta.com/guides/share-kyc-attributes

Example: https://github.com/KeetaNetwork/keetanet-examples/blob/main/src/anchor/kyc-client-sharekyc.ts

An asset-movement anchor that still needs identity returns `Errors.KYCShareNeeded`. The documented members are `shareWithPrincipals`, `neededAttributes`, `acceptedIssuers`, and optional `tosFlow`. Sharing uses an encrypted container so only those principals can decrypt the attributes.

```ts
const sharable = await KeetaAnchor.lib.Certificates.SharableCertificateAttributes.fromCertificate(
  certificate,
  intermediateSet,
  neededAttributes
);
for (const principal of shareWithPrincipals) {
  await sharable.grantAccess(principal);
}
await provider.shareKYCAttributes({ account, attributes: sharable });
```

Further onboarding arrives as `Errors.UserActionNeeded`. The share example publishes it with:

```ts
const builder = userClient.initBuilder();
Errors.UserActionNeeded.addOperationsToBuilder(userActionNeeded.actionsNeeded, builder);
await userClient.publishBuilder(builder);
```

`Errors` is imported from `@keetanetwork/anchor/services/asset-movement/common.js`.
