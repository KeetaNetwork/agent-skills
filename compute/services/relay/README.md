# @keeta-compute/relay

A Cloudflare Worker with two hosts:

- **relay.keeta.ai**, the provider relay. Each provider keeps an outbound WebSocket to its own Durable Object (`ProviderChannel`), so no provider opens a port. A buyer's agent posts a ticketed job (`POST /v1/jobs/:id/run`); the relay checks the ticket's MAC, forwards the job down the socket, streams the answer back as server-sent events, and posts a delivery record (a hash of the text it forwarded, when the buyer brought the ticket, and when it hung up if nothing had been forwarded) to the control plane, retrying until it is taken (`src/delivery.ts`). When the provider is not connected it records that instead, so the buyer, who showed up, owes no no-show fee. Prompts pass through memory only.
- **api.keeta.ai**, the public OpenAI-compatible router. `POST /v1/chat/completions` answers HTTP 402 with an x402 quote in KUSD (USDC until KUSD is pinned), verifies the payment through the facilitator, has the provider accept the job and hold a slot, settles the payment, and only then starts the job. A provider that is offline, busy or refuses the ticket is never paid. A payer cannot spend a verified payment elsewhere and still get the job run, because x402 verify only simulates the send. With a fallback configured on the control plane, a request no provider can take runs on OpenRouter instead.

Settings: `CONTROL_URL`, `NETWORK` and `FACILITATOR_URL` in `wrangler.toml`; `RELAY_SECRET`, `ROUTER_SECRET` and the optional `OPENROUTER_API_KEY` as Worker secrets. `test/worker.test.ts` in `compute/` runs this Worker under `wrangler dev` with a real provider.

## Develop

From `compute/`:

```bash
npm test -w @keeta-compute/relay
npm run typecheck -w @keeta-compute/relay
npm run dev -w @keeta-compute/relay        # wrangler dev
```
