# @keeta-compute/runtime-openai

Runs a chat completion on a local OpenAI-compatible model server and returns what a Keeta Compute receipt needs. Providers use it with `mlx_lm.server` on a Mac and with llama.cpp, vLLM or SGLang on Linux.

- `streamChat(backend, request, options)` forwards only the request fields the protocol allows (anything else could change the prefill), asks the server for its own model name, caps the output at the ticket's limit and relabels each chunk with the network model id. It returns the text, the token counts (the server's usage when it reports one, otherwise counted chunks and an estimated prompt) and the finish reason.
- `waitForServer(baseUrl, timeoutMs, signal?)` polls `/models` until the server answers.

Depends on `@keeta-compute/protocol`.

## Develop

From `compute/`:

```bash
npm test -w @keeta-compute/runtime-openai
npm run typecheck -w @keeta-compute/runtime-openai
```
