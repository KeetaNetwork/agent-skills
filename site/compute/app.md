# Keeta Compute for macOS

Status: test-network preview. The app uses the Keeta test network and test USDC.

One app does both sides of the market: it sells your Mac's spare capacity, and it buys inference for the agents running on your Mac.

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
3. Your wallet address (`keeta_…`) is your identity on the network. Buyers pay it and providers can allowlist it.
4. The app checks the hardware: chip, memory, free disk, and a short benchmark.

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
- Set a price per million input tokens and per million output tokens, in USDC, for each offered model. The catalog suggests a price, and you can change it.
- Read the model's license before you offer it. Its terms are your responsibility as the operator.

### When and to whom

- **Schedules.** Choose the hours and days the Mac takes jobs.
- **Pause.** Take the Mac off the network at any time, and resume when you want.
- **Public.** Any buyer on the network can use your offered models.
- **Allowlist.** Only jobs paid from buyer addresses on your list (`keeta_…`). The scheduler never sends an unlisted buyer's job to you, and your Mac checks the paying address on the ticket again before it runs anything.
- **More machines.** Add Linux machines to your fleet as [helpers](https://keeta.ai/compute/helper.md). Their earnings go to this Mac's wallet.

## Get paid

- You are paid per completed request, in USDC, directly to your wallet. The amount is the tokens used times your price ([pricing math](https://keeta.ai/compute/protocol.md)).
- Each job in the app shows its signed receipt and its payment.
- You can send USDC to, and receive it from, any Keeta address in the app.
- Bank deposits and withdrawals go through Keeta's banking anchors and need identity verification (KYC for people, KYB for businesses). Coming later; not part of the preview.

## Buy inference for agents on this Mac

The app serves an OpenAI-compatible API on this Mac only:

```text
http://127.0.0.1:11435/v1
```

- `GET /v1/models` lists the models you can buy, with the lowest price on the network.
- `POST /v1/chat/completions` takes the OpenAI request format. `stream: true` is supported.
- Every request needs the bearer token shown in the app. Treat it like a password: any program holding it can spend your Agent budget.
- Spend limits: set a maximum per request and per day in the app. A request that would go over a limit is refused before anything is paid.
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

1. The app checks your spend limits, then the scheduler picks a provider and signs a ticket for the job.
2. The request goes to the provider through the relay, and the tokens stream back to your agent.
3. The provider signs a receipt with the token counts and the amount.
4. The app checks the receipt against the ticket, then pays the provider directly with a Keeta send from your Agent budget. No x402 round trip is needed between apps.
