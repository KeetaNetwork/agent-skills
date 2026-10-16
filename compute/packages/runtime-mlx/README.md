# @keeta-compute/runtime-mlx

The MLX runtime for Apple Silicon Macs. `MlxRuntime` installs a private Python environment in the node's data directory and serves models with `mlx_lm.server`.

- Everything it executes is pinned: uv by version and SHA-256 (checked before it is unpacked), Python by uv's own download list, and mlx-lm with its whole dependency closure by a hash-locked requirements file (`src/mlx-lock.ts`, installed with `uv pip install --require-hashes`).
- `start(modelId, path)` runs one `mlx_lm.server` per model on a free port of 127.0.0.1, offline (`HF_HUB_OFFLINE=1`), and resolves once it answers. A running server is reused; `stop` and `stopAll` end them.
- It only serves model directories the provider downloaded and hash-verified. It never exposes a shell.

`ensureInstalled` refuses anything but macOS on Apple Silicon.

Depends on `@keeta-compute/protocol` and `@keeta-compute/runtime-openai`.

## Develop

From `compute/`:

```bash
npm test -w @keeta-compute/runtime-mlx
npm run typecheck -w @keeta-compute/runtime-mlx
```
