---
name: complete-kyb
description: Verify a business (KYB) on Keeta through Keeta's KYB provider, which covers companies incorporated in 33 countries. Discover business-capable providers with entityType 'business', start the hosted verification for an authorized person, poll status (manual review can take days), attach the business certificate, and share organization attributes with the providers that ask for them. Use when a company, not an individual, needs a verified identity for payments, payouts or stablecoin settlement, even if the user doesn't mention Keeta.
license: Apache-2.0
---

# Complete business verification (KYB)

## When to use

Use when the account owner or the payout beneficiary is a legal entity.

KYB runs through the same `KYC.Client` as individual KYC, with `entityType: 'business'`. This needs `@keetanetwork/anchor` 0.0.99 or later. Business-capable providers are returned **only** when you pass `entityType: 'business'`; without it, discovery filters for individual providers.

The Swift, Rust and C# SDKs don't support `entityType` yet.

- **Provider.** Keeta's KYB provider verifies companies incorporated in exactly one of 33 countries: AE, AT, AU, BE, BR, CA, CH, CN, DE, DK, ES, FI, FR, GB, HK, IE, IN, IT, JP, MX, MY, NL, NO, NZ, PL, PT, SE, SG, TH, TW, US, VN and ZA. It runs on the test network now, and on main where listed: `getSupportedCountries('business')` returns an empty list where no KYB provider is listed.
- **Who needs it.** Providers that serve businesses ask for organization attributes, such as `organizationName`, `tradeName`, `legalForm`, `email`, `incorporation`, `website` and `entityType`. Bivo and Bridge.xyz bank features serve individuals; for a business, use the providers discovery returns after KYB.

## SDK steps

1. Confirm that the verification is for an entity, and who is authorized to act for it. Collect only the routing facts discovery needs:
   - the environment
   - the country of incorporation (one ISO country code)
   - the intended anchor operation
   - any preferred provider
2. Discover business providers:

   ```ts
   import * as KeetaAnchor from '@keetanetwork/anchor';

   const kyc = new KeetaAnchor.KYC.Client(client);
   const countries = await kyc.getSupportedCountries('business');
   if (countries.length === 0) throw new Error('no KYB provider on this network');

   const providers = await kyc.createVerification({ countryCodes: ['US'], account, entityType: 'business' });
   for (const provider of providers) {
     console.log(provider.id, (await provider.countryCodes())?.map((country) => country.code));
   }
   ```

3. Present every provider with its terms. After the user approves one, call `provider.startVerification()` and give `verification.webURL` to the **authorized person**.
   - That person enters the business data, beneficial owners and documents in the provider's hosted page. The agent never does this for them.
   - Treat the link as a bearer secret.
   - Persist `verification.providerID`, `verification.id`, the country and the entity type, so you can resume later with `kyc.getVerificationStatus(providerID, { id, account, countryCodes, entityType: 'business' })`.
4. Poll `verification.getVerificationStatus()` with a long backoff:
   - Manual review (`requiresManualVerification`) can take days.
   - `fail` is final, so don't loop on it.
5. When the status is `pass`, call `verification.getCertificates()` and honor `retryAfter`. Inspect the issuer and validity, then attach the certificate with consent, using the same `modifyCertificate(ADD, cert, bundle)` call as [complete-kyc](../complete-kyc/SKILL.md).
6. When an asset-movement provider raises `KYCShareNeeded` for organization attributes, share exactly the requested ones. Examples include `organizationName`, `tradeName`, `legalForm`, `incorporation`, `documentBusinessRegistration`, `address` and `website`. The code is in the [identity reference](../keeta/references/identity.md).
7. Confirm readiness with the anchor's `getAccountStatus(...)` before any payout.

## Confirmations

- Require approval before any business records, beneficial-owner data, tax identifiers or banking details are submitted, even through the provider's own page.
- Show the provider, endpoint origin, environment, country, requested documents and fields, data recipients and retention terms.
- KYB doesn't authorize money movement. Require a separate transaction confirmation for every payout.

## Failures

- **`getSupportedCountries('business')` is empty, or no provider covers the country:** stop and report it. Don't call guessed `/kyb` endpoints, and don't push business data into individual KYC fields.
- **Pending or manual review:** report the status. The entity isn't verified yet.
- **`fail` or an expired certificate:** don't attach, share or rely on it.
- **Documents and identifiers:** never put KYB documents or sensitive identifiers on-chain or in an `external` field.

## Related skills

- Use [complete-kyc](../complete-kyc/SKILL.md) for natural persons, such as beneficial owners or representatives, when a provider asks for them.
- Re-check capabilities at run time with [discover-resolve-anchors](../discover-resolve-anchors/SKILL.md).
- Use [pay-out](../pay-out/SKILL.md) only after the provider confirms readiness.

## Sources

- [`KYC.Client` implementation (entityType)](https://github.com/KeetaNetwork/anchor/blob/main/src/services/kyc/client.ts)
- [Resolver KYC metadata (`entityTypes`)](https://github.com/KeetaNetwork/anchor/blob/main/src/lib/resolver.ts)
- [Add KYC Certificate](https://docs.keeta.com/guides/add-kyc-certificate)
