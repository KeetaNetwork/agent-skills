// Every use of the WebAuthn PRF extension API (AuthenticationServices,
// macOS 15 / iOS 18) is isolated in this file, so if the SDK spelling
// differs from what is written here only this file needs to change.
//
// API surface relied on (macOS 15.0 SDK, Swift overlay):
//   ASAuthorizationPlatformPublicKeyCredentialRegistrationRequest.prf
//       : ASAuthorizationPublicKeyCredentialPRFRegistrationInput?
//   ASAuthorizationPublicKeyCredentialPRFRegistrationInput.checkForSupport
//   ASAuthorizationPlatformPublicKeyCredentialAssertionRequest.prf
//       : ASAuthorizationPublicKeyCredentialPRFAssertionInput?
//   ASAuthorizationPublicKeyCredentialPRFAssertionInput(inputValues:perCredentialInputValues:)
//   ASAuthorizationPublicKeyCredentialPRFAssertionInput.InputValues(saltInput1:saltInput2:)
//   ASAuthorizationPlatformPublicKeyCredentialRegistration.prf
//       : ASAuthorizationPublicKeyCredentialPRFRegistrationOutput?  (.isSupported: Bool)
//   ASAuthorizationPlatformPublicKeyCredentialAssertion.prf
//       : ASAuthorizationPublicKeyCredentialPRFAssertionOutput?     (.first: SymmetricKey)

import AuthenticationServices
import CryptoKit
import Foundation

enum PasskeyPRF {
    /// Ask the authenticator at registration time whether it supports PRF.
    static func requestSupportCheck(on request: ASAuthorizationPlatformPublicKeyCredentialRegistrationRequest) {
        request.prf = .checkForSupport
    }

    /// Ask for PRF output with the wallet salt on an assertion.
    static func requestOutput(on request: ASAuthorizationPlatformPublicKeyCredentialAssertionRequest, salt: Data) {
        let values = ASAuthorizationPublicKeyCredentialPRFAssertionInput.InputValues(saltInput1: salt, saltInput2: nil)
        request.prf = .inputValues(values)
    }

    /// nil when the authenticator did not report PRF support at all.
    static func isSupported(_ registration: ASAuthorizationPlatformPublicKeyCredentialRegistration) -> Bool? {
        registration.prf?.isSupported
    }

    /// The 32-byte PRF output for salt 1, or nil when the authenticator returned none.
    static func firstOutput(_ assertion: ASAuthorizationPlatformPublicKeyCredentialAssertion) -> Data? {
        guard let key: SymmetricKey = assertion.prf?.first else { return nil }
        return key.withUnsafeBytes { Data($0) }
    }
}
