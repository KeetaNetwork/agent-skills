# Models

Status: test-network preview. Prices are suggestions; each provider sets its own.

The curated catalog below makes the common case one click in the macOS app. The network is model-agnostic: an operator can also install other weights that fit the machine, and the `id` column is the value of the OpenAI `model` field.

<!-- keeta-compute:models-table -->

## Columns

- **Memory** is the unified memory the model needs once loaded, including working headroom. A Mac can give a model about two thirds of its memory under 64 GB and about three quarters above that.
- **Disk** is the approximate download size.
- **Price** is the suggested price in USDC per million input and output tokens. On the wire, prices are integer base units: USDC has 6 decimals, so 0.05 USDC is `50000`. [Pricing math](https://keeta.ai/compute/protocol.md).
- **Cluster only** marks a model no single machine can hold. Clusters are not scheduled in this version.
- Live prices and provider counts come from `GET /v1/models` on the [router](https://keeta.ai/compute/router.md) or the app's local endpoint.

## Licenses

License terms travel with the model. An operator who offers a model to the network is serving it commercially and takes on that license's obligations, such as attribution ("Built with Llama"), acceptable-use policies, and size or revenue thresholds that need a separate license. Those obligations are the operator's responsibility, not the network's. The app shows each license before you offer the model; read it in full at the linked page.

Every receipt names the exact weights the provider ran by their sha256 hash, so a buyer can tell which build of a model served the request.
