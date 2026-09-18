---
name: create-fund-wallet
description: Create or restore a Keeta signer, connect it to a named network, expose only its public address, and prepare a safe funding request. Use when setting up a Keeta wallet or funding a new account.
---

# Create and fund a Keeta wallet

## When to use

Use for a new wallet, deterministic account recovery, or preparing an address to receive a known Keeta-native token. Ask whether the user intends `test` or `main`; never infer the network from an address or previous conversation.

## SDK steps

1. Install and import `@keetanetwork/keetanet-client`.
2. Generate a seed only for a new wallet:

   ```ts
   import * as KeetaNet from '@keetanetwork/keetanet-client';

   const seed = KeetaNet.lib.Account.generateRandomSeed({ asString: true });
   const account = KeetaNet.lib.Account.fromSeed(seed, 0);
   const userClient = KeetaNet.UserClient.fromNetwork('test', account);
   const address = account.publicKeyString.get();
   ```

3. For recovery, load the seed from an approved secret store and call `Account.fromSeed(seed, index)`. Do not print, log, commit, or transmit the seed.
4. Confirm the public address, network, token address, and expected base-unit amount before requesting funds from a known sender.
5. After the sender reports completion, verify with `await userClient.balance(token)` or `await userClient.allBalances()`.

There is no documented universal funding method. Faucets are environment-specific services, not wallet creation APIs. Do not guess a faucet URL or claim that a new account is funded.

## Confirmations

- Confirm `test` or `main` before constructing `UserClient`.
- Confirm whether this is a new seed or recovery of an existing seed and index.
- Show only the public address to the user.
- Confirm the exact token identifier and base-unit amount before sharing a funding request.

## Failures

- Stop if secure seed storage is unavailable.
- If `fromNetwork` cannot connect, report the selected network and error; do not silently switch networks.
- If the balance remains unchanged, return the address, token, and observed balance. Do not resubmit an unknown transfer.
- A paused or unavailable test network is not evidence that account creation failed; local key derivation and network funding are separate steps.

## Related skills

- Use [multi-asset-balances](../multi-asset-balances/SKILL.md) to inspect funds.
- Use [send-receive-tokens](../send-receive-tokens/SKILL.md) for a transfer.
- Apply [spend-policy](../spend-policy/SKILL.md) before enabling agent-initiated value movement.

## Sources

- [Create Your First Account](https://docs.keeta.com/introduction/create-your-first-account)
- [`@keetanetwork/keetanet-client` getting started](https://github.com/KeetaNetwork/keetanet-client/blob/main/docs/GETTING-STARTED.md)
