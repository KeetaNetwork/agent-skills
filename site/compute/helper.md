# Linux

Status: test-network preview.

`keeta-compute-agent` runs Keeta Compute on a Linux machine you own (a home server, a workstation, a GPU box). It runs in one of two modes:

- **Full node** (the default): everything the macOS app does, from the command line. The machine has its own wallet, sells capacity paid to that wallet, buys inference for agents on the machine through a local OpenAI-compatible endpoint, and can pair helpers of its own.
- **Helper**: provider-only capacity in another node's fleet. It has no wallet, no balance and cannot buy; every payment it earns goes to the node it paired with (a Mac or a Linux full node), which holds its policy.

## Install

```bash
curl -fsSL https://keeta.ai/compute/install-helper.sh | sh
```

Read the [install script](https://keeta.ai/compute/install-helper.sh) before you run it. It installs the `keeta-compute-agent` command for both modes.

## Full node

### Create the wallet

```bash
keeta-compute-agent init
```

- `init` creates the operator wallet: 32 random bytes, encrypted with your passphrase (scrypt and AES-256-GCM) in `~/.keeta-compute/operator-wallet.json`, mode `0600`.
- It prints a 24-word recovery phrase once. Write it down; it is never shown again. The phrase is also a standard Keeta passphrase for the same account.
- To restore on a new machine, run `keeta-compute-agent init --restore` and enter the phrase.
- The passphrase is read from `KEETA_COMPUTE_PASSPHRASE`, or asked for on the terminal.
- Options: `--network test|main` (default `test`), `--control URL`, `--relay URL`, `--name NAME`.

Every command takes `--data-dir DIR` (default `$KEETA_COMPUTE_HOME` or `~/.keeta-compute`).

### Sell capacity

The agent does not run models itself. Run any OpenAI-compatible server on the same machine, such as llama.cpp's `llama-server`, vLLM or SGLang, then register each model:

```bash
keeta-compute-agent models add \
  --id qwen3-8b \
  --url http://127.0.0.1:8080/v1 \
  --served-name <name the server uses for the model> \
  --weights <path-to-weights>
keeta-compute-agent provide --on
keeta-compute-agent run
```

- `--id` is the network model id from the [catalog](https://keeta.ai/compute/models.md).
- `--served-name` is the `model` value your local server expects.
- `--weights` is hashed, and the hash appears on every receipt the node signs.
- Keep the server bound to `127.0.0.1`. The agent refuses servers on other hosts.
- `models offer ID --price-in 0.10 --price-out 0.40` sets prices in credits (one credit is one US dollar) per million tokens; `--off` stops offering a model; `--access allowlist --allow KEY,...` limits it to listed buyers.
- `provide --access allowlist --allow KEY,...` sets the default for every model (a node's lists hold up to 1000 addresses in total, counting this one and the models' own); `--max-jobs N` sets concurrency.

### Buy inference

While `run` is running, agents on the machine can call `http://127.0.0.1:11435/v1` with the token from `keeta-compute-agent token`. If another program is already listening on that port, `run` stops with an error rather than leave agents talking to it, so the service manager reports the failure and starts it again. Requests are paid in Keeta Compute Credits from the agent budget, a separate local key: each request escrows its most possible cost on the Keeta ledger, and what the provider does not bill comes back.

Buy credits with a Keeta stablecoin held in the operator wallet (KUSD by default; also KEUR, KJPY, KMXN, KCAD, KAED, KGBP and USDC). They go straight to the agent budget:

```bash
keeta-compute-agent wallet buy-credits 5 --with KUSD
keeta-compute-agent buy --per-request-max 0.25 --daily-max 5
```

### Other commands

| Command | What it does |
| --- | --- |
| `status` | Node key, operator, network, endpoints, balances, policies and models (`--json` for scripts). |
| `wallet` | Addresses of the operator wallet and the agent budget, and their credits, stablecoins and KTA, read from the ledger. |
| `wallet buy-credits AMOUNT [--with KUSD] [--keep]` | Buy credits with a stablecoin through keeta.ai's exchange; they go to the agent budget unless `--keep`. Shows the estimate and the most you'll pay (0.5% over it); a price past that swaps nothing. Needs the passphrase. |
| `wallet sell-credits AMOUNT [--to KUSD]` | Cash out credits from the operator wallet for a stablecoin, receiving at least 0.5% under the estimate it shows. Needs the passphrase. |
| `wallet send TO AMOUNT` | Send credits from the operator wallet (`--asset KUSD` or another stablecoin, `--asset kta` for KTA, `--memo TEXT` for a memo). Needs the passphrase. |
| `wallet fund-budget AMOUNT` / `wallet drain-budget AMOUNT` | Move credits into or out of the agent budget. Draining needs no passphrase. |
| `wallet test-funds` | Request test-network KTA for fees. |
| `models list` / `models remove ID` | List or forget registered models. |
| `token [--rotate]` | Print or replace the local endpoint token. |
| `pair` | Show a pairing code for a helper and approve it after you compare check strings. |
| `fleet list` / `fleet approve ID` / `fleet reject ID` / `fleet revoke KEY` | Manage helpers. |
| `config` | Switch network (`--network main`) or coordinator (`--control URL`, `--relay URL`). Linking the wallet on a new network asks for the passphrase. |

## Helper

1. On the master, create a one-time pairing code: in the Mac app, open Fleet → Add a Linux machine; on a Linux full node, run `keeta-compute-agent pair`. The code expires in 10 minutes and works once.
2. On the helper:

   ```bash
   keeta-compute-agent helper pair <CODE>
   ```

3. Both machines show a short check string, such as `K7M-Q2X`. Compare them. If they differ, reject the claim on the master.
4. Approve the machine on the master. It joins the fleet, paid to the master's wallet.
5. Register models with `keeta-compute-agent helper add-model` (same options as `models add`), then run `keeta-compute-agent helper run`.

The code alone cannot pair a machine: pairing completes only after you approve it on the master.

## Run as a service

In `/etc/systemd/system/keeta-compute.service`:

```ini
[Unit]
Description=Keeta Compute
After=network-online.target
Wants=network-online.target

[Service]
User=keeta
ExecStart=/usr/local/bin/keeta-compute-agent run
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now keeta-compute
```

For a helper, use `helper run` in `ExecStart`. Adjust `User` and the `ExecStart` path to match where the install script put the binary (`command -v keeta-compute-agent`). Run `init` or `helper pair` as that same user so the service finds its keys. `run` never needs the passphrase; only wallet sends and linking do.

## Keys and revocation

- Each machine has its own node key in a `0600` keyfile. It signs receipts and requests; it cannot move funds.
- On a full node, the operator wallet is encrypted at rest and decrypted only for a send or a link, then wiped from memory. The agent budget key is a `0600` keyfile holding only what you moved into it.
- Revoking a helper on its master (Fleet, or `fleet revoke`) cuts it off: its credentials stop working and it gets no more jobs.
- A helper stays in its master's fleet until that master revokes it. To move it to another master, revoke it there first, then pair it again.
- If a machine is lost or compromised, revoke it from its master (for a helper), move funds out with the recovery phrase on another machine (for a full node), then delete the keyfiles.
