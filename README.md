# Keeta Agent Skills

Agent Skills for building on and transacting with Keeta Network: accounts, multi-asset balances, payments, tokens, permissions, identity, anchors (KYC, KYB, FX, bridges, bank deposits and payouts) and x402.

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
| [keeta](plugins/keeta/skills/keeta/SKILL.md) | **Start here.** Rules, quickstart, how Keeta works, task map, networks, errors, plus references for keys, transactions, tokens, permissions, identity and every anchor service |
| [create-fund-wallet](plugins/keeta/skills/create-fund-wallet/SKILL.md) | Create or restore an account, connect to test or main, and fund it (test faucet, or a transfer or on-ramp on main) |
| [multi-asset-balances](plugins/keeta/skills/multi-asset-balances/SKILL.md) | Read every token balance with on-chain decimals and verified token identity |
| [send-receive-tokens](plugins/keeta/skills/send-receive-tokens/SKILL.md) | Send, batch atomically, request payments, and recover safely from ambiguous publishes |
| [x402-payments](plugins/keeta/skills/x402-payments/SKILL.md) | Pay for, or charge for, HTTP requests with x402 on Keeta, with spend controls |
| [discover-resolve-anchors](plugins/keeta/skills/discover-resolve-anchors/SKILL.md) | Find KYC, FX, asset-movement, username, storage and notification providers from on-chain metadata |
| [complete-kyc](plugins/keeta/skills/complete-kyc/SKILL.md) | Verify an individual, attach the certificate, and share only requested attributes |
| [complete-kyb](plugins/keeta/skills/complete-kyb/SKILL.md) | Verify a business through the KYC client with `entityType: 'business'` |
| [convert-via-anchors](plugins/keeta/skills/convert-via-anchors/SKILL.md) | Quote, approve and execute FX conversions, including multi-hop chaining |
| [bridge-usdc](plugins/keeta/skills/bridge-usdc/SKILL.md) | Move USDC between Arbitrum or Base and Keeta through asset-movement anchors |
| [pay-out](plugins/keeta/skills/pay-out/SKILL.md) | Pay out Keeta USD to a US bank account and monitor it to completion |
| [spend-policy](plugins/keeta/skills/spend-policy/SKILL.md) | Network-enforced boundaries (vaults, delegation, multisig) plus advisory caps, approvals and audit |

## Accuracy policy

- **Verified code.** Every TypeScript block typechecks against the published packages: `@keetanetwork/keetanet-client` 0.18.7, `@keetanetwork/anchor` 0.0.100 and `@x402/*` 2.28.0.
- **Public sources only.** Every method and fact cites [Keeta docs](https://docs.keeta.com/), public Keeta repositories, or public npm packages.
- **Runtime discovery.** Providers, corridors and token addresses are discovered when the skill runs. The examples don't claim any test or main service is available right now.
- **No guessed endpoints.** Partner endpoints are never guessed. A missing or unstable capability is an explicit stop condition.
- **Base units.** Amounts are integer base units, and decimals are read from token metadata, never assumed.
- **Guidance, not authorization.** Every value-moving workflow asks for confirmation first. A skill doesn't replace application controls, or legal, compliance or security review.

## Hosting on keeta.ai

`.github/workflows/pages.yml` deploys `_site/`, which `.github/scripts/build-site.py` assembles from `site/` and `plugins/keeta/skills/`:

| Path | Content |
| --- | --- |
| `/` | the catalog page |
| `/SKILL.md` and `/skill.md` | the `keeta` skill, with links rewritten to absolute URLs |
| `/llms.txt` | a plain index for LLMs |
| `/.well-known/agent-skills/index.json` | skill discovery index v0.2.0, used by `npx skills add https://keeta.ai` |
| `/.well-known/skills/index.json` | legacy discovery index, for older CLI versions |
| `/.well-known/agent-skills/<name>/…` | every skill's files |

**Generated, never committed.** A `SKILL.md` outside `plugins/keeta/skills/<name>/` would hide the pack from `npx skills add KeetaNetwork/agent-skills`, so the validator rejects one.

**One-time setup.** GitHub Pages must be enabled with **GitHub Actions** as its source, and keeta.ai attached as the custom domain (Settings → Pages). The workflow token can't create the Pages site.

**Pinned action.** The workflow pins `actions/upload-pages-artifact@v3`, because v4 drops the `.well-known/` directory.

Build and check locally:

```bash
python3 .github/scripts/validate-skills.py
python3 .github/scripts/build-site.py _site
python3 -m http.server 8000 --directory _site &
npx skills add http://127.0.0.1:8000 --list
```

## Repository layout

| Path | Contents |
| --- | --- |
| `plugins/keeta/skills/` | the skills ([Agent Skills specification](https://agentskills.io/specification)) |
| `plugins/keeta/.claude-plugin/plugin.json` | the Claude Code plugin manifest |
| `.claude-plugin/marketplace.json` | the marketplace that lists the plugin |
| `site/` | the static catalog |

## License

Apache-2.0
