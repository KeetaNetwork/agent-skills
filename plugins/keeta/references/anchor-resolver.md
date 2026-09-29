# Anchor Resolver

Canonical page: https://docs.keeta.com/anchors/overview/anchor-resolver

The Resolver is how a client finds anchor services. It reads on-chain service metadata and returns endpoints that match the requested capabilities. Clients describe the service instead of storing a partner base URL.

```ts
const resolver = new KeetaAnchor.lib.Resolver({
  root: userClient.networkAddress,
  client: userClient,
  trustedCAs: []
});

const fxServices = await resolver.lookup('fx', {
  inputCurrencyCode: usdToken,
  outputCurrencyCode: ktaToken
});
```

Fully resolve a metadata value with `KeetaAnchor.lib.Resolver.Metadata.fullyResolveValuizable` before reading endpoints. KYC, FX, and Asset Movement clients call this discovery path for their typed searches, including `getProvidersForTransfer` for a US bank location.
