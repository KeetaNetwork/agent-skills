import XCTest
import KeetaComputeKit

final class AmountTests: XCTestCase {
    private let usdc = AssetFormatter(symbol: "USDC", decimals: 6)

    func testFormatMatchesProtocolFormatAmount() {
        XCTAssertEqual(BaseUnits.format("1234567", decimals: 6), "1.234567")
        XCTAssertEqual(BaseUnits.format("100000", decimals: 6), "0.1")
        XCTAssertEqual(BaseUnits.format("0", decimals: 6), "0")
        XCTAssertEqual(BaseUnits.format("1", decimals: 6), "0.000001")
        XCTAssertEqual(BaseUnits.format("000100", decimals: 2), "1")
        XCTAssertEqual(BaseUnits.format("5", decimals: 0), "5")
        XCTAssertEqual(BaseUnits.format("-2500000", decimals: 6), "-2.5")
        // Larger than any Int64.
        XCTAssertEqual(BaseUnits.format("123456789012345678901234567890", decimals: 18), "123456789012.34567890123456789")
    }

    func testDisplayGroupsAndPads() {
        XCTAssertEqual(BaseUnits.display("1234500000", decimals: 6), "1,234.50")
        XCTAssertEqual(BaseUnits.display("0", decimals: 6), "0.00")
        XCTAssertEqual(BaseUnits.display("123", decimals: 6), "0.000123")
        XCTAssertEqual(BaseUnits.display("1234567890123", decimals: 6), "1,234,567.890123")
        XCTAssertEqual(BaseUnits.display("123456789", decimals: 6, maxFractionDigits: 2), "123.45")
        XCTAssertEqual(BaseUnits.display("1500000000000000000", decimals: 18, maxFractionDigits: 4), "1.50")
        XCTAssertEqual(BaseUnits.display("-1500000", decimals: 6), "-1.50")
        XCTAssertEqual(BaseUnits.display("100", decimals: 0), "100")
    }

    func testParse() throws {
        XCTAssertEqual(try BaseUnits.parse("1.5", decimals: 6), "1500000")
        XCTAssertEqual(try BaseUnits.parse("0.000001", decimals: 6), "1")
        XCTAssertEqual(try BaseUnits.parse(" 1,000.25 ", decimals: 6), "1000250000")
        XCTAssertEqual(try BaseUnits.parse(".5", decimals: 6), "500000")
        XCTAssertEqual(try BaseUnits.parse("007", decimals: 6), "7000000")
        XCTAssertEqual(try BaseUnits.parse("0", decimals: 6), "0")
        XCTAssertEqual(try BaseUnits.parse("12", decimals: 0), "12")
    }

    func testParseRejects() {
        XCTAssertThrowsError(try BaseUnits.parse("0.0000001", decimals: 6)) { error in
            XCTAssertEqual(error as? AmountError, .tooPrecise(decimals: 6))
        }
        for bad in ["", "abc", "1.2.3", "1.", "-1", "1e6", "١"] {
            XCTAssertThrowsError(try BaseUnits.parse(bad, decimals: 6), "accepted \(bad)")
        }
    }

    func testRoundTrip() throws {
        for base in ["0", "1", "999999", "1000000", "123456789012"] {
            XCTAssertEqual(try BaseUnits.parse(BaseUnits.format(base, decimals: 6), decimals: 6), base)
        }
    }

    func testCompareAndAdd() {
        XCTAssertEqual(BaseUnits.compare("10", "9"), 1)
        XCTAssertEqual(BaseUnits.compare("009", "9"), 0)
        XCTAssertEqual(BaseUnits.compare("100", "200"), -1)
        XCTAssertEqual(BaseUnits.add("999", "1"), "1000")
        XCTAssertEqual(BaseUnits.add("0", "0"), "0")
        XCTAssertEqual(BaseUnits.add("18446744073709551615", "1"), "18446744073709551616")
        XCTAssertTrue(BaseUnits.isZero("000"))
    }

    func testAssetFormatterAndPrices() throws {
        XCTAssertEqual(usdc.string("100000"), "0.10 USDC")
        XCTAssertEqual(usdc.perMillion("250000"), "0.25 USDC / 1M tokens")
        XCTAssertEqual(usdc.priceSummary(Price(inputPerMillion: "100000", outputPerMillion: "250000")), "0.10 in · 0.25 out per 1M tokens (USDC)")
        XCTAssertEqual(usdc.editable("2500000"), "2.5")
        XCTAssertEqual(try usdc.parse("0.08"), "80000")
    }

    func testBytes() {
        let gb = 1024.0 * 1024.0 * 1024.0
        XCTAssertEqual(ByteFormat.string(1.8 * gb), "1.8 GB")
        XCTAssertEqual(ByteFormat.string(16 * gb), "16 GB")
        XCTAssertEqual(ByteFormat.string(512 * 1024 * 1024), "512 MB")
        XCTAssertEqual(ByteFormat.gigabytesRoundedUp(1.2 * gb), 2)
        // A paired helper chooses its own memoryBytes; Int(Double) traps past Int.max.
        XCTAssertEqual(ByteFormat.string(1e30), "931322574615478534144 GB")
        XCTAssertEqual(ByteFormat.gigabytesRoundedUp(1e30), 0)
    }

    func testAddressShape() {
        XCTAssertTrue(WalletConstants.looksLikeAddress("keeta_apna75yhhvnv4ei7ape55hndk4yepno7a7i2mhtiwahiygixjcnmvswxhnmnk"))
        XCTAssertFalse(WalletConstants.looksLikeAddress("0x1234"))
        XCTAssertFalse(WalletConstants.looksLikeAddress("keeta_short"))
        // Base32 has no 0, 1, 8 or 9, so the control plane would refuse these.
        XCTAssertFalse(WalletConstants.looksLikeAddress("keeta_apna75yhhvnv4ei7ape55hndk4yepno7a7i2mhtiwahiygixjcnmvswxhnmn0"))
        XCTAssertFalse(WalletConstants.looksLikeAddress("keeta_apna75yhhvnv4ei7ape55hndk4yepno7a7i2mhtiwahiygixjcnmvswxhnmn9"))
        XCTAssertFalse(WalletConstants.looksLikeAddress("keeta_" + String(repeating: "a", count: 49)))
        XCTAssertTrue(WalletConstants.looksLikeAddress("keeta_" + String(repeating: "a", count: 80)))
        XCTAssertFalse(WalletConstants.looksLikeAddress("keeta_" + String(repeating: "a", count: 81)))
    }
}
