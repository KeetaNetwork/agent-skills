import Foundation
import XCTest
@testable import KeetaComputeKit

@MainActor
private final class FakeAuthenticator: PasskeyAuthenticator {
    var registrationResult: Result<PasskeyRegistrationResult, Error> = .success(PasskeyRegistrationResult(credentialID: Data([1, 2, 3]), prfSupported: true))
    var assertionResult: Result<PasskeyAssertionResult, Error> = .success(PasskeyAssertionResult(credentialID: Data([1, 2, 3]), prfOutput: Data(repeating: 0xAB, count: 32)))
    var registrations: [PasskeyRegistrationRequest] = []
    var assertions: [PasskeyAssertionRequest] = []
    /// When set, assert() waits here so a second request can overlap it.
    var gate: CheckedContinuation<Void, Never>?
    var holdAssertions = false

    func register(_ request: PasskeyRegistrationRequest) async throws -> PasskeyRegistrationResult {
        registrations.append(request)
        return try registrationResult.get()
    }

    func assert(_ request: PasskeyAssertionRequest) async throws -> PasskeyAssertionResult {
        assertions.append(request)
        if holdAssertions {
            await withCheckedContinuation { gate = $0 }
        }
        return try assertionResult.get()
    }
}

@MainActor
private final class MemoryStore: PasskeyCredentialStore {
    var credentialID: Data?
}

@MainActor
final class PasskeyWalletTests: XCTestCase {
    private var authenticator: FakeAuthenticator!
    private var store: MemoryStore!
    private var wallet: PasskeyWalletCore!

    override func setUp() async throws {
        authenticator = FakeAuthenticator()
        store = MemoryStore()
        var counter: UInt8 = 0
        wallet = PasskeyWalletCore(authenticator: authenticator, store: store) { count in
            counter &+= 1
            return Data(repeating: counter, count: count)
        }
    }

    func testRegisterRemembersCredentialAndAsksForPRF() async throws {
        XCTAssertFalse(wallet.hasPasskey)
        try await wallet.register(accountName: "Keeta Compute wallet")
        XCTAssertTrue(wallet.hasPasskey)
        XCTAssertEqual(store.credentialID, Data([1, 2, 3]))
        let request = try XCTUnwrap(authenticator.registrations.first)
        XCTAssertEqual(request.relyingParty, "keeta.ai")
        XCTAssertEqual(request.accountName, "Keeta Compute wallet")
        XCTAssertEqual(request.userID.count, 16)
        XCTAssertEqual(request.challenge.count, 32)
        XCTAssertNotEqual(request.userID, request.challenge.prefix(16))
        XCTAssertTrue(request.checkPRFSupport)
    }

    func testRegisterRejectsAuthenticatorWithoutPRF() async {
        authenticator.registrationResult = .success(PasskeyRegistrationResult(credentialID: Data([9]), prfSupported: false))
        await XCTAssertThrowsWalletError(try await wallet.register(accountName: "x"), .prfUnsupported)
        XCTAssertNil(store.credentialID, "a passkey that can't derive the wallet must not be remembered")
    }

    func testRegisterAcceptsUnknownPRFSupport() async throws {
        authenticator.registrationResult = .success(PasskeyRegistrationResult(credentialID: Data([7]), prfSupported: nil))
        try await wallet.register(accountName: "x")
        XCTAssertEqual(store.credentialID, Data([7]))
    }

    func testAssertWithoutPasskeyFailsBeforePrompting() async {
        await XCTAssertThrowsWalletError(try await wallet.assertEntropy(), .noCredential)
        XCTAssertTrue(authenticator.assertions.isEmpty)
    }

    func testAssertLimitsToStoredCredentialAndUsesWalletSalt() async throws {
        store.credentialID = Data([4, 5, 6])
        let entropy = try await wallet.assertEntropy()
        XCTAssertEqual(entropy, Data(repeating: 0xAB, count: 32))
        let request = try XCTUnwrap(authenticator.assertions.first)
        XCTAssertEqual(request.allowedCredentialIDs, [Data([4, 5, 6])])
        XCTAssertEqual(request.prfSalt, WalletConstants.prfSalt)
        XCTAssertTrue(request.userVerificationRequired)
        XCTAssertEqual(request.relyingParty, "keeta.ai")
        XCTAssertEqual(request.challenge.count, 32)
    }

    func testAssertAnyPasskeyAllowsAllAndAdoptsTheChosenOne() async throws {
        authenticator.assertionResult = .success(PasskeyAssertionResult(credentialID: Data([8, 8]), prfOutput: Data(repeating: 1, count: 32)))
        _ = try await wallet.assertEntropy(anyPasskey: true)
        XCTAssertNil(authenticator.assertions.first?.allowedCredentialIDs)
        XCTAssertEqual(store.credentialID, Data([8, 8]))
    }

    func testAssertRejectsMissingOrShortPRFOutput() async {
        store.credentialID = Data([1])
        authenticator.assertionResult = .success(PasskeyAssertionResult(credentialID: Data([1]), prfOutput: nil))
        await XCTAssertThrowsWalletError(try await wallet.assertEntropy(), .noPRFOutput)
        authenticator.assertionResult = .success(PasskeyAssertionResult(credentialID: Data([1]), prfOutput: Data(repeating: 1, count: 16)))
        await XCTAssertThrowsWalletError(try await wallet.assertEntropy(), .noPRFOutput)
    }

    func testWithEntropyPassesHex() async throws {
        store.credentialID = Data([1])
        let hex = try await wallet.withEntropy { $0 }
        XCTAssertEqual(hex, String(repeating: "ab", count: 32))
    }

    func testOnlyOnePromptAtATime() async throws {
        store.credentialID = Data([1])
        authenticator.holdAssertions = true
        let first = Task { try await wallet.assertEntropy() }
        while authenticator.gate == nil {
            await Task.yield()
        }
        await XCTAssertThrowsWalletError(try await wallet.assertEntropy(), .busy)
        authenticator.gate?.resume()
        _ = try await first.value
        authenticator.holdAssertions = false
        _ = try await wallet.assertEntropy()
    }

    func testForget() async throws {
        try await wallet.register(accountName: "x")
        wallet.forget()
        XCTAssertFalse(wallet.hasPasskey)
    }

    func testErrorsAreClassified() async {
        store.credentialID = Data([1])
        let canceled = NSError(domain: "com.apple.AuthenticationServices.AuthorizationError", code: 1001)
        authenticator.assertionResult = .failure(canceled)
        await XCTAssertThrowsWalletError(try await wallet.assertEntropy(), .canceled)

        let association = NSError(domain: "com.apple.AuthenticationServices.AuthorizationError", code: 1004, userInfo: [
            NSLocalizedFailureReasonErrorKey: "Unable to verify webcredentials association of 2BG69HN56W.ai.keeta.compute with domain keeta.ai. Please try again in a few seconds."
        ])
        authenticator.assertionResult = .failure(association)
        await XCTAssertThrowsWalletError(try await wallet.assertEntropy(), .associationUnverified)

        let systemBusy = NSError(domain: "com.apple.AuthenticationServices.AuthorizationError", code: 1004, userInfo: [
            NSLocalizedFailureReasonErrorKey: "Request already in progress for specified application identifier."
        ])
        authenticator.assertionResult = .failure(systemBusy)
        await XCTAssertThrowsWalletError(try await wallet.assertEntropy(), .busy)

        let other = NSError(domain: "com.apple.AuthenticationServices.AuthorizationError", code: 1004, userInfo: [NSLocalizedDescriptionKey: "Something else"])
        authenticator.assertionResult = .failure(other)
        await XCTAssertThrowsWalletError(try await wallet.assertEntropy(), .authorization("Something else"))
    }

    func testUserDefaultsStoreRoundTrips() throws {
        let suite = "ai.keeta.compute.tests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = UserDefaultsPasskeyCredentialStore(defaults: defaults)
        XCTAssertNil(store.credentialID)
        store.credentialID = Data([3, 1, 4])
        XCTAssertEqual(UserDefaultsPasskeyCredentialStore(defaults: defaults).credentialID, Data([3, 1, 4]))
        store.credentialID = nil
        XCTAssertNil(store.credentialID)
    }
}

@MainActor
private func XCTAssertThrowsWalletError<T>(_ expression: @autoclosure () async throws -> T, _ expected: PasskeyWalletError, file: StaticString = #filePath, line: UInt = #line) async {
    do {
        _ = try await expression()
        XCTFail("expected \(expected), got success", file: file, line: line)
    } catch {
        XCTAssertEqual(error as? PasskeyWalletError, expected, file: file, line: line)
    }
}
