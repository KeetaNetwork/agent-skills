# Fiat deposit from bank

Canonical page: https://docs.keeta.com/guides/fiat-deposit-from-bank

Example: https://github.com/KeetaNetwork/keetanet-examples/blob/main/src/anchor/asset-movement-fiat-deposit-from-bank.ts

The guide obtains deposit instructions from an Asset Movement anchor that can mint inbound value on Keeta. It assumes KYC is already completed and shared. On test, the guide and the bank example both use Keeta USD `keeta_any4zllibya6fum3lsoimxmnmeo57nklxlh4c6d6xosfacarfaa3knkiprkmm`. On main, the guide names `keeta_amnkge74xitii5dsobstldatv3irmyimujfjotftx7plaaaseam4bntb7wnna` and `asset-movement-fiat-deposit-from-crypto.ts` names `keeta_aonxxqry6rknxyb6c5q2ybxk2gt776xlchhcohhyla5kqvinnaduevuxyx3tc`. Those mainnet ids conflict. Stop until the guide and provider metadata name one token.

Discovery and the forwarding request use the same pair and locations:

```ts
const US_BANK_SOURCE = { type: 'bank-account', account: { type: 'us' } } as const;
const keetaDestination = {
  type: 'chain',
  chain: { type: 'keeta', networkId: userClient.network }
} as const;
const assetPair = { from: 'USD' as const, to: KEETA_USD_ASSET };

const providers = await assetMovementClient.getProvidersForTransfer({
  asset: assetPair,
  from: US_BANK_SOURCE,
  to: keetaDestination
});

const depositInfo = await provider.createPersistentForwardingAddress({
  account,
  asset: assetPair,
  sourceLocation: US_BANK_SOURCE,
  destinationLocation: keetaDestination,
  destinationAddress: account.publicKeyString.get()
});
```

The example stops when `providers` is empty. It handles `Errors.KYCShareNeeded` and `Errors.UserActionNeeded` by sending the caller to the share-KYC example. After the bank payment, the guide reads `userClient.balance(KEETA_USD_ASSET)`, `userClient.history()`, or `userClient.on('change', ...)`.

Show `depositInfo` as returned. The client type for that object is `KeetaPersistentForwardingAddressDetails` in `@keetanetwork/anchor`.
