# Keeta Agent Skills

Installable, source-linked playbooks for agents building with Keeta wallets, native multi-asset balances, identity anchors, FX, bridges, bank deposits, and payouts.

```bash
npx skills add KeetaNetwork/agent-skills
```

**Catalog:** [keeta.ai](https://keeta.ai/)

## Basics path

A new account follows one order: create a wallet, complete individual KYC, request US bank deposit instructions, confirm the Keeta USD balance, and pay out only when the user asks.

| Step | Skill |
| --- | --- |
| 1. Create or restore a wallet and confirm `test` or `main` | [create-fund-wallet](plugins/keeta/skills/create-fund-wallet/SKILL.md) |
| 2. Complete individual KYC and share attributes when a provider asks | [complete-kyc](plugins/keeta/skills/complete-kyc/SKILL.md) |
| 3. Discover a provider and present the US bank deposit instructions it returns | [pay-in](plugins/keeta/skills/pay-in/SKILL.md) |
| 4. Read the Keeta USD balance and history after the bank payment | [multi-asset-balances](plugins/keeta/skills/multi-asset-balances/SKILL.md) |
| 5. Optionally pay Keeta USD out to a US bank account | [pay-out](plugins/keeta/skills/pay-out/SKILL.md) |

Example prompts:

- Create a Keeta wallet on the test network and show me only the public address.
- Complete individual KYC for this wallet and attach the certificate after I finish the provider page.
- Get US bank deposit instructions that credit Keeta USD, then check the balance.
- After the deposit is visible, pay out Keeta USD to this US bank account.

## Why this pack

Keeta is built for native multi-currency balances, discoverable anchors, identity certificates, conversions, bridges, and off-chain payout rails. These skills give agents that operating model while staying inside the public `@keetanetwork/keetanet-client`, `@keetanetwork/anchor`, and Keeta documentation surface.

Every workflow is confirmation-first. Skills guide agents through discovery, SDK calls, and failure handling; humans review and approve identity disclosures, quotes, recipients, and value-moving operations. A skill is guidance, not an authorization boundary or a substitute for legal, compliance, or security review.

## Skills

| Skill | Use it for |
| --- | --- |
| [create-fund-wallet](plugins/keeta/skills/create-fund-wallet/SKILL.md) | Create or restore a signer, connect to a named network, and hand off bank funding |
| [complete-kyc](plugins/keeta/skills/complete-kyc/SKILL.md) | Discover Footprint, track certificate status, and share only consented attributes |
| [pay-in](plugins/keeta/skills/pay-in/SKILL.md) | Discover a US bank deposit provider and present the instructions it returns |
| [pay-out](plugins/keeta/skills/pay-out/SKILL.md) | Initiate one Keeta USD payout to a US bank and poll status before any retry |
| [multi-asset-balances](plugins/keeta/skills/multi-asset-balances/SKILL.md) | Read one or all native token balances without mixing base units |
| [send-receive-tokens](plugins/keeta/skills/send-receive-tokens/SKILL.md) | Validate a recipient and send a specific Keeta-native asset |
| [discover-resolve-anchors](plugins/keeta/skills/discover-resolve-anchors/SKILL.md) | Resolve KYC, FX, and asset-movement providers from on-chain metadata |
| [complete-kyb](plugins/keeta/skills/complete-kyb/SKILL.md) | Gate business verification on provider documentation without inventing a KYB API |
| [convert-via-anchors](plugins/keeta/skills/convert-via-anchors/SKILL.md) | Discover quotes and convert a documented token pair through an FX anchor |
| [bridge-usdc](plugins/keeta/skills/bridge-usdc/SKILL.md) | Discover support for documented Arbitrum inbound and Base Sepolia USDC corridors |
| [spend-policy](plugins/keeta/skills/spend-policy/SKILL.md) | Apply advisory limits and approval controls around agent transactions |

## Accuracy policy

- Public methods are cited to [Keeta docs](https://docs.keeta.com/) or public Keeta repositories.
- Provider availability is discovered at runtime; examples do not assert that test or main network services are currently available.
- Partner endpoints are never guessed. An undocumented or unstable capability becomes an explicit stop condition.
- Amounts are base-unit integers. Resolve token metadata and decimals before displaying or moving value.

## Repository layout

Skills follow the [Agent Skills specification](https://agentskills.io/specification). The plugin manifest is at [`plugins/keeta/plugin.json`](plugins/keeta/plugin.json), and the static catalog is in [`site/`](site/).

Thin notes for the bank, KYC, Asset Movement, and Resolver pages live in [`plugins/keeta/references/`](plugins/keeta/references/). `node scripts/sync-keeta-docs.mjs` checks those notes against the public docs pages.

## License

Apache-2.0
