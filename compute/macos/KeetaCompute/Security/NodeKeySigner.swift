import CryptoKit
import Foundation
import KeetaComputeKit
import Security
import os

/// The node key: a P-256 key that identifies this Mac on the network and
/// signs receipts. It never moves funds (that is the passkey wallet's job),
/// so it must sign unattended: no user-presence flag.
///
/// Preferred storage is the Secure Enclave. When the enclave is unavailable
/// (or the build lacks the keychain entitlements it needs), a software key is
/// kept in the login Keychain instead and Settings says so.
final class NodeKeySigner: @unchecked Sendable {
    enum Storage: Equatable {
        case secureEnclave
        /// Software key in the Keychain; `reason` says why the enclave was not used.
        case software(reason: String)
    }

    enum SignerError: LocalizedError {
        case keychain(OSStatus, String)
        case security(String)
        case badDigest

        var errorDescription: String? {
            switch self {
            case .keychain(let status, let action):
                let message = SecCopyErrorMessageString(status, nil) as String? ?? "status \(status)"
                return "Keychain error while \(action): \(message)"
            case .security(let message):
                return message
            case .badDigest:
                return "The digest to sign must be exactly 32 bytes."
            }
        }
    }

    private static let enclaveTag = Data("ai.keeta.compute.node-key.se".utf8)
    private static let softwareService = "ai.keeta.compute.node-key"
    private static let softwareAccount = "software-p256"
    private static let log = Logger(subsystem: "ai.keeta.compute", category: "node-key")

    let storage: Storage
    private let privateKey: SecKey
    /// 33-byte compressed point.
    let compressedPublicKey: Data

    var publicKeyHex: String { Hex.encode(compressedPublicKey) }

    private init(privateKey: SecKey, storage: Storage) throws {
        self.privateKey = privateKey
        self.storage = storage
        guard let publicKey = SecKeyCopyPublicKey(privateKey) else {
            throw SignerError.security("The node key has no public key.")
        }
        var error: Unmanaged<CFError>?
        guard let external = SecKeyCopyExternalRepresentation(publicKey, &error) as Data? else {
            throw SignerError.security(Self.describe(error, fallback: "Could not export the node public key."))
        }
        // `external` is the 65-byte X9.63 point 04||X||Y.
        self.compressedPublicKey = try P256Signature.compressedPublicKey(fromX963: external)
    }

    /// Loads the existing node key or creates one.
    static func loadOrCreate() throws -> NodeKeySigner {
        if SecureEnclave.isAvailable {
            do {
                if let key = try findEnclaveKey() {
                    return try NodeKeySigner(privateKey: key, storage: .secureEnclave)
                }
                // Prefer an existing software key over minting a new enclave key so the node keeps its identity.
                if let key = try findSoftwareKey() {
                    return try NodeKeySigner(privateKey: key, storage: .software(reason: "This Mac's node key was created before the Secure Enclave was available to the app."))
                }
                return try NodeKeySigner(privateKey: try createEnclaveKey(), storage: .secureEnclave)
            } catch {
                log.error("Secure Enclave key unavailable, using a software key: \(error.localizedDescription, privacy: .public)")
                let key = try findSoftwareKey() ?? createSoftwareKey()
                return try NodeKeySigner(privateKey: key, storage: .software(reason: "The Secure Enclave could not be used (\(error.localizedDescription))."))
            }
        }
        let key = try findSoftwareKey() ?? createSoftwareKey()
        return try NodeKeySigner(privateKey: key, storage: .software(reason: "This Mac has no Secure Enclave."))
    }

    /// Signs a 32-byte digest as-is (the agent computed it with SHA3-256) and
    /// returns raw r||s, 64 bytes, low S.
    func sign(digest: Data) throws -> Data {
        guard digest.count == 32 else { throw SignerError.badDigest }
        var error: Unmanaged<CFError>?
        // `.ecdsaSignatureDigestX962SHA256` signs the given 32 bytes without hashing them again.
        guard let der = SecKeyCreateSignature(privateKey, .ecdsaSignatureDigestX962SHA256, digest as CFData, &error) as Data? else {
            throw SignerError.security(Self.describe(error, fallback: "The node key could not sign."))
        }
        return try P256Signature.normalizedRawSignature(fromDER: der)
    }

    // MARK: Secure Enclave

    private static func enclaveQuery() -> [CFString: Any] {
        [
            kSecClass: kSecClassKey,
            kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrKeyClass: kSecAttrKeyClassPrivate,
            kSecAttrTokenID: kSecAttrTokenIDSecureEnclave,
            kSecAttrApplicationTag: enclaveTag,
            kSecUseDataProtectionKeychain: true,
        ]
    }

    private static func findEnclaveKey() throws -> SecKey? {
        var query = enclaveQuery()
        query[kSecReturnRef] = true
        query[kSecMatchLimit] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        switch status {
        case errSecSuccess:
            guard let item, CFGetTypeID(item) == SecKeyGetTypeID() else { return nil }
            return (item as! SecKey)
        case errSecItemNotFound:
            return nil
        default:
            throw SignerError.keychain(status, "looking up the node key")
        }
    }

    private static func createEnclaveKey() throws -> SecKey {
        var accessError: Unmanaged<CFError>?
        // Unattended signing: private key usage only, no user presence. Available after first unlock.
        guard let access = SecAccessControlCreateWithFlags(
            kCFAllocatorDefault,
            kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            [.privateKeyUsage],
            &accessError
        ) else {
            throw SignerError.security(describe(accessError, fallback: "Could not create the node key access policy."))
        }
        let attributes: [CFString: Any] = [
            kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrKeySizeInBits: 256,
            kSecAttrTokenID: kSecAttrTokenIDSecureEnclave,
            kSecUseDataProtectionKeychain: true,
            kSecAttrLabel: "Keeta Compute node key",
            kSecPrivateKeyAttrs: [
                kSecAttrIsPermanent: true,
                kSecAttrApplicationTag: enclaveTag,
                kSecAttrAccessControl: access,
            ] as [CFString: Any],
        ]
        var error: Unmanaged<CFError>?
        guard let key = SecKeyCreateRandomKey(attributes as CFDictionary, &error) else {
            throw SignerError.security(describe(error, fallback: "Could not create the node key in the Secure Enclave."))
        }
        log.info("Created a Secure Enclave node key")
        return key
    }

    // MARK: Software fallback

    private static func softwareQuery() -> [CFString: Any] {
        [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: softwareService,
            kSecAttrAccount: softwareAccount,
        ]
    }

    private static func findSoftwareKey() throws -> SecKey? {
        var query = softwareQuery()
        query[kSecReturnData] = true
        query[kSecMatchLimit] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        switch status {
        case errSecSuccess:
            guard var raw = item as? Data else { return nil }
            defer { raw.resetBytes(in: 0..<raw.count) }
            let key = try CryptoKit.P256.Signing.PrivateKey(rawRepresentation: raw)
            return try secKey(from: key)
        case errSecItemNotFound:
            return nil
        default:
            throw SignerError.keychain(status, "reading the node key")
        }
    }

    private static func createSoftwareKey() throws -> SecKey {
        let key = CryptoKit.P256.Signing.PrivateKey()
        var raw = key.rawRepresentation
        defer { raw.resetBytes(in: 0..<raw.count) }
        var attributes = softwareQuery()
        attributes[kSecValueData] = raw
        attributes[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        attributes[kSecAttrLabel] = "Keeta Compute node key"
        let status = SecItemAdd(attributes as CFDictionary, nil)
        guard status == errSecSuccess else { throw SignerError.keychain(status, "saving the node key") }
        log.info("Created a software node key")
        return try secKey(from: key)
    }

    /// Wraps a CryptoKit key as a SecKey so both storage kinds sign through the same API.
    private static func secKey(from key: CryptoKit.P256.Signing.PrivateKey) throws -> SecKey {
        // X9.63 private representation: 04||X||Y||D (97 bytes).
        var x963 = key.x963Representation
        defer { x963.resetBytes(in: 0..<x963.count) }
        let attributes: [CFString: Any] = [
            kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrKeyClass: kSecAttrKeyClassPrivate,
            kSecAttrKeySizeInBits: 256,
        ]
        var error: Unmanaged<CFError>?
        guard let secKey = SecKeyCreateWithData(x963 as CFData, attributes as CFDictionary, &error) else {
            throw SignerError.security(describe(error, fallback: "Could not load the node key."))
        }
        return secKey
    }

    private static func describe(_ error: Unmanaged<CFError>?, fallback: String) -> String {
        guard let error else { return fallback }
        return (error.takeRetainedValue() as Error).localizedDescription
    }
}
