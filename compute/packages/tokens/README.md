# @keeta-compute/tokens

Counts a chat request's prompt tokens exactly, the way the model server will: the request's messages and tools rendered with the model's own chat template, then encoded with its own tokenizer. Buyers price a ticket's input with this count and providers check it before running anything, so a provider can bill no more input than the prompt really has, plus a small margin.

- `PromptCounter(files)` takes a tokenizer's files as a Hugging Face repository keeps them (`tokenizer.json`, `tokenizer_config.json`, and `chat_template.jinja` or `chat_template.json` when the template lives there). `count(request)` returns the prompt tokens, or null when the template cannot render the request. Text parts are joined as mlx_lm.server joins them, and a structured-output schema is counted on top, since some servers put it in the prompt.
- `promptTokenLimit(count)` is the input limit a ticket carries: the count plus 16 tokens plus 1% (`PROMPT_MARGIN_TOKENS`, `PROMPT_MARGIN_BPS`), so an honest provider whose server renders a few tokens differently (a date in the template, say) is not refused or underpaid.
- `TokenizerCache({ dir })` gives each catalog model its pinned tokenizer. A model's tokenizer files are pinned with their SHA-256 at the model's pinned commit (`npm run catalog:pin`, in `@keeta-compute/protocol`'s `catalog-pins.ts`). The cache reads them from the model's own directory when the provider has it installed, otherwise downloads them once from that commit on huggingface.co and keeps them under `dir`. A file that does not match its pin is never used. `count(modelId, request, { localDir })` returns null for a model with no pinned tokenizer (custom models, unpinned ones), which is then priced by its size (`promptTokenBound`) as before.
- `@keeta-compute/tokens/testing` has a byte-level test tokenizer (every UTF-8 byte one token) with a ChatML template, and its pin.

The public router still prices input by size for now. It runs in a Cloudflare Worker, which would have to load each model's tokenizer (several megabytes for most) to count there.

Depends on `@keeta-compute/protocol`, `@huggingface/tokenizers` and `@huggingface/jinja` (both plain JavaScript).

## Develop

From `compute/`:

```bash
npm test -w @keeta-compute/tokens
npm run typecheck -w @keeta-compute/tokens
```
