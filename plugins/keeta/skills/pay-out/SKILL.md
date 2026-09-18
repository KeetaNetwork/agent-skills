---
name: pay-out
description: Discover an outbound Asset Movement anchor, initiate a Keeta USD payment to a US bank account, fund its instruction, and monitor status. Use for external fiat payouts.
---

# Pay out to a bank account

## When to use

Use after recipient validation and required identity onboarding. The concrete public example is **test Keeta USD → USD at a US bank account**:

- source: test Keeta USD `keeta_any4zllibya6fum3lsoimxmnmeo57nklxlh4c6d6xosfacarfaa3knkiprkmm`
- destination: `USD`, `bank-account:us`
- environment: `test`

**Anchor-name gap:** the guide uses a Resolver-selected Asset Movement anchor and does not name the operator. This corridor is illustrative until discovery returns a provider and the human approves it. Do not infer HopNow or a partner endpoint.

## SDK steps

1. Confirm KYC/KYB readiness, source token balance, recipient ownership, bank details, amount, environment, fees, and provider terms.
2. Discover providers:

   ```ts
   const client = new KeetaAnchor.AssetMovement.Client(userClient);
   const providers = await client.getProvidersForTransfer({
     asset: { from: keetaUsdToken, to: 'USD' },
     from: {
       type: 'chain',
       chain: { type: 'keeta', networkId: userClient.network }
     },
     to: { type: 'bank-account', account: { type: 'us' } }
   });
   ```

3. Build the documented `UsBankAccountResolved` recipient locally. Never log account or routing numbers.
4. Select a reviewed provider, check `getAccountStatus(...)` if offered, and call `provider.initiateTransfer(...)` with the exact source, destination, recipient, and base-unit `value`.
5. Review the returned transfer ID and instruction. After final approval, follow it exactly:

   ```ts
   const instruction = transfer.instructions[0];
   await userClient.send(
     KeetaAnchor.KeetaNet.lib.Account.toAccount(instruction.sendToAddress),
     amount,
     keetaUsdToken,
     instruction.external
   );
   ```

6. Poll `transfer.getTransferStatus()` until a documented terminal status, respecting provider intervals.

## Confirmations

- Confirm provider identity, recipient name, masked bank details, amount, currency, fees, expected delivery, and terms.
- Confirm `sendToAddress`, token, amount, and `external` instruction immediately before funding.
- Require human approval for any new recipient or changed quote/instruction.

## Failures

- No provider or missing operation: stop.
- KYC-share-needed, additional-KYC, or user-action-needed: present and complete only the typed action with consent.
- Never fund an instruction whose amount, token, provider, recipient, or identifier differs from the approved transfer.
- If funding publish or payout status is ambiguous, reconcile history and status before retrying.
- Do not expose bank details in logs, prompts, commits, or on-chain metadata.

## Related skills

- Use [complete-kyc](../complete-kyc/SKILL.md) or [complete-kyb](../complete-kyb/SKILL.md).
- Use [discover-resolve-anchors](../discover-resolve-anchors/SKILL.md) for provider review.
- Apply [spend-policy](../spend-policy/SKILL.md) before initiation and funding.

## Sources

- [Fiat Withdraw to Bank](https://docs.keeta.com/guides/fiat-withdraw-to-bank)
- [Full withdrawal example](https://github.com/KeetaNetwork/keetanet-examples/blob/main/src/anchor/asset-movement-fiat-withdraw-to-bank.ts)
- [Asset Movement client](https://github.com/KeetaNetwork/anchor/blob/main/src/services/asset-movement/client.ts)
