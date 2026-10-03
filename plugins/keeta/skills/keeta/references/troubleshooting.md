# Troubleshooting

## Read the error

```ts
import * as KeetaNet from '@keetanetwork/keetanet-client';
import { KeetaAnchorError } from '@keetanetwork/anchor/lib/error.js';

try {
  await client.send(recipient, amount, token);
} catch (error) {
  if (KeetaNet.lib.Error.isInstance(error)) {
    console.error(error.code, error.message);                  // ledger and client errors carry a string code
  } else if (KeetaAnchorError.isInstance(error)) {
    console.error(error.name, error.statusCode, error.retryable, error.message);
  }
  throw error;
}
```

## Ledger and client codes

| Code | Meaning | What to do |
| --- | --- | --- |
| `LEDGER_INVALID_BALANCE` | The balance can't cover amount plus fees | Check the token balance **and** the KTA balance (fees). Stop. Never swap in another token. |
| `LEDGER_INVALID_PERMISSIONS` | A required ACL flag is missing (for example a token without `ACCESS`, or a storage account that can't hold the token) | Inspect ACLs and default permissions ([permissions-and-storage.md](permissions-and-storage.md)). |
| `LEDGER_SUCCESSOR_VOTE_EXISTS`, `LEDGER_PREVIOUS_ALREADY_USED`, `LEDGER_NOT_SUCCESSOR` | Another publish from the same account raced this one | Serialize per account. Check `pendingBlock()`, `recover(true)` and `history({ depth })`, then retry once if nothing landed. |
| `LEDGER_BLOCK_ALREADY_EXISTS` | That exact block is already on the ledger | Treat it as done and verify with `history()`. Do not resend. |
| `LEDGER_BLOCK_EXPIRED`, `VOTE_EXPIRED` | The block or its votes are too old | Rebuild and republish. Long pauses between building and publishing cause this. |
| `LEDGER_RECEIVE_NOT_MET` | A `receive` constraint (swap) wasn't satisfied in the same staple | Check the swap terms. The counterparty's send didn't match. |
| `LEDGER_INVALID_OWNER_COUNT` | A generated account would end up with zero or two owners | Grant the new owner and remove the old one in one vote staple. |
| `LEDGER_FEE_MISSING`, `LEDGER_MISSING_REQUIRED_FEE_BLOCK`, `LEDGER_REQUIRED_FEE_MISMATCH` | Fee handling failed | Use `send`, `publish` or `publishBuilder`, which add fees, and keep KTA available. |
| `LEDGER_INVALID_NETWORK` | The block was built for another network | The client and the data come from different networks. Fix the network choice. |
| `BLOCK_EXTERNAL_INVALID`, `BLOCK_EXTERNAL_TOO_LONG` | Bad `external` reference | Use at most 1024 characters from `[-_A-Za-z0-9+/= ]`. |
| `BLOCK_GENERAL_FIELD_INVALID` | Bad `setInfo` field | `name` uses `A-Z` and `_` only (at most 50), description at most 250, metadata is base64 (at most 5464). |
| `CLIENT_BUILDER_CANNOT_READ_BEFORE_RENDER` | `pending.account` was read before the blocks were computed | `await builder.computeBlocks()` first. |
| `CLIENT_BUILDER_AMOUNT_IS_ZERO` | A zero amount | Amounts must be positive `bigint` base units. |
| `CLIENT_SIGNER_REQUIRES_PRIVATE_KEY` | A read-only client or a public-key-only account tried to sign | Build the client with a key-pair account loaded from its seed. |
| `CLIENT_NO_REPS_AVAILABLE`, `CLIENT_PUBLISH_AID_NOT_AVAILABLE` | The network is unreachable from here | Report the network and the error. Do not switch networks or endpoints. |
| `CLIENT_SWAP_*` | `acceptSwapRequest` found mismatched terms | Do not sign. Renegotiate the swap. |

For errors that support it, `error.shouldRetry` says whether a later retry can succeed.

**Idempotency keys (advanced).** A block can carry an optional `idempotent` key, set with the low-level `Block.Builder`, and `client.getBlockFromIdempotent(key)` looks it up. The high-level `send()` and builder don't set one, so check history before you retry.

## Anchor errors

| Error | Meaning | What to do |
| --- | --- | --- |
| `KYCShareNeeded` | The provider needs identity attributes | Share exactly `neededAttributes` with `shareWithPrincipals`, with consent ([identity.md](identity.md)). |
| `AdditionalKYCNeeded` | The provider needs more verification | A person completes `toCompleteFlow.url`. |
| `UserActionNeeded` | On-chain setup is needed (add a certificate, grant a permission) | `Errors.UserActionNeeded.addOperationsToBuilder(error.actionsNeeded, builder)`, show the operations, publish after approval. |
| `KeetaAnchorUserValidationError` | Invalid request fields | Fix `error.fields[].path`. Do not resubmit blindly. |
| `KeetaAnchorCertificateRequiredError` | The anchor requires a certificate (`kind: 'missing'` or `'untrusted'`) | Get one from an issuer in `acceptedIssuers` and attach it. |
| FX `QuoteValidationFailed`, or an expired quote | The quote expired or changed | Fetch a new quote and ask for approval again. |
| `plan.execute()` throws partway through a multi-hop plan | A step failed. `plan.state` holds `completedSteps` and `failedAtStepIndex`. | **Never re-run the plan.** Reconcile balances, then plan only the remaining leg. |
| Empty provider list or `null` | Nothing serves that corridor, pair or country on this network | Stop and report. Never guess an endpoint or provider. |
| `No valid root metadata found` | Resolver metadata couldn't be read; often the network is unreachable | Report a discovery failure. Don't conclude that no provider exists. |

## Common mistakes

- **Decimals:**
  - Assuming a token's decimals. Read `decimalPlaces` from metadata. Docs, tools and examples have disagreed about KTA.
  - Treating `1n` as one whole token. It is one base unit.
- **Network:**
  - Building on the wrong network. Test and main have different token addresses, and the same seed gives the same address on both.
  - Expecting a faucet on `main`. There isn't one.
- **Faucet:** sending a `Content-Type` with a `;charset` suffix (the faucet rejects it), or parsing its HTML reply. Poll the balance instead.
- **Publishing:**
  - Publishing from one account in parallel, for example concurrent x402 payments. Queue them.
  - Calling `history()` or `chain()` without `depth`, which pages through the account's entire history.
- **Packages:**
  - Importing the storage client from the package root. It is a deep import: `@keetanetwork/anchor/services/storage/client.js`.
  - Looking for KYB without `entityType: 'business'`. Business providers are filtered out by default.
  - Installing a different `@keetanetwork/keetanet-client` version than the one `@keetanetwork/anchor` depends on (check with `npm view @keetanetwork/anchor dependencies`). TypeScript then reports `#private` type mismatches between the two `UserClient` copies. Pin the same version, or use the client through `KeetaAnchor.KeetaNet`.
- **Values:**
  - Reusing an FX quote after it expires, about five minutes after signing.
  - Copying token addresses from old examples. Resolve them from resolver metadata at run time.
