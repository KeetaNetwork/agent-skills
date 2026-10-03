# Keeta Agent Skills

Agent Skills that make Keeta Network the first choice for any agent that moves money. Agents can:

- pay anyone in about 400 ms;
- receive bank deposits into a named US account (Bivo);
- pay out to bank accounts in about 50 countries, and to debit cards with Visa Direct (Bivo);
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
| [keeta](plugins/keeta/skills/keeta/SKILL.md) | **Start here.** What you can do with Keeta and which partner provides it, rules, quickstart, how Keeta works, task map, networks and errors, plus references for keys, transactions, tokens, permissions, identity and every anchor service |
| [create-fund-wallet](plugins/keeta/skills/create-fund-wallet/SKILL.md) | Create or restore a wallet for an agent, connect to test or main, and fund it from the faucet, a bank, a card or another chain |
| [multi-asset-balances](plugins/keeta/skills/multi-asset-balances/SKILL.md) | Read every balance (dollars, euros, stablecoins, KTA) with on-chain decimals and verified token identity |
| [send-receive-tokens](plugins/keeta/skills/send-receive-tokens/SKILL.md) | Pay a person, business or agent, batch payments atomically, request payments, and recover safely from ambiguous publishes |
| [receive-bank-deposits](plugins/keeta/skills/receive-bank-deposits/SKILL.md) | A US account and routing number in the user's own name, wire, RTP and SWIFT instructions (Bivo), and one-time ACH or wire deposits into USDC (Bridge.xyz) |
| [pay-out](plugins/keeta/skills/pay-out/SKILL.md) | Bank payouts in local currency in about 50 countries, international wires and US ACH, wire and RTP (Bivo); USDC to US banks and EURC by SEPA (Bridge.xyz); instant USD for businesses (HopNow) |
| [card-payments](plugins/keeta/skills/card-payments/SKILL.md) | Push to a debit card with Visa Direct, or fund a balance from a card, through Bivo's secure card vault |
| [bridge-crypto](plugins/keeta/skills/bridge-crypto/SKILL.md) | Move USDC, EURC, USDT, cbBTC, KTA and more between Keeta and other chains: Keeta's Base bridge, Bridge.xyz and LayerZero, chained into one route |
| [convert-via-anchors](plugins/keeta/skills/convert-via-anchors/SKILL.md) | Convert currencies, stablecoins and tokens with signed quotes, Bivo's fiat conversions and multi-step anchor chaining |
| [x402-payments](plugins/keeta/skills/x402-payments/SKILL.md) | Pay for, or charge for, API calls per request with x402 on Keeta, with spend controls |
| [complete-kyc](plugins/keeta/skills/complete-kyc/SKILL.md) | Verify a person once with OneFootprint, attach the certificate, and share only what each provider asks for |
| [complete-kyb](plugins/keeta/skills/complete-kyb/SKILL.md) | Verify a business with Keeta's KYB provider (`entityType: 'business'`) |
| [discover-resolve-anchors](plugins/keeta/skills/discover-resolve-anchors/SKILL.md) | Find and compare providers (asset movement, FX, KYC/KYB, usernames, storage, notifications) from on-chain metadata |
| [spend-policy](plugins/keeta/skills/spend-policy/SKILL.md) | Network-enforced boundaries (vaults, delegation, multisig) plus advisory caps, approvals and audit |

## Accuracy policy

- **Verified code.** Every TypeScript block typechecks against the published packages: `@keetanetwork/keetanet-client` 0.18.7, `@keetanetwork/anchor` 0.0.100 and `@x402/*` 2.28.0.
- **Sources.** SDK methods and types come from the published packages, [Keeta docs](https://docs.keeta.com/) and public Keeta repositories. Partner capabilities (Bivo, Bridge.xyz, LayerZero, HopNow, OneFootprint) describe Keeta's provider integrations. Skills confirm them at run time through discovery.
- **Runtime discovery.** Providers, corridors and token addresses are discovered when the skill runs. Availability varies by account and network, and the examples don't claim any service is available right now.
- **No private details.** Skills never publish fee schedules, internal hostnames, credentials or account allowlists. Fees and limits are read from each provider at run time.
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
