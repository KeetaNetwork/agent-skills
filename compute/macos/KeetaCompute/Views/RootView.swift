import AppKit
import KeetaComputeKit
import SwiftUI

/// Popover size. The app lives in the menu bar, like Keeta Agent, with no main window.
enum PopoverMetrics {
    static let width: CGFloat = 400
    static let height: CGFloat = 600
}

/// The screens reachable from Home.
enum Page: String, CaseIterable, Identifiable, Hashable {
    case wallet, models, provide, use, fleet, settings

    var id: String { rawValue }

    var title: String {
        switch self {
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
        case .wallet: return "wallet.pass"
        case .models: return "shippingbox"
        case .provide: return "bolt.horizontal.circle"
        case .use: return "terminal"
        case .fleet: return "server.rack"
        case .settings: return "gearshape"
        }
    }
}

/// Moves the popover to another screen.
struct OpenPageAction {
    var action: (Page) -> Void = { _ in }

    func callAsFunction(_ page: Page) {
        action(page)
    }
}

private struct OpenPageKey: EnvironmentKey {
    static let defaultValue = OpenPageAction()
}

extension EnvironmentValues {
    var openPage: OpenPageAction {
        get { self[OpenPageKey.self] }
        set { self[OpenPageKey.self] = newValue }
    }
}

/// Everything in the menu bar popover: a header, the current screen, and "Powered by Keeta".
struct RootView: View {
    @EnvironmentObject private var model: AppModel
    @State private var page: Page?

    init(page: Page? = nil) {
        self._page = State(initialValue: page)
    }

    var body: some View {
        VStack(spacing: 0) {
            PopoverHeader(page: model.onboardingComplete ? page : nil) { page = nil }
            ConnectionBanner()
            Group {
                if !model.onboardingComplete {
                    OnboardingView()
                } else if let page {
                    screen(for: page)
                } else {
                    HomeView()
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            PopoverFooter()
        }
        .frame(width: PopoverMetrics.width, height: PopoverMetrics.height)
        .background(Color.keetaGray)
        .foregroundStyle(Color.keetaYellow)
        .environment(\.colorScheme, .dark)
        .environment(\.openPage, OpenPageAction { page = $0 })
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
                    .font(.callout)
                    .foregroundStyle(Color.keetaBlack)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .background(Color.keetaYellow, in: Capsule())
                    .padding(.horizontal, 16)
                    .padding(.bottom, 56)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(.default, value: model.notice)
    }

    @ViewBuilder
    private func screen(for page: Page) -> some View {
        switch page {
        case .wallet: WalletView()
        case .models: ModelsView()
        case .provide: ProvideView()
        case .use: UseView()
        case .fleet: FleetView()
        case .settings: SettingsView()
        }
    }
}

/// Title in Keeta cream, as in Keeta Agent, with a back button on inner screens.
private struct PopoverHeader: View {
    @EnvironmentObject private var model: AppModel
    let page: Page?
    let back: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            if let page {
                Button(action: back) {
                    Image(systemName: "chevron.left")
                        .font(.title3.weight(.semibold))
                        .frame(width: 24, height: 28)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(Color.keetaRed)
                .help("Back")
                Text(page.title)
                    .font(.title.weight(.medium))
            } else {
                Text("Keeta Compute")
                    .font(.title.weight(.medium))
            }
            Spacer()
            if model.isTestNetwork {
                Badge(text: "Test network", color: .orange)
            }
        }
        .foregroundStyle(Color.keetaYellow)
        .padding(.horizontal, 16)
        .padding(.top, 16)
        .padding(.bottom, 10)
    }
}

private struct PopoverFooter: View {
    var body: some View {
        HStack {
            PoweredByKeeta()
            Spacer()
            Button {
                NSApp.terminate(nil)
            } label: {
                Image(systemName: "power")
                    .font(.body.weight(.medium))
            }
            .buttonStyle(.borderless)
            .foregroundStyle(Color.keetaGray40)
            .keyboardShortcut("q")
            .help("Quit Keeta Compute")
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .overlay(alignment: .top) {
            Rectangle().fill(Color.keetaGray50.opacity(0.5)).frame(height: 1)
        }
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
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                if case .failed = model.connection {
                    Button("Try again") { Task { await model.restartAgent() } }
                        .buttonStyle(.keetaCompact)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            .background(.orange.opacity(0.14))
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
