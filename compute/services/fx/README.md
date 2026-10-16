# @keeta-compute/fx

keeta.ai's FX provider for Keeta Compute Credits: a Keeta anchor FX service (`KeetaNetFXAnchorHTTPServer` from `@keetanetwork/anchor`) run by the FX account, which holds the credit supply. It swaps credits both ways with the Keeta stablecoins (KUSD, KEUR, KJPY, KMXN, KCAD, KAED, KGBP) and USDC. KUSD and USDC trade one to one; the others trade at the rate source's US dollar rate with a spread (50 basis points by default). The test network uses fixed rates; the main network needs a live rate source. Live rates are checked before they are quoted: each currency must sit inside a fixed range (`USD_RATE_BANDS` in `src/rates.ts`) and within 2% of the last rate quoted, and the first rate needs two reads that agree. A bigger jump pauses that currency until the source comes back near the last rate or an operator who has checked the source restarts the service.

Scripts (run from `compute/`):

- `npm run assets:pin [-- test|main]`: resolves each `$K` stablecoin through the network's anchor resolver and writes `asset-pins.ts` in `@keeta-compute/protocol`. Reads only.
- `FX_SEED=... npm run credits:create`: creates Keeta Compute Credits on the test network, mints the supply to the FX account and writes `credit-pins.ts`. Refuses the main network.
- `FX_SEED=... FX_NETWORK=test FX_PORT=... FX_PUBLIC_URL=https://... npm run fx:start`: runs the service.
- `FX_SEED=... FX_PUBLIC_URL=https://... npm run fx:publish`: publishes the service in the FX account's on-chain metadata, where clients find it with the anchor resolver.

Settings are in `src/config.ts`: `FX_SEED`, `FX_NETWORK`, `FX_PORT`, `FX_PUBLIC_URL`, `FX_SPREAD_BPS`, `FX_RATE_SOURCE` and `FX_TEST_RATES`.

## Develop

From `compute/`:

```bash
npm test -w @keeta-compute/fx
npm run typecheck -w @keeta-compute/fx
```
