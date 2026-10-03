# Permissions, storage accounts, delegation and multisig

Every code block here typechecks against `@keetanetwork/keetanet-client` 0.18.7. Shorthand: `const { Account, Permissions, Block } = KeetaNet.lib;`.

## The permission model

Each ACL entry has four parts:

- **principal:** the account that acts.
- **entity:** the account acted on. The change is recorded on the entity's chain.
- **target** (optional): narrows the entry, usually to one token.
- **permissions:** a set of base flags, plus optional external bits that apps define and the network does not enforce.

The network resolves permissions from most specific to least specific, with no inheritance:

1. principal + entity + target
2. principal + entity, with no target
3. the entity's **default permission**, set with `setInfo({ defaultPermission })` on generated accounts
4. nothing

An explicit entry overrides the default. That is how a blocklist works: on a token whose default is `ACCESS`, give the blocked account an explicit entry without `ACCESS`.

### Base flags (`KeetaNet.lib.Permissions` names)

| Flag | Lets the principal… | Typical entity |
| --- | --- | --- |
| `ACCESS` | use the entity at all; it must accompany any other flag | token, storage, any |
| `OWNER` | do anything. A generated account has exactly one owner | generated account |
| `ADMIN` | do anything except change the owner | any |
| `UPDATE_INFO` | call `setInfo` on the entity's behalf | any |
| `SEND_ON_BEHALF` | send the entity's funds (optionally for one target token) | storage, any |
| `STORAGE_CAN_HOLD` | (principal = token) let a storage account hold that token | storage |
| `STORAGE_DEPOSIT` | deposit into a storage account | storage |
| `STORAGE_CREATE` / `TOKEN_ADMIN_CREATE` | create storage accounts or tokens | network account |
| `TOKEN_ADMIN_SUPPLY` | mint and burn | token |
| `TOKEN_ADMIN_MODIFY_BALANCE` | change a holder's balance without changing supply | token |
| `PERMISSION_DELEGATE_ADD` / `PERMISSION_DELEGATE_REMOVE` | grant or remove a subset of its own permissions | any |
| `MANAGE_CERTIFICATE` | manage certificates on the entity's behalf | any |

## Grant, revoke and inspect

```ts
// updatePermissions(principal, permissions, target?, method = SET, { account: entity }?)
await client.updatePermissions(operator, new Permissions(['UPDATE_INFO']));            // SET, on my own account
await client.updatePermissions(operator, new Permissions(['TOKEN_ADMIN_SUPPLY']), undefined, Block.AdjustMethod.ADD, { account: token });
await client.updatePermissions(operator, new Permissions(['TOKEN_ADMIN_SUPPLY']), undefined, Block.AdjustMethod.SUBTRACT, { account: token });

const mine = await client.listACLsByPrincipal();                 // where I am the principal
const onEntity = await client.client.listACLsByEntity(entity);   // who can do what on an entity
for (const row of onEntity) {
  console.log(row.permissions.base.flags.join(','), row.target?.publicKeyString.get());
}
```

- `AdjustMethod.SET` replaces the principal's entry, `ADD` merges flags in, and `SUBTRACT` removes them.
- Builders accept the same call (`builder.updatePermissions(...)`), so you can create an account and grant permissions in one atomic publish.

## Delegation is not a spending limit

`SEND_ON_BEHALF` lets a principal move an entity's funds. A target can limit it to one token. **It has no amount limit, rate limit, destination allowlist or expiry.** Any such limits are advisory controls in your application ([spend-policy](../../spend-policy/SKILL.md)). Revoke a delegation with `SUBTRACT` or `SET` to an empty set; the change takes effect as soon as it is published.

## Storage accounts

A storage account is a generated vault that holds balances under ACL control. Use one for a shared treasury, per-customer funds, segregated balances, or to give an agent a separate pot of money.

```ts
const { account: vault } = await client.generateIdentifier(Account.AccountKeyAlgorithm.STORAGE);
const setup = client.initBuilder();
setup.setInfo({
  name: 'TEAM_VAULT', description: 'Shared treasury', metadata: '',
  defaultPermission: new Permissions(['ACCESS', 'STORAGE_DEPOSIT', 'STORAGE_CAN_HOLD']) // anyone may deposit; any token may be held
}, { account: vault });
setup.updatePermissions(teammate, new Permissions(['SEND_ON_BEHALF']), usdc, Block.AdjustMethod.SET, { account: vault });
await setup.publish();

await client.send(vault, amount, usdc);                                   // deposit: a normal send
await client.send(recipient, amount, usdc, undefined, { account: vault }); // spend: owner or SEND_ON_BEHALF principal
const balances = await client.allBalances({ account: vault });
const myVaults = (await client.listACLsByPrincipal()).filter((acl) => acl.entity.isStorage());
```

To create a **single-token vault**, leave `STORAGE_CAN_HOLD` out of the default and allow one token explicitly. The token is the principal:

```ts
await client.updatePermissions(usdc, new Permissions(['STORAGE_CAN_HOLD']), undefined, Block.AdjustMethod.ADD, { account: vault });
```

Sends of any other token then fail with a permissions error.

## Multisig

A multisig account is a generated identifier with a signer set and a quorum. Give it the powers that should need several approvals, such as `ADMIN` on a token or `SEND_ON_BEHALF` on a vault:

```ts
const builder = client.initBuilder();
const pending = builder.generateIdentifier({ type: Account.AccountKeyAlgorithm.MULTISIG, signers: [s1, s2, s3], quorum: 2n });
await builder.computeBlocks();
const multisig = pending.account;
builder.updatePermissions(multisig, new Permissions(['ADMIN']), undefined, Block.AdjustMethod.SET, { account: token });
await builder.publish();

// Later: a block on the token's chain, signed by 2 of the 3 signers
const head = await client.client.getHeadBlock(token);
const block = await new Block.Builder({
  version: 2,
  account: token,
  signer: [multisig, [s1, s2]],
  previous: head?.hash ?? Block.NO_PREVIOUS,
  network: client.network,
  operations: [{ type: Block.OperationType.SET_INFO, name: 'MS_TOKEN', description: 'Multisig-admined', metadata: '', defaultPermission: new Permissions(['ACCESS']) }]
}).seal();
await client.transmit([block]);
```

The network enforces the quorum. The quorum must be between 1 and the number of signers, the signers must be distinct, and multisig signers can nest at most three levels deep. The public docs don't cover multisig yet; the flow above comes from the SDK types. Test it on `test` before you use it for real value.
