// Typed method table for `AppToAgent` and `AgentToApp` in types.ts.
//
// Usage: `try await client.call(AgentRPC.WalletSend.self, .init(...))`.

import Foundation

public protocol RPCMethod {
    associatedtype Params: Encodable & Sendable
    associatedtype Result: Decodable & Sendable
    static var name: String { get }
}

/// `Record<string, never>`: encodes as `{}`.
public struct EmptyParams: Codable, Sendable, Equatable {
    public init() {}
}

/// `WalletAssetName` in types.ts: credits, KTA, or a stablecoin by symbol (KUSD, …, USDC).
/// Encodes as the plain string.
public struct WalletAsset: RawRepresentable, Codable, Sendable, Hashable {
    public var rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }

    public static let credits = WalletAsset(rawValue: "credits")
    public static let kta = WalletAsset(rawValue: "kta")
    public static func stablecoin(_ symbol: String) -> WalletAsset { WalletAsset(rawValue: symbol) }
}

// MARK: - Params

public struct InitializeParams: Codable, Sendable, Equatable {
    public var network: NetworkName
    public var controlUrl: String
    public var relayUrl: String
    /// 33-byte compressed P-256 point, hex.
    public var nodePublicKey: String
    public var appVersion: String
    public var machineName: String

    public init(network: NetworkName, controlUrl: String, relayUrl: String, nodePublicKey: String, appVersion: String, machineName: String) {
        self.network = network
        self.controlUrl = controlUrl
        self.relayUrl = relayUrl
        self.nodePublicKey = nodePublicKey
        self.appVersion = appVersion
        self.machineName = machineName
    }
}

public struct SetNetworkParams: Codable, Sendable, Equatable {
    public var network: NetworkName
    public init(network: NetworkName) { self.network = network }
}

public struct SetOperatorParams: Codable, Sendable, Equatable {
    /// 32-byte passkey PRF output, hex. The agent derives the operator key and does not keep it.
    public var entropy: String
    public init(entropy: String) { self.entropy = entropy }
}

public struct WalletSendParams: Codable, Sendable, Equatable {
    public var entropy: String
    public var to: String
    public var amount: String
    public var asset: WalletAsset
    public var memo: String?

    public init(entropy: String, to: String, amount: String, asset: WalletAsset, memo: String? = nil) {
        self.entropy = entropy
        self.to = to
        self.amount = amount
        self.asset = asset
        self.memo = memo
    }
}

public struct FundBudgetParams: Codable, Sendable, Equatable {
    public var entropy: String
    public var amount: String
    public var asset: WalletAsset

    public init(entropy: String, amount: String, asset: WalletAsset) {
        self.entropy = entropy
        self.amount = amount
        self.asset = asset
    }
}

public struct DrainBudgetParams: Codable, Sendable, Equatable {
    public var amount: String
    public var asset: WalletAsset

    public init(amount: String, asset: WalletAsset) {
        self.amount = amount
        self.asset = asset
    }
}

public enum CreditSide: String, Codable, Sendable {
    case buy, sell
}

/// `wallet.creditQuote`: 'buy' asks what `amount` credits cost in the stablecoin, 'sell' what they bring.
public struct CreditQuoteParams: Codable, Sendable, Equatable {
    public var side: CreditSide
    /// Credit base units.
    public var amount: String
    /// Stablecoin symbol, e.g. "KUSD".
    public var stablecoin: String

    public init(side: CreditSide, amount: String, stablecoin: String) {
        self.side = side
        self.amount = amount
        self.stablecoin = stablecoin
    }
}

/// `wallet.buyCredits`: buy exactly `amount` credits with a stablecoin from the operator account.
public struct BuyCreditsParams: Codable, Sendable, Equatable {
    public var entropy: String
    /// Credit base units.
    public var amount: String
    /// Stablecoin symbol to pay with, e.g. "KUSD".
    public var with: String
    /// The most stablecoin (base units) the operator confirmed paying: `wallet.creditQuote`'s `limit`.
    public var maxPay: String
    /// Move the credits into the agent budget (the agent's default) or keep them in the operator account.
    public var toBudget: Bool?

    public init(entropy: String, amount: String, with: String, maxPay: String, toBudget: Bool? = nil) {
        self.entropy = entropy
        self.amount = amount
        self.with = with
        self.maxPay = maxPay
        self.toBudget = toBudget
    }
}

/// `wallet.sellCredits`: cash out exactly `amount` credits from the operator account for a stablecoin.
public struct SellCreditsParams: Codable, Sendable, Equatable {
    public var entropy: String
    /// Credit base units.
    public var amount: String
    /// Stablecoin symbol to receive, e.g. "KUSD".
    public var to: String
    /// The least stablecoin (base units) the operator confirmed receiving: `wallet.creditQuote`'s `limit`.
    public var minReceive: String

    public init(entropy: String, amount: String, to: String, minReceive: String) {
        self.entropy = entropy
        self.amount = amount
        self.to = to
        self.minReceive = minReceive
    }
}

public struct ModelIDParams: Codable, Sendable, Equatable {
    public var modelId: String
    public init(modelId: String) { self.modelId = modelId }
}

public struct InstallCustomParams: Codable, Sendable, Equatable {
    public var repo: String
    public var name: String
    public var contextLength: Int?

    public init(repo: String, name: String, contextLength: Int? = nil) {
        self.repo = repo
        self.name = name
        self.contextLength = contextLength
    }
}

/// How `models.setOffer` should treat the per-model access override.
/// The TypeScript type is `access?: AccessPolicy | null`, which has three states.
public enum OfferAccessUpdate: Sendable, Equatable {
    /// Omit the field: keep whatever the model has now.
    case unchanged
    /// Send `null`: use the install-wide default.
    case useDefault
    /// Send a policy for this model only.
    case override(AccessPolicy)
}

public struct SetOfferParams: Encodable, Sendable, Equatable {
    public var modelId: String
    public var offered: Bool
    public var price: Price?
    public var access: OfferAccessUpdate

    public init(modelId: String, offered: Bool, price: Price? = nil, access: OfferAccessUpdate = .unchanged) {
        self.modelId = modelId
        self.offered = offered
        self.price = price
        self.access = access
    }

    private enum CodingKeys: String, CodingKey {
        case modelId, offered, price, access
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(modelId, forKey: .modelId)
        try container.encode(offered, forKey: .offered)
        try container.encodeIfPresent(price, forKey: .price)
        switch access {
        case .unchanged:
            break
        case .useDefault:
            try container.encodeNil(forKey: .access)
        case .override(let policy):
            try container.encode(policy, forKey: .access)
        }
    }
}

public struct PairingIDParams: Codable, Sendable, Equatable {
    public var pairingId: String
    public init(pairingId: String) { self.pairingId = pairingId }
}

public struct NodeKeyParams: Codable, Sendable, Equatable {
    public var nodeKey: String
    public init(nodeKey: String) { self.nodeKey = nodeKey }
}

// MARK: - Results

public struct SetOperatorResult: Codable, Sendable, Equatable {
    public var operatorAddress: String
    private enum CodingKeys: String, CodingKey { case operatorAddress = "operator" }
}

public struct BlockHashResult: Codable, Sendable, Equatable {
    public var blockHash: String
}

public struct CreditQuoteResult: Codable, Sendable, Equatable {
    /// Stablecoin base units: the estimate.
    public var amount: String
    /// Stablecoin base units the operator confirms with it: the most a buy may cost, or the least a sale may bring.
    public var limit: String
}

public struct BuyCreditsResult: Codable, Sendable, Equatable {
    public var exchangeId: String
    public var blockHash: String
    /// Stablecoin base units paid.
    public var paid: String
    /// Credit base units bought.
    public var credits: String
    /// The move into the agent budget, when there was one.
    public var budgetBlockHash: String?
}

public struct SellCreditsResult: Codable, Sendable, Equatable {
    public var exchangeId: String
    public var blockHash: String
    /// Credit base units sold.
    public var credits: String
    /// Stablecoin base units received.
    public var received: String
}

public struct TestFundsResult: Codable, Sendable, Equatable {
    public var requested: Bool
    public var message: String
}

public struct HardwareCheck: Codable, Sendable, Equatable {
    public var hardware: HardwareProfile
    public var tier: HardwareTier
    public var canProvide: Bool
    public var reason: String?
}

public struct StartedResult: Codable, Sendable, Equatable {
    public var started: Bool
}

public struct InstallCustomResult: Codable, Sendable, Equatable {
    public var started: Bool
    public var modelId: String
}

public struct CancelledResult: Codable, Sendable, Equatable {
    public var cancelled: Bool
}

public struct RemovedResult: Codable, Sendable, Equatable {
    public var removed: Bool
}

/// `buyer.settle`: escrows reported to the control plane, and recent jobs whose settlement was read.
public struct SettleResult: Codable, Sendable, Equatable {
    public var reported: Int
    public var settled: Int
}

public struct PairingCreated: Codable, Sendable, Equatable {
    public var pairingId: String
    public var code: String
    /// Milliseconds since the Unix epoch.
    public var expiresAt: Double
}

public struct ApprovedResult: Codable, Sendable, Equatable {
    public var approved: Bool
}

public struct RejectedResult: Codable, Sendable, Equatable {
    public var rejected: Bool
}

public struct RevokedResult: Codable, Sendable, Equatable {
    public var revoked: Bool
}

public struct OKResult: Codable, Sendable, Equatable {
    public var ok: Bool
}

// MARK: - AgentToApp

public struct SignDigestParams: Codable, Sendable, Equatable {
    /// 32-byte digest, hex.
    public var digest: String
    public init(digest: String) { self.digest = digest }
}

public struct SignDigestResult: Codable, Sendable, Equatable {
    /// Raw r||s, 64 bytes, hex, low S.
    public var signature: String
    public init(signature: String) { self.signature = signature }
}

// MARK: - Method table

public enum AgentRPC {
    public enum Initialize: RPCMethod {
        public typealias Params = InitializeParams
        public typealias Result = AgentState
        public static let name = "agent.initialize"
    }

    public enum State: RPCMethod {
        public typealias Params = EmptyParams
        public typealias Result = AgentState
        public static let name = "agent.state"
    }

    public enum SetNetwork: RPCMethod {
        public typealias Params = SetNetworkParams
        public typealias Result = AgentState
        public static let name = "agent.setNetwork"
    }

    public enum Shutdown: RPCMethod {
        public typealias Params = EmptyParams
        public typealias Result = OKResult
        public static let name = "agent.shutdown"
    }

    public enum WalletSetOperator: RPCMethod {
        public typealias Params = SetOperatorParams
        public typealias Result = SetOperatorResult
        public static let name = "wallet.setOperator"
    }

    public enum WalletRefresh: RPCMethod {
        public typealias Params = EmptyParams
        public typealias Result = WalletState
        public static let name = "wallet.refresh"
    }

    public enum WalletSend: RPCMethod {
        public typealias Params = WalletSendParams
        public typealias Result = BlockHashResult
        public static let name = "wallet.send"
    }

    public enum WalletFundBudget: RPCMethod {
        public typealias Params = FundBudgetParams
        public typealias Result = BlockHashResult
        public static let name = "wallet.fundBudget"
    }

    public enum WalletDrainBudget: RPCMethod {
        public typealias Params = DrainBudgetParams
        public typealias Result = BlockHashResult
        public static let name = "wallet.drainBudget"
    }

    public enum WalletCreditQuote: RPCMethod {
        public typealias Params = CreditQuoteParams
        public typealias Result = CreditQuoteResult
        public static let name = "wallet.creditQuote"
    }

    public enum WalletBuyCredits: RPCMethod {
        public typealias Params = BuyCreditsParams
        public typealias Result = BuyCreditsResult
        public static let name = "wallet.buyCredits"
    }

    public enum WalletSellCredits: RPCMethod {
        public typealias Params = SellCreditsParams
        public typealias Result = SellCreditsResult
        public static let name = "wallet.sellCredits"
    }

    public enum WalletRequestTestFunds: RPCMethod {
        public typealias Params = EmptyParams
        public typealias Result = TestFundsResult
        public static let name = "wallet.requestTestFunds"
    }

    public enum HardwareProfileCheck: RPCMethod {
        public typealias Params = EmptyParams
        public typealias Result = HardwareCheck
        public static let name = "hardware.profile"
    }

    public enum ModelsList: RPCMethod {
        public typealias Params = EmptyParams
        public typealias Result = [CatalogEntry]
        public static let name = "models.list"
    }

    public enum ModelsInstall: RPCMethod {
        public typealias Params = ModelIDParams
        public typealias Result = StartedResult
        public static let name = "models.install"
    }

    public enum ModelsInstallCustom: RPCMethod {
        public typealias Params = InstallCustomParams
        public typealias Result = InstallCustomResult
        public static let name = "models.installCustom"
    }

    public enum ModelsCancelInstall: RPCMethod {
        public typealias Params = ModelIDParams
        public typealias Result = CancelledResult
        public static let name = "models.cancelInstall"
    }

    public enum ModelsRemove: RPCMethod {
        public typealias Params = ModelIDParams
        public typealias Result = RemovedResult
        public static let name = "models.remove"
    }

    public enum ModelsSetOffer: RPCMethod {
        public typealias Params = SetOfferParams
        public typealias Result = InstalledModel
        public static let name = "models.setOffer"
    }

    public enum ProviderStatusGet: RPCMethod {
        public typealias Params = EmptyParams
        public typealias Result = ProviderStatus
        public static let name = "provider.status"
    }

    public enum ProviderSetPolicy: RPCMethod {
        public typealias Params = ProviderPolicyUpdate
        public typealias Result = ProviderStatus
        public static let name = "provider.setPolicy"
    }

    public enum BuyerStatusGet: RPCMethod {
        public typealias Params = EmptyParams
        public typealias Result = BuyerStatus
        public static let name = "buyer.status"
    }

    public enum BuyerSetPolicy: RPCMethod {
        public typealias Params = BuyerPolicyUpdate
        public typealias Result = BuyerStatus
        public static let name = "buyer.setPolicy"
    }

    public enum BuyerRotateToken: RPCMethod {
        public typealias Params = EmptyParams
        public typealias Result = BuyerStatus
        public static let name = "buyer.rotateToken"
    }

    public enum BuyerNetworkModels: RPCMethod {
        public typealias Params = EmptyParams
        public typealias Result = [NetworkModel]
        public static let name = "buyer.networkModels"
    }

    public enum BuyerSettle: RPCMethod {
        public typealias Params = EmptyParams
        public typealias Result = SettleResult
        public static let name = "buyer.settle"
    }

    public enum FleetCreatePairing: RPCMethod {
        public typealias Params = EmptyParams
        public typealias Result = PairingCreated
        public static let name = "fleet.createPairing"
    }

    public enum FleetPairingStatus: RPCMethod {
        public typealias Params = PairingIDParams
        public typealias Result = PairingRecord
        public static let name = "fleet.pairingStatus"
    }

    public enum FleetApprove: RPCMethod {
        public typealias Params = PairingIDParams
        public typealias Result = ApprovedResult
        public static let name = "fleet.approve"
    }

    public enum FleetReject: RPCMethod {
        public typealias Params = PairingIDParams
        public typealias Result = RejectedResult
        public static let name = "fleet.reject"
    }

    public enum FleetList: RPCMethod {
        public typealias Params = EmptyParams
        public typealias Result = [FleetHelper]
        public static let name = "fleet.list"
    }

    public enum FleetRevoke: RPCMethod {
        public typealias Params = NodeKeyParams
        public typealias Result = RevokedResult
        public static let name = "fleet.revoke"
    }
}

/// Methods the agent calls on the app (`AgentToApp`).
public enum AppRPC {
    public static let signDigest = "signer.signDigest"
}

/// Notifications the agent sends (`AgentNotifications`).
public enum AgentNotificationName {
    public static let state = "event.state"
    public static let installProgress = "event.installProgress"
    public static let job = "event.job"
    public static let log = "event.log"
}
