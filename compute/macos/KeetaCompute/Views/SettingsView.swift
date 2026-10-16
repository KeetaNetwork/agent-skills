import KeetaComputeKit
import ServiceManagement
import SwiftUI

struct SettingsView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.openWindow) var openWindow
    @State var confirmingMain = false
    @State var switching = false
    @State var showAdvanced = false
    @State var controlURL = ""
    @State var relayURL = ""
    @State var launchAtLogin = LaunchAtLogin.isEnabled
    @State var launchError: String?

    var body: some View {
        Screen("Settings") {
            networkCard
            identityCard
            generalCard
            advancedCard
        }
        .onAppear {
            controlURL = model.controlURL
            relayURL = model.relayURL
            launchAtLogin = LaunchAtLogin.isEnabled
        }
        .alert("Switch to the main network?", isPresented: $confirmingMain) {
            Button("Cancel", role: .cancel) {}
            Button("Use real money", role: .destructive) { switchNetwork(.main) }
        } message: {
            Text("On the main network, credits and stablecoins are real money. Anything you send can't be reversed. Your test balance doesn't carry over.")
        }
    }

    // MARK: Network

    private var networkCard: some View {
        Card("Network", systemImage: "globe") {
            Picker("Network", selection: Binding(
                get: { model.network },
                set: { newValue in
                    if newValue == .main {
                        confirmingMain = true
                    } else {
                        switchNetwork(newValue)
                    }
                }
            )) {
                Text("Test (no real money)").tag(NetworkName.test)
                Text("Main (real money)").tag(NetworkName.main)
            }
            .pickerStyle(.radioGroup)
            .disabled(switching || !model.connection.isRunning)
            if switching {
                ProgressView("Switching…").controlSize(.small)
            }
            Text(model.network == .test
                 ? "You're on the test network. Use it to try everything with free test funds."
                 : "You're on the main network. Credits and stablecoins are real money.")
                .font(.callout)
                .foregroundStyle(model.network == .test ? Color.secondary : Color.orange)
        }
    }

    private func switchNetwork(_ network: NetworkName) {
        switching = true
        Task {
            await model.setNetwork(network)
            switching = false
        }
    }

    // MARK: Identity

    private var identityCard: some View {
        Card("This Mac's identity", systemImage: "key") {
            Text("This Mac signs a receipt for every request it serves with its own key. That key can't move money.")
                .foregroundStyle(.secondary)
            if let nodeKey = model.agent?.nodeKey {
                LabeledContent("Node address") {
                    CopyField(value: nodeKey)
                }
            }
            if let signer = model.signer {
                switch signer.storage {
                case .secureEnclave:
                    Label("Protected by the Secure Enclave", systemImage: "lock.shield.fill")
                        .foregroundStyle(Color.keetaGreen)
                case .software(let reason):
                    Label("Stored in your Keychain (not the Secure Enclave). \(reason)", systemImage: "exclamationmark.shield")
                        .foregroundStyle(.orange)
                }
            } else if let error = model.signerError {
                Label("The node key couldn't be created: \(error)", systemImage: "xmark.shield")
                    .foregroundStyle(.red)
            }
            Divider()
            LabeledContent("Wallet passkey") {
                Text(model.passkeys.hasPasskey ? "Set up on this Mac" : "Not set up")
                    .foregroundStyle(.secondary)
            }
            if let address = model.wallet?.operatorAddress {
                LabeledContent("Wallet address") {
                    CopyField(value: address)
                }
            }
        }
    }

    // MARK: General

    private var generalCard: some View {
        Card("General", systemImage: "gearshape") {
            Toggle("Open Keeta Compute when you log in", isOn: Binding(
                get: { launchAtLogin },
                set: { enabled in
                    do {
                        try LaunchAtLogin.set(enabled)
                        launchError = nil
                    } catch {
                        launchError = error.localizedDescription
                    }
                    launchAtLogin = LaunchAtLogin.isEnabled
                }
            ))
            if LaunchAtLogin.needsApproval {
                HStack {
                    Text("Allow Keeta Compute in System Settings › Login Items.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                    Button("Open Login Items") { SMAppService.openSystemSettingsLoginItems() }
                }
            }
            if let launchError {
                Text(launchError).font(.callout).foregroundStyle(.red)
            }
            HStack {
                Button("Show logs") { openWindow(id: WindowID.logs) }
                Button("Restart background service") { Task { await model.restartAgent() } }
            }
            LabeledContent("Version") {
                Text("App \(model.appVersion)\(model.agent.map { " · Service \($0.version)" } ?? "")")
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
        }
    }

    // MARK: Advanced

    private var advancedCard: some View {
        Card {
            DisclosureGroup("Advanced", isExpanded: $showAdvanced) {
                VStack(alignment: .leading, spacing: 12) {
                    Text("Only change these if Keeta support asks you to. The background service restarts to apply them.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                    LabeledContent("Control service") {
                        TextField("Control service URL", text: $controlURL)
                            .textFieldStyle(.roundedBorder)
                    }
                    LabeledContent("Relay service") {
                        TextField("Relay service URL", text: $relayURL)
                            .textFieldStyle(.roundedBorder)
                    }
                    HStack {
                        Button("Reset to defaults") {
                            controlURL = ProtocolConstants.defaultControlURL
                            relayURL = ProtocolConstants.defaultRelayURL
                        }
                        Spacer()
                        Button("Apply and restart") {
                            Task { await model.setEndpoints(control: controlURL, relay: relayURL) }
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(!urlsValid || (controlURL == model.controlURL && relayURL == model.relayURL))
                    }
                }
                .padding(.top, 8)
            }
        }
    }

    private var urlsValid: Bool {
        [controlURL, relayURL].allSatisfy { text in
            guard let url = URL(string: text), let scheme = url.scheme else { return false }
            return (scheme == "https" || scheme == "http") && url.host != nil
        }
    }
}

// MARK: - Logs

struct LogsView: View {
    @EnvironmentObject var model: AppModel
    @State var showDebug = false

    private var lines: [LogLine] {
        showDebug ? model.logs : model.logs.filter { $0.level != .debug }
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Toggle("Show detailed output", isOn: $showDebug)
                Spacer()
                Button("Copy all") {
                    Pasteboard.copy(lines.map(Self.format).joined(separator: "\n"))
                }
            }
            .padding(10)
            Divider()
            if lines.isEmpty {
                EmptyNote(title: "No log entries yet", systemImage: "doc.plaintext")
                    .frame(maxHeight: .infinity)
            } else {
                ScrollViewReader { proxy in
                    List(lines) { line in
                        Text(Self.format(line))
                            .font(.system(.caption, design: .monospaced))
                            .foregroundStyle(color(for: line.level))
                            .textSelection(.enabled)
                            .id(line.id)
                    }
                    .onChange(of: lines.last?.id) { _, last in
                        if let last { proxy.scrollTo(last, anchor: .bottom) }
                    }
                }
            }
        }
        .frame(minWidth: 520, minHeight: 300)
    }

    private func color(for level: LogLevel) -> Color {
        switch level {
        case .error: return .red
        case .warn: return .orange
        case .info: return .primary
        case .debug: return .secondary
        }
    }

    static func format(_ line: LogLine) -> String {
        "\(line.date.formatted(date: .omitted, time: .standard)) [\(line.source.rawValue)] \(line.level.rawValue.uppercased()) \(line.message)"
    }
}
