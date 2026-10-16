// Mirrors compute/agent/src/rpc/types.ts — the contract between this app and
// the bundled `keeta-compute-agent`. Keep field names identical to the
// TypeScript; when the contract changes, change this file and the tests.

import Foundation

public struct AssetBalance: Codable, Sendable, Equatable {
    /// Keeta Compute Credits, which pay for requests, base units.
    public var credits: String
    /// KTA, which pays network fees, base units.
    public var kta: String
    /// Each available stablecoin by symbol (KUSD, …, USDC), in its own base units.
    public var stablecoins: [String: String]

    public init(credits: String, kta: String, stablecoins: [String: String] = [:]) {
        self.credits = credits
        self.kta = kta
        self.stablecoins = stablecoins
    }
}

/// A stablecoin that buys credits and that credits cash out to.
public struct StablecoinInfo: Codable, Sendable, Equatable, Hashable, Identifiable {
    public var symbol: String
    public var name: String
    /// ISO 4217 code it tracks.
    public var currency: String
    public var address: String
    public var decimals: Int

    public init(symbol: String, name: String, currency: String, address: String, decimals: Int) {
        self.symbol = symbol
        self.name = name
        self.currency = currency
        self.address = address
        self.decimals = decimals
    }

    public var id: String { symbol }
}

public struct WalletBalances: Codable, Sendable, Equatable {
    /// `operator` is a Swift keyword, so the property is renamed.
    public var operatorBalance: AssetBalance?
    public var spend: AssetBalance

    private enum CodingKeys: String, CodingKey {
        case operatorBalance = "operator"
        case spend
    }

    public init(operatorBalance: AssetBalance?, spend: AssetBalance) {
        self.operatorBalance = operatorBalance
        self.spend = spend
    }
}

public struct WalletState: Codable, Sendable, Equatable {
    /// Passkey-backed operator account: identity, payout address, main balance.
    public var operatorAddress: String?
    /// Local key used to pay for inference on behalf of agents on this Mac ("agent budget").
    public var spend: String
    public var balances: WalletBalances?
    /// Keeta Compute Credits: what prices, limits, costs and earnings are in.
    public var asset: NetworkAsset
    /// False until credits exist on this network; buying inference needs them.
    public var creditsAvailable: Bool
    /// Stablecoins available on this network, in lead order (KUSD first, USDC last).
    public var stablecoins: [StablecoinInfo]
    public var explorer: String
    /// Last balance read error, e.g. network unreachable.
    public var error: String?

    private enum CodingKeys: String, CodingKey {
        case operatorAddress = "operator"
        case spend, balances, asset, creditsAvailable, stablecoins, explorer, error
    }

    public init(operatorAddress: String?, spend: String, balances: WalletBalances?, asset: NetworkAsset, creditsAvailable: Bool, stablecoins: [StablecoinInfo], explorer: String, error: String? = nil) {
        self.operatorAddress = operatorAddress
        self.spend = spend
        self.balances = balances
        self.asset = asset
        self.creditsAvailable = creditsAvailable
        self.stablecoins = stablecoins
        self.explorer = explorer
        self.error = error
    }

    // Encode `operator` and `balances` as explicit nulls, as the agent does.
    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(operatorAddress, forKey: .operatorAddress)
        try container.encode(spend, forKey: .spend)
        try container.encode(balances, forKey: .balances)
        try container.encode(asset, forKey: .asset)
        try container.encode(creditsAvailable, forKey: .creditsAvailable)
        try container.encode(stablecoins, forKey: .stablecoins)
        try container.encode(explorer, forKey: .explorer)
        try container.encodeIfPresent(error, forKey: .error)
    }
}

public enum ScheduleMode: String, Codable, Sendable, CaseIterable {
    case always
    case idle
    case hours
}

public struct ProviderSchedule: Codable, Sendable, Equatable {
    public var mode: ScheduleMode
    public var startHour: Int?
    public var endHour: Int?
    public var idleMinutes: Int?

    public init(mode: ScheduleMode, startHour: Int? = nil, endHour: Int? = nil, idleMinutes: Int? = nil) {
        self.mode = mode
        self.startHour = startHour
        self.endHour = endHour
        self.idleMinutes = idleMinutes
    }
}

public struct ProviderPolicy: Codable, Sendable, Equatable {
    public var enabled: Bool
    public var schedule: ProviderSchedule
    public var pauseOnBattery: Bool
    public var maxConcurrentJobs: Int
    /// Install-wide default; each offer may override.
    public var access: AccessPolicy

    public init(enabled: Bool, schedule: ProviderSchedule, pauseOnBattery: Bool, maxConcurrentJobs: Int, access: AccessPolicy) {
        self.enabled = enabled
        self.schedule = schedule
        self.pauseOnBattery = pauseOnBattery
        self.maxConcurrentJobs = maxConcurrentJobs
        self.access = access
    }
}

/// `Partial<ProviderPolicy>`: nil fields are omitted from the JSON.
public struct ProviderPolicyUpdate: Codable, Sendable, Equatable {
    public var enabled: Bool?
    public var schedule: ProviderSchedule?
    public var pauseOnBattery: Bool?
    public var maxConcurrentJobs: Int?
    public var access: AccessPolicy?

    public init(enabled: Bool? = nil, schedule: ProviderSchedule? = nil, pauseOnBattery: Bool? = nil, maxConcurrentJobs: Int? = nil, access: AccessPolicy? = nil) {
        self.enabled = enabled
        self.schedule = schedule
        self.pauseOnBattery = pauseOnBattery
        self.maxConcurrentJobs = maxConcurrentJobs
        self.access = access
    }
}

public struct BuyerPolicy: Codable, Sendable, Equatable {
    /// Largest amount a single request may cost (its escrow), credit base units.
    public var perRequestMax: String
    /// Largest total providers may bill per UTC day, credit base units.
    public var dailyMax: String
    /// Empty means any model.
    public var allowedModels: [String]
    /// Empty means any provider.
    public var allowedProviders: [String]
    /// Highest price the app will accept, credit base units per million tokens.
    public var maxPrice: Price

    public init(perRequestMax: String, dailyMax: String, allowedModels: [String], allowedProviders: [String], maxPrice: Price) {
        self.perRequestMax = perRequestMax
        self.dailyMax = dailyMax
        self.allowedModels = allowedModels
        self.allowedProviders = allowedProviders
        self.maxPrice = maxPrice
    }
}

/// `Partial<BuyerPolicy>`: nil fields are omitted from the JSON.
public struct BuyerPolicyUpdate: Codable, Sendable, Equatable {
    public var perRequestMax: String?
    public var dailyMax: String?
    public var allowedModels: [String]?
    public var allowedProviders: [String]?
    public var maxPrice: Price?

    public init(perRequestMax: String? = nil, dailyMax: String? = nil, allowedModels: [String]? = nil, allowedProviders: [String]? = nil, maxPrice: Price? = nil) {
        self.perRequestMax = perRequestMax
        self.dailyMax = dailyMax
        self.allowedModels = allowedModels
        self.allowedProviders = allowedProviders
        self.maxPrice = maxPrice
    }
}

public struct ModelOffer: Codable, Sendable, Equatable {
    public var offered: Bool
    public var price: Price
    /// nil means the install-wide default applies.
    public var access: AccessPolicy?

    public init(offered: Bool, price: Price, access: AccessPolicy?) {
        self.offered = offered
        self.price = price
        self.access = access
    }
}

public struct InstalledModel: Codable, Sendable, Equatable {
    public var modelId: String
    public var name: String
    public var path: String
    public var weightsHash: String
    public var sizeBytes: Double
    public var installedAt: Double
    public var custom: Bool
    public var offer: ModelOffer
}

public struct CatalogEntry: Codable, Sendable, Equatable, Identifiable {
    public var model: CatalogModel
    public var compatibility: Compatibility
    public var installed: InstalledModel?

    public var id: String { model.id }
}

public enum InstallPhase: String, Codable, Sendable {
    case queued, runtime, downloading, verifying, done, failed
}

public struct InstallProgress: Codable, Sendable, Equatable {
    public var modelId: String
    public var phase: InstallPhase
    public var bytesDone: Double
    public var bytesTotal: Double
    public var message: String?

    public init(modelId: String, phase: InstallPhase, bytesDone: Double, bytesTotal: Double, message: String? = nil) {
        self.modelId = modelId
        self.phase = phase
        self.bytesDone = bytesDone
        self.bytesTotal = bytesTotal
        self.message = message
    }

    /// 0...1, or nil when the total is unknown.
    public var fraction: Double? {
        guard bytesTotal > 0 else { return nil }
        return min(1, max(0, bytesDone / bytesTotal))
    }

    public var isActive: Bool { phase != .done && phase != .failed }
}

public enum JobRole: String, Codable, Sendable {
    case provider, buyer
}

/// 'completed': receipt in; 'paid': settled from the escrow on the ledger; 'failed': refunded or not run.
public enum JobSummaryStatus: String, Codable, Sendable {
    case running, completed, paid, failed
}

public struct JobSummary: Codable, Sendable, Equatable, Identifiable {
    public var jobId: String
    public var role: JobRole
    public var modelId: String
    public var counterparty: String
    public var inputTokens: Int
    public var outputTokens: Int
    /// Credit base units billed.
    public var amount: String
    public var status: JobSummaryStatus
    /// Milliseconds since the Unix epoch.
    public var at: Double
    public var helper: String?
    public var error: String?

    public var id: String { jobId }
    public var date: Date { Date(timeIntervalSince1970: at / 1000) }
}

public enum ProviderState: String, Codable, Sendable {
    case online
    case paused
    case outsideSchedule = "outside-schedule"
    case onBattery = "on-battery"
    case noOffers = "no-offers"
    case notEligible = "not-eligible"
    case connecting
    case offline
}

public struct ProviderStatus: Codable, Sendable, Equatable {
    public var policy: ProviderPolicy
    /// Why the node is not taking jobs right now, if it isn't.
    public var state: ProviderState
    public var activeJobs: Int
    /// Credits the settlement account paid the operator, read from the ledger.
    public var earnedToday: String
    public var earnedTotal: String
    public var tokensServedToday: Int
    public var recentJobs: [JobSummary]
}

public struct BuyerStatus: Codable, Sendable, Equatable {
    public var endpoint: String
    public var token: String
    public var policy: BuyerPolicy
    /// Credits charged today (what providers billed; escrow refunds are not counted).
    public var spentToday: String
    public var recentJobs: [JobSummary]
}

public enum HelperStatus: String, Codable, Sendable {
    case online, paused, offline
}

public struct FleetHelper: Codable, Sendable, Equatable, Identifiable {
    public var nodeKey: String
    public var name: String
    public var hardware: HardwareProfile
    public var tier: HardwareTier
    public var status: HelperStatus
    public var offers: [String]
    /// Jobs this helper completed; what they earned is paid to the master's operator account.
    public var completed: Int
    public var lastHeartbeat: Double

    public var id: String { nodeKey }
}

public struct AgentState: Codable, Sendable, Equatable {
    public var version: String
    public var network: NetworkName
    public var nodeKey: String?
    public var onboarded: Bool
    public var controlReachable: Bool
    public var hardware: HardwareProfile?
    public var tier: HardwareTier?
    public var wallet: WalletState?
    public var provider: ProviderStatus?
    public var buyer: BuyerStatus?
}

public enum LogLevel: String, Codable, Sendable {
    case debug, info, warn, error
}

public struct LogEvent: Codable, Sendable, Equatable {
    public var level: LogLevel
    public var message: String

    public init(level: LogLevel, message: String) {
        self.level = level
        self.message = message
    }
}

/// `RPC_ERRORS` in types.ts.
public enum RPCErrorCode {
    public static let parse = -32700
    public static let invalidRequest = -32600
    public static let methodNotFound = -32601
    public static let invalidParams = -32602
    public static let `internal` = -32603
    public static let notInitialized = -32001
    public static let noOperator = -32002
    public static let policyDenied = -32003
    public static let insufficientFunds = -32004
    public static let network = -32005
    public static let notEligible = -32006
}
