---
name: create-fund-wallet
description: Create or restore a Keeta wallet for an agent, app or person, connect it to the test or main network, share only its public address, and fund it from the test faucet, a bank deposit, a card or another chain. One Keeta account holds dollars, euros, stablecoins, KTA and any other token. Use when an agent needs its own wallet to hold or move money, when recovering a wallet from a seed or recovery phrase, or when getting first funds into a new account, even if the user doesn't mention Keeta.
license: Apache-2.0
---

# Create and fund a Keeta wallet

## When to use

Use for a new agent or app account, for recovering an account from its seed or recovery phrase, or for getting a new account its first funds. Ask whether the user means `test` or `main`. Never infer the network from an address or an earlier conversation: the same key has the same address on both networks.

Prefer a **dedicated account per agent**, funded with only what the task needs. Use a user's personal wallet only if the user explicitly hands over its recovery phrase for this purpose.

## SDK steps

1. Install the client: `npm install @keetanetwork/keetanet-client`.
2. Create or restore the account, then connect:

   ```ts
   import * as KeetaNet from '@keetanetwork/keetanet-client';

   const { Account } = KeetaNet.lib;
   // New wallet: generate once, store it in your secret manager, never print it.
   // Recovery: load the stored seed instead.
   const seed = process.env.KEETA_SEED ?? Account.generateRandomSeed({ asString: true });
   const account = Account.fromSeed(seed, 0);                  // index 0; use other indexes for more accounts
   const client = KeetaNet.UserClient.fromNetwork('test', account); // or 'main' when the user says so
   const address = account.publicKeyString.get();              // share only this
   ```

   To restore from a recovery phrase, which is also how Keeta Personal derives accounts, run `const seed = await Account.seedFromPassphrase(process.env.KEETA_PHRASE!, { asString: true })` and then `Account.fromSeed(seed, 0)`. The SDK rejects short passphrases.
3. Fund the account:
   - **test:** ask the faucet for test KTA. Send the header exactly as written: a `;charset` suffix is rejected.

     ```bash
     curl -sS -X POST https://faucet.test.keeta.com/ \
       -H 'Content-Type: application/x-www-form-urlencoded' \
       --data "address=${KEETA_ADDRESS}&amount=10"
     ```

     The reply is an HTML page and sends go out in batches, so don't parse the reply. The faucet sends only KTA, only to key-pair or storage accounts, and may be rate limited or empty. For test stablecoins, see [bridge-crypto](../bridge-crypto/SKILL.md) (Circle's test-USDC faucet plus a bridge).
   - **main:** there is no faucet. Funds arrive by:
     - a transfer the user sends from their own wallet, for example Keeta Personal at <https://wallet.keeta.com>;
     - a bank deposit into the user's own named US account, or a wire ([receive-bank-deposits](../receive-bank-deposits/SKILL.md));
     - a debit card top-up ([card-payments](../card-payments/SKILL.md));
     - stablecoins or other tokens bridged from another chain ([bridge-crypto](../bridge-crypto/SKILL.md)).
4. Confirm the funds arrived by polling the balance. Don't trust a faucet reply or a sender's word:

   ```ts
   const before = await client.balance(client.baseToken);
   // ...request funds, then:
   for (let attempt = 0; attempt < 20; attempt++) {
     if ((await client.balance(client.baseToken)) > before) break;
     await KeetaNet.lib.Utils.Helper.asleep(15_000);
   }
   ```

5. Report the network, the address, an explorer link (`https://explorer.test.keeta.com/account/<address>` or `https://explorer.keeta.com/account/<address>`), and the balance in base units. Add a decimal amount only after you read the token's `decimalPlaces` ([multi-asset-balances](../multi-asset-balances/SKILL.md)).
6. Call `await client.destroy()` when you are done.

## Confirmations

- Confirm `test` or `main` before you build the client.
- Confirm whether this is a new seed or a recovery, and which index.
- Show only the public address. Never show the seed or phrase, even when the user asks to "see the wallet".
- Before asking someone to fund the account, confirm the token address and the expected base-unit amount.

## Failures

- No secure place to store the seed: stop before you generate one.
- `fromNetwork` or a balance read fails (`CLIENT_NO_REPS_AVAILABLE`): report the network and the error. Do not switch networks.
- The balance has not changed after a few minutes: return the address, token and observed balance. Don't ask the faucet again in a loop.
- A network outage does not mean account creation failed. Key derivation is local, and funding is a separate step.

## Related skills

- Read balances with [multi-asset-balances](../multi-asset-balances/SKILL.md).
- Send funds with [send-receive-tokens](../send-receive-tokens/SKILL.md).
- Set limits before an agent moves value: [spend-policy](../spend-policy/SKILL.md).
- For the full map of what Keeta can do, start at the [keeta](../keeta/SKILL.md) skill.

## Sources

- [Create Your First Account](https://docs.keeta.com/introduction/create-your-first-account)
- [Start Developing](https://docs.keeta.com/introduction/start-developing)
- [Official links: wallet, explorer, faucet](https://docs.keeta.com/other-documentation/official-links)
- [Faucet request helper in the public examples](https://github.com/KeetaNetwork/keetanet-examples/blob/main/src/helper.ts)
