---
name: multi-asset-balances
description: Read and reconcile every balance on a Keeta account (dollars, euros, stablecoins, KTA or any token), or a storage account it controls, with exact token identities, on-chain decimals and base units, and flag look-alike tokens. Use for portfolio views, for checking funds before a payment, conversion or payout, and for confirming that a deposit or transfer settled.
license: Apache-2.0
---

# Read multi-asset balances

## When to use

Use when an agent must list an account's assets, check one token before a transfer, or compare balances before and after an anchor flow. A Keeta account holds many native tokens at once. Never collapse them into a single "USD balance" or "wallet balance", and never identify a token by its ticker alone.

## SDK steps

1. Build a `UserClient` for the selected network. A read-only client works for any address: `KeetaNet.UserClient.fromNetwork(network, null)`, then pass `{ account }` to reads.
2. Read balances. They are always `bigint` base units:

   ```ts
   const all = await client.allBalances();                    // [{ token, balance }]
   const kta = await client.balance(client.baseToken);
   const vault = await client.allBalances({ account: vaultAccount }); // a storage account you can read
   ```

3. Identify each token from the chain, and cross-check it against the network's official token list:

   ```ts
   import * as KeetaAnchor from '@keetanetwork/anchor';
   import type { TokenAddress } from '@keetanetwork/keetanet-client/lib/account.js';

   const resolver = new KeetaAnchor.lib.Resolver({ root: client.networkAddress, client, trustedCAs: [] });
   const official = new Map((await resolver.listTokens()).map(({ token, currency }) => [token, currency]));

   async function describe(token: TokenAddress) {
     const { info } = await client.client.getAccountInfo(token);
     const raw = KeetaNet.lib.Utils.Helper.bufferToArrayBuffer(Buffer.from(info.metadata, 'base64'));
     let json: ArrayBuffer;
     try { json = KeetaNet.lib.Utils.Buffer.ZlibInflate(raw); } catch { json = raw; }
     let decimals: number | null = null;
     try { decimals = Number(JSON.parse(Buffer.from(json).toString('utf-8')).decimalPlaces); } catch { /* no metadata */ }
     const address = token.publicKeyString.get();
     return {
       address,
       ticker: info.name,                                     // token name is the ticker
       displayName: info.description,
       decimals: Number.isInteger(decimals) ? decimals : null,
       officialCurrency: official.get(address) ?? null        // null = not in the network's token list
     };
   }

   function format(amount: bigint, decimals: number): string {
     const base = 10n ** BigInt(decimals);
     const fraction = (amount % base).toString().padStart(decimals, '0').replace(/0+$/, '');
     return fraction ? `${amount / base}.${fraction}` : `${amount / base}`;
   }
   ```

4. For each balance, report the network, account, token address, raw amount, and the ticker plus formatted amount when decimals are known. Show the explorer link for the token: `https://explorer.test.keeta.com/token/<address>` or `https://explorer.keeta.com/token/<address>`.
5. To prove a transfer settled, compare a fresh read with the expected token and amount, and find the matching entry in `history({ depth: 25 })` (see the `keeta` skill's `references/transactions.md`).

## Confirmations

- Confirm the network and the account address before you read anything.
- For a single-token check, confirm the full token address, not just the ticker.
- Before using a balance as proof of settlement, take a fresh read after the expected transfer.

## Failures

- **Empty balance list:** it may be an unfunded account, the wrong network, or a node that can't be reached. Work out which before you act.
- **Missing or unparseable decimals:** show raw base units only, and don't convert.
- **Look-alike tokens:** a token that is not in the official list (`officialCurrency === null`) but whose ticker looks like a currency or a well-known asset (`USD`, `USDC`, `EUR`, `KTA`) may be a spoof. Label it unverified, and never treat it as that asset.
- **Floating point:** never convert `bigint` to `number` for arithmetic on money.
- **Cached state:** don't claim settlement from a cached UI value. Refresh from the client, and for anchor flows also check the anchor's transfer status.

## Related skills

- Set up the account with [create-fund-wallet](../create-fund-wallet/SKILL.md).
- Exchange assets with [convert-via-anchors](../convert-via-anchors/SKILL.md).
- Pay out externally with [pay-out](../pay-out/SKILL.md).
- For the full map of what Keeta can do, start at the [keeta](../keeta/SKILL.md) skill.

## Sources

- [UserClient reference](https://static.test.keeta.com/docs/classes/KeetaNetSDK.UserClient.html)
- [Anchor Resolver](https://docs.keeta.com/anchors/overview/anchor-resolver)
- [Overview: main vs test networks](https://docs.keeta.com/guides/overview-main-vs-test-networks)
- [KeetaNet client package](https://www.npmjs.com/package/@keetanetwork/keetanet-client)
