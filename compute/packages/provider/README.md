# @keeta-compute/provider

The provider side of a Keeta Compute node.

- **`Provider`** registers the node with the control plane, heartbeats its offers and load, and keeps an outbound WebSocket to the relay. For each job it checks the ticket (coordinator signature, its own key and network, expiry, model, price, allowlist and the buyer's signature), runs it on the model's local server through `@keeta-compute/runtime-openai`, and signs a receipt with the token counts, price, amount and weights hash. It pauses on battery or when the Mac is in use, per the operator's policy.
- **`ModelManager`** installs catalog models from their pinned Hugging Face commit, checks the weights hash, keeps installed models and their offers, and registers models already served on this machine (Linux).
- **Hardware** probes: memory, chip, free disk, battery and idle time.

It reads and writes the node's saved state through `ProviderStore` (`src/store.ts`); the agent's `StateStore` implements it.

`npm run catalog:pin` (from `compute/`, needs huggingface.co) pins every catalog model to its current commit and weights hash in `@keeta-compute/protocol`.

Depends on `@keeta-compute/protocol`, `@keeta-compute/runtime-openai` and `@keeta-compute/runtime-mlx`.

## Develop

From `compute/`:

```bash
npm test -w @keeta-compute/provider
npm run typecheck -w @keeta-compute/provider
```
