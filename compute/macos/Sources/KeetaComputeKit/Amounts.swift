// Money and size formatting. Amounts are strings of integer base units and
// are handled with string arithmetic only — never Double — mirroring
// formatAmount/parseAmount in packages/protocol/src/pricing.ts.

import Foundation

public enum AmountError: Error, Equatable, LocalizedError {
    case invalid(String)
    case tooPrecise(decimals: Int)

    public var errorDescription: String? {
        switch self {
        case .invalid: return "Enter an amount like 12.50."
        case .tooPrecise(let decimals): return "Use at most \(decimals) decimal places."
        }
    }
}

public enum BaseUnits {
    /// True when `text` is a non-negative integer with digits only.
    public static func isValid(_ text: String) -> Bool {
        !text.isEmpty && text.utf8.allSatisfy { $0 >= 48 && $0 <= 57 }
    }

    /// Strips leading zeros; "" and "000" become "0". Non-digit input becomes "0".
    public static func normalize(_ text: String) -> String {
        guard isValid(text) else { return "0" }
        let trimmed = text.drop { $0 == "0" }
        return trimmed.isEmpty ? "0" : String(trimmed)
    }

    /// Exact decimal string, e.g. ("1234567", 6) -> "1.234567", ("100000", 6) -> "0.1".
    /// Mirrors `formatAmount` in pricing.ts. A leading "-" is preserved.
    public static func format(_ amount: String, decimals: Int) -> String {
        let negative = amount.hasPrefix("-")
        let digits = normalize(negative ? String(amount.dropFirst()) : amount)
        guard decimals > 0 else { return (negative && digits != "0" ? "-" : "") + digits }
        let padded = digits.count <= decimals ? String(repeating: "0", count: decimals - digits.count + 1) + digits : digits
        let split = padded.index(padded.endIndex, offsetBy: -decimals)
        let whole = String(padded[..<split])
        var fraction = String(padded[split...])
        while fraction.last == "0" { fraction.removeLast() }
        let sign = negative && digits != "0" ? "-" : ""
        return fraction.isEmpty ? "\(sign)\(whole)" : "\(sign)\(whole).\(fraction)"
    }

    /// Display string with digit grouping and at least `minFractionDigits` decimals,
    /// e.g. ("1234500000", 6) -> "1,234.50". Never rounds: all significant digits are kept,
    /// unless `maxFractionDigits` is given, in which case extra digits are truncated (rounded toward zero).
    public static func display(_ amount: String, decimals: Int, minFractionDigits: Int = 2, maxFractionDigits: Int? = nil, groupingSeparator: String = ",", decimalSeparator: String = ".") -> String {
        let exact = format(amount, decimals: decimals)
        let negative = exact.hasPrefix("-")
        let body = negative ? String(exact.dropFirst()) : exact
        let parts = body.split(separator: ".", omittingEmptySubsequences: false)
        let whole = String(parts[0])
        var fraction = parts.count > 1 ? String(parts[1]) : ""
        if let maxFractionDigits, fraction.count > maxFractionDigits {
            fraction = String(fraction.prefix(maxFractionDigits))
        }
        let minimum = min(minFractionDigits, max(decimals, 0))
        if fraction.count < minimum {
            fraction += String(repeating: "0", count: minimum - fraction.count)
        }
        var grouped = ""
        for (offset, character) in whole.enumerated() {
            if offset > 0 && (whole.count - offset) % 3 == 0 {
                grouped += groupingSeparator
            }
            grouped.append(character)
        }
        let sign = negative ? "-" : ""
        return fraction.isEmpty ? "\(sign)\(grouped)" : "\(sign)\(grouped)\(decimalSeparator)\(fraction)"
    }

    /// Parses user input into base units. Mirrors `parseAmount` in pricing.ts and
    /// additionally accepts surrounding whitespace, a leading "." and "," digit grouping.
    public static func parse(_ text: String, decimals: Int) throws -> String {
        var cleaned = text.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: ",", with: "")
        if cleaned.hasPrefix(".") { cleaned = "0" + cleaned }
        let parts = cleaned.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 1 || parts.count == 2 else { throw AmountError.invalid(text) }
        let whole = String(parts[0])
        let fraction = parts.count == 2 ? String(parts[1]) : ""
        guard isValid(whole) else { throw AmountError.invalid(text) }
        if parts.count == 2 && !isValid(fraction) { throw AmountError.invalid(text) }
        guard fraction.count <= decimals else { throw AmountError.tooPrecise(decimals: decimals) }
        let padded = fraction + String(repeating: "0", count: decimals - fraction.count)
        return normalize(whole + padded)
    }

    /// -1, 0 or 1. Both inputs must be non-negative integer strings.
    public static func compare(_ a: String, _ b: String) -> Int {
        let x = normalize(a)
        let y = normalize(b)
        if x.count != y.count { return x.count < y.count ? -1 : 1 }
        if x == y { return 0 }
        return x < y ? -1 : 1
    }

    public static func isZero(_ amount: String) -> Bool {
        normalize(amount) == "0"
    }

    /// Sum of non-negative integer strings.
    public static func add(_ a: String, _ b: String) -> String {
        let x = Array(normalize(a).utf8.reversed())
        let y = Array(normalize(b).utf8.reversed())
        var out: [UInt8] = []
        var carry = 0
        for i in 0..<max(x.count, y.count) {
            let dx = i < x.count ? Int(x[i]) - 48 : 0
            let dy = i < y.count ? Int(y[i]) - 48 : 0
            let sum = dx + dy + carry
            out.append(UInt8(sum % 10 + 48))
            carry = sum / 10
        }
        if carry > 0 { out.append(UInt8(carry + 48)) }
        return normalize(String(decoding: out.reversed(), as: UTF8.self))
    }
}

/// Formats amounts for one asset (from `WalletState.asset`).
public struct AssetFormatter: Sendable, Equatable {
    public var symbol: String
    public var decimals: Int

    public init(symbol: String, decimals: Int) {
        self.symbol = symbol
        self.decimals = decimals
    }

    public init(asset: NetworkAsset) {
        self.init(symbol: asset.symbol, decimals: asset.decimals)
    }

    /// "12.50 USDC"
    public func string(_ baseUnits: String, minFractionDigits: Int = 2) -> String {
        "\(number(baseUnits, minFractionDigits: minFractionDigits)) \(symbol)"
    }

    /// "12.50"
    public func number(_ baseUnits: String, minFractionDigits: Int = 2) -> String {
        BaseUnits.display(baseUnits, decimals: decimals, minFractionDigits: minFractionDigits)
    }

    /// Plain decimal for editing in a text field ("12.5"), without grouping.
    public func editable(_ baseUnits: String) -> String {
        BaseUnits.format(baseUnits, decimals: decimals)
    }

    public func parse(_ text: String) throws -> String {
        try BaseUnits.parse(text, decimals: decimals)
    }

    /// "0.10 USDC / 1M tokens"
    public func perMillion(_ baseUnits: String) -> String {
        "\(string(baseUnits)) / 1M tokens"
    }

    /// "0.10 in · 0.25 out per 1M tokens (USDC)"
    public func priceSummary(_ price: Price) -> String {
        "\(number(price.inputPerMillion)) in · \(number(price.outputPerMillion)) out per 1M tokens (\(symbol))"
    }
}

public enum ByteFormat {
    private static let gb = 1024.0 * 1024.0 * 1024.0

    /// Mirrors `formatBytes` in hardware.ts: "18 GB", "4.5 GB", "512 MB".
    /// Byte counts can come from other machines (a helper's memory), so the
    /// Double is formatted as is: converting one past Int.max to Int would trap.
    public static func string(_ bytes: Double) -> String {
        if bytes >= gb {
            let value = bytes / gb
            return value >= 10 ? String(format: "%.0f GB", value.rounded()) : String(format: "%.1f GB", value)
        }
        return String(format: "%.0f MB", (bytes / (1024 * 1024)).rounded())
    }

    /// Whole gigabytes rounded up, for "needs X GB more" messages; 0 when that is not a representable Int.
    public static func gigabytesRoundedUp(_ bytes: Double) -> Int {
        Int(exactly: (bytes / gb).rounded(.up)) ?? 0
    }
}
