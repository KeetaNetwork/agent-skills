# Linux helper

Status: test-network preview.

The Linux helper adds a Linux machine you own (a home server, a workstation, a GPU box) to your Mac's fleet as extra provider capacity.

- It is provider-only. It has no wallet, no balance and cannot buy.
- Every payment it earns goes to the paired Mac's wallet.
- The Mac holds the policy: prices, access mode, pause and revoke.
- It is tiered by what it proves in its benchmark, like a Mac.

## Install

```bash
curl -fsSL https://keeta.ai/compute/install-helper.sh | sh
```

Read the [install script](https://keeta.ai/compute/install-helper.sh) before you run it. It installs the `keeta-compute-agent` command.

## Pair with your Mac

1. In the Mac app, open Fleet → Add a Linux machine. The app shows a one-time pairing code. It expires in 10 minutes and works once.
2. On the Linux machine:

   ```bash
   keeta-compute-agent helper pair <CODE>
   ```

3. Both machines show a short check string, such as `K7M-Q2X`. Compare them. If they differ, reject the claim on the Mac.
4. Approve the machine on the Mac. It joins the fleet, paid to the Mac's address.

The code alone cannot pair a machine: pairing completes only after you approve it on the Mac.

## Serve a model

The helper does not run models itself. Run any OpenAI-compatible server on the same machine, such as llama.cpp's `llama-server`, vLLM or SGLang, then register each model with the helper:

```bash
keeta-compute-agent helper add-model \
  --id qwen3-8b \
  --url http://127.0.0.1:8080/v1 \
  --served-name <name the server uses for the model> \
  --weights <path-to-weights>
```

- `--id` is the network model id from the [catalog](https://keeta.ai/compute/models.md).
- `--served-name` is the `model` value your local server expects.
- `--weights` is hashed, and the hash appears on every receipt the helper signs.
- Keep the server bound to `127.0.0.1`. The helper is the only thing that should reach it.

## Run

```bash
keeta-compute-agent helper run
```

As a systemd service, in `/etc/systemd/system/keeta-compute-helper.service`:

```ini
[Unit]
Description=Keeta Compute helper
After=network-online.target
Wants=network-online.target

[Service]
User=keeta
ExecStart=/usr/local/bin/keeta-compute-agent helper run
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now keeta-compute-helper
```

Adjust `User` and the `ExecStart` path to match where the install script put the binary (`command -v keeta-compute-agent`). Run `helper pair` as that same user so the service finds its key.

## Keys and revocation

- Pairing creates the helper's own node key. It signs receipts and requests; it cannot move funds.
- The key is stored in a keyfile with mode `0600`, readable only by the user that runs the helper.
- Revoking the machine in the Mac app (Fleet) cuts it off: its credentials stop working and it gets no more jobs.
- If the machine is lost or compromised, revoke it from the Mac first, then delete the keyfile.
