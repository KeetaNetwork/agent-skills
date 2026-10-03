# Accounts and keys

Every code block here typechecks against `@keetanetwork/keetanet-client` 0.18.7. In this file, `Account` means `KeetaNet.lib.Account`.

## Account kinds

| Kind | Created by | Signs? | Address prefix | Check |
| --- | --- | --- | --- | --- |
| Key pair, secp256k1 (default) | `Account.fromSeed(seed, index)` | yes | `keeta_aa…`–`keeta_ad…` | `isAccount()` |
| Key pair, ed25519 | `fromSeed(seed, index, Account.AccountKeyAlgorithm.ED25519)` | yes | `keeta_ae…`–`keeta_ah…` | `isAccount()` |
| Key pair, secp256r1 | `fromSeed(seed, index, Account.AccountKeyAlgorithm.ECDSA_SECP256R1)` | yes | `keeta_ay…`, `keeta_az…`, `keeta_a2…`, `keeta_a3…` | `isAccount()` |
| Token | `generateIdentifier(TOKEN)` | no | `keeta_am…`–`keeta_ap…` | `isToken()` |
| Storage account | `generateIdentifier(STORAGE)` | no | — | `isStorage()` |
| Multisig | `generateIdentifier({ type: MULTISIG, signers, quorum })` | through its signers | — | `isMultisig()` |
| Network account | derived from the network ID | no | — | — |

Generated accounts (tokens, storage, multisig) have no private key. A key-pair account acts on them through permissions. Their creator becomes `OWNER`.

## Seeds, indexes and passphrases

```ts
import * as KeetaNet from '@keetanetwork/keetanet-client';
const { Account } = KeetaNet.lib;

const seed = Account.generateRandomSeed({ asString: true });   // 64 hex characters; store it, never print it
const first = Account.fromSeed(seed, 0);                        // index is a uint32
const second = Account.fromSeed(seed, 1);                       // independent account from the same seed
const ed = Account.fromSeed(seed, 0, Account.AccountKeyAlgorithm.ED25519); // different address

// Recovery phrase → seed (PBKDF2). Rejects input shorter than 60 bytes after normalization.
const phraseSeed = await Account.seedFromPassphrase(process.env.KEETA_PHRASE!, { asString: true });
const restored = Account.fromSeed(phraseSeed, 0);
```

- The same seed, index and algorithm always give the same address. Addresses do not depend on the network: one key has the same address on test and main, with separate balances on each.
- Keeta Personal (the official wallet) derives accounts as `seedFromPassphrase(phrase)` followed by `fromSeed(seed, 0)`. Do this only when the user explicitly hands an agent their recovery phrase. Otherwise create a separate agent account and fund it with only what the task needs.
- Use separate indexes or seeds to separate duties: one account per agent, per customer or per purpose. Accounts are cheap, and isolation limits the damage from a leak.

## Parse and check addresses

```ts
const recipient = Account.fromPublicKeyString(address);        // throws on a malformed or tampered address
const token = Account.fromPublicKeyString(tokenAddress)
  .assertKeyType(Account.AccountKeyAlgorithm.TOKEN);           // throws unless it is a token address
const same = recipient.comparePublicKey(first);
const kind = recipient.isToken() ? 'token'
  : recipient.isStorage() ? 'storage'
  : recipient.isMultisig() ? 'multisig'
  : recipient.isAccount() ? 'key pair' : 'other';
const text: string = first.publicKeyString.get();              // the shareable keeta_… address
```

Validate the recipient **and** the token before every send. A token address in the recipient field, or a key-pair address in the token field, is a common agent error.

## Sign, verify and encrypt

```ts
const data = new TextEncoder().encode('hello').buffer;
const signature = await first.sign(data);
const valid = first.verify(data, signature);
const ciphertext = await recipient.encrypt(data);              // ECIES: only the recipient's key decrypts
```

To share data with several accounts, or to sign it as well, use `EncryptedContainer` ([identity.md](identity.md)). For authenticated HTTP requests to anchors, use `SignData` and `VerifySignedData` (also in [identity.md](identity.md)).

## Clients

```ts
const client = KeetaNet.UserClient.fromNetwork('test', first);        // signer
const reader = KeetaNet.UserClient.fromNetwork('test', null);         // read-only, no signer
const theirKTA = await reader.balance(reader.baseToken, { account: Account.toAccount(address) });
await reader.destroy();
```

- `fromNetwork` accepts `'test'` and `'main'`. The SDK also knows `'staging'` and `'dev'`, which are internal environments; don't use them.
- Call `destroy()` when you are done. With TypeScript 5.2+ and `esnext.disposable`, you can use `await using`.
- `client.network` is the network ID (`bigint`), `client.baseToken` is KTA, and `client.networkAddress` is the network account (the default anchor-metadata root).

## Key storage

- Keep seeds in a secret manager, KMS or HSM, and pass them to the process at run time. Never put seeds in prompts, source files, logs, browser bundles or on-chain fields.
- Hand the model a narrow signing interface, such as "send up to N of token T to approved recipients". Never give it raw key material.
- If a seed may have leaked, move the funds to a new account immediately. For generated accounts it controlled, grant permissions to a new key and remove the old one, ideally in one vote staple. A blocklist cannot revoke a key.
