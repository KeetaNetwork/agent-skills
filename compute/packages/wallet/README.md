# @keeta-compute/wallet

The Keeta wallet of a Keeta Compute node.

- **Keys** (`src/keys.ts`): the node key (Secure Enclave through the app on a Mac, or a 0600 file), the agent budget key per network (a 0600 file that holds only what the operator moved into it), and the operator key derived from 32 bytes of entropy on demand and never stored.
- **Wallet file** (`src/wallet-file.ts`): on Linux, the operator's entropy encrypted with scrypt and AES-256-GCM under the user's passphrase in `operator-wallet.json` (0600), with a 24-word recovery phrase that is also a Keeta passphrase.
- **Ledger** (`src/ledger.ts`): `KeetaLedger` sends tokens with a reference, reads balances and what one account received from another, and asks the test faucet for KTA. `SerialQueue` runs one account's sends one at a time.
- **Credits** (`src/fx.ts`, `src/assets.ts`): `AnchorCreditExchange` swaps stablecoins and Keeta Compute Credits through keeta.ai's FX provider, found with the anchor resolver; the asset helpers name and scale credits, KTA and the pinned stablecoins.

Balances are always read from the ledger; nothing here keeps a balance.

Depends on `@keeta-compute/protocol`, `@keetanetwork/keetanet-client`, `@keetanetwork/anchor` and `@scure/bip39`.

## Develop

From `compute/`:

```bash
npm test -w @keeta-compute/wallet
npm run typecheck -w @keeta-compute/wallet
```
