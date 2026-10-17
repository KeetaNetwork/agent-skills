import AppKit
import AuthenticationServices
import Foundation
import KeetaComputeKit
import os

/// The app's passkey wallet: PasskeyWalletCore (KeetaComputeKit, unit tested)
/// driving the system passkey UI through SystemPasskeyAuthenticator.
@MainActor
final class PasskeyWallet {
    typealias WalletError = PasskeyWalletError

    private let core: PasskeyWalletCore
    private let log = Logger(subsystem: "ai.keeta.compute", category: "passkey")

    init(authenticator: PasskeyAuthenticator, store: PasskeyCredentialStore) {
        core = PasskeyWalletCore(authenticator: authenticator, store: store)
    }

    convenience init() {
        self.init(authenticator: SystemPasskeyAuthenticator(), store: UserDefaultsPasskeyCredentialStore())
    }

    var hasPasskey: Bool { core.hasPasskey }

    func register(accountName: String) async throws {
        do {
            try await core.register(accountName: accountName)
            log.info("Registered wallet passkey")
        } catch {
            log.error("Passkey registration failed: \(String(describing: error), privacy: .public)")
            throw error
        }
    }

    func assertEntropy(anyPasskey: Bool = false) async throws -> Data {
        do {
            return try await core.assertEntropy(anyPasskey: anyPasskey)
        } catch {
            log.error("Passkey assertion failed: \(String(describing: error), privacy: .public)")
            throw error
        }
    }

    func withEntropy<T>(anyPasskey: Bool = false, _ body: (String) async throws -> T) async throws -> T {
        try await core.withEntropy(anyPasskey: anyPasskey, body)
    }

    func forget() {
        core.forget()
    }
}

/// Runs passkey requests with ASAuthorizationController, anchored to the
/// popover (or another visible window of this app).
@MainActor
final class SystemPasskeyAuthenticator: PasskeyAuthenticator {
    /// Overrides the window the system prompt attaches to.
    var anchorOverride: NSWindow?

    func register(_ request: PasskeyRegistrationRequest) async throws -> PasskeyRegistrationResult {
        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: request.relyingParty)
        let registrationRequest = provider.createCredentialRegistrationRequest(challenge: request.challenge, name: request.accountName, userID: request.userID)
        if request.checkPRFSupport {
            PasskeyPRF.requestSupportCheck(on: registrationRequest)
        }
        let authorization = try await perform(registrationRequest)
        guard let registration = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialRegistration else {
            throw PasskeyWalletError.unexpectedCredential
        }
        return PasskeyRegistrationResult(credentialID: registration.credentialID, prfSupported: PasskeyPRF.isSupported(registration))
    }

    func assert(_ request: PasskeyAssertionRequest) async throws -> PasskeyAssertionResult {
        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: request.relyingParty)
        let assertionRequest = provider.createCredentialAssertionRequest(challenge: request.challenge)
        if let allowed = request.allowedCredentialIDs {
            assertionRequest.allowedCredentials = allowed.map { ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: $0) }
        }
        assertionRequest.userVerificationPreference = request.userVerificationRequired ? .required : .preferred
        PasskeyPRF.requestOutput(on: assertionRequest, salt: request.prfSalt)
        let authorization = try await perform(assertionRequest)
        guard let assertion = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialAssertion else {
            throw PasskeyWalletError.unexpectedCredential
        }
        return PasskeyAssertionResult(credentialID: assertion.credentialID, prfOutput: PasskeyPRF.firstOutput(assertion))
    }

    private func perform(_ request: ASAuthorizationRequest) async throws -> ASAuthorization {
        // An accessory app must be active for the system prompt to take focus.
        NSApp.activate()
        let anchor = anchorOverride ?? NSApp.keyWindow ?? NSApp.windows.first(where: { $0.isVisible }) ?? NSWindow()
        let session = AuthorizationSession(anchor: anchor)
        // The popover is the key window; keep it open while the system prompt has focus.
        PopoverHold.begin()
        defer { PopoverHold.end() }
        return try await session.run(request)
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
        continuation?.resume(throwing: PasskeyWalletError.classify(error, canceledCode: ASAuthorizationError.canceled.rawValue))
        continuation = nil
        self.controller = nil
    }

    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        anchor
    }
}
