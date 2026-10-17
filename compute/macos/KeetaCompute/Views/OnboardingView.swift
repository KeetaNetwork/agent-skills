import KeetaComputeKit
import SwiftUI

struct OnboardingView: View {
    enum Step: Int, CaseIterable {
        case welcome, wallet, hardware, models, done
    }

    @EnvironmentObject var model: AppModel
    @State var step: Step = .welcome

    var body: some View {
        VStack(spacing: 0) {
            ProgressDots(current: step.rawValue, count: Step.allCases.count)
                .padding(.top, 4)
            ScrollView {
                Group {
                    switch step {
                    case .welcome: WelcomeStep { step = .wallet }
                    case .wallet: WalletStep { step = .hardware }
                    case .hardware: HardwareStep(onProvide: { step = .models }, onBuyOnly: { step = .done })
                    case .models: ModelPickStep { step = .done }
                    case .done: DoneStep { model.finishOnboarding() }
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(.horizontal, 20)
                .padding(.vertical, 16)
            }
        }
        .animation(.easeInOut(duration: 0.2), value: step)
    }
}

private struct ProgressDots: View {
    let current: Int
    let count: Int

    var body: some View {
        HStack(spacing: 8) {
            ForEach(0..<count, id: \.self) { index in
                Capsule()
                    .fill(index <= current ? Color.keetaGreen : Color.secondary.opacity(0.25))
                    .frame(width: index == current ? 22 : 8, height: 8)
            }
        }
    }
}

private struct StepHeader: View {
    let systemImage: String
    let title: String
    let message: String

    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: systemImage)
                .font(.system(size: 34, weight: .regular))
                .foregroundStyle(Color.keetaRed)
            Text(title)
                .font(.title2.weight(.semibold))
                .multilineTextAlignment(.center)
            Text(message)
                .font(.body)
                .foregroundStyle(Color.keetaGray40)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

// MARK: - Welcome

private struct WelcomeStep: View {
    let next: () -> Void

    var body: some View {
        VStack(spacing: 22) {
            StepHeader(
                systemImage: "macbook.and.iphone",
                title: "Welcome to Keeta Compute",
                message: "Earn by sharing your Mac's AI capacity, or use models running on other Macs."
            )
            VStack(alignment: .leading, spacing: 14) {
                Point(symbol: "dollarsign.circle", text: "Earn Keeta Compute Credits for every request your Mac serves, and cash them out to KUSD or another Keeta stablecoin.")
                Point(symbol: "hand.raised", text: "You decide which models to share, when, and with whom.")
                Point(symbol: "terminal", text: "Point your own tools and agents at a local endpoint and pay per request.")
            }
            Button("Get started", action: next)
                .buttonStyle(.keetaPrimary)
                .keyboardShortcut(.defaultAction)
        }
    }

    private struct Point: View {
        let symbol: String
        let text: String

        var body: some View {
            Label {
                Text(text)
            } icon: {
                Image(systemName: symbol).foregroundStyle(Color.keetaRed)
            }
            .font(.callout)
            .fixedSize(horizontal: false, vertical: true)
        }
    }
}

// MARK: - Wallet

private struct WalletStep: View {
    @EnvironmentObject var model: AppModel
    let next: () -> Void
    @State var working = false

    var body: some View {
        VStack(spacing: 24) {
            StepHeader(
                systemImage: "person.badge.key",
                title: "Create your wallet",
                message: "Your wallet holds what you earn and pays for what you use. It's protected by a passkey with Touch ID."
            )
            VStack(alignment: .leading, spacing: 10) {
                Label("Your passkey syncs with iCloud Keychain, so your wallet follows you to your other Macs.", systemImage: "icloud")
                Label("There's no recovery phrase to write down. Keep iCloud Keychain turned on to keep access.", systemImage: "lock.shield")
                Label("Only you can move money. Keeta Compute asks for Touch ID every time.", systemImage: "touchid")
            }
            .font(.callout)
            .foregroundStyle(Color.keetaGray40)
            .fixedSize(horizontal: false, vertical: true)

            if model.hasOperator, let address = model.wallet?.operatorAddress {
                VStack(spacing: 8) {
                    Label("Wallet ready", systemImage: "checkmark.circle.fill")
                        .foregroundStyle(Color.keetaGreen)
                        .font(.headline)
                    Text(Abbreviate.address(address))
                        .font(.system(.callout, design: .monospaced))
                        .foregroundStyle(.secondary)
                }
                Button("Continue", action: next)
                    .buttonStyle(.keetaPrimary)
                    .keyboardShortcut(.defaultAction)
            } else {
                VStack(spacing: 10) {
                    Button {
                        run { try await model.createWallet() }
                    } label: {
                        if working {
                            ProgressView().controlSize(.small)
                        } else {
                            Text("Create wallet with passkey")
                        }
                    }
                    .buttonStyle(.keetaPrimary)
                    .keyboardShortcut(.defaultAction)

                    Button("I already have a wallet passkey") {
                        run { try await model.restoreWallet() }
                    }
                    .buttonStyle(.link)
                }
                .disabled(working || !model.connection.isRunning)
            }
        }
    }

    private func run(_ action: @escaping () async throws -> Void) {
        working = true
        Task {
            defer { working = false }
            do {
                try await action()
                if model.hasOperator { next() }
            } catch {
                model.show(error, title: "Couldn't set up your wallet")
            }
        }
    }
}

// MARK: - Hardware

private struct HardwareStep: View {
    @EnvironmentObject var model: AppModel
    let onProvide: () -> Void
    let onBuyOnly: () -> Void
    @State var check: HardwareCheck?
    @State var error: String?

    var body: some View {
        VStack(spacing: 24) {
            StepHeader(
                systemImage: "cpu",
                title: "Check this Mac",
                message: "Keeta Compute looks at your chip and memory to see which models it can run."
            )
            if let check {
                Card {
                    Grid(alignment: .leading, horizontalSpacing: 24, verticalSpacing: 8) {
                        GridRow {
                            Text("Chip").foregroundStyle(.secondary)
                            Text(check.hardware.chip)
                        }
                        GridRow {
                            Text("Memory").foregroundStyle(.secondary)
                            Text(ByteFormat.string(check.hardware.memoryBytes))
                        }
                        GridRow {
                            Text("Free disk").foregroundStyle(.secondary)
                            Text(ByteFormat.string(check.hardware.freeDiskBytes))
                        }
                        GridRow {
                            Text("Class").foregroundStyle(.secondary)
                            Text(check.tier.title)
                        }
                    }
                }
                if check.canProvide {
                    Label("This Mac can earn by serving models to the network.", systemImage: "checkmark.seal.fill")
                        .foregroundStyle(Color.keetaGreen)
                    Button("Choose models", action: onProvide)
                        .buttonStyle(.keetaPrimary)
                        .keyboardShortcut(.defaultAction)
                } else {
                    VStack(spacing: 6) {
                        Label("This Mac can use models from the network.", systemImage: "info.circle")
                        Text(check.reason ?? "Serving others needs a Mac with 32 GB of memory or more.")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                    }
                    Button("Continue", action: onBuyOnly)
                        .buttonStyle(.keetaPrimary)
                        .keyboardShortcut(.defaultAction)
                }
            } else if let error {
                Text(error).foregroundStyle(.red)
                Button("Try again") { Task { await load() } }
            } else {
                ProgressView("Checking…")
            }
        }
        .task { await load() }
    }

    private func load() async {
        error = nil
        do {
            check = try await model.checkHardware()
        } catch {
            self.error = AppModel.friendlyMessage(for: error)
        }
    }
}

// MARK: - Models

private struct ModelPickStep: View {
    @EnvironmentObject var model: AppModel
    let next: () -> Void
    @State var selected: Set<String> = []
    @State var didPreselect = false

    /// Catalog models that fit this Mac, largest first.
    private var candidates: [CatalogEntry] {
        model.catalog
            .filter { $0.compatibility.fits && $0.model.requiresCluster != true }
            .sorted { $0.model.memoryBytes > $1.model.memoryBytes }
    }

    /// The largest model that fits and still leaves room to work.
    private var recommended: CatalogEntry? {
        let comfortable = candidates.first { entry in
            if case .fits(let headroom) = entry.compatibility {
                return headroom >= 4 * 1024 * 1024 * 1024
            }
            return false
        }
        return comfortable ?? candidates.first
    }

    var body: some View {
        VStack(spacing: 20) {
            StepHeader(
                systemImage: "shippingbox",
                title: "Pick models to install",
                message: "Installed models can be offered to the network. You choose which ones to offer, and at what price, later."
            )
            if !model.catalogLoaded {
                ProgressView("Loading models…")
                    .task { await model.refreshCatalog() }
            } else if candidates.isEmpty {
                EmptyNote(title: "No catalog models fit right now", systemImage: "externaldrive.badge.exclamationmark", message: "Free up disk space or add a model later from the Models screen.")
            } else {
                ScrollView {
                    VStack(spacing: 8) {
                        ForEach(candidates) { entry in
                            Toggle(isOn: Binding(
                                get: { selected.contains(entry.id) },
                                set: { isOn in
                                    if isOn { selected.insert(entry.id) } else { selected.remove(entry.id) }
                                }
                            )) {
                                HStack {
                                    VStack(alignment: .leading, spacing: 2) {
                                        HStack(spacing: 6) {
                                            Text(entry.model.name).font(.body.weight(.medium))
                                            if entry.id == recommended?.id {
                                                Badge(text: "Recommended", color: .keetaGreen)
                                            }
                                        }
                                        Text("\(ByteFormat.string(entry.model.diskBytes)) download · \(entry.compatibility.summary) · \(entry.model.license.name)")
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                }
                            }
                            .toggleStyle(.checkbox)
                            .padding(10)
                            .background(.quaternary.opacity(0.35), in: RoundedRectangle(cornerRadius: 8))
                        }
                    }
                }
                .frame(maxHeight: 220)
            }
            HStack {
                Button("Skip for now", action: next)
                Spacer()
                Button(selected.isEmpty ? "Continue" : "Install \(selected.count) model\(selected.count == 1 ? "" : "s")") {
                    let ids = selected
                    Task {
                        for id in ids {
                            await model.install(id)
                        }
                    }
                    next()
                }
                .buttonStyle(.keetaPrimary)
                .keyboardShortcut(.defaultAction)
            }
        }
        .onChange(of: model.catalogLoaded, initial: true) { _, loaded in
            if loaded && !didPreselect, let recommended {
                selected = [recommended.id]
                didPreselect = true
            }
        }
    }
}

// MARK: - Done

private struct DoneStep: View {
    @EnvironmentObject var model: AppModel
    let finish: () -> Void

    var body: some View {
        VStack(spacing: 24) {
            StepHeader(
                systemImage: "checkmark.circle",
                title: "You're all set",
                message: model.hardwareCheck?.canProvide == true
                    ? "Downloads continue in the background. When a model is ready, offer it to the network from Models and turn on Provide to start earning."
                    : "Buy credits with KUSD or another Keeta stablecoin in Wallet, then point your tools at the local endpoint shown under Use."
            )
            Button("Done", action: finish)
                .buttonStyle(.keetaPrimary)
                .keyboardShortcut(.defaultAction)
        }
    }
}
