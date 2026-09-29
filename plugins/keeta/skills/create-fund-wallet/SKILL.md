---
name: create-fund-wallet
description: Create or restore a Keeta signer, connect it to a named network, expose only its public address, and hand off bank funding to KYC and pay-in. Use when setting up a Keeta wallet or preparing an address to receive funds.
---

# Create and fund a Keeta wallet

## When to use

Use this skill for a new wallet, deterministic account recovery, or preparing an address that will receive a known Keeta-native token. Ask whether the user intends `test` or `main`. The address does not select the network.

Bank funding is a later step. After the public address exists, individual KYC is [complete-kyc](../complete-kyc/SKILL.md), and standing US bank deposit instructions are [pay-in](../pay-in/SKILL.md). This skill does not call a faucet and does not claim the new account holds a balance.

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

3. For recovery, load the seed from an approved secret store and call `Account.fromSeed(seed, index)`. Keep the seed out of logs, prompts, commits, and chat transcripts.
4. Show the public address and the selected network. A direct Keeta transfer from a known sender is ready once the human confirms the token identifier and the base-unit amount.
5. For USD that should arrive from a US bank, stop here and continue with complete-kyc, then pay-in. Pay-in discovers an Asset Movement provider and returns that provider's deposit instructions. There is no documented universal funding method on the wallet client.
6. After a sender or a bank credit is reported, verify with `await userClient.balance(token)` or `await userClient.allBalances()`.

## Confirmations

- Confirm `test` or `main` before constructing `UserClient`.
- Confirm whether this is a new seed or recovery of an existing seed and index.
- Show only the public address to the user.
- Confirm the exact token identifier and base-unit amount before sharing a request for a direct Keeta transfer.
- Confirm that bank deposit instructions will be requested only in pay-in, after KYC.

## Failures

- Stop when secure seed storage is unavailable.
- When `fromNetwork` cannot connect, report the selected network and the error. Stay on the network the human chose.
- When the balance is unchanged, return the address, token, and observed balance. Leave an unknown transfer unsent.
- A paused or unavailable test network means network funding could not be checked. Local key derivation has still produced an address.
- Stop when someone asks for a faucet URL, a promo credit, or any funding endpoint that is not in the cited sources. Example helpers that request test tokens are outside this skill.

## Related skills

- Continue with [complete-kyc](../complete-kyc/SKILL.md) before a provider will issue bank deposit instructions.
- Continue with [pay-in](../pay-in/SKILL.md) to obtain those instructions and reconcile the Keeta USD credit.
- Use [multi-asset-balances](../multi-asset-balances/SKILL.md) to inspect funds.
- Use [send-receive-tokens](../send-receive-tokens/SKILL.md) for a direct Keeta transfer.
- Apply [spend-policy](../spend-policy/SKILL.md) before enabling agent-initiated value movement.

## Sources

- [Create Your First Account](https://docs.keeta.com/introduction/create-your-first-account)
- [`@keetanetwork/keetanet-client` getting started](https://github.com/KeetaNetwork/keetanet-client/blob/main/docs/GETTING-STARTED.md)
- [Fiat Deposit from Bank](https://docs.keeta.com/guides/fiat-deposit-from-bank)
