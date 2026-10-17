// P-256 helpers for the node key, in pure Swift so they can be unit tested
// without a Secure Enclave:
// - DER (X9.62) ECDSA signature -> raw 64-byte r||s
// - low-S normalization (s > n/2 -> n - s)
// - uncompressed (04||X||Y) -> compressed (02/03||X) public key

import Foundation

public enum ECDSAError: Error, Equatable, LocalizedError {
    case malformedDER(String)
    case integerTooLarge
    case invalidPublicKey
    case invalidScalar

    public var errorDescription: String? {
        switch self {
        case .malformedDER(let detail): return "Malformed DER signature: \(detail)"
        case .integerTooLarge: return "Signature integer is larger than 32 bytes."
        case .invalidPublicKey: return "Public key is not an uncompressed P-256 point."
        case .invalidScalar: return "Signature scalar is zero or not below the curve order."
        }
    }
}

public enum P256Signature {
    /// Curve order n, big-endian.
    public static let order: [UInt8] = hexBytes("FFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551")
    /// floor(n / 2), big-endian. A signature is low-S when s <= halfOrder.
    public static let halfOrder: [UInt8] = hexBytes("7FFFFFFF800000007FFFFFFFFFFFFFFFDE737D56D38BCF4279DCE5617E3192A8")

    private static func hexBytes(_ hex: String) -> [UInt8] {
        // Constants above are valid hex; force-unwrap is safe.
        Array(Hex.decode(hex)!)
    }

    // MARK: DER

    /// Converts a DER `SEQUENCE { INTEGER r, INTEGER s }` into raw r||s (64 bytes),
    /// each integer stripped of sign padding and left-padded to 32 bytes.
    public static func rawSignature(fromDER der: Data) throws -> Data {
        let bytes = [UInt8](der)
        var index = 0

        func readByte() throws -> UInt8 {
            guard index < bytes.count else { throw ECDSAError.malformedDER("truncated") }
            defer { index += 1 }
            return bytes[index]
        }

        func readLength() throws -> Int {
            let first = try readByte()
            if first & 0x80 == 0 {
                return Int(first)
            }
            let count = Int(first & 0x7F)
            guard count >= 1, count <= 2 else { throw ECDSAError.malformedDER("unsupported length form") }
            var length = 0
            for _ in 0..<count {
                let next = try readByte()
                length = (length << 8) | Int(next)
            }
            return length
        }

        func readInteger() throws -> [UInt8] {
            guard try readByte() == 0x02 else { throw ECDSAError.malformedDER("expected INTEGER") }
            let length = try readLength()
            guard length > 0, index + length <= bytes.count else { throw ECDSAError.malformedDER("bad INTEGER length") }
            var value = Array(bytes[index..<(index + length)])
            index += length
            guard value[0] & 0x80 == 0 else { throw ECDSAError.malformedDER("negative INTEGER") }
            while value.count > 1 && value[0] == 0 {
                value.removeFirst()
            }
            guard value.count <= 32 else { throw ECDSAError.integerTooLarge }
            return [UInt8](repeating: 0, count: 32 - value.count) + value
        }

        guard try readByte() == 0x30 else { throw ECDSAError.malformedDER("expected SEQUENCE") }
        let sequenceLength = try readLength()
        guard index + sequenceLength == bytes.count else { throw ECDSAError.malformedDER("SEQUENCE length mismatch") }
        let r = try readInteger()
        let s = try readInteger()
        guard index == bytes.count else { throw ECDSAError.malformedDER("trailing bytes") }
        return Data(r + s)
    }

    // MARK: Low S

    /// Returns r||s with s replaced by n - s when s > n/2. Input and output are 64 bytes.
    public static func normalizeLowS(_ raw: Data) throws -> Data {
        guard raw.count == 64 else { throw ECDSAError.malformedDER("raw signature must be 64 bytes") }
        let bytes = [UInt8](raw)
        let r = Array(bytes[0..<32])
        var s = Array(bytes[32..<64])
        guard !isZero(r), !isZero(s), compare(r, order) < 0, compare(s, order) < 0 else {
            throw ECDSAError.invalidScalar
        }
        if compare(s, halfOrder) > 0 {
            s = subtract(order, s)
        }
        return Data(r + s)
    }

    public static func isLowS(_ raw: Data) -> Bool {
        guard raw.count == 64 else { return false }
        return compare(Array(raw.suffix(32)), halfOrder) <= 0
    }

    /// DER -> raw r||s -> low S, in one step. This is what `signer.signDigest` returns.
    public static func normalizedRawSignature(fromDER der: Data) throws -> Data {
        try normalizeLowS(rawSignature(fromDER: der))
    }

    // MARK: Compressed points

    /// 65-byte `04||X||Y` -> 33-byte `02||X` (Y even) or `03||X` (Y odd).
    public static func compressedPublicKey(fromX963 uncompressed: Data) throws -> Data {
        let bytes = [UInt8](uncompressed)
        guard bytes.count == 65, bytes[0] == 0x04 else { throw ECDSAError.invalidPublicKey }
        let x = bytes[1..<33]
        let yIsOdd = bytes[64] & 1 == 1
        var out: [UInt8] = [yIsOdd ? 0x03 : 0x02]
        out.append(contentsOf: x)
        return Data(out)
    }

    // MARK: 256-bit big-endian arithmetic

    /// -1, 0, 1 comparing two equal-length big-endian numbers.
    public static func compare(_ a: [UInt8], _ b: [UInt8]) -> Int {
        precondition(a.count == b.count, "compare needs equal lengths")
        for i in 0..<a.count where a[i] != b[i] {
            return a[i] < b[i] ? -1 : 1
        }
        return 0
    }

    /// a - b for equal-length big-endian numbers with a >= b.
    public static func subtract(_ a: [UInt8], _ b: [UInt8]) -> [UInt8] {
        precondition(a.count == b.count, "subtract needs equal lengths")
        var result = [UInt8](repeating: 0, count: a.count)
        var borrow = 0
        for i in stride(from: a.count - 1, through: 0, by: -1) {
            var difference = Int(a[i]) - Int(b[i]) - borrow
            if difference < 0 {
                difference += 256
                borrow = 1
            } else {
                borrow = 0
            }
            result[i] = UInt8(difference)
        }
        precondition(borrow == 0, "subtract underflow")
        return result
    }

    private static func isZero(_ value: [UInt8]) -> Bool {
        value.allSatisfy { $0 == 0 }
    }
}

public enum Hex {
    public static func encode(_ data: Data) -> String {
        let digits = Array("0123456789abcdef".utf8)
        var out = [UInt8]()
        out.reserveCapacity(data.count * 2)
        for byte in data {
            out.append(digits[Int(byte >> 4)])
            out.append(digits[Int(byte & 0x0F)])
        }
        return String(decoding: out, as: UTF8.self)
    }

    /// Accepts upper or lower case and an optional `0x` prefix; nil when not valid hex.
    public static func decode(_ string: String) -> Data? {
        var text = Substring(string)
        if text.hasPrefix("0x") || text.hasPrefix("0X") {
            text = text.dropFirst(2)
        }
        let utf8 = Array(text.utf8)
        guard utf8.count % 2 == 0 else { return nil }
        var out = Data(capacity: utf8.count / 2)
        var index = 0
        while index < utf8.count {
            guard let high = nibble(utf8[index]), let low = nibble(utf8[index + 1]) else { return nil }
            out.append(high << 4 | low)
            index += 2
        }
        return out
    }

    private static func nibble(_ c: UInt8) -> UInt8? {
        switch c {
        case UInt8(ascii: "0")...UInt8(ascii: "9"): return c - UInt8(ascii: "0")
        case UInt8(ascii: "a")...UInt8(ascii: "f"): return c - UInt8(ascii: "a") + 10
        case UInt8(ascii: "A")...UInt8(ascii: "F"): return c - UInt8(ascii: "A") + 10
        default: return nil
        }
    }
}
