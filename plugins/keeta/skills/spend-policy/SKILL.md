---
name: spend-policy
description: Apply explicit advisory limits, recipient controls, and human approval gates around Keeta wallet actions. Use before allowing an agent to quote, convert, bridge, send, or pay out.
---

# Apply a spend policy

## When to use

**Honesty first:** this skill is an advisory control for agent behavior. A policy written in a prompt, file, or application does not become chain-level enforcement. `@keetanetwork/keetanet-client` can publish permission updates, and Keeta tokens may have network-enforced rules, but this pack does not prove that arbitrary budgets, daily limits, recipient allowlists, or approval thresholds are enforced by the chain.

Use before any agent can propose or execute value movement. For real enforcement, use reviewed application controls, protected keys, transaction signing boundaries, and only separately verified Keeta permissions/rules.

## SDK steps

1. Define policy in machine-readable application state:
   - allowed networks, tokens, actions, providers, and recipients;
   - per-transaction and rolling-window limits in base units;
   - quote slippage/fee limits;
   - approvals required;
   - expiry and emergency stop.
2. Before an SDK call, read fresh balances and normalize the proposed action into network, method, token, amount, recipient/provider, and external destination.
3. Evaluate every rule. A missing field, stale policy, unknown token decimal, or unavailable policy store is a denial—not permission.
4. Present the full normalized action and policy result to the human when approval is required.
5. Only after approval call the exact workflow method, such as `userClient.send(...)`, `approvedOffer.createExchange()`, or `provider.initiateTransfer(...)`.
6. Record a redacted audit entry with policy version, approval reference, request hash, SDK result, and final status.

Do not call `userClient.updatePermissions(...)` as a generic spend-limit API. Use it only when a separately reviewed design maps a documented Keeta permission type to the intended on-chain control.

## Confirmations

- Always require approval for seed/key access, identity disclosure, new recipients, provider terms, and policy changes.
- Require reapproval when network, token, amount, recipient, provider, quote, fee, or instruction changes.
- Keep signers outside the model context and expose the narrowest signing interface possible.

## Failures

- Policy store unavailable, malformed, expired, or inconsistent: fail closed.
- Unknown token decimals or recipient: deny.
- Approval timeout or mismatch: deny and discard the prepared action.
- Ambiguous publish result: reconcile before another signature.
- An advisory denial can prevent the agent from calling the signer, but it cannot revoke a leaked key. Rotate or disable compromised credentials through the actual custody/control system.

## Related skills

- Apply this skill to [send-receive-tokens](../send-receive-tokens/SKILL.md), [convert-via-anchors](../convert-via-anchors/SKILL.md), [bridge-usdc](../bridge-usdc/SKILL.md), and [pay-out](../pay-out/SKILL.md).
- Use [multi-asset-balances](../multi-asset-balances/SKILL.md) for fresh preflight state.

## Sources

- [`UserClient.updatePermissions()` SDK reference](https://static.network.keeta.com/docs/classes/UserClient.html)
- [Keeta Permissions](https://docs.keeta.com/keetanet/accounts/permissions)
- [Built-in Rules Engine](https://docs.keeta.com/features/built-in-rules-engine)
