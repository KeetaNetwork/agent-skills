# keeta.ai

This repository is keeta.ai: Keeta Compute, a market for AI inference paid with Keeta stablecoins. The Keeta agent skills live at [keeta.md](https://keeta.md) ([KeetaNetwork/keeta.md](https://github.com/KeetaNetwork/keeta.md)).

## Keeta Compute

AI inference from spare compute, paid per request. Apple Silicon Macs sell capacity through the macOS app, and Linux GPU machines through the same agent on the command line, running open-weight models. It is in a test-network preview.

- **Paying.** Buyers pay with Keeta stablecoins: KUSD first, then KEUR, KJPY, KMXN, KCAD, KAED, KGBP, and USDC. In the app and the CLI they swap them for Keeta Compute Credits, a token on the Keeta ledger worth one US dollar, through keeta.ai's FX provider. Before a request runs, its maximum cost in credits is escrowed with keeta.ai's settlement account. Afterwards one ledger block pays the provider what it billed, less a 0.25% network fee, and returns the rest to the buyer; a ticket not used within 10 seconds pays the provider a 0.001-credit no-show fee for the slot it held. Clients without the app pay per request with x402 through the public router, which settles the same way. Buyers pay the listed price; the fee comes out of the provider's share.
- **Balances live on the Keeta ledger.** The control plane keeps routing state and block hashes, never balances, amounts owed or earnings.
- **Parts.** Each part is its own package with its own README and tests, and could move to its own repository: `protocol`, `runtime-openai`, `runtime-mlx`, `tokens`, `wallet`, `provider`, `buyer`, `agent` and `cli` in [`compute/packages/`](compute/packages/); the control plane, relay and FX provider in [`compute/services/`](compute/services/); the macOS app in [`compute/macos/`](compute/macos/). The end-to-end and live test-network suites in `compute/test/` run them together.
- **Docs.** [`compute/README.md`](compute/README.md) covers how a job flows, the keys, and how to develop, test and deploy. The developer docs are at <https://keeta.ai/compute/>, built from `site/compute/`: every page is plain HTML with a Markdown twin (for example <https://keeta.ai/compute/router.md>), and the build fills the models table from `compute/packages/protocol/catalog.json`.

## Agent Skills

The Keeta agent skills (wallets, payments, bank payouts, cards, bridges, FX, identity and x402) moved to [KeetaNetwork/keeta.md](https://github.com/KeetaNetwork/keeta.md) and are served for agents at <https://keeta.md>. To get started:

| Where | Command |
| --- | --- |
| Any agent | `Read https://keeta.md/SKILL.md and follow it to work with Keeta.` |
| The `skills` CLI (Claude Code, Cursor, Codex and others) | `npx skills add https://keeta.md` |
| Claude Code plugin | `/plugin marketplace add KeetaNetwork/keeta.md`, then `/plugin install keeta@keeta` |

keeta.ai's old skill URLs (`/SKILL.md`, `/skills/…`, `/llms-full.txt` and the `/.well-known/` skill indexes) redirect to the same paths on keeta.md.
Claude Code users who added the old `KeetaNetwork/agent-skills` marketplace (this repository before it was renamed `keeta-inference`; GitHub redirects the old name) keep the `keeta` plugin: `.claude-plugin/marketplace.json` here now installs it from KeetaNetwork/keeta.md.

## Hosting on keeta.ai

keeta.ai is the Cloudflare Pages project `agent-skills` (named before the repository was renamed), connected to this repository. Pages builds every push. `main` deploys to keeta.ai, and other branches and pull requests get preview URLs.

The build turns `site/` into `_site/`, the folder Pages serves, and fills the Compute models table from `compute/packages/protocol/catalog.json`.

| Setting | Value | Where it's set |
| --- | --- | --- |
| Build command | `python3 .github/scripts/build-site.py` | Pages dashboard |
| Build output directory | `_site` | `wrangler.toml` |
| Production branch | `main` | Pages dashboard |

| Path | Content |
| --- | --- |
| `/` | the Keeta Compute home page |
| `/compute/<page>` and `/compute/<page>.md` | the Compute docs, as HTML and as Markdown |
| `/llms.txt` | a plain index for LLMs: the Compute docs, and where the skills live |
| `/SKILL.md`, `/skills/…`, `/llms-full.txt`, `/.well-known/…` | 301 redirects to the same paths on keeta.md |

- **Response headers.** `site/_headers` lets any origin fetch `llms.txt` and the Compute docs, so browser-based agents can read them. Pages applies the file and doesn't publish it.
- **Redirects.** `site/_redirects` sends the old skill URLs to keeta.md. Pages adds `Access-Control-Allow-Origin: *` to the redirects too, so browser-based agents follow them; CI checks this under `wrangler pages dev`. Merge and deploy keeta.md before a keeta.ai build with these redirects reaches `main`, so the old URLs and the old marketplace never point at nothing.
- **Not found.** Pages serves `404.html` with status 404 for any path that doesn't exist.

**One-time setup:**

1. **Build.** In the Cloudflare dashboard, open Workers & Pages → `agent-skills` → Settings → Build. Set the build command above, with framework preset None and the root directory left blank.
2. **Domain.** Under Custom domains, add `keeta.ai`. If the keeta.ai zone is in the same Cloudflare account, Pages creates the DNS record.
3. **Deploy.** Retry the latest deployment, or push to `main`.

Build and check locally:

```bash
python3 .github/scripts/build-site.py
npx wrangler@4.151.0 pages dev _site      # serves _site/ the way Pages does, on http://localhost:8788
```

## Repository layout

| Path | Contents |
| --- | --- |
| `site/` | the home page and 404 page, plus `_headers` and `_redirects` for Cloudflare |
| `.claude-plugin/marketplace.json` | the old plugin marketplace, kept so existing installs of the `keeta` plugin update from KeetaNetwork/keeta.md |
| `site/assets/` | the official Keeta wordmark and app icon, the link-preview image, and self-hosted Geist fonts (SIL Open Font License, in `fonts/OFL.txt`) |
| `wrangler.toml` | Cloudflare Pages settings: the project name and the `_site` output directory |
| `compute/packages/` | Keeta Compute's packages: protocol, runtimes, wallet, provider, buyer, agent and CLI |
| `compute/services/` | the control plane (Firebase), relay and router (Cloudflare Workers) and FX provider |
| `compute/macos/` | the macOS app |
| `compute/test/` | the end-to-end, Worker and live test-network suites |
| `site/compute/` | the Keeta Compute docs at keeta.ai/compute |

## License

Apache-2.0
