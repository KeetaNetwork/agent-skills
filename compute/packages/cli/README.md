# @keeta-compute/cli

`keeta-compute-agent`, the agent binary.

- **macOS app**: the app bundles the binary and runs `keeta-compute-agent app`, then drives it over JSON-RPC on stdio (`macos/scripts/bundle-agent.sh` builds it).
- **Linux node**: a full node from the command line, with its own encrypted wallet and 24-word recovery phrase. It provides (serving a local vLLM or llama.cpp server), buys through the local OpenAI-compatible endpoint, buys and cashes out credits, and pairs helpers.
- **Linux helper**: a satellite paired with a Mac or a Linux node, which earns into that node's operator wallet.

```text
keeta-compute-agent init [--network test|main] [--control URL] [--relay URL] [--name NAME] [--restore]
keeta-compute-agent wallet buy-credits AMOUNT [--with KUSD|KEUR|KJPY|KMXN|KCAD|KAED|KGBP|USDC]
keeta-compute-agent models add --id ID --url URL --served-name NAME --weights DIR
keeta-compute-agent provide --on
keeta-compute-agent run
keeta-compute-agent helper pair CODE
keeta-compute-agent --help                 # every command
```

Every command takes `--data-dir DIR` (default `$KEETA_COMPUTE_HOME` or `~/.keeta-compute`). The wallet passphrase comes from `$KEETA_COMPUTE_PASSPHRASE` or a hidden prompt.

Build the binaries with [bun](https://bun.sh); they land in `dist/`:

```bash
npm run build:mac -w @keeta-compute/cli
npm run build:linux-x64 -w @keeta-compute/cli
npm run build:linux-arm64 -w @keeta-compute/cli
```

Depends on `@keeta-compute/agent`, `@keeta-compute/protocol`, `@keeta-compute/provider`, `@keeta-compute/runtime-openai`, `@keeta-compute/tokens` and `@keeta-compute/wallet`.

## Develop

From `compute/`:

```bash
npm test -w @keeta-compute/cli
npm run typecheck -w @keeta-compute/cli
```
