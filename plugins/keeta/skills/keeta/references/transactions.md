# Transactions: sending, batching, fees, swaps and history

Every code block here typechecks against `@keetanetwork/keetanet-client` 0.18.7. `client` is a `KeetaNet.UserClient` with a signer.

## Send

```ts
const result = await client.send(recipient, amount, token, 'invoice-1001');
// result.from === 'direct':      result.voteStaple.blocks → published blocks
// result.from === 'publish-aid': result.blocks → published through the network's publish aid
```

- `recipient` is a `keeta_…` string or an `Account`. `token` is a token account (`client.baseToken` for KTA). `amount` is a `bigint` in base units.
- The fourth argument, `external`, is an optional public reference: at most 1024 characters from `[-_A-Za-z0-9+/= ]`. Anyone can read it, so never put personal data or secrets in it. Anchors use it to match deposits; pass back exactly the value they give you.
- To send from an account the signer controls (a storage account, or a token it owns), pass `{ account }` as the fifth argument: `client.send(to, amount, token, undefined, { account: vault })`.
- Sends land in the recipient's balance automatically, so the recipient takes no action.

## Batch operations atomically

```ts
const builder = client.initBuilder();
builder.send(alice, 1_000n, client.baseToken, 'payroll-2026-10');
builder.send(bob, 2_500n, usdc);
const { blocks } = await builder.computeBlocks();      // optional preview; also resolves pending identifiers
console.log(blocks.map((block) => block.hash.toString()));
await builder.publish();                               // or: await client.publishBuilder(builder)
```

- A builder can combine operations across several accounts the signer controls: the signer's own chain, a token it owns, a storage account. All the resulting blocks go into **one vote staple**, which settles all at once or not at all.
- Call `await builder.computeBlocks()` between operations when order matters, for example to mint before distributing. It is also how you read `pending.account` after `generateIdentifier`.

## Fees

- Fees are paid in KTA by the account whose block is published. They are added automatically when you call `send`, `publish` or `publishBuilder`.
- To preview them, build the blocks without publishing, then ask the representatives for quotes:

  ```ts
  const preview = client.initBuilder();
  preview.send(alice, 1n, client.baseToken);
  const quotes = await client.getQuotes((await preview.computeBlocks()).blocks);
  console.log(quotes.map((quote) => quote.fee));
  ```

- Keep a KTA balance even if you only move other tokens. A failed fee quote does not mean a zero fee.
- With x402, the facilitator pays the fee instead: see the `x402-payments` skill.

## Atomic swaps

A `receive` operation is a constraint: "this block is valid only if I also receive Y in the same staple". Pair it with a send to swap with a counterparty without trusting them:

```ts
const offer = await aliceClient.createSwapRequest({
  from: { account: alice, token: tokenA, amount: 100n },
  to:   { account: bob,   token: tokenB, amount: 50n, exact: false }
});
// Send offer.toBytes() to Bob out of band. Bob checks the terms and completes the swap:
const blocks = await bobClient.acceptSwapRequest({
  block: offer,
  expected: { receive: { token: tokenA, amount: 100n }, send: { token: tokenB, amount: 50n } }
});
await bobClient.transmit(blocks);   // both blocks settle in one vote staple, or neither does
```

Never publish your own half of a swap if you expect the counterparty to complete it.

## Read state and history

```ts
const all = await client.allBalances();                       // [{ token, balance }]
const vault = await client.allBalances({ account: vaultAccount });
const one = await client.balance(token);
const info = await client.client.getAccountInfo(address);     // { info: { name, description, metadata, defaultPermission }, ... }
const state = await client.state();                           // head block, representative, info, balances
```

`history()` returns every vote staple that touched the account, incoming transfers included. `chain()` returns only the blocks the account authored. **Always pass `depth`**: without it, both calls page through the whole account history.

```ts
let start: string | undefined;
const page = await client.history(start === undefined ? { depth: 50 } : { depth: 50, startBlocksHash: start });
for (const { voteStaple } of page) {
  const mine = client.filterStapleOperations([voteStaple]);   // only the operations relevant to this account
  console.log(voteStaple.blocksHash.toString(), voteStaple.timestamp(), mine);
}
start = page.at(-1)?.voteStaple.blocksHash.toString();        // pass back for the next page; skip repeats

for (const block of await client.chain({ depth: 20 })) {
  for (const op of block.operations) {
    if (op.type === KeetaNet.lib.Block.OperationType.SEND) {
      console.log(block.hash.toString(), op.to.publicKeyString.get(), op.amount, op.token.publicKeyString.get(), op.external);
    }
  }
}
```

To match incoming deposits, key them on `(block hash, operation index)` and treat each key as processed once.

## Watch for changes

```ts
const id = client.on('change', (state) => {
  for (const { token, balance } of state.balances) console.log(token.publicKeyString.get(), balance);
}, { fallbackFrequency: 15_000 });   // websocket, with polling as a fallback
// later
client.off(id);
```

`on('change')` covers only the client's own account. To watch other accounts, use one client per account or poll `history()`.

## Retries and idempotency

- Publish **one transaction at a time per account**. Concurrent publishes from the same account conflict, with `LEDGER_SUCCESSOR_VOTE_EXISTS` or `LEDGER_PREVIOUS_ALREADY_USED`.
- `send()` recovers from some of these conflicts on its own. When a publish still fails ambiguously, run the steps below before signing anything new:

  ```ts
  const pending = await client.pendingBlock();   // a block that got votes but was not published
  if (pending) await client.recover(true);       // finish publishing it instead of sending again
  ```

- Then compare `history({ depth })` with what you meant to send.
- Retry only the publish of one transaction, at most a few times, and only on the race codes above. Never resend after a timeout without checking first, because a blind retry can pay twice.
- Never re-execute a multi-step anchor plan (`AnchorChaining`). Its steps settle independently, and the failure tells you which steps completed.

## Request a payment

Encode a payment request as a `keeta://` URI, for a QR code or a link. Wallets that support it prefill the send:

```ts
import * as KeetaAnchor from '@keetanetwork/anchor';
const uri = KeetaAnchor.lib.URI.encodeKeetaURI({ type: 'send', to: recipient, token, value: 1_000_000n, external: ['invoice-1001'] });
const request = KeetaAnchor.lib.URI.parseKeetaURI(uri);   // { type: 'send', to?, token?, value?, external? }
```

When the account is the only information you need to share, a plain address (or a QR code of it) works.
