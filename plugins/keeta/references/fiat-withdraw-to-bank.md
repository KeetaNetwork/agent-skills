# Fiat withdraw to bank

Canonical page: https://docs.keeta.com/guides/fiat-withdraw-to-bank

Example: https://github.com/KeetaNetwork/keetanet-examples/blob/main/src/anchor/asset-movement-fiat-withdraw-to-bank.ts

The guide initiates an outbound payment to a US bank and then sends Keeta USD to the anchor with the returned instruction. Test and main Keeta USD token ids match the deposit guide.

Provider search:

```ts
const providers = await assetMovementClient.getProvidersForTransfer({
  asset: { from: keetaUsdToken, to: 'USD' },
  from: { type: 'chain', chain: { type: 'keeta', networkId: userClient.network } },
  to: { type: 'bank-account', account: { type: 'us' } }
});
```

The guide names the recipient type `UsBankAccountResolved`. The example requires `accountNumber`, `routingNumber`, `bankName`, `accountTypeDetail` of `checking` or `savings`, an individual `accountOwner`, and a US `accountAddress`. Address line 2 may be empty.

`initiateTransfer` takes `value` in source base units. The returned `instructions[0]` in the example must be type `KEETA_SEND` and must include `external`. `userClient.send` uses `instruction.sendToAddress`, the same amount, the Keeta USD token, and `instruction.external`.

`transfer.getTransferStatus()` returns `transaction.status`. The example polls every 5 seconds and stops when that string is `PROCESSING` or `COMPLETED`. Instruction objects may include `assetFee` and `totalReceiveAmount`. Status objects may include `transaction.fee`.
