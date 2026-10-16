import AppKit
import CoreImage
import CoreImage.CIFilterBuiltins
import KeetaComputeKit
import ServiceManagement
import SwiftUI

// MARK: - Brand

extension Color {
    static let keetaGreen = Color("KeetaGreen")
    static let keetaGray = Color("KeetaGray")
    static let keetaGray50 = Color("KeetaGray50")
}

// MARK: - Pasteboard

enum Pasteboard {
    static func copy(_ text: String) {
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString(text, forType: .string)
    }
}

// MARK: - QR codes

enum QRCode {
    /// A crisp QR code image for `text`, or nil if CoreImage can't make one.
    static func image(for text: String, size: CGFloat = 220) -> NSImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage, output.extent.width > 0 else { return nil }
        let scale = (size / output.extent.width).rounded(.down)
        let scaled = output.transformed(by: CGAffineTransform(scaleX: max(scale, 1), y: max(scale, 1)))
        let context = CIContext()
        guard let cgImage = context.createCGImage(scaled, from: scaled.extent) else { return nil }
        return NSImage(cgImage: cgImage, size: NSSize(width: scaled.extent.width, height: scaled.extent.height))
    }
}

// MARK: - Launch at login

enum LaunchAtLogin {
    static var isEnabled: Bool {
        SMAppService.mainApp.status == .enabled
    }

    static var needsApproval: Bool {
        SMAppService.mainApp.status == .requiresApproval
    }

    static func set(_ enabled: Bool) throws {
        if enabled {
            try SMAppService.mainApp.register()
        } else {
            try SMAppService.mainApp.unregister()
        }
    }
}

// MARK: - Plain-language descriptions

extension ProviderState {
    /// Short label for badges.
    var title: String {
        switch self {
        case .online: return "Sharing"
        case .paused: return "Paused"
        case .outsideSchedule: return "Waiting for schedule"
        case .onBattery: return "Paused on battery"
        case .noOffers: return "No models offered"
        case .notEligible: return "Can't provide"
        case .connecting: return "Connecting"
        case .offline: return "Offline"
        }
    }

    /// One sentence explaining what is happening.
    var explanation: String {
        switch self {
        case .online: return "Your Mac is available to the network and earns for every request it serves."
        case .paused: return "Sharing is turned off. Turn it on to start earning."
        case .outsideSchedule: return "Your schedule says not now. Sharing resumes automatically."
        case .onBattery: return "Sharing pauses while your Mac runs on battery. Plug in to resume."
        case .noOffers: return "Offer at least one installed model to the network to start earning."
        case .notEligible: return "This Mac doesn't meet the requirements to serve others, but you can still use models from the network."
        case .connecting: return "Connecting to the network…"
        case .offline: return "Can't reach the network. Check your internet connection."
        }
    }

    var color: Color {
        switch self {
        case .online: return .keetaGreen
        case .connecting, .outsideSchedule: return .orange
        case .paused, .noOffers, .onBattery: return .secondary
        case .notEligible, .offline: return .red
        }
    }

    var symbol: String {
        switch self {
        case .online: return "bolt.circle.fill"
        case .paused: return "pause.circle.fill"
        case .outsideSchedule: return "clock.fill"
        case .onBattery: return "battery.25"
        case .noOffers: return "shippingbox"
        case .notEligible: return "nosign"
        case .connecting: return "arrow.triangle.2.circlepath"
        case .offline: return "wifi.slash"
        }
    }
}

extension HardwareTier {
    var title: String {
        switch self {
        case .a: return "Tier A"
        case .b: return "Tier B"
        case .c: return "Tier C"
        case .excluded: return "Buy only"
        }
    }
}

extension Compatibility {
    /// "Fits, 12 GB to spare" / "Needs 8 GB more memory" / "Needs a multi-Mac cluster".
    var summary: String {
        switch self {
        case .fits(let headroom):
            return headroom > 0 ? "Fits · \(ByteFormat.string(headroom)) to spare" : "Fits"
        case .doesNotFit(let reason, let short):
            let amount = short.map { "\(ByteFormat.gigabytesRoundedUp($0)) GB" }
            switch reason {
            case .needsCluster: return "Needs a multi-Mac cluster"
            case .notEnoughMemory: return amount.map { "Needs \($0) more memory" } ?? "Needs more memory"
            case .notEnoughDisk: return amount.map { "Needs \($0) more free disk space" } ?? "Needs more free disk space"
            case .unsupportedRuntime: return "Not supported on this Mac"
            }
        }
    }
}

extension JobSummaryStatus {
    var title: String {
        switch self {
        case .running: return "Running"
        case .completed: return "Settling"
        case .paid: return "Paid"
        case .failed: return "Failed"
        }
    }

    var color: Color {
        switch self {
        case .running: return .orange
        case .completed: return .secondary
        case .paid: return .keetaGreen
        case .failed: return .red
        }
    }
}

enum Abbreviate {
    /// "keeta_aabb…wxyz" for long addresses.
    static func address(_ address: String) -> String {
        guard address.count > 22 else { return address }
        return "\(address.prefix(12))…\(address.suffix(6))"
    }

    static func tokens(_ count: Int) -> String {
        count.formatted(.number.notation(.compactName))
    }
}

extension Date {
    var relative: String {
        formatted(.relative(presentation: .named))
    }
}
