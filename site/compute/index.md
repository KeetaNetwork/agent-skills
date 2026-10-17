# Keeta Compute

Status: test-network preview. Nothing on these pages runs on the Keeta main network yet. Hostnames such as `api.keeta.ai` are the planned production endpoints.

Keeta Compute is a market for AI inference from spare compute (Apple Silicon Macs and Linux GPU machines), paid with Keeta stablecoins on Keeta Network.

- **Pay with Keeta stablecoins.** KUSD first, then KEUR, KJPY, KMXN, KCAD, KAED, KGBP and USDC. In the app you swap them for Keeta Compute Credits, a token on the Keeta ledger worth one US dollar each, and cash credits back out to any of them.
- **Providers.** A Mac or a Linux machine sells its spare inference capacity. It runs open-weight models and earns credits for each completed request, paid on the ledger to its own wallet.
- **Buyers on a Mac.** The same macOS app buys inference for the agents running on that Mac, through a local OpenAI-compatible endpoint, within spend limits you set.
- **Everyone else.** A public API router at `https://api.keeta.ai/v1` serves the same models to servers and other platforms. It speaks the OpenAI chat API and charges per request with x402 in KUSD (in USDC until KUSD is live on the network).

Payments settle on Keeta. Prompts and outputs never go on chain.

## How it works

1. A provider installs the macOS app. The app creates a passkey wallet and checks the hardware.
2. The provider installs models that fit, sets a price in credits per million tokens for each, and offers them to everyone or only to listed buyer addresses.
3. A buyer sends an OpenAI-style chat request: an agent through the app's local endpoint, or any client through the public router.
4. The scheduler picks an online provider that has the model, accepts that buyer and fits the price, and quotes the most the job can cost.
5. The app escrows that much in credits with keeta.ai's settlement account on the Keeta ledger, and gets a ticket for that one job, which reserves a slot on the provider.
6. The provider runs the job, streams the tokens back through the relay, and signs a receipt. The relay records what it forwarded.
7. When the receipt matches the relay's record, one Keeta transaction pays the provider what it billed, less a 0.25% network fee, and returns the rest to the buyer. A ticket not brought to the relay within 10 seconds, or cancelled before any text, pays the provider a 0.001-credit no-show fee. Anything else returns the whole escrow. The result feeds the provider's reputation.

## Trust and privacy

- A provider can see the prompts it serves and the text it generates. Running a request on someone else's Mac is not private from that Mac's operator.
- For sensitive work, use your own machines or an allowlist. A provider can serve only listed buyer addresses, such as your own other machines or your company.
- Every response comes with a receipt signed by the provider. It names the model, the weights hash, the runtime and its version, the input and output tokens, the price and the amount. Check it against what you asked for.
- A receipt is a signed statement by the provider. It is not a cryptographic proof that the work was done as described. A provider is paid only when its receipt matches what the relay forwarded.
- The network never stores prompts or outputs. The relay passes them through, and job records keep the receipt, which holds only a sha256 hash of the output.
- Balances and earnings live only on the Keeta ledger. Job records keep the hashes of the escrow and payout transactions, not balances.

## Pages

- [macOS app](https://keeta.ai/compute/app.md): install, buy credits with Keeta stablecoins, provide capacity, get paid, buy for local agents.
- [Models](https://keeta.ai/compute/models.md): the catalog, memory needs, licenses and suggested prices.
- [Public API router](https://keeta.ai/compute/router.md): endpoints, x402 payment flow, receipts, errors.
- [Linux](https://keeta.ai/compute/helper.md): run a full node from the command line with its own wallet, or add a machine to a fleet as a helper.
- [Protocol](https://keeta.ai/compute/protocol.md): identities, signed requests, credits, escrow and settlement, receipts, pricing math.

Each page is also served as Markdown: add `.md` to its path, for example `https://keeta.ai/compute/router.md`.

Keeta Compute builds on the [Keeta agent skills](https://keeta.md/), which cover wallets, payments and [x402](https://keeta.md/skills/x402-payments/SKILL.md).
