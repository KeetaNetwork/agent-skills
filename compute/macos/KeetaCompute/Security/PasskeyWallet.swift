import AppKit
import AuthenticationServices
import Foundation
import KeetaComputeKit
import Security
import os

/// The operator wallet's key material comes from a passkey (relying party
/// keeta.ai) through the WebAuthn PRF extension, the same mechanism as the
/// Keeta web wallet. There is no seed phrase: the passkey syncs with iCloud
/// Keychain, and the same passkey always yields the same PRF output.
///
/// PRF output ("entropy") is handed to the agent for one call and never stored.
@MainActor
final class PasskeyWallet {
    enum WalletError: LocalizedError {
        case canceled
        case prfUnsupported
        case noPRFOutput
        case noCredential
        case unexpectedCredential
        case authorization(String)

        var errorDescription: String? {
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
            case .authorization(let message):
                return message
            }
        }
    }

    private static let credentialIDKey = "wallet.passkeyCredentialID"
    private let log = Logger(subsystem: "ai.keeta.compute", category: "passkey")
    private let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: WalletConstants.relyingPartyIdentifier)
    /// Keeps the in-flight controller and its delegate alive.
    private var inFlight: AuthorizationSession?

    var credentialID: Data? {
        get { UserDefaults.standard.data(forKey: Self.credentialIDKey) }
        set { UserDefaults.standard.set(newValue, forKey: Self.credentialIDKey) }
    }

    var hasPasskey: Bool { credentialID != nil }

    /// Creates a new passkey for the wallet and remembers its credential ID.
    func register(accountName: String) async throws {
        let request = provider.createCredentialRegistrationRequest(
            challenge: Self.randomBytes(32),
            name: accountName,
            userID: Self.randomBytes(16)
        )
        PasskeyPRF.requestSupportCheck(on: request)
        let authorization = try await perform(request)
        guard let registration = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialRegistration else {
            throw WalletError.unexpectedCredential
        }
        if PasskeyPRF.isSupported(registration) == false {
            throw WalletError.prfUnsupported
        }
        credentialID = registration.credentialID
        log.info("Registered wallet passkey")
    }

    /// Runs a passkey assertion (Touch ID / password) and returns the 32-byte PRF output.
    /// The caller must zero the returned Data when done.
    /// - Parameter anyPasskey: when true, let the user pick any keeta.ai passkey
    ///   (used to restore a wallet that was created on another Mac).
    func assertEntropy(anyPasskey: Bool = false) async throws -> Data {
        let request = provider.createCredentialAssertionRequest(challenge: Self.randomBytes(32))
        if !anyPasskey {
            guard let credentialID else { throw WalletError.noCredential }
            request.allowedCredentials = [ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: credentialID)]
        }
        request.userVerificationPreference = .required
        PasskeyPRF.requestOutput(on: request, salt: WalletConstants.prfSalt)
        let authorization = try await perform(request)
        guard let assertion = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialAssertion else {
            throw WalletError.unexpectedCredential
        }
        guard let output = PasskeyPRF.firstOutput(assertion), output.count == 32 else {
            throw WalletError.noPRFOutput
        }
        if anyPasskey {
            credentialID = assertion.credentialID
        }
        return output
    }

    /// Asserts, hands the hex entropy to `body`, then zeroes the bytes.
    /// Swift Strings cannot be wiped, so the hex copy lives only for the duration of the call.
    func withEntropy<T>(anyPasskey: Bool = false, _ body: (String) async throws -> T) async throws -> T {
        var entropy = try await assertEntropy(anyPasskey: anyPasskey)
        defer { entropy.resetBytes(in: 0..<entropy.count) }
        return try await body(Hex.encode(entropy))
    }

    func forget() {
        credentialID = nil
    }

    // MARK: Plumbing

    private func perform(_ request: ASAuthorizationRequest) async throws -> ASAuthorization {
        if inFlight != nil {
            throw WalletError.authorization("Another passkey request is already open.")
        }
        // The popover is the key window; keep it open while the system prompt has focus.
        let anchor = NSApp.keyWindow ?? NSApp.mainWindow ?? NSApp.windows.first(where: { $0.isVisible }) ?? NSWindow()
        let session = AuthorizationSession(anchor: anchor)
        inFlight = session
        PopoverHold.begin()
        defer {
            inFlight = nil
            PopoverHold.end()
        }
        return try await session.run(request)
    }

    private static func randomBytes(_ count: Int) -> Data {
        var bytes = [UInt8](repeating: 0, count: count)
        let status = SecRandomCopyBytes(kSecRandomDefault, count, &bytes)
        precondition(status == errSecSuccess, "SecRandomCopyBytes failed")
        return Data(bytes)
    }
}

/// One ASAuthorizationController run bridged to async/await.
///
/// Deliberately not actor-isolated: the delegate callbacks only resume the
/// continuation, and the presentation anchor is captured up front on the main
/// actor, so this compiles the same whether or not the SDK marks the
/// AuthenticationServices delegate protocols as main-actor isolated.
private final class AuthorizationSession: NSObject, ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
    private var continuation: CheckedContinuation<ASAuthorization, Error>?
    private var controller: ASAuthorizationController?
    private let anchor: NSWindow

    init(anchor: NSWindow) {
        self.anchor = anchor
    }

    @MainActor
    func run(_ request: ASAuthorizationRequest) async throws -> ASAuthorization {
        try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            let controller = ASAuthorizationController(authorizationRequests: [request])
            controller.delegate = self
            controller.presentationContextProvider = self
            self.controller = controller
            controller.performRequests()
        }
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
        continuation?.resume(returning: authorization)
        continuation = nil
        self.controller = nil
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        let mapped: Error
        if let authError = error as? ASAuthorizationError, authError.code == .canceled {
            mapped = PasskeyWallet.WalletError.canceled
        } else {
            mapped = PasskeyWallet.WalletError.authorization(error.localizedDescription)
        }
        continuation?.resume(throwing: mapped)
        continuation = nil
        self.controller = nil
    }

    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        anchor
    }
}
