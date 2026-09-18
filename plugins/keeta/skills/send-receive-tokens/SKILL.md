---
name: send-receive-tokens
description: Prepare, confirm, send, and verify a Keeta-native token transfer using an explicit recipient, token account, and base-unit amount. Use for wallet-to-wallet sends or receiving instructions.
---

# Send and receive Keeta tokens

## When to use

Use for a direct on-chain transfer of a specific Keeta token. For an off-chain bank payment, bridge, or FX conversion, use the corresponding anchor skill instead.

## SDK steps

1. For receiving, return `account.publicKeyString.get()` with the selected network and requested token address. No SDK call is required to receive.
2. Parse the recipient and token:

   ```ts
   const Account = KeetaNet.lib.Account;
   const recipient = Account.fromPublicKeyString(recipientAddress);
   const token = Account
     .fromPublicKeyString(tokenAddress)
     .assertKeyType(Account.AccountKeyAlgorithm.TOKEN);
   ```

3. Check `await userClient.balance(token)` and keep the amount as `bigint`.
4. Present the network, recipient, token, base-unit amount, and optional external identifier for confirmation.
5. After approval, send:

   ```ts
   const result = await userClient.send(
     recipient,
     amount,
     token,
     externalIdentifier
   );
   ```

6. Confirm the publish result and refresh `balance(token)` or `history()` as appropriate.

## Confirmations

- Require human confirmation for the final recipient, token address, and amount.
- Display both base units and a formatted value only when token decimals are verified.
- Treat `externalIdentifier` as public transaction metadata; do not place secrets or personal data in it.

## Failures

- Stop on an invalid recipient or non-token asset identifier.
- On insufficient balance, do not substitute another token.
- If publish status is ambiguous, inspect history before retrying; a blind retry can duplicate payment.
- Do not switch network, recipient, token, or amount to “make it work.”

## Related skills

- Use [multi-asset-balances](../multi-asset-balances/SKILL.md) for preflight and reconciliation.
- Use [pay-out](../pay-out/SKILL.md) for bank recipients.
- Apply [spend-policy](../spend-policy/SKILL.md) before publishing.

## Sources

- [Send a Transaction](https://docs.keeta.com/introduction/send-a-transaction)
- [`UserClient.send()`](https://static.network.keeta.com/docs/classes/UserClient.html)
