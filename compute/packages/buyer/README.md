# @keeta-compute/buyer

The buyer side of a Keeta Compute node: a local OpenAI-compatible endpoint (`POST /v1/chat/completions`, `GET /v1/models`) that tools and agents on the machine call with a bearer token.

For each request `Buyer`:

1. asks the control plane for a quote: the job's maximum cost in credits, from a provider whose cost fits under the Mac's per-request and remaining daily limits (sent as `maxCost`), for the requested output limit and an input limit of the prompt's exact token count plus a small margin (counted with the model's pinned tokenizer through `@keeta-compute/tokens`, or the prompt's size when the model has none);
2. checks the quote against the request and the local per-request and daily limits;
3. sends that maximum from the agent budget to keeta.ai's settlement account with the job id as the reference, saves the block, and reports it until the control plane issues the ticket;
4. streams the answer from the provider through the relay;
5. checks the provider's signed receipt against the ticket and the text it received.

Settlement happens on the ledger: the provider is paid what it billed and the rest of the escrow comes back. `followUp` reports saved escrows again after a restart and settles jobs whose receipt arrived late.

It reads and writes the node's saved state through `BuyerStore` (`src/store.ts`); the agent's `StateStore` implements it.

Depends on `@keeta-compute/protocol`, `@keeta-compute/tokens` and `@keeta-compute/wallet`.

## Develop

From `compute/`:

```bash
npm test -w @keeta-compute/buyer
npm run typecheck -w @keeta-compute/buyer
```
