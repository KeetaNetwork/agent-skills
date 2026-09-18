---
name: complete-kyb
description: Safely scope business verification for a Keeta anchor, discover provider requirements, and stop when no public KYB contract is available. Use when an organization—not an individual—must be verified.
---

# Complete business verification (KYB)

## When to use

Use when the account owner or payout beneficiary is a legal entity. **Public gap:** the published `@keetanetwork/anchor` package exposes `KYC.Client` but no `KYB.Client`, and current Keeta public docs do not specify a stable Footprint, Signzy, or other KYB HTTP contract. Business-shaped bank-recipient fields are not proof of KYB.

This skill is therefore a discovery and safety gate, not a fabricated executable integration.

## SDK steps

1. Confirm that entity verification—not individual KYC—is required. Collect only the minimum non-secret routing facts needed for discovery: environment, jurisdiction, entity type, intended anchor operation, and provider preference.
2. Use [discover-resolve-anchors](../discover-resolve-anchors/SKILL.md) to inspect current signed metadata for the target asset-movement provider and call its documented `getAccountStatus(...)` when available.
3. Record the returned typed actions. If the provider requests individual KYC sharing or additional KYC, route only that portion through [complete-kyc](../complete-kyc/SKILL.md); do not relabel it KYB.
4. Continue only if the resolved provider publishes a KYB operation schema or links to provider-owned documentation that specifies:
   - authenticated endpoint and environment,
   - request/response schema,
   - supported jurisdictions and entity types,
   - status polling and evidence returned,
   - data handling and terms.
5. Ask a human to approve the provider and disclosure set. Use the provider's published client or HTTP contract exactly. Keep the integration provider-specific and do not claim it is a Keeta SDK method.
6. Confirm completion using the provider's documented status response plus a fresh anchor `getAccountStatus(...)` check.

## Confirmations

- Require human approval before sending incorporation records, beneficial-owner data, tax identifiers, or banking information.
- Show the provider, endpoint origin, environment, jurisdiction, requested documents/fields, data recipients, and retention terms.
- Require a separate transaction confirmation after KYB; verification does not authorize a payout.

## Failures

- If no stable public KYB contract is discoverable, stop and report the missing provider schema. Do not call guessed `/kyb`, `/businessVerification`, Footprint, or Signzy endpoints.
- If a provider exposes only KYC methods, do not force business data into individual KYC fields.
- Treat pending/manual review as incomplete.
- Never put KYB documents or sensitive identifiers on-chain unless an explicit, reviewed protocol requires it.

## Related skills

- Use [complete-kyc](../complete-kyc/SKILL.md) for natural persons and beneficial owners.
- Use [discover-resolve-anchors](../discover-resolve-anchors/SKILL.md) to re-check capabilities at runtime.
- Use [pay-out](../pay-out/SKILL.md) only after provider readiness is confirmed.

## Sources

- [`@keetanetwork/anchor` KYC client](https://github.com/KeetaNetwork/anchor/blob/main/src/services/kyc/client.ts)
- [Asset Movement client and `getAccountStatus`](https://github.com/KeetaNetwork/anchor/blob/main/src/services/asset-movement/client.ts)
- [Anchor Resolver](https://docs.keeta.com/anchors/overview/anchor-resolver)
