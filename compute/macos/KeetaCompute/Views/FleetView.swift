import KeetaComputeKit
import SwiftUI

struct FleetView: View {
    @EnvironmentObject var model: AppModel
    @State var pairing = false
    @State var revoking: FleetHelper?

    var body: some View {
        Screen("Fleet", subtitle: "Add Linux machines you own as extra capacity. Everything they earn is paid into this Mac's wallet.") {
            Card {
                HStack(alignment: .center) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Linux helpers")
                            .font(.headline)
                        Text("A helper only serves requests. It has no wallet of its own and can't spend anything.")
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button {
                        pairing = true
                    } label: {
                        Label("Add a Linux machine", systemImage: "plus")
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(!model.connection.isRunning || !model.hasOperator)
                }
            }

            Card("Machines", systemImage: "server.rack") {
                if model.fleet.isEmpty {
                    EmptyNote(title: "No helpers yet", systemImage: "server.rack", message: "Add a Linux machine to sell its capacity alongside this Mac.")
                } else {
                    ForEach(model.fleet) { helper in
                        HelperRow(helper: helper) { revoking = helper }
                        if helper.id != model.fleet.last?.id { Divider() }
                    }
                }
            }
        }
        .task {
            while !Task.isCancelled {
                await model.refreshFleet()
                try? await Task.sleep(for: .seconds(15))
            }
        }
        .sheet(isPresented: $pairing) {
            PairingSheet()
                .environmentObject(model)
        }
        .confirmationDialog(
            "Remove \(revoking?.name ?? "this machine")?",
            isPresented: Binding(get: { revoking != nil }, set: { if !$0 { revoking = nil } }),
            presenting: revoking
        ) { helper in
            Button("Remove", role: .destructive) {
                Task { await model.revokeHelper(helper.nodeKey) }
            }
        } message: { _ in
            Text("It stops receiving requests immediately. You can pair it again later with a new code.")
        }
    }
}

struct HelperRow: View {
    @EnvironmentObject var model: AppModel
    let helper: FleetHelper
    let onRemove: () -> Void

    private var statusColor: Color {
        switch helper.status {
        case .online: return .keetaGreen
        case .paused: return .orange
        case .offline: return .secondary
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "server.rack")
                .font(.title2)
                .foregroundStyle(statusColor)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(helper.name).font(.body.weight(.semibold))
                    Badge(text: helper.status.rawValue.capitalized, color: statusColor)
                }
                Text("\(helper.hardware.chip) · \(ByteFormat.string(helper.hardware.memoryBytes)) · \(helper.hardware.osVersion)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(helper.offers.isEmpty ? "No models offered" : "Offers \(helper.offers.joined(separator: ", "))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text("Last seen \(Date(timeIntervalSince1970: helper.lastHeartbeat / 1000).relative)")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 6) {
                Text(model.money.string(helper.earnedTotal))
                    .monospacedDigit()
                    .font(.body.weight(.medium))
                Text("earned").font(.caption).foregroundStyle(.secondary)
                Button("Remove…", role: .destructive, action: onRemove)
                    .controlSize(.small)
            }
        }
        .padding(.vertical, 4)
    }
}

// MARK: - Pairing

struct PairingSheet: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) var dismiss
    @State var created: PairingCreated?
    @State var record: PairingRecord?
    @State var error: String?
    @State var deciding = false
    @State var pollGeneration = 0
    /// Set locally for outcomes the app knows before the next poll (expiry, approve, reject).
    @State var localStatus: PairingStatus?

    static let installCommand = "curl -fsSL https://keeta.ai/compute/install-helper.sh | sh"

    private var status: PairingStatus { localStatus ?? record?.status ?? .waiting }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Add a Linux machine")
                .font(.title2.weight(.semibold))
            if let error {
                Text(error).foregroundStyle(.red)
                Button("Try again") { Task { await start() } }
            } else if let created {
                switch status {
                case .waiting:
                    waiting(created)
                case .claimed:
                    if let claim = record?.claim {
                        confirm(claim, pairingId: created.pairingId)
                    } else {
                        waiting(created)
                    }
                case .approved:
                    finished(symbol: "checkmark.circle.fill", color: .keetaGreen, title: "Machine added", message: "It appears in your fleet once it comes online. Its earnings go to this Mac's wallet.")
                case .rejected:
                    finished(symbol: "xmark.circle.fill", color: .secondary, title: "Pairing rejected", message: "The machine was not added.")
                case .expired:
                    finished(symbol: "clock.badge.xmark", color: .orange, title: "Code expired", message: "Pairing codes last 10 minutes. Create a new one to try again.")
                    Button("New code") { Task { await start() } }
                }
            } else {
                ProgressView("Creating a pairing code…")
                    .frame(maxWidth: .infinity)
            }
            HStack {
                Spacer()
                Button(status == .approved || status == .rejected ? "Done" : "Cancel") { dismiss() }
                    .keyboardShortcut(.cancelAction)
            }
        }
        .padding(24)
        .frame(width: 560)
        .task { await start() }
        .onDisappear { pollGeneration += 1 }
    }

    @ViewBuilder
    private func waiting(_ created: PairingCreated) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("1. On the Linux machine, install the helper:")
            CodeBlock(code: Self.installCommand)
            Text("2. Then pair it with this code:")
            CodeBlock(code: "keeta-compute-agent helper pair \(created.code)")
            Text(created.code)
                .font(.system(size: 22, weight: .semibold, design: .monospaced))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("Waiting for the machine…")
                Spacer()
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    Text("Code expires in \(Self.remaining(until: created.expiresAt, now: context.date))")
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                }
            }
            .font(.callout)
        }
    }

    @ViewBuilder
    private func confirm(_ claim: PairingClaim, pairingId: String) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("A machine wants to join your fleet. Check that it's yours.")
            Card {
                Grid(alignment: .leading, horizontalSpacing: 20, verticalSpacing: 6) {
                    GridRow { Text("Name").foregroundStyle(.secondary); Text(claim.descriptor.name) }
                    GridRow { Text("System").foregroundStyle(.secondary); Text(claim.descriptor.hardware.osVersion) }
                    GridRow { Text("Hardware").foregroundStyle(.secondary); Text(claim.descriptor.hardware.chip) }
                    GridRow { Text("Memory").foregroundStyle(.secondary); Text(ByteFormat.string(claim.descriptor.hardware.memoryBytes)) }
                }
            }
            HStack {
                Text("Check code")
                    .foregroundStyle(.secondary)
                Text(claim.checkString)
                    .font(.system(size: 24, weight: .bold, design: .monospaced))
            }
            Text("Approve only if the Linux machine shows the same check code.")
                .font(.callout)
                .foregroundStyle(.secondary)
            HStack {
                Button("Reject", role: .destructive) { decide(approve: false, pairingId: pairingId) }
                Spacer()
                if deciding { ProgressView().controlSize(.small) }
                Button("Approve") { decide(approve: true, pairingId: pairingId) }
                    .buttonStyle(.borderedProminent)
            }
            .disabled(deciding)
        }
    }

    private func finished(symbol: String, color: Color, title: String, message: String) -> some View {
        VStack(spacing: 10) {
            Image(systemName: symbol)
                .font(.system(size: 40))
                .foregroundStyle(color)
            Text(title).font(.headline)
            Text(message)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 12)
    }

    static func remaining(until expiresAt: Double, now: Date) -> String {
        let seconds = max(0, Int(expiresAt / 1000 - now.timeIntervalSince1970))
        return String(format: "%d:%02d", seconds / 60, seconds % 60)
    }

    private func start() async {
        error = nil
        record = nil
        created = nil
        localStatus = nil
        pollGeneration += 1
        let generation = pollGeneration
        do {
            let pairing = try await model.createPairing()
            created = pairing
            await poll(pairing, generation: generation)
        } catch {
            self.error = AppModel.friendlyMessage(for: error)
        }
    }

    /// Polls until the pairing leaves the waiting state, the sheet closes, or a new code is made.
    private func poll(_ pairing: PairingCreated, generation: Int) async {
        while !Task.isCancelled && generation == pollGeneration {
            if Date().timeIntervalSince1970 * 1000 > pairing.expiresAt, status == .waiting {
                localStatus = .expired
                return
            }
            if let latest = try? await model.pairingStatus(pairing.pairingId), generation == pollGeneration {
                record = latest
                if latest.status != .waiting { return }
            }
            try? await Task.sleep(for: .seconds(2))
        }
    }

    private func decide(approve: Bool, pairingId: String) {
        deciding = true
        Task {
            defer { deciding = false }
            do {
                if approve {
                    try await model.approvePairing(pairingId)
                    localStatus = .approved
                } else {
                    try await model.rejectPairing(pairingId)
                    localStatus = .rejected
                }
            } catch {
                self.error = AppModel.friendlyMessage(for: error)
            }
        }
    }
}
