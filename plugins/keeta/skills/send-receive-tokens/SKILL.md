---
name: send-receive-tokens
description: Send money or any token to a person, business or another agent on Keeta, settled in about 400 ms. Handles one payment or many published atomically (payroll, mass payouts to wallets), with an explicit recipient, token address and base-unit amount. Also covers receiving, payment-request links (keeta:// URIs) and safe recovery after an ambiguous publish. Use for wallet payments, splitting bills, invoices and receive instructions, even if the user doesn't mention Keeta, unless they ask for a different payment method.
license: Apache-2.0
---

# Send and receive Keeta tokens

## When to use

Use for a direct on-chain transfer of a specific Keeta token, or to tell someone how to pay you.

- For a bank payout, use [pay-out](../pay-out/SKILL.md).
- For a payout to a debit card, use [card-payments](../card-payments/SKILL.md).
- For a cross-chain transfer, use [bridge-crypto](../bridge-crypto/SKILL.md).
- For a currency conversion, use [convert-via-anchors](../convert-via-anchors/SKILL.md).
- To pay for an HTTP API call, use [x402-payments](../x402-payments/SKILL.md).

## SDK steps

1. **Receiving needs no on-chain action.** Sends land in the balance automatically. Share the address (`account.publicKeyString.get()`) with the network and the token you expect.
   - To pre-fill a payment, give the payer a `keeta://` request:

     ```ts
     import * as KeetaAnchor from '@keetanetwork/anchor';
     const request = KeetaAnchor.lib.URI.encodeKeetaURI({ type: 'send', to: account, token, value: amount, external: ['invoice-1001'] });
     ```

   - Detect arrival with `client.on('change', …)`, or poll `balance(token)` or `history({ depth })`.
2. **Parse and validate** the recipient and the token. Each must be the right kind of address:

   ```ts
   const Account = KeetaNet.lib.Account;
   const recipient = Account.fromPublicKeyString(recipientAddress);      // throws if malformed
   if (recipient.isToken()) throw new Error('recipient is a token address, not an account');
   const token = Account.fromPublicKeyString(tokenAddress)
     .assertKeyType(Account.AccountKeyAlgorithm.TOKEN);                 // throws unless it is a token
   ```

3. **Check funds.** Read the token's balance, and the KTA balance for fees (`client.balance(client.baseToken)`). Keep amounts as `bigint` base units, and read the token's decimals from its metadata before you display a decimal amount ([multi-asset-balances](../multi-asset-balances/SKILL.md)).
4. **Confirm.** Present the network, recipient, token address, base-unit amount (plus the decimal amount if verified) and the external reference.
5. **Send** after approval:

   ```ts
   const result = await client.send(recipient, amount, token, externalIdentifier);
   const hashes = result.from === 'direct'
     ? result.voteStaple.blocks.map((block) => block.hash.toString())
     : result.blocks.map((block) => block.hash.toString());
   ```

   - `externalIdentifier` is optional, **public** and limited to 1024 characters from `[-_A-Za-z0-9+/= ]`.
   - Use it for invoice numbers or the reference an anchor gives you, never for personal data.
6. **Verify.** Refresh `balance(token)`, find the entry in `history({ depth: 10 })`, and give the user an explorer link: `https://explorer.test.keeta.com/block/<hash>` or `https://explorer.keeta.com/block/<hash>`.
7. **Batch.** To pay several recipients at once, put the sends in one builder. The batch settles together or not at all:

   ```ts
   const builder = client.initBuilder();
   builder.send(alice, 1_000n, token, 'payroll-2026-10');
   builder.send(bob, 2_500n, token, 'payroll-2026-10');
   await builder.publish();
   ```

## Confirmations

- Require human confirmation of the final recipient, token address and amount, or a pre-approved policy that covers exactly this payment ([spend-policy](../spend-policy/SKILL.md)).
- Show base units, plus a decimal amount only when the token's decimals are verified.
- Treat `externalIdentifier` as public. Never put secrets or personal data in it.

## Failures

- **Invalid address:** stop on an invalid recipient, a token address in the recipient field, or a non-token address in the token field.
- **`LEDGER_INVALID_BALANCE`:** the balance can't cover amount plus fees. Don't substitute another token or account.
- **`LEDGER_INVALID_PERMISSIONS`:** the token may require an allowlist, or the recipient may be blocked. Report it; don't route around it.
- **Provider-issued fiat tokens:** a bank partner's Keeta USD or EUR token can carry transfer rules set by its issuer, and a direct send may be rejected. To pay someone in fiat, use [pay-out](../pay-out/SKILL.md), or convert first.
- **Ambiguous outcome** (timeout, crash, `LEDGER_SUCCESSOR_VOTE_EXISTS`): don't resend. Check first:

  ```ts
  const pending = await client.pendingBlock();
  if (pending) await client.recover(true);   // finish the earlier publish instead of paying twice
  ```

  Then compare `history({ depth: 10 })` with what you meant to send.
- **Concurrency:** never publish from the same account in parallel. Queue sends.
- **Don't force it:** never change the network, recipient, token or amount to "make it work".

## Related skills

- Run preflight and reconciliation with [multi-asset-balances](../multi-asset-balances/SKILL.md).
- Use [pay-out](../pay-out/SKILL.md) for bank recipients.
- Apply [spend-policy](../spend-policy/SKILL.md) before publishing.
- For atomic swaps and history paging, see the [transactions reference](../keeta/references/transactions.md).

## Sources

- [Send a Transaction](https://docs.keeta.com/introduction/send-a-transaction)
- [Send operation](https://docs.keeta.com/components/blocks/operations/send)
- [UserClient reference](https://static.test.keeta.com/docs/classes/KeetaNetSDK.UserClient.html)
