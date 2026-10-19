# @keeta-compute/agent

The node agent. `AgentApp` ties the wallet, provider and buyer together and implements the JSON-RPC contract in `@keeta-compute/protocol/rpc`: the macOS app drives it over stdio (`RpcPeer`), and the Linux CLI calls it directly.

- **Saved state** (`StateStore`): one JSON file (0600) in the data directory with policies, installed models, the operator link proof, job history, today's spend for the local limits and escrows still to be reported. It implements the provider's and the buyer's store interfaces. A running node shares it with one-shot CLI commands: when one of them saves it, the node reads it again before its next read or save, so a rotated token or a new policy applies at once and is not undone (a new network or control plane rebuilds the node's connections). Balances and earnings are read from the ledger, never kept here.
- **Wallet operations**: balances, sends, moving credits into and out of the agent budget, buying and cashing out credits. Each call that spends from the operator wallet carries the passkey's PRF output from the app (the CLI unlocks its wallet file with the passphrase instead), and the operator key is dropped after the call.
- **Fleet**: pairing Linux helpers by code and approving them.

Depends on `@keeta-compute/protocol`, `@keeta-compute/wallet`, `@keeta-compute/provider`, `@keeta-compute/buyer`, `@keeta-compute/runtime-mlx` and `@keeta-compute/tokens`.

## Develop

From `compute/`:

```bash
npm test -w @keeta-compute/agent
npm run typecheck -w @keeta-compute/agent
```
