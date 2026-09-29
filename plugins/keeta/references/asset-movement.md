# Asset Movement

Canonical page: https://docs.keeta.com/anchors/anchor-types/asset-movement

Client: https://github.com/KeetaNetwork/anchor/blob/main/src/services/asset-movement/client.ts

Asset Movement anchors connect Keeta with external rails. The overview describes two mechanics: Managed Transfers and Persistent Addresses.

Managed transfers are one-off movements. The client supplies the asset or asset pair, the value in the source asset's smallest unit, a source location, and a destination location plus recipient. The provider returns instructions. After the provider receives the funds, it completes the destination side. `getTransferStatus()` reports `transaction.status`, amounts, and an optional `fee`.

Persistent addresses are reusable forwarding destinations. Incoming value is forwarded to the Keeta account. `createPersistentForwardingAddress` is the client method. Its endpoint name for `isOperationSupported` is `createPersistentForwarding`. The response details type includes `address`, optional `depositMessage`, locations, rails, `minimumTransferValue`, and `fees`.

Fiat bank corridors are specified on the deposit and withdraw guides, not on this overview page.
