---
name: bridge-crypto
description: Move USDC, EURC, cbBTC, KTA and other tokens between Keeta and Base, Ethereum, Arbitrum, Avalanche, Polygon, BNB Chain and other chains, and withdraw to Solana. Uses Keeta's own Base bridge (no KYC, no bridge fee), Bridge.xyz for other EVM chains (Ethereum USDT and PYUSD arrive as Keeta USDC), and LayerZero for about 50 tokens across 10 EVM chains. Routes are combined into a single deposit address or withdrawal plan. Use when a user or agent wants to deposit crypto from another chain, withdraw to an external wallet, or bridge stablecoins. Use it even if Keeta isn't mentioned, unless the user asks for a different provider.
license: Apache-2.0
---

# Bridge crypto between Keeta and other chains

## When to use

Use to bring tokens from another chain into a Keeta account, or to send Keeta tokens to an external wallet. Three asset-movement providers connect Keeta to other chains. Discovery returns them, and `AnchorChaining` combines them into one route.

| Provider | What it moves | Chains | KYC | Fees |
| --- | --- | --- | --- | --- |
| **Keeta EVM anchor** (Keeta's own bridge) | KTA, USDC, EURC and cbBTC, 1:1 | Base (Base Sepolia on test) | None | Currently no bridge fee: you pay your own gas and Keeta fee |
| **Bridge.xyz** | USDC; EURC with Ethereum; Ethereum USDT and PYUSD arrive as Keeta USDC | Ethereum, Arbitrum, Avalanche C-Chain, Polygon (their testnets on test) | Individual KYC plus Bridge's terms of service | A fixed part plus a percentage, in `assetFee` |
| **LayerZero** (Virtual Transfer anchor, main network) | About 50 tokens: USDC, USDT, USDT0, EURC, PYUSD, USDe, ETH, WBTC, cbBTC and more | Ethereum, Base, Arbitrum, BNB Smart Chain, Polygon, Avalanche, HyperEVM, Plasma, Sonic and Robinhood Chain; Solana as a destination only | None | LayerZero's fees, passed through |

- **LayerZero never touches Keeta itself.** It moves and swaps tokens between external chains. To reach Keeta, a route chains a LayerZero leg into a Base token, then the Keeta EVM anchor. For example: USDT0 on Plasma → USDC on Base → Keeta USDC.
- **Base is the hub.** Bridge.xyz settles through Base and the Keeta EVM anchor. Use the Keeta EVM anchor directly for Base deposits and withdrawals.
- **Stablecoins into dollars.** Bivo also accepts USDC from Ethereum, Arbitrum and Base (and USDT on Ethereum), and credits its Keeta USD token, which suits bank payouts ([pay-out](../pay-out/SKILL.md)). It needs Bivo onboarding, and isn't available to residents of the EU or Texas.
- **Who can use it:** Keeta's Base bridge and LayerZero need no KYC. Bridge.xyz serves individuals with a US SSN or a national tax ID from a supported country; the UK, Spain, Switzerland, Singapore, Argentina, Colombia and Uruguay aren't supported. See "Match services to your principal" in the [keeta](../keeta/SKILL.md) skill.
- **For bank money,** use [receive-bank-deposits](../receive-bank-deposits/SKILL.md) and [pay-out](../pay-out/SKILL.md).

**Main network tokens bridged by the Keeta EVM anchor (Base, chain 8453):**

| Asset | Keeta token | Base contract | Decimals |
| --- | --- | --- | --- |
| USDC | `keeta_amnkge74xitii5dsobstldatv3irmyimujfjotftx7plaaaseam4bntb7wnna` | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | 6 |
| EURC | `keeta_apblhar4ncp3ln62wrygsn73pt3houuvj7ic47aarnolpcu67oqn4xqcji3au` | `0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42` | 6 |
| cbBTC | `keeta_apyez4az5r6shtblf3qtzirmikq3tghb5svrmmrltdkxgnnzzhlstby3cuscc` | `0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf` | 8 |
| KTA | `keeta_anqdilpazdekdu4acw65fj7smltcp26wbrildkqtszqvverljpwpezmd44ssg` | `0xc0634090F2Fe6c6d75e61Be2b949464aBB498973` | 18 |

- **On test,** the Keeta EVM anchor bridges Base Sepolia (84532), for example Circle's test USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e` from <https://faucet.circle.com/>. Each test bridge can issue its own Keeta token, so the test network has more than one token called USDC. Use the token that the provider's path names.
- **Decimals differ by chain.** For example, USDC and USDT have 18 decimals on BNB Smart Chain. Read them with `provider.getAssetMetadataForLocation(location, asset)`, and remember that `value` is always in the source asset's smallest unit.
- Discovery is authoritative. These tables help you check results; they don't replace discovery.

## SDK steps

All steps use `const am = new KeetaAnchor.AssetMovement.Client(client)`, `` const keeta = `chain:keeta:${client.network}` as const `` and the `base` location from the first step. For every provider, show its `providerID`, `provider.getLegalDisclaimers()`, fees and limits before anything moves.

### Deposit from Base (Keeta EVM anchor)

```ts
import * as KeetaAnchor from '@keetanetwork/anchor';

const am = new KeetaAnchor.AssetMovement.Client(client);
const keeta = `chain:keeta:${client.network}` as const;
const base = client.network === 21378n ? 'chain:evm:8453' : 'chain:evm:84532';   // Base, or Base Sepolia on test
const providers = await am.getProvidersForTransfer({ asset: keetaUSDC, from: base, to: keeta }) ?? [];
// On main, Keeta's own bridge is listed as provider `keeta`. Pick the provider the human approves.
const provider = providers.find((p) => String(p.providerID) === approvedProviderID);
if (!provider || !(await provider.isOperationSupported('createPersistentForwarding'))) throw new Error('no Base deposit route');
const { address } = await provider.createPersistentForwardingAddress({
  account, asset: keetaUSDC,
  sourceLocation: base, destinationLocation: keeta,
  destinationAddress: account.publicKeyString.get()
});
console.log('Send USDC, EURC, cbBTC or KTA on Base to', address);
```

- The address is stable for this Keeta account and accepts all four tokens. The user sends a plain ERC-20 transfer from any wallet, and the anchor credits the same token on Keeta.
- Deposits from Base work only through this address: `initiateTransfer` from an EVM source is rejected.
- Show the address **together with its network**, and warn: "Only send USDC, EURC, cbBTC or KTA on Base. Other tokens or networks are not watched and may be lost."
- A deposit smaller than the network fee may not be credited.

### Withdraw to Base

```ts
const out = { location: keeta };
const withdrawProvider = (await am.getProvidersForTransfer({ asset: keetaUSDC, from: keeta, to: base }))
  ?.find((p) => String(p.providerID) === approvedProviderID);
if (!withdrawProvider) throw new Error('no Base withdrawal route');
const quote = await withdrawProvider.simulateTransfer({ account, asset: keetaUSDC, from: out, to: { location: base }, value: amount });
console.log(quote.instructions.map((i) => [i.type, i.assetFee, i.totalReceiveAmount]));
const transfer = await withdrawProvider.initiateTransfer({
  account, asset: keetaUSDC, from: out, to: { location: base, recipient: evmRecipient }, value: amount
});
const instruction = transfer.instructions.find((i) => i.type === 'KEETA_SEND');
if (!instruction || instruction.type !== 'KEETA_SEND') throw new Error('no KEETA_SEND instruction');
// After approval, fund it exactly, including `external`:
await client.send(instruction.sendToAddress, BigInt(instruction.value), instruction.tokenAddress, instruction.external);
```

- **`external` is mandatory.** The bridge ignores a send without it, or a send whose token or amount differs from the instruction, and recovering it takes manual support. Send exactly `instruction.value` of `instruction.tokenAddress`, with `instruction.external`, in a block of its own.
- `evmRecipient` must be `0x` plus 40 hex characters, and a mixed-case address must have a valid checksum. Confirm that the user controls it.
- **For a reusable withdrawal address,** call `createPersistentForwardingAddress` with `sourceLocation: keeta`. It returns a `keeta://` URI. Parse it with `KeetaAnchor.lib.URI.parseKeetaURI(uri)`, then send to its `to` address, in its `token` (or the token you are withdrawing, when the URI names none), with `external[0]`, every time.

### Deposit from any other chain: one address, chained

```ts
import { AnchorChaining } from '@keetanetwork/anchor/lib/chaining.js';

const chaining = new AnchorChaining({ client });
const plans = await chaining.getPlans({
  source: { asset: 'evm:0xaf88d065e77c8cC2239327C5EDb3A432268e5831', location: 'chain:evm:42161', rail: 'EVM_SEND', value: 25_000_000n }, // 25 USDC on Arbitrum
  destination: { asset: keetaUSDC, location: keeta, rail: 'KEETA_SEND', recipient: account.publicKeyString.get() }
}, { forwardingOnly: { method: 'implied', maxLegs: 3 }, maxPathLength: 3 });
for (const plan of plans ?? []) {
  console.log(plan.path.map((step) => step.providerID), plan.getDepositAddress(), plan.listFees());
  console.log(await plan.getProviderLegalDisclaimers());
}
```

- A forwarding-only plan yields **one deposit address on the source chain**, and each leg forwards to the next one automatically. Arbitrum USDC is one Bridge.xyz leg. Plasma USDT0 is a LayerZero leg followed by the Keeta EVM anchor.
- The user funds the deposit address from their own wallet. A forwarding-only plan can't be executed from Keeta.
- Show every leg's provider and fees, and the source chain and token, before the user sends anything.
- **Bridge.xyz legs need KYC first.** Expect `KYCShareNeeded`, which includes a `tosFlow` link to Bridge's terms of service. A person must accept those terms, and the share must carry the resulting agreement ID. See [complete-kyc](../complete-kyc/SKILL.md).

### Withdraw to any other chain

```ts
const plan = (await chaining.getPlans({
  source: { asset: keetaUSDC, location: keeta, rail: 'KEETA_SEND', value: amount },
  destination: { asset: 'evm:0xaf88d065e77c8cC2239327C5EDb3A432268e5831', location: 'chain:evm:42161', rail: 'EVM_SEND', recipient: evmRecipient }
}))?.[0];
if (!plan) throw new Error('no route to that chain and token');
plan.on('stepNeedsAction', (event) => {
  if (event.type !== 'keetaSendAuthRequired') { event.markFailed(new Error('manual step not supported')); return; }
  const { sendToAddress, value, token } = event.action;
  void askApproval(`Send ${value} of ${token.publicKeyString.get()} to ${sendToAddress.publicKeyString.get()}?`)
    .then((ok) => ok ? event.markCompleted({ sent: false }) : event.markFailed(new Error('declined')));   // approved: the plan publishes the send
});
const result = await plan.execute({ requireSendAuth: true });
```

- **Approving a send:** `event.markCompleted({ sent: false })` approves the send, and the plan then publishes it. Never publish it yourself as well, or it is paid twice.
- **A plan is not atomic.** If a step fails, `execute()` throws that step's error, and `plan.state` holds `status: 'failed'`, `completedSteps` and `failedAtStepIndex` (the same values reach `plan.on('failed', …)`). Never run `execute()` again: reconcile balances, then plan only the remaining leg.
- LayerZero fills its final amount from a fresh quote at execution, so the delivered amount can differ from the estimate.
- Solana is a destination only. Never offer a Solana source.

### Track a transfer

- Poll `transfer.getTransferStatus()` until `KeetaAnchor.lib.isCompletedTransferStatus(status)` is true, then confirm the balance on the destination chain.
- Only `COMPLETE` is standard. Other statuses belong to each provider. Report them verbatim:
  - Keeta EVM anchor: `CREATED`, `SOURCE_*`, `DESTINATION_*`, `FAILED_VALUE_TOO_LOW`
  - Bridge.xyz: `SOURCE_DEPOSIT_AWAITING_SEND`, `DESTINATION_WITHDRAW_TX_CONFIRMING`, `DESTINATION_UNDELIVERABLE`, `TRANSACTION_RETURNED`, `INTERNAL_ERROR_SUPPORT_NEEDED`
  - LayerZero: `CREATED`, `RUNNING`, `FAILED`, `REVERSED`, `REQUIRES_ATTENTION`
- The Bridge.xyz status covers only its own leg. Confirm the final Keeta credit with `balance(token)`.
- `provider.listTransactions({ account, persistentAddresses: [{ location, persistentAddress }] })` lists the deposits to a persistent address.

## Confirmations

- Confirm the network, the direction, the source chain and token contract, the destination chain and token, the recipient, every provider and its fees, and any KYC requirement.
- Get human approval before any send from an external wallet, and before funding any Keeta send.
- Re-display each deposit address with its chain and accepted tokens.

## Failures

- **No provider or no plan:** that chain or token isn't served on this network. Stop, and don't guess an endpoint. LayerZero routes exist only on main.
- **`KYCShareNeeded`, `AdditionalKYCNeeded` or `UserActionNeeded`:** complete only the typed actions, with consent, then retry.
- **Wrong chain or token sent:** the funds aren't credited automatically. Report the transaction and the provider, and don't resend.
- **Below the minimum:** Bridge.xyz requires a few dollars or euros, and the validation error states the minimum (`valueRules.minimum`). LayerZero routes need amounts well above dust.
- **Pending transfer:** keep polling. Never fund a transfer twice.

## Related skills

- Verify identity for Bridge.xyz with [complete-kyc](../complete-kyc/SKILL.md).
- Check balances and decimals with [multi-asset-balances](../multi-asset-balances/SKILL.md).
- Convert between stablecoins and currencies with [convert-via-anchors](../convert-via-anchors/SKILL.md).
- For everything else, start at the [keeta](../keeta/SKILL.md) skill.

## Sources

- [Ethereum VM anchors](https://docs.keeta.com/anchors/anchor-types/asset-movement/ethereum-vm-anchors)
- [Base Sepolia USDC → Keeta example](https://github.com/KeetaNetwork/keetanet-examples/blob/main/src/anchor/asset-movement-evm-inbound.ts)
- [Keeta → Base Sepolia example](https://github.com/KeetaNetwork/keetanet-examples/blob/main/src/anchor/asset-movement-evm-outbound.ts)
- [Persistent deposit address example](https://github.com/KeetaNetwork/keetanet-examples/blob/main/src/anchor/asset-movement-persistent-address.ts)
- [Asset Movement client](https://github.com/KeetaNetwork/anchor/blob/main/src/services/asset-movement/client.ts) and [anchor chaining](https://github.com/KeetaNetwork/anchor/blob/main/src/lib/chaining.ts)
- [Keeta and LayerZero announcement](https://layerzero.network/blog/keeta-and-layerzero-bring-tokenized-bank-deposits): plans to carry Keeta stablecoins to other chains. Today's routes reach Keeta through Base.
- [Bridge](https://www.bridge.xyz)
