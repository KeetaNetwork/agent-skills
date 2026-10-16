import AppKit
import KeetaComputeKit
import SwiftUI

struct MenuBarView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.openWindow) var openWindow

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Keeta Compute")
                    .font(.headline)
                Spacer()
                if model.isTestNetwork {
                    Badge(text: "Test", color: .orange)
                }
            }

            HStack(spacing: 16) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Earned today").font(.caption).foregroundStyle(.secondary)
                    Text(model.provider.map { model.money.string($0.earnedToday) } ?? "—")
                        .font(.title3.weight(.semibold))
                        .monospacedDigit()
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text("Balance").font(.caption).foregroundStyle(.secondary)
                    Text(model.wallet?.balances?.operatorBalance.map { model.money.string($0.usdc) } ?? "—")
                        .font(.title3.weight(.semibold))
                        .monospacedDigit()
                }
            }

            Divider()

            if let provider = model.provider {
                Toggle(isOn: Binding(
                    get: { provider.policy.enabled },
                    set: { enabled in Task { await model.setProviderPolicy(ProviderPolicyUpdate(enabled: enabled)) } }
                )) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Share this Mac")
                        Label(provider.state.title, systemImage: provider.state.symbol)
                            .font(.caption)
                            .foregroundStyle(provider.state.color)
                    }
                }
                .toggleStyle(.switch)
                .disabled(provider.state == .notEligible)
                if provider.activeJobs > 0 {
                    Text("Serving \(provider.activeJobs) request\(provider.activeJobs == 1 ? "" : "s") now")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            } else {
                Text(statusText)
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }

            Divider()

            Button {
                NSApp.showMainWindow(using: openWindow)
            } label: {
                Label("Open Keeta Compute", systemImage: "macwindow")
            }
            .buttonStyle(.borderless)

            Button {
                NSApp.terminate(nil)
            } label: {
                Label("Quit", systemImage: "power")
            }
            .buttonStyle(.borderless)
            .keyboardShortcut("q")
        }
        .padding(14)
        .frame(width: 280)
    }

    private var statusText: String {
        switch model.connection {
        case .running: return model.onboardingComplete ? "Loading…" : "Finish setting up in the main window."
        case .starting: return "Starting…"
        case .restarting: return "Restarting the background service…"
        case .missingExecutable: return "Background service missing from this build."
        case .failed(let reason): return reason
        case .stopped: return "Stopped."
        }
    }
}
