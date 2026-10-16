// Shapes shared across the network, mirrored from
// compute/packages/protocol/src/{types.ts,catalog.ts,hardware.ts,pricing.ts,constants.ts}.
//
// Conventions:
// - Amounts are strings of integer base units (never Double).
// - Byte counts and millisecond timestamps are JSON numbers that may be
//   fractional (the catalog computes `1.8 * GB`), so they decode as Double.
// - Token counts, hours, ports and context lengths decode as Int.

import Foundation

// MARK: - constants.ts

public enum NetworkName: String, Codable, Sendable, CaseIterable, Identifiable {
    case test
    case main

    public var id: String { rawValue }
}

public struct NetworkAsset: Codable, Sendable, Equatable {
    public var address: String
    public var symbol: String
    public var decimals: Int

    public init(address: String, symbol: String, decimals: Int) {
        self.address = address
        self.symbol = symbol
        self.decimals = decimals
    }
}

public enum ProtocolConstants {
    /// Port of the buyer endpoint the agent exposes to local tools (constants.ts LOCAL_API_PORT).
    public static let localAPIPort = 11435
    public static let defaultLocalEndpoint = "http://127.0.0.1:11435/v1"
    /// Prices are quoted per this many tokens (constants.ts PRICE_UNIT_TOKENS).
    public static let priceUnitTokens = 1_000_000
    /// Keeta Compute Credits before the agent reports the token (credits.ts: one credit is one US dollar, 6 decimals).
    public static let fallbackCreditAsset = NetworkAsset(address: "", symbol: "credits", decimals: 6)
    /// Decimal places of KTA, the network fee token.
    /// NOTE: the RPC contract does not report KTA decimals; Keeta's KTA uses 18.
    public static let ktaDecimals = 18
    public static let defaultControlURL = "https://control.keeta.ai"
    public static let defaultRelayURL = "https://relay.keeta.ai"
}

// MARK: - hardware.ts

public enum HardwareTier: String, Codable, Sendable {
    case a = "A"
    case b = "B"
    case c = "C"
    case excluded
}

public enum OperatingSystem: String, Codable, Sendable {
    case macos
    case linux
}

public struct HardwareProfile: Codable, Sendable, Equatable {
    public var os: OperatingSystem
    public var osVersion: String
    public var chip: String
    public var memoryBytes: Double
    public var freeDiskBytes: Double
    public var gpuCores: Int?
    public var machineModel: String?
    public var rdmaCapable: Bool?

    public init(os: OperatingSystem, osVersion: String, chip: String, memoryBytes: Double, freeDiskBytes: Double, gpuCores: Int? = nil, machineModel: String? = nil, rdmaCapable: Bool? = nil) {
        self.os = os
        self.osVersion = osVersion
        self.chip = chip
        self.memoryBytes = memoryBytes
        self.freeDiskBytes = freeDiskBytes
        self.gpuCores = gpuCores
        self.machineModel = machineModel
        self.rdmaCapable = rdmaCapable
    }
}

public enum IncompatibilityReason: String, Codable, Sendable {
    case needsCluster = "needs-cluster"
    case notEnoughMemory = "not-enough-memory"
    case notEnoughDisk = "not-enough-disk"
    case unsupportedRuntime = "unsupported-runtime"
}

/// `{ fits: true; headroomBytes } | { fits: false; reason; shortByBytes? }`
public enum Compatibility: Codable, Sendable, Equatable {
    case fits(headroomBytes: Double)
    case doesNotFit(reason: IncompatibilityReason, shortByBytes: Double?)

    private enum CodingKeys: String, CodingKey {
        case fits, headroomBytes, reason, shortByBytes
    }

    public var fits: Bool {
        if case .fits = self { return true }
        return false
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        if try container.decode(Bool.self, forKey: .fits) {
            self = .fits(headroomBytes: try container.decodeIfPresent(Double.self, forKey: .headroomBytes) ?? 0)
        } else {
            self = .doesNotFit(
                reason: try container.decode(IncompatibilityReason.self, forKey: .reason),
                shortByBytes: try container.decodeIfPresent(Double.self, forKey: .shortByBytes)
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .fits(let headroom):
            try container.encode(true, forKey: .fits)
            try container.encode(headroom, forKey: .headroomBytes)
        case .doesNotFit(let reason, let short):
            try container.encode(false, forKey: .fits)
            try container.encode(reason, forKey: .reason)
            try container.encodeIfPresent(short, forKey: .shortByBytes)
        }
    }
}

// MARK: - pricing.ts

public struct Price: Codable, Sendable, Equatable, Hashable {
    /// Base units of the settlement asset per million input tokens.
    public var inputPerMillion: String
    /// Base units of the settlement asset per million output tokens.
    public var outputPerMillion: String

    public init(inputPerMillion: String, outputPerMillion: String) {
        self.inputPerMillion = inputPerMillion
        self.outputPerMillion = outputPerMillion
    }
}

// MARK: - catalog.ts

public enum RuntimeKind: String, Codable, Sendable {
    case mlx
    case openaiCompatible = "openai-compatible"
}

public struct ModelLicense: Codable, Sendable, Equatable {
    public var name: String
    public var url: String
    public var operatorNotes: String
    public var attribution: String?

    public init(name: String, url: String, operatorNotes: String, attribution: String? = nil) {
        self.name = name
        self.url = url
        self.operatorNotes = operatorNotes
        self.attribution = attribution
    }
}

public struct ModelSource: Codable, Sendable, Equatable {
    public var kind: String
    public var repo: String
    public var revision: String

    public init(kind: String = "huggingface", repo: String, revision: String = "main") {
        self.kind = kind
        self.repo = repo
        self.revision = revision
    }
}

public struct CatalogModel: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var name: String
    public var family: String
    public var parameters: String
    public var quantization: String
    public var runtime: RuntimeKind
    public var source: ModelSource
    public var diskBytes: Double
    public var memoryBytes: Double
    public var contextLength: Int
    public var license: ModelLicense
    public var suggestedPrice: Price
    public var weightsHash: String?
    public var requiresCluster: Bool?
    public var tags: [String]

    public init(id: String, name: String, family: String, parameters: String, quantization: String, runtime: RuntimeKind, source: ModelSource, diskBytes: Double, memoryBytes: Double, contextLength: Int, license: ModelLicense, suggestedPrice: Price, weightsHash: String? = nil, requiresCluster: Bool? = nil, tags: [String] = []) {
        self.id = id
        self.name = name
        self.family = family
        self.parameters = parameters
        self.quantization = quantization
        self.runtime = runtime
        self.source = source
        self.diskBytes = diskBytes
        self.memoryBytes = memoryBytes
        self.contextLength = contextLength
        self.license = license
        self.suggestedPrice = suggestedPrice
        self.weightsHash = weightsHash
        self.requiresCluster = requiresCluster
        self.tags = tags
    }
}

// MARK: - types.ts

public enum AccessMode: String, Codable, Sendable, CaseIterable {
    case `public`
    case allowlist
}

public struct AccessPolicy: Codable, Sendable, Equatable {
    public var mode: AccessMode
    /// Buyer paying keys allowed when mode is allowlist.
    public var allow: [String]

    public init(mode: AccessMode, allow: [String] = []) {
        self.mode = mode
        self.allow = allow
    }

    public static let publicAccess = AccessPolicy(mode: .public, allow: [])
}

public enum PairingStatus: String, Codable, Sendable {
    case waiting, claimed, approved, rejected, expired
}

/// `HardwareProfile & { name: string }` — the descriptor a Linux helper posts when it claims a code.
public struct HelperDescriptor: Codable, Sendable, Equatable {
    public var name: String
    public var hardware: HardwareProfile

    private enum CodingKeys: String, CodingKey { case name }

    public init(name: String, hardware: HardwareProfile) {
        self.name = name
        self.hardware = hardware
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        name = try container.decode(String.self, forKey: .name)
        hardware = try HardwareProfile(from: decoder)
    }

    public func encode(to encoder: Encoder) throws {
        try hardware.encode(to: encoder)
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(name, forKey: .name)
    }
}

public struct PairingClaim: Codable, Sendable, Equatable {
    public var nodeKey: String
    public var descriptor: HelperDescriptor
    public var checkString: String
    public var claimedAt: Double
}

public struct PairingRecord: Codable, Sendable, Equatable {
    public var pairingId: String
    public var codeHash: String
    public var masterNodeKey: String
    public var payTo: String
    public var network: NetworkName
    public var createdAt: Double
    public var expiresAt: Double
    public var status: PairingStatus
    public var claim: PairingClaim?
}

/// Network-wide view of one model for buyers.
public struct NetworkModel: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var name: String
    public var providers: Int
    public var lowestPrice: Price
    public var contextLength: Int
    public var license: String?
}
