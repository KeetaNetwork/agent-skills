# Keeta Compute

Status: test-network preview. Nothing on these pages runs on the Keeta main network yet. Hostnames such as `api.keeta.ai` are the planned production endpoints.

Keeta Compute is a market for AI inference from spare compute (Apple Silicon Macs and Linux GPU machines), paid per request in USDC on Keeta Network.

- **Providers.** A Mac or a Linux machine sells its spare inference capacity. It runs open-weight models and is paid per completed request, in USDC, straight to its own wallet.
- **Buyers on a Mac.** The same macOS app buys inference for the agents running on that Mac, through a local OpenAI-compatible endpoint, within spend limits you set.
- **Everyone else.** A public API router at `https://api.keeta.ai/v1` serves the same models to servers and other platforms. It speaks the OpenAI chat API and charges per request with x402.

Payments settle on Keeta. Prompts and outputs never go on chain.

## How it works

1. A provider installs the macOS app. The app creates a passkey wallet and checks the hardware.
2. The provider installs models that fit, sets a price per million tokens for each, and offers them to everyone or only to listed buyer addresses.
3. A buyer sends an OpenAI-style chat request: an agent through the app's local endpoint, or any client through the public router.
4. The scheduler picks an online provider that has the model, accepts that buyer and fits the price, and signs a ticket for that one job.
5. The provider runs the job, streams the tokens back through the relay, and signs a receipt.
6. The buyer pays the provider directly in USDC, and the result feeds the provider's reputation.

## Trust and privacy

- A provider can see the prompts it serves and the text it generates. Running a request on someone else's Mac is not private from that Mac's operator.
- For sensitive work, use your own machines or an allowlist. A provider can serve only listed buyer addresses, such as your own other machines or your company.
- Every response comes with a receipt signed by the provider. It names the model, the weights hash, the runtime and its version, the input and output tokens, the price and the amount. Check it against what you asked for.
- A receipt is a signed statement by the provider. It is not a cryptographic proof that the work was done as described.
- The network never stores prompts or outputs. The relay passes them through, and job records keep the receipt, which holds only a sha256 hash of the output.

## Pages

- [macOS app](https://keeta.ai/compute/app.md): install, provide capacity, get paid, buy for local agents.
- [Models](https://keeta.ai/compute/models.md): the catalog, memory needs, licenses and suggested prices.
- [Public API router](https://keeta.ai/compute/router.md): endpoints, x402 payment flow, receipts, errors.
- [Linux](https://keeta.ai/compute/helper.md): run a full node from the command line with its own wallet, or add a machine to a fleet as a helper.
- [Protocol](https://keeta.ai/compute/protocol.md): identities, signed requests, jobs, receipts, pricing math.

Each page is also served as Markdown: add `.md` to its path, for example `https://keeta.ai/compute/router.md`.

Keeta Compute builds on the [Keeta agent skills](https://keeta.ai/), which cover wallets, payments and [x402](https://keeta.ai/skills/x402-payments/SKILL.md).
