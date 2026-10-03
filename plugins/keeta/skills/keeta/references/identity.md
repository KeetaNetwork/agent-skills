# Identity: certificates, selective disclosure, encryption and signed requests

Every code block here typechecks against `@keetanetwork/keetanet-client` 0.18.7 and `@keetanetwork/anchor` 0.0.100.

## Certificates on accounts

Keeta accounts can carry X.509 certificates, for example a KYC certificate (a person) or a KYB certificate (a business) issued by an identity anchor.

- A certificate's subject key must match the account that carries it.
- Sensitive attributes are encrypted to the subject. Only commitments to them are visible on-chain.
- The network doesn't decide whom to trust. Each anchor or app chooses which issuers it accepts.

```ts
const mine = await client.getCertificates();                      // [{ certificate, intermediates }]
const theirs = await client.client.getAllCertificates(otherAccount);
for (const { certificate, intermediates } of mine) {
  console.log(certificate.subject, certificate.issuer, certificate.notAfter.toISOString(),
    certificate.checkValid(), certificate.hash().toString(), intermediates?.getCertificates().length ?? 0);
}

const { Certificate, CertificateBundle } = KeetaNet.lib.Utils.Certificate;
const cert = new Certificate(pem);
const bundle = intermediatePems.length ? new CertificateBundle(intermediatePems) : null;
await client.modifyCertificate(KeetaNet.lib.Block.AdjustMethod.ADD, cert, bundle);   // attach (with consent)
await client.modifyCertificate(KeetaNet.lib.Block.AdjustMethod.SUBTRACT, cert.hash()); // remove by hash
```

- To get a certificate, use the [complete-kyc](../../complete-kyc/SKILL.md) skill for a person or [complete-kyb](../../complete-kyb/SKILL.md) for a business.
- On the test network, KYC certificates chain to "Keeta Test Network KYC Root CA".
- Check the issuer, subject, validity period and intermediates before you attach a certificate or rely on one.

## Share only what is asked (selective disclosure)

When an anchor raises `KYCShareNeeded`, it lists the attributes it needs (`neededAttributes`) and who should receive them (`shareWithPrincipals`). Share exactly those, after the user consents:

```ts
import * as KeetaAnchor from '@keetanetwork/anchor';

const [record] = await client.client.getAllCertificates(account);
if (!record) throw new Error('no on-chain KYC certificate');
const cert = new KeetaAnchor.lib.Certificates.Certificate(record.certificate.toPEM(), { subjectKey: account });
const intermediates = record.intermediates ? new Set(record.intermediates.getCertificates()) : undefined;
const sharable = await KeetaAnchor.lib.Certificates.SharableCertificateAttributes.fromCertificate(cert, intermediates, neededAttributes);
for (const principal of shareWithPrincipals) await sharable.grantAccess(principal);
await provider.shareKYCAttributes({ account, attributes: sharable });
```

Opening a certificate with `subjectKey: account` decrypts its sensitive attributes locally. Keep the decrypted values out of logs, prompts and on-chain fields.

## Certificate-gated anchors

Username, storage and notification anchors can require a certificate from accepted issuers. They then fail with `KeetaAnchorCertificateRequiredError`, which you can import from `@keetanetwork/anchor/lib/error.js`:

- **`kind: 'missing'` (HTTP 401):** the signer has no published certificate.
- **`kind: 'untrusted'` (HTTP 403):** its certificate chain isn't trusted.
- **`acceptedIssuers`:** lists acceptable issuer names. The outer list means "any of"; each inner list means "all of".

Get a certificate from an accepted issuer and attach it, then retry.

## Encrypt data to accounts

`EncryptedContainer` encrypts a payload to one or more Keeta accounts, and can optionally sign it:

```ts
const { EncryptedContainer } = KeetaAnchor.lib;
const box = EncryptedContainer.fromPlaintext(JSON.stringify({ invoice: 1001 }), [recipient], { signer: sender, locked: false });
const wire: ArrayBuffer = await box.getEncodedBuffer();                 // send or store this
const opened = EncryptedContainer.fromEncodedBuffer(wire, [recipient]); // needs the recipient's private key
const text = Buffer.from(await opened.getPlaintext()).toString('utf-8');
const authentic = opened.isSigned ? await opened.verifySignature() : false;
```

The storage anchor uses these containers. Accounts backed by a Ledger hardware wallet cannot decrypt them.

## Signed requests

Anchors authenticate requests with account signatures. Use the same scheme for your own services:

```ts
import { SignData, VerifySignedData } from '@keetanetwork/anchor/lib/utils/signing.js';

const signable = ['my-service', 'GET_INVOICE', invoiceId, account];         // strings, numbers, bigints, accounts
const signed = await SignData(account, signable);                          // { nonce, timestamp, signature }
const ok = await VerifySignedData(account, signable, signed, { maxSkewMs: 300_000 });
```

- Verification allows about five minutes of clock skew, so keep clocks synced.
- Store nonces you have already seen, to reject replays.
