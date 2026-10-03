---
name: spend-policy
description: "Keep an agent's spending safe on Keeta. Start with network-enforced limits: a dedicated funded account or vault, token-scoped SEND_ON_BEHALF delegation, multisig co-signing. Then add application checks that fail closed: per-payment and rolling caps, allowlists, approvals, audit. Use before letting an agent quote, convert, bridge, send, pay out, pay a card or pay for x402 requests, or when a user asks how to cap or control what an agent can spend."
license: Apache-2.0
---

# Apply a spend policy

**What Keeta enforces and what it doesn't.**

- **The network enforces:** balances (an account or storage vault can never spend more than it holds), permissions (a delegate can move only the tokens its `SEND_ON_BEHALF` entry allows, and revocation takes effect when published), signatures, and multisig quorums (a block needs the required co-signers).
- **The network does not enforce:** per-payment or daily amount caps, rate limits, recipient or provider allowlists, slippage limits, time windows or approval workflows. Those are **advisory**: your application or signing service must enforce them. A policy written in a prompt or a file enforces nothing.
- **In between:** the x402 client's spend controls are enforced by the library inside your process, not by the chain.

## When to use

Use before any agent can propose or execute value movement: sends, conversions, bridges, payouts, x402 payments, token minting. Combine one network-enforced boundary with application checks. Never rely on the application checks alone when real money is at stake.

## SDK steps

1. **Bound the blast radius on-chain.** Give the agent its own account, or a storage vault, and fund it with only the current budget. Refill it on a schedule. The ledger then caps losses at that balance, even if the agent misbehaves.

   ```ts
   const { Account, Permissions, Block } = KeetaNet.lib;
   const { account: vault } = await client.generateIdentifier(Account.AccountKeyAlgorithm.STORAGE); // owner: the human's client
   const setup = client.initBuilder();
   setup.setInfo({ name: 'AGENT_BUDGET', description: 'Agent spending pot', metadata: '',
     defaultPermission: new Permissions(['ACCESS', 'STORAGE_DEPOSIT', 'STORAGE_CAN_HOLD']) }, { account: vault });
   setup.updatePermissions(agentAccount, new Permissions(['SEND_ON_BEHALF']), usdc, Block.AdjustMethod.SET, { account: vault }); // USDC only
   await setup.publish();
   await client.send(vault, budgetBaseUnits, usdc);   // fund only this period's budget

   // The agent spends with its own key: agentClient.send(to, amount, usdc, ref, { account: vault })
   // Revoke immediately if needed:
   await client.updatePermissions(agentAccount, new Permissions(['SEND_ON_BEHALF']), usdc, Block.AdjustMethod.SUBTRACT, { account: vault });
   ```

2. **Require a human co-signature where it matters.** Give the powerful permission, such as `SEND_ON_BEHALF` on a large vault or `ADMIN` on a token, to a multisig account whose signers include a human-held key. The network then rejects any block without the quorum. The setup is in the [permissions reference](../keeta/references/permissions-and-storage.md).
3. **Define the application policy as data.** Include:
   - allowed networks, tokens, actions, providers and recipients;
   - per-transaction and rolling-window limits in base units;
   - quote, slippage and fee limits;
   - which approvals each action needs;
   - an expiry and an emergency stop.
4. **Normalize before every SDK call.** Read fresh balances. Reduce the proposed action to network, method, token, base-unit amount, recipient or provider, and external reference. Evaluate every rule. A missing field, a stale policy, unknown token decimals or an unreachable policy store is a **denial**.
5. **Ask for approval when the policy requires it.** Show the full normalized action and the policy result. Then call exactly that method: `client.send(...)`, `approvedQuote.createExchange()`, `provider.initiateTransfer(...)`, or the instruction's funding send.
6. **For x402, also set the library's controls:** `x402Client.setSpendControls({ maxAmountPerPayment, allowedAssets })` plus an `onBeforePaymentCreation` hook that calls this policy ([x402-payments](../x402-payments/SKILL.md)).
7. **Record a redacted audit entry:** policy version, approval reference, request hash, SDK result (block hashes or anchor transfer ID) and final status.

## Confirmations

- Always require approval for key or seed access, identity disclosure, new recipients, provider terms, policy changes, and widening a delegation.
- Require approval again when the network, token, amount, recipient, provider, quote, fee or instruction changes.
- Keep signers outside the model's context, and give the model the narrowest signing interface possible.

## Failures

- **Policy store unavailable, malformed, expired or inconsistent:** fail closed.
- **Unknown token decimals or an unknown recipient:** deny.
- **Approval times out or doesn't match:** deny, and discard the prepared action.
- **Ambiguous publish result:** reconcile with `pendingBlock()`, `recover()` and `history()` before signing anything else.
- **Leaked or compromised key:** an advisory denial can't revoke it. Revoke its permissions on vaults and tokens on-chain, move the remaining funds, and rotate the key.

## Related skills

- Apply this to [send-receive-tokens](../send-receive-tokens/SKILL.md), [convert-via-anchors](../convert-via-anchors/SKILL.md), [bridge-crypto](../bridge-crypto/SKILL.md), [pay-out](../pay-out/SKILL.md), [card-payments](../card-payments/SKILL.md) and [x402-payments](../x402-payments/SKILL.md).
- Get fresh preflight state from [multi-asset-balances](../multi-asset-balances/SKILL.md).

## Sources

- [Keeta permissions](https://docs.keeta.com/components/accounts/permissions)
- [Storage accounts](https://docs.keeta.com/components/accounts/storage-accounts)
- [`UserClient.updatePermissions()`](https://static.test.keeta.com/docs/classes/KeetaNetSDK.UserClient.html)
- [Using x402 on Keeta](https://docs.keeta.com/guides/using-x402-on-keeta)
