# Keeta Compute for macOS

Status: test-network preview. The app uses the Keeta test network and test stablecoins.

One app does both sides of the market: it sells your Mac's spare capacity, and it buys inference for the agents running on your Mac. Both sides are paid in Keeta Compute Credits, which you buy and cash out with Keeta stablecoins.

## Requirements

- macOS 15 or later.
- Apple Silicon (M1 or later).
- To provide capacity: 32 GB of unified memory or more. Macs with less than 32 GB can buy inference, but cannot provide it at launch.

## Install

- Download: [Keeta Compute for macOS](https://keeta.ai/compute/download). Coming soon: this link is not live yet.
- Move the app to Applications and open it.

## First run

1. The app creates your wallet and secures it with a passkey. There is no recovery phrase to write down.
2. The passkey syncs through iCloud Keychain, so another Mac signed in to the same Apple Account can open the same wallet.
3. Your wallet address (`keeta_…`) is your identity on the network. Your earnings are paid to it and providers can allowlist it.
4. The app checks the hardware: chip, memory, free disk, and a short benchmark.

## Pay with Keeta stablecoins

Keeta Compute Credits pay for requests and are what providers earn. A credit is a token on the Keeta ledger worth one US dollar, with 6 decimals.

- **Buy credits.** In Wallet, choose Buy credits, pick a stablecoin (KUSD by default; also KEUR, KJPY, KMXN, KCAD, KAED, KGBP and USDC) and the number of credits. The app shows what they cost and the most you'll pay (0.5% over the estimate), then swaps them through keeta.ai's exchange once you confirm with Touch ID. If the exchange's price has moved past that, nothing is swapped and you see the new price. KUSD and USDC buy credits one to one; the other stablecoins at the exchange's rate. New credits go to the Agent budget unless you turn that off.
- **Cash out.** Choose Cash out to sell credits from your balance for any of those stablecoins. The app shows what you'll receive and the least you'll accept (0.5% under the estimate).
- **Balances.** The app reads every balance from the Keeta ledger: your credits, the Agent budget's credits, the stablecoins you hold, and a little KTA for network fees.
- **Send and receive.** You can send credits to, and receive credits or stablecoins from, any Keeta address.

## Provide capacity

### Hardware tiers

| Tier | Hardware | Typical work |
| --- | --- | --- |
| A | 2 to 4 Mac Studios (256 or 512 GB) linked by Thunderbolt 5 | The largest open models. Clusters are not scheduled in this version. |
| B | One Mac with 64 to 256 GB | Mid-size models, coding agents |
| C | One Mac with 32 to 64 GB | Small models, batch work |
| none | Less than 32 GB | Can buy, cannot provide at launch |

A tier describes what a machine proves in its benchmark, not the badge on it.

### Models

- The Models tab lists the [catalog](https://keeta.ai/compute/models.md) models that fit your Mac. A model may use about two thirds of memory on Macs under 64 GB and about three quarters above that. The rest stays free for macOS and your own work.
- Installing a model downloads its weights and hashes them. That weights hash appears on every receipt you sign.
- Offering is per model. Each installed model can be offered to the network or kept for your own use.
- Set a price per million input tokens and per million output tokens, in credits, for each offered model. The catalog suggests a price, and you can change it.
- Read the model's license before you offer it. Its terms are your responsibility as the operator.

### When and to whom

- **Schedules.** Choose the hours and days the Mac takes jobs.
- **Pause.** Take the Mac off the network at any time, and resume when you want.
- **Public.** Any buyer on the network can use your offered models.
- **Allowlist.** Only jobs paid from buyer addresses on your list (`keeta_…`). A Mac's lists hold up to 1000 addresses in total, counting this list and the lists of models that set their own. The scheduler never sends an unlisted buyer's job to you, and your Mac checks the paying address on the ticket again before it runs anything.
- **More machines.** Add Linux machines to your fleet as [helpers](https://keeta.ai/compute/helper.md). Their earnings go to this Mac's wallet.

## Get paid

- You earn credits for each completed request, paid to your wallet on the Keeta ledger. The amount is the tokens used times your price ([pricing math](https://keeta.ai/compute/protocol.md)).
- The buyer's credits are escrowed before your Mac runs anything. When your signed receipt matches what the relay forwarded, one Keeta transaction pays you what you billed. A receipt that bills anything else is not paid and counts against you.
- A ticket reserves one of your Mac's slots. If the buyer does not use it promptly, you keep a 0.001-credit no-show fee from the escrow. A buyer hanging up within 10 seconds, before your Mac answers, does not count against you; one that waited longer counts as a stall.
- Earnings in the app are read from the ledger: what keeta.ai's settlement account sent your wallet.
- Requests from the public router are paid to your wallet directly in KUSD (USDC until KUSD is live).
- Cash credits out to KUSD or another Keeta stablecoin whenever you like.
- Bank deposits and withdrawals go through Keeta's banking anchors and need identity verification (KYC for people, KYB for businesses). Coming later; not part of the preview.

## Buy inference for agents on this Mac

The app serves an OpenAI-compatible API on this Mac only:

```text
http://127.0.0.1:11435/v1
```

- `GET /v1/models` lists the models you can buy, with the lowest price on the network.
- `POST /v1/chat/completions` takes the OpenAI request format. `stream: true` is supported.
- Every request needs the bearer token shown in the app. Treat it like a password: any program holding it can spend your Agent budget.
- Spend limits: set a maximum per request and per day, in credits. A request is refused before anything is escrowed if its most possible cost is over the per-request limit, or would take the day's spending over the daily limit.
- Set `max_tokens` on each request to bound its cost.

curl:

```bash
curl http://127.0.0.1:11435/v1/chat/completions \
  -H "Authorization: Bearer $KEETA_COMPUTE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model": "qwen3-8b", "messages": [{"role": "user", "content": "Say hello."}], "max_tokens": 200}'
```

OpenAI Python SDK:

```python
import os
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:11435/v1",
    api_key=os.environ["KEETA_COMPUTE_TOKEN"],  # the token shown in the app
)
response = client.chat.completions.create(
    model="qwen3-8b",
    messages=[{"role": "user", "content": "Say hello."}],
    max_tokens=200,
)
print(response.choices[0].message.content)
```

Tools that read the standard OpenAI environment variables work without code changes:

```bash
export OPENAI_BASE_URL=http://127.0.0.1:11435/v1
export OPENAI_API_KEY=<token shown in the app>
```

### How the app pays

1. The scheduler picks a provider and quotes the most the request can cost, from its price and the request's token limits (at least 0.001 credits). The app checks that against your spend limits.
2. The app escrows that many credits from your Agent budget with keeta.ai's settlement account, in one Keeta transaction that names the job, and gets a ticket for the job. The ticket reserves a slot on the provider. It escrows each job once, even if it retries.
3. The request goes to the provider through the relay, and the tokens stream back to your agent. The relay records a hash of what it forwarded.
4. The provider signs a receipt with the token counts and the amount, and the app checks it against the ticket and the text it received.
5. Settlement is one Keeta transaction from the settlement account: when the receipt matches the relay's record, the provider gets what it billed and the rest comes back to your Agent budget. If the provider fails, the receipt bills other text, or no receipt arrives, all of it comes back. The ticket reserves the provider, so if the request does not reach the relay within 10 seconds (the app quit or lost its connection), or your agent cancels it within 10 seconds before any text arrives, the provider keeps a no-show fee of 0.001 credits and the rest comes back. No x402 round trip is needed between apps.
