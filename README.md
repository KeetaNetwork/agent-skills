# Keeta Agent Skills

Installable, source-linked playbooks for agents building with Keeta wallets, native multi-asset balances, identity anchors, FX, bridges, and external payouts.

```bash
npx skills add KeetaNetwork/agent-skills
```

**Catalog:** [keetanetwork.github.io/agent-skills](https://keetanetwork.github.io/agent-skills/) — the static catalog goes live after GitHub Pages is enabled (source: GitHub Actions).

## Why this pack

Keeta is built for native multi-currency balances, discoverable anchors, identity certificates, conversions, bridges, and off-chain payout rails. These skills give agents that operating model while staying inside the public `@keetanetwork/keetanet-client`, `@keetanetwork/anchor`, and Keeta documentation surface.

Every workflow is confirmation-first. Skills guide agents through discovery, SDK calls, and failure handling; humans review and approve identity disclosures, quotes, recipients, and value-moving operations. A skill is guidance, not an authorization boundary or a substitute for legal, compliance, or security review.

## Skills

| Skill | Use it for |
| --- | --- |
| [create-fund-wallet](plugins/keeta/skills/create-fund-wallet/SKILL.md) | Create or restore a signer, connect to a named network, and prepare funding safely |
| [multi-asset-balances](plugins/keeta/skills/multi-asset-balances/SKILL.md) | Read one or all native token balances without mixing base units |
| [send-receive-tokens](plugins/keeta/skills/send-receive-tokens/SKILL.md) | Validate a recipient and send a specific Keeta-native asset |
| [discover-resolve-anchors](plugins/keeta/skills/discover-resolve-anchors/SKILL.md) | Resolve KYC, FX, and asset-movement providers from on-chain metadata |
| [complete-kyc](plugins/keeta/skills/complete-kyc/SKILL.md) | Run the documented Footprint sandbox KYC pattern and attach certificates |
| [complete-kyb](plugins/keeta/skills/complete-kyb/SKILL.md) | Gate business verification on provider documentation without inventing a KYB API |
| [convert-via-anchors](plugins/keeta/skills/convert-via-anchors/SKILL.md) | Discover quotes and convert a documented token pair through an FX anchor |
| [bridge-usdc](plugins/keeta/skills/bridge-usdc/SKILL.md) | Discover support for documented Arbitrum inbound and Base Sepolia USDC corridors |
| [pay-out](plugins/keeta/skills/pay-out/SKILL.md) | Initiate and monitor a Keeta USD-to-US-bank payout |
| [spend-policy](plugins/keeta/skills/spend-policy/SKILL.md) | Apply advisory limits and approval controls around agent transactions |

## Accuracy policy

- Public methods are cited to [Keeta docs](https://docs.keeta.com/) or public Keeta repositories.
- Provider availability is discovered at runtime; examples do not assert that test or main network services are currently available.
- Partner endpoints are never guessed. An undocumented or unstable capability becomes an explicit stop condition.
- Amounts are base-unit integers. Resolve token metadata and decimals before displaying or moving value.

## Repository layout

Skills follow the [Agent Skills specification](https://agentskills.io/specification). The plugin manifest is at [`plugins/keeta/plugin.json`](plugins/keeta/plugin.json), and the static catalog is in [`site/`](site/).

## License

Apache-2.0
