import Foundation
import Security

/// What a passkey registration returned, without AuthenticationServices types,
/// so the wallet logic can run in unit tests with a fake authenticator.
public struct PasskeyRegistrationResult: Sendable, Equatable {
    public var credentialID: Data
    /// nil when the authenticator did not say whether it supports PRF.
    public var prfSupported: Bool?

    public init(credentialID: Data, prfSupported: Bool?) {
        self.credentialID = credentialID
        self.prfSupported = prfSupported
    }
}

/// What a passkey assertion returned.
public struct PasskeyAssertionResult: Sendable, Equatable {
    public var credentialID: Data
    /// PRF output for the first salt, or nil when the authenticator returned none.
    public var prfOutput: Data?

    public init(credentialID: Data, prfOutput: Data?) {
        self.credentialID = credentialID
        self.prfOutput = prfOutput
    }
}

/// The parameters of one passkey registration request.
public struct PasskeyRegistrationRequest: Sendable, Equatable {
    public var relyingParty: String
    public var accountName: String
    public var userID: Data
    public var challenge: Data
    /// Ask the authenticator whether it supports PRF.
    public var checkPRFSupport: Bool
}

/// The parameters of one passkey assertion request.
public struct PasskeyAssertionRequest: Sendable, Equatable {
    public var relyingParty: String
    public var challenge: Data
    /// nil lets the user pick any passkey for the relying party.
    public var allowedCredentialIDs: [Data]?
    public var userVerificationRequired: Bool
    public var prfSalt: Data
}

/// Runs passkey requests. The app's implementation uses ASAuthorizationController.
@MainActor
public protocol PasskeyAuthenticator: AnyObject {
    func register(_ request: PasskeyRegistrationRequest) async throws -> PasskeyRegistrationResult
    func assert(_ request: PasskeyAssertionRequest) async throws -> PasskeyAssertionResult
}

/// Where the wallet passkey's credential ID is remembered.
@MainActor
public protocol PasskeyCredentialStore: AnyObject {
    var credentialID: Data? { get set }
}

public final class UserDefaultsPasskeyCredentialStore: PasskeyCredentialStore {
    public static let key = "wallet.passkeyCredentialID"
    private let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    public var credentialID: Data? {
        get { defaults.data(forKey: Self.key) }
        set { defaults.set(newValue, forKey: Self.key) }
    }
}

public enum PasskeyWalletError: LocalizedError, Equatable {
    case canceled
    case prfUnsupported
    case noPRFOutput
    case noCredential
    case unexpectedCredential
    case busy
    /// macOS could not confirm that keeta.ai lists this app for passkeys.
    case associationUnverified
    case authorization(String)

    public var errorDescription: String? {
        switch self {
        case .canceled:
            return "Canceled."
        case .prfUnsupported:
            return "This passkey provider can't secure a wallet. Use iCloud Keychain (Passwords) and try again."
        case .noPRFOutput:
            return "The passkey didn't return the information the wallet needs. Try again, or use iCloud Keychain."
        case .noCredential:
            return "No wallet passkey was found on this Mac."
        case .unexpectedCredential:
            return "The system returned an unexpected credential."
        case .busy:
            return "Another passkey request is already open."
        case .associationUnverified:
            return "macOS couldn't confirm this app with keeta.ai yet, so passkeys aren't available. Check the internet connection and try again in a minute."
        case .authorization(let message):
            return message
        }
    }

    /// Maps an error from AuthenticationServices. `canceledCode` is
    /// ASAuthorizationError.canceled's raw value (1001), passed in so this file
    /// needs no AuthenticationServices import.
    public static func classify(_ error: Error, canceledCode: Int = 1001) -> PasskeyWalletError {
        if let walletError = error as? PasskeyWalletError {
            return walletError
        }
        let nsError = error as NSError
        if nsError.domain == "com.apple.AuthenticationServices.AuthorizationError", nsError.code == canceledCode {
            return .canceled
        }
        let text = [nsError.localizedDescription, nsError.localizedFailureReason ?? ""].joined(separator: " ")
        if text.localizedCaseInsensitiveContains("webcredentials association") || text.localizedCaseInsensitiveContains("not associated with domain") {
            return .associationUnverified
        }
        return .authorization(nsError.localizedDescription)
    }
}

/// The operator wallet's key material comes from a passkey (relying party
/// keeta.ai) through the WebAuthn PRF extension, the same mechanism as the
/// Keeta web wallet. There is no seed phrase: the passkey syncs with iCloud
/// Keychain, and the same passkey always yields the same PRF output.
///
/// PRF output ("entropy") is handed to the agent for one call and never stored.
@MainActor
public final class PasskeyWalletCore {
    private let authenticator: PasskeyAuthenticator
    private let store: PasskeyCredentialStore
    private let randomBytes: (Int) -> Data
    private var busy = false

    public init(authenticator: PasskeyAuthenticator, store: PasskeyCredentialStore, randomBytes: @escaping (Int) -> Data = PasskeyWalletCore.secureRandomBytes) {
        self.authenticator = authenticator
        self.store = store
        self.randomBytes = randomBytes
    }

    public var credentialID: Data? { store.credentialID }
    public var hasPasskey: Bool { store.credentialID != nil }

    /// Creates a new passkey for the wallet and remembers its credential ID.
    public func register(accountName: String) async throws {
        let request = PasskeyRegistrationRequest(
            relyingParty: WalletConstants.relyingPartyIdentifier,
            accountName: accountName,
            userID: randomBytes(16),
            challenge: randomBytes(32),
            checkPRFSupport: true
        )
        let result = try await exclusive { try await self.authenticator.register(request) }
        if result.prfSupported == false {
            throw PasskeyWalletError.prfUnsupported
        }
        store.credentialID = result.credentialID
    }

    /// Runs a passkey assertion (Touch ID / password) and returns the 32-byte PRF output.
    /// The caller must zero the returned Data when done.
    /// - Parameter anyPasskey: when true, let the user pick any keeta.ai passkey
    ///   (used to restore a wallet that was created on another Mac).
    public func assertEntropy(anyPasskey: Bool = false) async throws -> Data {
        var allowed: [Data]?
        if !anyPasskey {
            guard let credentialID = store.credentialID else { throw PasskeyWalletError.noCredential }
            allowed = [credentialID]
        }
        let request = PasskeyAssertionRequest(
            relyingParty: WalletConstants.relyingPartyIdentifier,
            challenge: randomBytes(32),
            allowedCredentialIDs: allowed,
            userVerificationRequired: true,
            prfSalt: WalletConstants.prfSalt
        )
        let result = try await exclusive { try await self.authenticator.assert(request) }
        guard let output = result.prfOutput, output.count == 32 else {
            throw PasskeyWalletError.noPRFOutput
        }
        if anyPasskey {
            store.credentialID = result.credentialID
        }
        return output
    }

    /// Asserts, hands the hex entropy to `body`, then zeroes the bytes.
    /// Swift Strings cannot be wiped, so the hex copy lives only for the duration of the call.
    public func withEntropy<T>(anyPasskey: Bool = false, _ body: (String) async throws -> T) async throws -> T {
        var entropy = try await assertEntropy(anyPasskey: anyPasskey)
        defer { entropy.resetBytes(in: 0..<entropy.count) }
        return try await body(Hex.encode(entropy))
    }

    public func forget() {
        store.credentialID = nil
    }

    /// One system passkey prompt at a time; errors come back as PasskeyWalletError.
    private func exclusive<T>(_ body: () async throws -> T) async throws -> T {
        guard !busy else { throw PasskeyWalletError.busy }
        busy = true
        defer { busy = false }
        do {
            return try await body()
        } catch {
            throw PasskeyWalletError.classify(error)
        }
    }

    public nonisolated static func secureRandomBytes(_ count: Int) -> Data {
        var bytes = [UInt8](repeating: 0, count: count)
        let status = SecRandomCopyBytes(kSecRandomDefault, count, &bytes)
        precondition(status == errSecSuccess, "SecRandomCopyBytes failed")
        return Data(bytes)
    }
}
