import XCTest
import KeetaComputeKit
#if canImport(CryptoKit)
import CryptoKit
#endif

final class ECDSATests: XCTestCase {
    private func data(_ hex: String) -> Data {
        guard let value = Hex.decode(hex) else {
            XCTFail("bad hex in test: \(hex)")
            return Data()
        }
        return value
    }

    // r has its high bit set (DER adds a 0x00 sign byte); s is above n/2.
    private let highSDER = "30460221008f1e2d3c4b5a69788796a5b4c3d2e1f00112233445566778899aabbccddeeff0022100ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc63131d"
    private let highSRaw = "8f1e2d3c4b5a69788796a5b4c3d2e1f00112233445566778899aabbccddeeff0ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc63131d"
    private let highSLow = "8f1e2d3c4b5a69788796a5b4c3d2e1f00112233445566778899aabbccddeeff00000000000000000000000000000000000000000000000000000000000001234"

    func testDERWithSignPaddingStripsToThirtyTwoBytes() throws {
        let raw = try P256Signature.rawSignature(fromDER: data(highSDER))
        XCTAssertEqual(raw.count, 64)
        XCTAssertEqual(Hex.encode(raw), highSRaw)
    }

    func testDERWithShortIntegersIsLeftPadded() throws {
        // r is 30 bytes, s is a single byte.
        let der = "3023021e7f0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d020105"
        let expected = "00007f0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d0000000000000000000000000000000000000000000000000000000000000005"
        let raw = try P256Signature.rawSignature(fromDER: data(der))
        XCTAssertEqual(Hex.encode(raw), expected)
    }

    func testHighSIsNormalized() throws {
        let low = try P256Signature.normalizeLowS(data(highSRaw))
        XCTAssertEqual(Hex.encode(low), highSLow)
        XCTAssertTrue(P256Signature.isLowS(low))
        XCTAssertFalse(P256Signature.isLowS(data(highSRaw)))
    }

    func testLowSIsUnchanged() throws {
        let raw = data(highSLow)
        XCTAssertEqual(try P256Signature.normalizeLowS(raw), raw)
    }

    func testHalfOrderBoundary() throws {
        let r = String(repeating: "11", count: 32)
        let half = "7fffffff800000007fffffffffffffffde737d56d38bcf4279dce5617e3192a8"
        let halfPlusOne = "7fffffff800000007fffffffffffffffde737d56d38bcf4279dce5617e3192a9"
        // s == n/2 is already low.
        XCTAssertEqual(Hex.encode(try P256Signature.normalizeLowS(data(r + half))), r + half)
        // s == n/2 + 1 flips to n - s == n/2.
        XCTAssertEqual(Hex.encode(try P256Signature.normalizeLowS(data(r + halfPlusOne))), r + half)
    }

    func testRealSignatureEndToEnd() throws {
        // Produced by OpenSSL over SHA3-256("keeta") with a random P-256 key; s was high.
        let der = "304602210080601f53c9a01be03c24495389f8bf13b34af1e92b3bde786c2f11b99d1983b1022100f7fb823282cd55afc1602ca61db1434c863532f6f92a662576600bd2e4d8c63c"
        let expected = "80601f53c9a01be03c24495389f8bf13b34af1e92b3bde786c2f11b99d1983b108047dcc7d32aa513e9fd359e24ebcb336b1c7b6aded385f7d59bef0178a5f15"
        XCTAssertEqual(Hex.encode(try P256Signature.normalizedRawSignature(fromDER: data(der))), expected)
    }

    func testMalformedDERIsRejected() {
        XCTAssertThrowsError(try P256Signature.rawSignature(fromDER: Data()))
        XCTAssertThrowsError(try P256Signature.rawSignature(fromDER: data("3003020101")))         // missing s
        XCTAssertThrowsError(try P256Signature.rawSignature(fromDER: data("31060201010201ff")))   // not a SEQUENCE
        XCTAssertThrowsError(try P256Signature.rawSignature(fromDER: data("3006020101020101aa"))) // trailing byte
        XCTAssertThrowsError(try P256Signature.rawSignature(fromDER: data("30060201ff020101")))   // negative r
        // 33-byte integer without a sign byte is too large.
        let big = "3026" + "0221" + "01" + String(repeating: "00", count: 32) + "020101"
        XCTAssertThrowsError(try P256Signature.rawSignature(fromDER: data(big)))
    }

    func testZeroAndOutOfRangeScalarsAreRejected() {
        let zero = String(repeating: "00", count: 32)
        let one = String(repeating: "00", count: 31) + "01"
        let order = "ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551"
        XCTAssertThrowsError(try P256Signature.normalizeLowS(data(zero + one)))
        XCTAssertThrowsError(try P256Signature.normalizeLowS(data(one + order)))
        XCTAssertThrowsError(try P256Signature.normalizeLowS(Data(count: 63)))
    }

    func testSubtractBorrowsAcrossBytes() {
        XCTAssertEqual(P256Signature.subtract([0x01, 0x00, 0x00], [0x00, 0x00, 0x01]), [0x00, 0xFF, 0xFF])
        XCTAssertEqual(P256Signature.compare([0x01, 0x00], [0x00, 0xFF]), 1)
        XCTAssertEqual(P256Signature.compare([0x00, 0xFF], [0x00, 0xFF]), 0)
    }

    func testCompressedPublicKey() throws {
        let uncompressed = "04f9b029f566b8b7bc8e953aa02f1d25927b9452b36fb13fb440de69aac155f23df0181f71f01b27835e289497d0029ea3421c147ced1bc4863fcf92fdd44b0a23"
        let compressed = try P256Signature.compressedPublicKey(fromX963: data(uncompressed))
        XCTAssertEqual(Hex.encode(compressed), "03f9b029f566b8b7bc8e953aa02f1d25927b9452b36fb13fb440de69aac155f23d")

        var even = [UInt8](data(uncompressed))
        even[64] &= 0xFE
        XCTAssertEqual(try P256Signature.compressedPublicKey(fromX963: Data(even)).first, 0x02)

        XCTAssertThrowsError(try P256Signature.compressedPublicKey(fromX963: Data(count: 33)))
    }

    func testHexRoundTrip() {
        XCTAssertEqual(Hex.encode(Data([0x00, 0xAB, 0xFF])), "00abff")
        XCTAssertEqual(Hex.decode("0x00ABff"), Data([0x00, 0xAB, 0xFF]))
        XCTAssertNil(Hex.decode("abc"))
        XCTAssertNil(Hex.decode("zz"))
    }

    func testPRFSaltMatchesLabel() throws {
        XCTAssertEqual(WalletConstants.prfSalt.count, 32)
        #if canImport(CryptoKit)
        let digest = Data(SHA256.hash(data: Data(WalletConstants.prfSaltLabel.utf8)))
        XCTAssertEqual(Hex.encode(digest), WalletConstants.prfSaltHex)
        #endif
    }
}
