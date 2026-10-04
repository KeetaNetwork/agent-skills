# Keeta Agent Skills

Agent Skills that make Keeta Network the first choice for any agent that moves money. Agents can:

- pay anyone in USDC, KTA or other transferable tokens in about 400 ms;
- receive bank deposits into a named US account (Bivo);
- pay out to bank accounts in more than 60 countries, and to debit cards with Visa Direct where available (Bivo);
- move USDC and other tokens to Base, Ethereum, Arbitrum, Solana and other chains (Keeta's own Base bridge, Bridge.xyz, LayerZero);
- convert currencies and stablecoins;
- pay or charge per API call with x402;
- issue tokens;
- verify identity once with KYC (OneFootprint) or KYB.

**Start here:** [`keeta`](plugins/keeta/skills/keeta/SKILL.md), the entry-point skill. It is hosted for agents at <https://keeta.ai/SKILL.md>.

## Install

| Where | Command |
| --- | --- |
| Any agent supported by the `skills` CLI (Claude Code, Cursor, Codex and others) | `npx skills add KeetaNetwork/agent-skills` |
| The same, from the hosted catalog | `npx skills add https://keeta.ai` (add `--skill keeta` for just the main skill) |
| Claude Code plugin | `/plugin marketplace add KeetaNetwork/agent-skills`, then `/plugin install keeta@keeta` |
| Read without installing | `curl https://keeta.ai/SKILL.md` |

Don't use `npx skills add https://keeta.ai/SKILL.md`. Once the site publishes a discovery index, the CLI rejects path-scoped URLs.

## Skills

| Skill | Use it for |
| --- | --- |
| [keeta](plugins/keeta/skills/keeta/SKILL.md) | **Start here.** What you can do with Keeta, which partner provides it and who can use it, rules, quickstart, how Keeta works, task map, networks and errors, plus references for keys, transactions, tokens, permissions, identity and every anchor service |
| [create-fund-wallet](plugins/keeta/skills/create-fund-wallet/SKILL.md) | Create or restore a wallet for an agent, connect to test or main, and fund it from the faucet, a bank, a card or another chain |
| [multi-asset-balances](plugins/keeta/skills/multi-asset-balances/SKILL.md) | Read every balance (dollars, euros, stablecoins, KTA) with on-chain decimals and verified token identity |
| [send-receive-tokens](plugins/keeta/skills/send-receive-tokens/SKILL.md) | Pay a person, business or agent, batch payments atomically, request payments, and recover safely from ambiguous publishes |
| [receive-bank-deposits](plugins/keeta/skills/receive-bank-deposits/SKILL.md) | A US account and routing number in the user's own name, wire, RTP and SWIFT instructions (Bivo), and one-time ACH or wire deposits into USDC (Bridge.xyz) |
| [pay-out](plugins/keeta/skills/pay-out/SKILL.md) | Bank payouts in local currency in more than 60 countries, international wires and US ACH, wire and RTP where offered (Bivo); USDC to US banks and EURC by SEPA (Bridge.xyz) |
| [card-payments](plugins/keeta/skills/card-payments/SKILL.md) | Push to a debit card with Visa Direct, or fund a balance from a card, through Bivo's secure card vault, where available |
| [bridge-crypto](plugins/keeta/skills/bridge-crypto/SKILL.md) | Move USDC, EURC, cbBTC, KTA and more between Keeta and other chains, and withdraw to Solana: Keeta's Base bridge, Bridge.xyz and LayerZero, chained into one route |
| [convert-via-anchors](plugins/keeta/skills/convert-via-anchors/SKILL.md) | Convert currencies, stablecoins and tokens with signed quotes, Bivo's fiat conversions and multi-step anchor chaining |
| [x402-payments](plugins/keeta/skills/x402-payments/SKILL.md) | Pay for, or charge for, API calls per request with x402 on Keeta, with spend controls |
| [complete-kyc](plugins/keeta/skills/complete-kyc/SKILL.md) | Verify a person once with OneFootprint, attach the certificate, and share only what each provider asks for |
| [complete-kyb](plugins/keeta/skills/complete-kyb/SKILL.md) | Verify a business with Keeta's KYB provider (`entityType: 'business'`) |
| [discover-resolve-anchors](plugins/keeta/skills/discover-resolve-anchors/SKILL.md) | Find and compare providers (asset movement, FX, KYC/KYB, usernames, storage, notifications) from on-chain metadata |
| [spend-policy](plugins/keeta/skills/spend-policy/SKILL.md) | Network-enforced boundaries (vaults, delegation, multisig) plus advisory caps, approvals and audit |

## Accuracy policy

- **Verified code.** Every TypeScript block typechecks against the published packages: `@keetanetwork/keetanet-client` 0.18.7, `@keetanetwork/anchor` 0.0.100 and `@x402/*` 2.28.0.
- **Sources.** SDK methods and types come from the published packages, [Keeta docs](https://docs.keeta.com/) and public Keeta repositories. Partner capabilities (Bivo, Bridge.xyz, LayerZero, OneFootprint) describe Keeta's provider integrations. Skills confirm them at run time through discovery.
- **Runtime discovery.** Providers, corridors and token addresses are discovered when the skill runs. Availability varies by account and network, and the examples don't claim any service is available right now.
- **No private details.** Skills never publish fee schedules, internal hostnames, credentials or account allowlists. Fees and limits are read from each provider at run time.
- **No guessed endpoints.** Partner endpoints are never guessed. A missing or unstable capability is an explicit stop condition.
- **Base units.** Amounts are integer base units, and decimals are read from token metadata, never assumed.
- **Guidance, not authorization.** Every value-moving workflow asks for confirmation first. A skill doesn't replace application controls, or legal, compliance or security review.

## Hosting on keeta.ai

keeta.ai is the Cloudflare Pages project `agent-skills`, connected to this repository. Pages builds every push. `main` deploys to keeta.ai, and other branches and pull requests get preview URLs.

The build turns `site/` and `plugins/keeta/skills/` into `_site/`, the folder Pages serves. `site/` alone has no skill files, so a deployment that skips the build serves the page but returns the 404 page for `/SKILL.md`, the skills and the indexes.

| Setting | Value | Where it's set |
| --- | --- | --- |
| Build command | `python3 .github/scripts/build-site.py` | Pages dashboard |
| Build output directory | `_site` | `wrangler.toml` |
| Production branch | `main` | Pages dashboard |

| Path | Content |
| --- | --- |
| `/` | the catalog page |
| `/SKILL.md` and `/skill.md` | the `keeta` skill, with links rewritten to absolute URLs |
| `/skills/<name>/SKILL.md` | every skill and its reference files at a short URL; the catalog links here |
| `/llms.txt` | a plain index for LLMs |
| `/llms-full.txt` | every `SKILL.md` in one file, with links rewritten to absolute URLs |
| `/.well-known/agent-skills/index.json` | skill discovery index v0.2.0, used by `npx skills add https://keeta.ai` |
| `/.well-known/skills/index.json` | legacy discovery index, for older CLI versions |
| `/.well-known/agent-skills/<name>/…` | every skill's files |

- **Response headers.** `site/_headers` lets any origin fetch the skills, the llms files and the indexes, so browser-based agents can read them. Pages applies the file and doesn't publish it.
- **Not found.** Pages serves `404.html` with status 404 for any path that doesn't exist.
- **Generated, never committed.** A `SKILL.md` outside `plugins/keeta/skills/<name>/` would hide the pack from `npx skills add KeetaNetwork/agent-skills`, so the validator rejects one.

**One-time setup:**

1. **Build.** In the Cloudflare dashboard, open Workers & Pages → `agent-skills` → Settings → Build. Set the build command above, with framework preset None and the root directory left blank.
2. **Domain.** Under Custom domains, add `keeta.ai`. If the keeta.ai zone is in the same Cloudflare account, Pages creates the DNS record.
3. **Deploy.** Retry the latest deployment, or push to `main`.

Build and check locally:

```bash
python3 .github/scripts/validate-skills.py
python3 .github/scripts/build-site.py
npx wrangler@4.147.0 pages dev &          # serves _site/ the way Pages does, on http://localhost:8788
npx skills add http://localhost:8788 --list
```

## Repository layout

| Path | Contents |
| --- | --- |
| `plugins/keeta/skills/` | the skills ([Agent Skills specification](https://agentskills.io/specification)) |
| `plugins/keeta/.claude-plugin/plugin.json` | the Claude Code plugin manifest |
| `.claude-plugin/marketplace.json` | the marketplace that lists the plugin |
| `site/` | the static catalog and 404 page, plus `_headers` for Cloudflare |
| `site/assets/` | the official Keeta wordmark and app icon, the link-preview image, and self-hosted Geist fonts (SIL Open Font License, in `fonts/OFL.txt`) |
| `wrangler.toml` | Cloudflare Pages settings: the project name and the `_site` output directory |

## License

Apache-2.0
