# Tokens: issue, mint, burn and control

Keeta tokens are native ledger objects, not smart contracts. Every code block here typechecks against `@keetanetwork/keetanet-client` 0.18.7. `client` is a `UserClient` whose signer becomes the token's `OWNER`. Shorthand: `const { Account, Permissions, Block } = KeetaNet.lib;`.

## Before you start

- Creating a token needs `TOKEN_ADMIN_CREATE` on the network account. On test, the network's default permission normally grants it. Check before you rely on it:

  ```ts
  const { info } = await client.client.getAccountInfo(client.networkAddress);
  console.log(info.defaultPermission?.base.flags);   // e.g. includes 'TOKEN_ADMIN_CREATE', 'STORAGE_CREATE'
  ```

- Every publish costs a small KTA fee, so fund the signer first.
- Issuing a token that claims to be a stablecoin, security or other regulated asset carries legal duties. Confirm the user's intent and authority before you mint on main.

## Create, describe, mint and distribute

```ts
import { encodeTokenMetadata } from '@keetanetwork/anchor/lib/token-metadata.js';

const { account: token } = await client.generateIdentifier(Account.AccountKeyAlgorithm.TOKEN); // publishes one block

const decimals = 6;
const builder = client.initBuilder();
builder.setInfo({
  name: 'DEMO_USD',                                   // A-Z and _ only, at most 50 characters
  description: 'Demo stable token',                   // at most 250 characters
  metadata: encodeTokenMetadata({ decimalPlaces: decimals }), // base64, at most 5464 characters
  defaultPermission: new Permissions(['ACCESS'])      // required: ['ACCESS'] = anyone may hold and transfer
}, { account: token });
builder.modifyTokenSupply(1_000_000n * 10n ** BigInt(decimals), { account: token }); // mint into the token's own balance
await builder.computeBlocks();                        // seal, so the mint is ordered before the send
builder.send(me, 1_000n * 10n ** BigInt(decimals), token, undefined, { account: token }); // distribute from the token account
await builder.publish();                              // one atomic vote staple
```

- **Decimals are metadata.** Use the `{ decimalPlaces, logoURI? }` JSON convention that wallets and anchors read, base64-encoded. `encodeTokenMetadata` and `decodeTokenMetadata` from `@keetanetwork/anchor/lib/token-metadata.js` produce and parse it.
- **Name** is the ticker and **description** is the display name.
- `metadata` is public. A later `setInfo` replaces the current values, but earlier blocks stay readable forever.
- **Supply** is minted into the token account itself. Distribute it with a send from `{ account: token }`.
- To create everything in one publish instead, use `const pending = builder.generateIdentifier(Account.AccountKeyAlgorithm.TOKEN); await builder.computeBlocks(); const token = pending.account;`, then add the operations above to the same builder.

## Supply and balances

```ts
// Burn tokens that the token account holds
const burn = client.initBuilder();
burn.modifyTokenSupply(-amount, { account: token });
await burn.publish();

// Return tokens to the token account and burn them in one staple
const back = client.initBuilder();
back.send(token, amount, token);
await back.computeBlocks();
back.modifyTokenSupply(-amount, { account: token });
await back.publish();

// Mint or burn and adjust the caller's own balance in one call
await client.modTokenSupplyAndBalance(delta, token);

// Admin balance change: no supply change; needs TOKEN_ADMIN_MODIFY_BALANCE
const adjust = client.initBuilder();
adjust.modifyTokenBalance(token, 10n, false, { account: holder }); // isSet=false adds; a negative amount subtracts
await adjust.publish();

const supply: bigint = await client.client.getTokenSupply(token);
```

## Delegate token administration

```ts
await client.updatePermissions(minter, new Permissions(['TOKEN_ADMIN_SUPPLY']), undefined, Block.AdjustMethod.ADD, { account: token });
await client.updatePermissions(minter, new Permissions(['TOKEN_ADMIN_SUPPLY']), undefined, Block.AdjustMethod.SUBTRACT, { account: token });
```

- **Token flags:** `TOKEN_ADMIN_SUPPLY` (mint and burn), `TOKEN_ADMIN_MODIFY_BALANCE`, `UPDATE_INFO`, `ADMIN` (everything except changing the owner) and `PERMISSION_DELEGATE_ADD` / `_REMOVE`.
- **Owner:** there is always exactly one `OWNER`. To transfer ownership, grant it to the new owner and remove it from the old one in the same vote staple, using one builder.
- **Multisig:** to require several approvals for administration, give `ADMIN` to a multisig account instead of a single key ([permissions-and-storage.md](permissions-and-storage.md)).

## Who may hold the token

| Model | Default permission | Per-account entries |
| --- | --- | --- |
| Open (anyone may hold and transfer) | `['ACCESS']` | Block an account by giving it an explicit entry without `ACCESS` (an explicit entry beats the default). |
| Permit list (only approved holders) | `[]` | Grant `ACCESS` to each approved account with `updatePermissions(holder, new Permissions(['ACCESS']), undefined, Block.AdjustMethod.ADD, { account: token })`. |

- A storage account must be allowed to hold a token, through `STORAGE_CAN_HOLD` ([permissions-and-storage.md](permissions-and-storage.md)).
- Transfers that break these rules fail with `LEDGER_INVALID_PERMISSIONS`.

## NFTs and real-world assets

An NFT is a token with a supply of `1n`. For real-world assets, put a document hash or other attestation in the metadata, signed by the issuing authority (`await authority.sign(bytes)`). The docs guide "Tokenizing Real-World Assets" walks through this.

## What is not available

- **Transfer rules:** the docs describe a "built-in rules engine" (time locks, approval-before-transfer, rules based on certificates) as a concept and as roadmap items. Today there is **no SDK call or operation** for it. Model access with permissions (above), and say so plainly when a user asks for transfer rules.
- **Smart contracts:** Keeta has no general smart contracts. Use native tokens, permissions, storage accounts, multisig and anchors.
