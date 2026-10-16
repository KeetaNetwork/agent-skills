import Foundation

/// Constants for the passkey-backed operator wallet.
public enum WalletConstants {
    /// WebAuthn relying party. The app's associated domain must list `webcredentials:keeta.ai`.
    public static let relyingPartyIdentifier = "keeta.ai"

    /// The salt string used by the Keeta web wallet's passkey-PRF driver.
    public static let prfSaltLabel = "keeta.com/wallet/seed/v1"

    /// SHA-256(`prfSaltLabel`), the PRF `first` salt input. Pinned here and
    /// checked against a fresh hash in the unit tests.
    public static let prfSaltHex = "256d61f01f6fbf9644493be0341b4f0ebd8fd14b1cfc6c1a10ae42630669290c"

    public static var prfSalt: Data {
        // The constant is valid hex.
        Hex.decode(prfSaltHex)!
    }

    /// Keeta account addresses start with this prefix.
    public static let addressPrefix = "keeta_"

    /// Cheap shape check for addresses typed or pasted by the user. The agent does the real validation.
    public static func looksLikeAddress(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix(addressPrefix), trimmed.count > addressPrefix.count + 20 else { return false }
        return trimmed.dropFirst(addressPrefix.count).allSatisfy { $0.isASCII && ($0.isLowercase || $0.isNumber) }
    }
}
