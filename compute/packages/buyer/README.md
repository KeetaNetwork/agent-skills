# @keeta-compute/buyer

The buyer side of a Keeta Compute node: a local OpenAI-compatible endpoint (`POST /v1/chat/completions`, `GET /v1/models`) that tools and agents on the machine call with a bearer token.

For each request `Buyer`:

1. asks the control plane for a quote: the credits to escrow (the job's maximum cost, and at least the no-show fee), from a provider whose cost fits under the Mac's per-request and remaining daily limits (sent as `maxCost`; escrows of requests not billed yet count as spent), for the requested output limit and an input limit of the prompt's exact token count plus a small margin (counted with the model's pinned tokenizer through `@keeta-compute/tokens`, or the prompt's size when the model has none);
2. checks the quote against the request and the local per-request and daily limits, and holds its escrow against the daily limit until the job's bill is counted, so parallel requests cannot pass the limit together;
3. sends that amount from the agent budget to keeta.ai's settlement account with the job id as the reference, saves the block, and reports it until the control plane issues the ticket (or, if no provider has a free slot by then, refunds it);
4. streams the answer from the provider through the relay;
5. checks the provider's signed receipt against the ticket and the text it received, and counts what it bills against the daily limit (a receipt that breaks the ticket's terms, such as one with a negative token count, is not counted).

Settlement happens on the ledger: the provider is paid what it billed and the rest of the escrow comes back. A ticket not used promptly (not at the relay within 10 seconds, or cancelled before any text) also pays the provider the no-show fee. `followUp` cancels the quote of an escrow its request gave up on before reporting the block again (so it is refunded rather than ticketed), and reads how jobs settled: what the escrow paid the provider, or the no-show fee, counts against the daily limit once, on the day the job ran on this node. A job counted from a streamed receipt that billed less than the receipt the control plane paid is topped up to what was paid.

If the endpoint cannot open its port (another program is listening there), `status` reports the error instead of the address and the token, since tools pointed at the port would reach that program; the Linux CLI's `run` stops with that error.

It reads and writes the node's saved state through `BuyerStore` (`src/store.ts`); the agent's `StateStore` implements it.

Depends on `@keeta-compute/protocol`, `@keeta-compute/tokens` and `@keeta-compute/wallet`.

## Develop

From `compute/`:

```bash
npm test -w @keeta-compute/buyer
npm run typecheck -w @keeta-compute/buyer
```
