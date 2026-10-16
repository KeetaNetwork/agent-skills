import KeetaComputeKit
import SwiftUI

enum SidebarItem: String, CaseIterable, Identifiable, Hashable {
    case home, wallet, models, provide, use, fleet, settings

    var id: String { rawValue }

    var title: String {
        switch self {
        case .home: return "Home"
        case .wallet: return "Wallet"
        case .models: return "Models"
        case .provide: return "Provide"
        case .use: return "Use"
        case .fleet: return "Fleet"
        case .settings: return "Settings"
        }
    }

    var systemImage: String {
        switch self {
        case .home: return "house"
        case .wallet: return "wallet.pass"
        case .models: return "shippingbox"
        case .provide: return "bolt.horizontal.circle"
        case .use: return "terminal"
        case .fleet: return "server.rack"
        case .settings: return "gearshape"
        }
    }
}

struct RootView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        Group {
            if model.onboardingComplete {
                MainView()
            } else {
                OnboardingView()
                    .frame(minWidth: 720, minHeight: 560)
            }
        }
        .alert(
            model.alert?.title ?? "",
            isPresented: Binding(get: { model.alert != nil }, set: { if !$0 { model.alert = nil } }),
            presenting: model.alert
        ) { _ in
            Button("OK", role: .cancel) {}
        } message: { alert in
            Text(alert.message)
        }
        .overlay(alignment: .bottom) {
            if let notice = model.notice {
                Text(notice)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .background(.regularMaterial, in: Capsule())
                    .padding(.bottom, 20)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(.default, value: model.notice)
    }
}

struct MainView: View {
    @EnvironmentObject private var model: AppModel
    @SceneStorage("sidebarSelection") private var selection: SidebarItem = .home

    var body: some View {
        NavigationSplitView {
            List(selection: Binding<SidebarItem?>(get: { selection }, set: { selection = $0 ?? .home })) {
                Section {
                    ForEach([SidebarItem.home, .wallet]) { item in
                        Label(item.title, systemImage: item.systemImage).tag(item)
                    }
                }
                Section("Earn") {
                    ForEach([SidebarItem.models, .provide, .fleet]) { item in
                        Label(item.title, systemImage: item.systemImage).tag(item)
                    }
                }
                Section("Spend") {
                    Label(SidebarItem.use.title, systemImage: SidebarItem.use.systemImage).tag(SidebarItem.use)
                }
                Section {
                    Label(SidebarItem.settings.title, systemImage: SidebarItem.settings.systemImage).tag(SidebarItem.settings)
                }
            }
            .navigationSplitViewColumnWidth(min: 180, ideal: 200)
            .safeAreaInset(edge: .bottom) {
                SidebarFooter()
            }
        } detail: {
            VStack(spacing: 0) {
                ConnectionBanner()
                detail
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .frame(minWidth: 860, minHeight: 560)
    }

    @ViewBuilder
    private var detail: some View {
        switch selection {
        case .home: HomeView(selection: $selection)
        case .wallet: WalletView()
        case .models: ModelsView()
        case .provide: ProvideView()
        case .use: UseView()
        case .fleet: FleetView()
        case .settings: SettingsView()
        }
    }
}

/// Balance and network at the bottom of the sidebar.
private struct SidebarFooter: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Divider()
            if let usdc = model.wallet?.balances?.operatorBalance?.usdc {
                Text(model.money.string(usdc))
                    .font(.headline)
                    .monospacedDigit()
            }
            if model.isTestNetwork {
                Badge(text: "Test network", color: .orange)
            }
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Explains, in plain words, when the background service isn't ready.
struct ConnectionBanner: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        if let message {
            HStack(spacing: 10) {
                if model.connection == .starting {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange)
                }
                Text(message)
                    .font(.callout)
                Spacer()
                if case .failed = model.connection {
                    Button("Try again") { Task { await model.restartAgent() } }
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            .background(.orange.opacity(0.12))
        }
    }

    private var message: String? {
        switch model.connection {
        case .running:
            if let agent = model.agent, !agent.controlReachable {
                return "Can't reach the network right now. Your balance and settings are safe; we'll keep trying."
            }
            return nil
        case .starting:
            return "Starting…"
        case .stopped:
            return nil
        case .restarting(_, let delay):
            return "The background service stopped unexpectedly. Restarting in \(delay)s."
        case .missingExecutable:
            return "This build doesn't include the background service (keeta-compute-agent). See the README to bundle it."
        case .failed(let reason):
            return reason
        }
    }
}
