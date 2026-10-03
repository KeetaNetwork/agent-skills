---
name: keeta
description: Build on and transact with Keeta Network from code or as an autonomous agent. Covers accounts and keys, multi-asset balances, sending and receiving, fees, atomic swaps, token issuance (mint, burn, permissions), storage accounts, delegation and multisig, identity certificates, and anchors (KYC, KYB, FX conversion, USDC bridging, bank deposits and payouts, usernames, encrypted storage). Also covers x402 pay-per-request and the test and main networks, including the faucet. Use for any task that mentions Keeta, KeetaNet, KTA, keeta_ addresses or @keetanetwork packages, or that asks an agent to hold, send, convert or pay out money on Keeta.
license: Apache-2.0
compatibility: TypeScript or JavaScript on Node.js 24 (the @keetanetwork/anchor engine) or in a browser, with network access to Keeta representatives.
---

# Keeta Network

Keeta Network is a layer-1 network for moving any asset:

- **Accounts:** one account holds many native tokens at once (KTA, stablecoins, fiat-backed tokens, tokens you issue).
- **Settlement:** transactions settle in about 400 ms.
- **Protocol features:** tokens and permissions are built in, and identity certificates attach to accounts.
- **Anchors:** these off-chain services connect Keeta to banks, other chains, FX and identity providers. You discover them from signed on-chain metadata instead of hardcoding endpoints.

This is the entry-point skill. Follow the rules, run the quickstart once, then use the task map to open the workflow skill or reference file you need.

## Rules

1. **Pick the network explicitly.** Build on `test`, which has free faucet KTA. Use `main` only for real value, and only when the user asks for it. Never infer the network from an address, and never switch networks to make something work.
2. **Keep keys out of every output.** Never print, log, commit or paste a seed, passphrase or private key. Load keys from a secret store and show only public `keeta_…` addresses. Prefer a dedicated agent account over a user's personal wallet.
3. **Amounts are `bigint` base units.** Read a token's decimals from its on-chain metadata (`decimalPlaces`) before converting, and never hardcode them: the published KTA decimals have differed between docs and tools. Never use floating point for money.
4. **Confirm before value moves.** Before any send, show the network, token address, recipient, base-unit amount (plus the decimal amount when decimals are verified), fees and provider. Get approval, and get it again if any of those change.
5. **Publish one transaction at a time per account.** Each Keeta account is an ordered chain, so serialize publishes per account. After an ambiguous failure, inspect `history()` or call `recover()` before you retry. Never re-run a multi-step anchor plan.
6. **Never invent endpoints, providers or token addresses.** Discover anchors through the resolver, and take token addresses from resolver metadata or the chain. An empty result means stop.
7. **Say what is enforced.** The network enforces balances, permissions (ACLs), signatures and multisig quorums. It does not enforce spending caps, allowances or approval workflows. `SEND_ON_BEHALF` delegation is scoped to a token and carries no amount or destination limit. See [spend-policy](../spend-policy/SKILL.md).

## Quickstart (test network)

```bash
npm install @keetanetwork/keetanet-client @keetanetwork/anchor
```

```ts
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { TokenAddress } from '@keetanetwork/keetanet-client/lib/account.js';

const { Account } = KeetaNet.lib;

// Use your stored seed. Generate one only for a brand-new wallet, and save it in a secret store.
const seed = process.env.KEETA_SEED ?? Account.generateRandomSeed({ asString: true });
const account = Account.fromSeed(seed, 0);
const client = KeetaNet.UserClient.fromNetwork('test', account);

// Decimals are token metadata: base64 JSON with `decimalPlaces` (sometimes zlib-deflated first).
async function decimalsOf(token: TokenAddress): Promise<number> {
  const { info } = await client.client.getAccountInfo(token);
  const raw = KeetaNet.lib.Utils.Helper.bufferToArrayBuffer(Buffer.from(info.metadata, 'base64'));
  let json: ArrayBuffer;
  try { json = KeetaNet.lib.Utils.Buffer.ZlibInflate(raw); } catch { json = raw; }
  const { decimalPlaces } = JSON.parse(Buffer.from(json).toString('utf-8'));
  if (!Number.isInteger(decimalPlaces)) throw new Error('token has no decimalPlaces metadata');
  return decimalPlaces;
}

try {
  const address = account.publicKeyString.get();
  console.log('Address:', address, `https://explorer.test.keeta.com/account/${address}`);

  const kta = client.baseToken;
  const decimals = await decimalsOf(kta);
  console.log('KTA balance (base units):', await client.balance(kta), 'decimals:', decimals);

  // Send 0.01 KTA only after the user confirms the recipient, token, and amount.
  if (process.env.KEETA_RECIPIENT && process.env.KEETA_CONFIRMED === 'yes') {
    const amount = 10n ** BigInt(decimals) / 100n;
    await client.send(process.env.KEETA_RECIPIENT, amount, kta, 'quickstart');
    console.log('New balance:', await client.balance(kta));
  }
} finally {
  await client.destroy();
}
```

To fund the account, ask the test faucet for a small amount of KTA. Send the header exactly as written: it rejects a `;charset` suffix.

```bash
curl -sS -X POST https://faucet.test.keeta.com/ \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data "address=${KEETA_ADDRESS}&amount=10"
```

- The faucet replies with an HTML page and sends in batches, so poll `balance()` for a few minutes instead of parsing the reply.
- It sends only test KTA, and only to key-pair or storage accounts.
- It may be rate limited or temporarily empty. Do not loop on it.
- There is no faucet on main.

## How Keeta works

- **Accounts.**
  - *Key-pair accounts* sign. The default is secp256k1 (`keeta_aa…`); ed25519 and secp256r1 are also supported. One seed derives many accounts by index.
  - *Generated accounts* — tokens, storage accounts, multisig accounts and the network account — are created by an operation and controlled through permissions.
- **Tokens.**
  - Every asset is a token account, and every account keeps a separate balance for each token.
  - KTA, the base token (`client.baseToken`), pays fees and carries voting weight.
  - Name, description and metadata (decimals, logo) are set with `setInfo`.
- **Blocks, operations and vote staples.**
  - A block is an ordered list of operations from one account: `send`, `receive`, `setInfo`, `updatePermissions`, `generateIdentifier`, `modifyTokenSupply`, `modifyTokenBalance`, `setRep` and certificate changes.
  - The client gathers representative votes and publishes the blocks with their votes as a vote staple. Every block in a staple succeeds or fails together.
  - A builder batches operations across accounts into one atomic publish.
- **Receiving needs no action.** Incoming sends land automatically. The `receive` operation is a constraint used for atomic swaps.
- **Fees.** They are paid in KTA by the block's account and added when you publish. Preview them with `getQuotes(blocks)`, and keep some KTA on hand.
- **Permissions.**
  - An ACL entry has a principal, an entity, an optional target and base flags (`ACCESS`, `OWNER`, `ADMIN`, `SEND_ON_BEHALF`, `STORAGE_DEPOSIT`, `TOKEN_ADMIN_SUPPLY`…).
  - The most specific entry wins. When no entry matches, the entity's default permission applies.
- **Storage accounts.** Generated vaults hold funds under ACL control: shared treasuries, per-customer accounts, segregated funds.
- **Certificates.** X.509 certificates, such as KYC or KYB, attach to accounts. Their sensitive attributes are encrypted and shared selectively.
- **Anchors.** These services are found through the resolver, rooted at the network account:
  - asset movement (bridges, bank deposits and withdrawals)
  - FX
  - KYC and KYB
  - usernames
  - encrypted storage
  - notifications

## Task map

| Goal | Open | Key SDK entry points |
| --- | --- | --- |
| Create, restore or fund an account | [create-fund-wallet](../create-fund-wallet/SKILL.md) | `Account.fromSeed`, `seedFromPassphrase`, faucet |
| Read balances, token info and history | [multi-asset-balances](../multi-asset-balances/SKILL.md) | `allBalances`, `getAccountInfo`, `history({ depth })` |
| Send, batch or request a payment | [send-receive-tokens](../send-receive-tokens/SKILL.md) | `send`, `initBuilder`, `encodeKeetaURI` |
| Pay for or charge for an API call (x402) | [x402-payments](../x402-payments/SKILL.md) | `@x402/keeta` |
| Set agent limits and approvals | [spend-policy](../spend-policy/SKILL.md) | advisory controls, x402 spend controls |
| Issue, mint, burn or restrict a token | [references/tokens.md](references/tokens.md) | `generateIdentifier`, `setInfo`, `modifyTokenSupply` |
| Create vaults, delegate spending, use multisig | [references/permissions-and-storage.md](references/permissions-and-storage.md) | `updatePermissions`, `STORAGE`, `MULTISIG` |
| Swap atomically with a counterparty, watch activity | [references/transactions.md](references/transactions.md) | `createSwapRequest`, `acceptSwapRequest`, `on('change')` |
| Manage keys, addresses and signing | [references/accounts-and-keys.md](references/accounts-and-keys.md) | `Account`, `sign`, `encrypt` |
| Find a KYC, FX, bridge or bank provider | [discover-resolve-anchors](../discover-resolve-anchors/SKILL.md) | `KeetaAnchor.lib.Resolver`, service clients |
| Verify a person (KYC) | [complete-kyc](../complete-kyc/SKILL.md) | `KYC.Client` |
| Verify a business (KYB) | [complete-kyb](../complete-kyb/SKILL.md) | `KYC.Client` with `entityType: 'business'` |
| Convert between assets | [convert-via-anchors](../convert-via-anchors/SKILL.md) | `FX.Client.getQuotes`, `createExchange` |
| Move USDC between Keeta and EVM chains | [bridge-usdc](../bridge-usdc/SKILL.md) | `AssetMovement.Client` |
| Pay out to a bank account | [pay-out](../pay-out/SKILL.md) | `initiateTransfer`, `getTransferStatus` |
| Deposit from a bank; convert across several hops | [references/anchors.md](references/anchors.md) | `createPersistentForwardingAddress`, `AnchorChaining` |
| Usernames, encrypted storage, push notifications | [references/anchors.md](references/anchors.md) | `Username.Client`, storage client, `Notification.Client` |
| Attach certificates; encrypt data to accounts | [references/identity.md](references/identity.md) | `modifyCertificate`, `EncryptedContainer` |
| Diagnose an error | [references/troubleshooting.md](references/troubleshooting.md) | error codes, typed anchor errors |

## Networks

| | test | main |
| --- | --- | --- |
| SDK alias | `'test'` | `'main'` |
| Network ID, x402 CAIP-2 | `1413829460`, `keeta:1413829460` | `21378`, `keeta:21378` |
| KTA base token | `keeta_anyiff4v34alvumupagmdyosydeq24lc4def5mrpmmyhx3j6vj2uucckeqn52` | `keeta_anqdilpazdekdu4acw65fj7smltcp26wbrildkqtszqvverljpwpezmd44ssg` |
| USDC | `keeta_apna75yhhvnv4ei7ape55hndk4yepno7a7i2mhtiwahiygixjcnmvswxhnmnk` | `keeta_amnkge74xitii5dsobstldatv3irmyimujfjotftx7plaaaseam4bntb7wnna` |
| Wallet (Keeta Personal) | <https://wallet.test.keeta.com> | <https://wallet.keeta.com> |
| Explorer | <https://explorer.test.keeta.com> | <https://explorer.keeta.com> |
| Faucet | <https://faucet.test.keeta.com> | none |

- **Token addresses.** Prefer `client.baseToken` and resolver lookups (`resolver.listTokens()`, `resolver.lookupToken('USD')`) over the hardcoded values above.
- **Metadata mirror.** <https://static.network.keeta.com/metadata/currencyMap> and `/metadata/services` publish token and service metadata. It is a convenience copy, so verify it against the on-chain resolver.
- **Explorer paths.** Append `/account/<address>`, `/token/<address>`, `/block/<hash>`, `/staple/<hash>` or `/storage/<address>` to the explorer URL. Give the user an explorer link after each publish.
- **Other chains.** EVM chain IDs for anchors are: Base 84532 (test) and 8453 (main), Ethereum 11155111 and 1, Arbitrum 421614 and 42161.

## When something fails

| Symptom | Meaning | Do this |
| --- | --- | --- |
| `LEDGER_INVALID_BALANCE` | The balance cannot cover amount plus fees | Check `balance()` for the token and for KTA. Do not swap in another token. |
| `LEDGER_INVALID_PERMISSIONS` | A required ACL flag is missing | Inspect ACLs (see [references/permissions-and-storage.md](references/permissions-and-storage.md)). |
| `LEDGER_SUCCESSOR_VOTE_EXISTS`, `LEDGER_PREVIOUS_ALREADY_USED` | Another publish from this account raced you | Serialize publishes, then call `recover()` and check `history()` before you retry. |
| `BLOCK_EXTERNAL_INVALID` | The external reference is malformed | Use at most 1024 characters from `[-_A-Za-z0-9+/= ]`. |
| `CLIENT_NO_REPS_AVAILABLE` | Representatives are unreachable | Report the network and error. Do not switch networks. |
| `KYCShareNeeded`, `AdditionalKYCNeeded`, `UserActionNeeded` | An anchor needs identity or setup actions first | Complete only the requested actions, with consent ([complete-kyc](../complete-kyc/SKILL.md)). |
| Empty provider list, or `null` | No anchor serves that corridor | Stop and report. Do not guess an endpoint. |

The full list is in [references/troubleshooting.md](references/troubleshooting.md).

## SDKs and resources

- **TypeScript and JavaScript:**
  - `@keetanetwork/keetanet-client` is the network client and works in Node.js and browsers. Without a build step, load <https://static.test.keeta.com/keetanet-browser.js>.
  - `@keetanetwork/anchor` provides anchors, the resolver, certificates and encrypted containers. It is ESM-only and re-exports the client as `KeetaAnchor.KeetaNet`.
- **x402:** `@x402/keeta`, `@x402/core`, `@x402/fetch` and `@x402/express`.
- **Rust:** `cargo add keetanetwork-anchor-client` covers KYC and HTTP. Add `--features asset` for asset movement.
- **Swift:** add <https://github.com/KeetaNetwork/swift-client> with Swift Package Manager.
- **Documentation:**
  - API reference: <https://static.test.keeta.com/docs/>
  - Docs: <https://docs.keeta.com>
  - Examples: <https://github.com/KeetaNetwork/keetanet-examples>

## Reference files

Load these only when the task needs them:

- [references/accounts-and-keys.md](references/accounts-and-keys.md): seeds, passphrases, indexes, key algorithms, address checks, signing and encryption.
- [references/transactions.md](references/transactions.md): sends, builders, fees, atomic swaps, history paging, subscriptions, retries.
- [references/tokens.md](references/tokens.md): create, mint, burn, distribute, decimals, default permissions, NFTs, permit lists.
- [references/permissions-and-storage.md](references/permissions-and-storage.md): ACL model and flags, delegation, storage accounts, multisig.
- [references/identity.md](references/identity.md): certificates, selective disclosure, encrypted containers, signed requests.
- [references/anchors.md](references/anchors.md): resolver, all six service clients, bank deposits, anchor chaining, payment URIs, building an anchor.
- [references/troubleshooting.md](references/troubleshooting.md): error codes, typed anchor errors and recovery.
