---
name: multi-asset-balances
description: Read and reconcile one or all Keeta-native token balances with explicit token identities and base units. Use for portfolio views, preflight balance checks, or post-transaction confirmation.
---

# Read multi-asset balances

## When to use

Use when an agent must list a wallet's assets, check one token before a transfer, or compare balances before and after an anchor flow. Keeta accounts can hold multiple native tokens; never collapse them into a single “USD” or “wallet balance.”

## SDK steps

1. Construct a `UserClient` for the explicitly selected network and signer.
2. Read every balance:

   ```ts
   const balances = await userClient.allBalances();
   ```

3. Read one token by its token account:

   ```ts
   const token = KeetaNet.lib.Account
     .fromPublicKeyString(tokenAddress)
     .assertKeyType(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);
   const balance = await userClient.balance(token);
   ```

4. Preserve every returned amount as `bigint` base units. Resolve token metadata/decimals from a trusted source before formatting a display amount.
5. Report network, wallet address, token address, raw amount, and—only when metadata is known—symbol and formatted amount.

## Confirmations

- Confirm the network and wallet public address.
- For a single-asset check, confirm the complete token address rather than symbol alone.
- Before using a balance as proof of settlement, compare a fresh read with the expected token and amount.

## Failures

- An empty balance set can mean an unfunded account, the wrong network, or an unavailable node. Distinguish these before acting.
- Never convert `bigint` to JavaScript `number` for arithmetic on money.
- If token decimals or symbol cannot be verified, show raw base units and stop short of a human-readable conversion.
- Do not claim final settlement from a UI cache; refresh from the client and, for anchor flows, also check the anchor transaction status.

## Related skills

- Use [create-fund-wallet](../create-fund-wallet/SKILL.md) for initial setup.
- Use [convert-via-anchors](../convert-via-anchors/SKILL.md) to exchange assets.
- Use [pay-out](../pay-out/SKILL.md) for an external payout.

## Sources

- [`UserClient.allBalances()` and `UserClient.balance()`](https://static.network.keeta.com/docs/classes/UserClient.html)
- [KeetaNet client package](https://github.com/KeetaNetwork/keetanet-client)
