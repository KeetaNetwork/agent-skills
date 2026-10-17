# @keeta-compute/provider

The provider side of a Keeta Compute node.

- **`Provider`** registers the node with the control plane, heartbeats its offers and load, and keeps an outbound WebSocket to the relay. For each job it checks the ticket (coordinator signature, its own key and network, expiry, model, price, allowlist and the buyer's signature) and that the prompt, counted with the model's pinned tokenizer through `@keeta-compute/tokens`, fits the ticket's input limit (a request far larger than its ticket, past `maxPromptBoundFor`, or one that arrives with no free slot, is refused before it is counted), runs it on the model's local server through `@keeta-compute/runtime-openai`, and signs a receipt with the token counts, price, amount and weights hash. It pauses on battery or when the Mac is in use, per the operator's policy.
- **`ModelManager`** installs catalog models from their pinned Hugging Face commit, checks the weights hash, leaves the model's folder holding only the files that hash covers (an interrupted install of another revision can leave other shards, and the runtime loads every weight file in the folder), keeps installed models and their offers, and registers models already served on this machine (Linux).
- **Hardware** probes: memory, chip, free disk, battery and idle time.

It reads and writes the node's saved state through `ProviderStore` (`src/store.ts`); the agent's `StateStore` implements it.

`npm run catalog:pin` (from `compute/`, needs huggingface.co) pins every catalog model to its current commit, weights hash and tokenizer file hashes in `@keeta-compute/protocol`.

Depends on `@keeta-compute/protocol`, `@keeta-compute/runtime-openai`, `@keeta-compute/runtime-mlx` and `@keeta-compute/tokens`.

## Develop

From `compute/`:

```bash
npm test -w @keeta-compute/provider
npm run typecheck -w @keeta-compute/provider
```
