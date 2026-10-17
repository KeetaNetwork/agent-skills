import KeetaComputeKit
import SwiftUI

struct HomeView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.openPage) var openPage

    var body: some View {
        Screen("Home") {
            balanceCard
            provideCard
            if !model.runningJobs.isEmpty {
                activeJobsCard
            }
            menuCard
        }
        .task { await model.refreshWallet() }
    }

    // MARK: Balance

    private var balanceCard: some View {
        Card {
            Stat(
                title: "Credits",
                value: model.creditBalance.map { model.money.string($0) } ?? "—",
                detail: model.wallet?.error ?? (model.hasOperator ? nil : "Set up your wallet to see your balance."),
                size: 30
            )
            HStack(alignment: .top, spacing: 16) {
                Stat(
                    title: "Earned today",
                    value: model.provider.map { model.money.string($0.earnedToday) } ?? "—",
                    detail: model.provider.map { "\(Abbreviate.tokens($0.tokensServedToday)) tokens served" },
                    size: 18
                )
                Stat(
                    title: "Earned in total",
                    value: model.provider.map { model.money.string($0.earnedTotal) } ?? "—",
                    size: 18
                )
            }
            if model.isTestNetwork {
                Text("Test network: balances here aren't real money.")
                    .font(.caption)
                    .foregroundStyle(Color.keetaGray40)
            }
        }
    }

    // MARK: Provide

    private var provideCard: some View {
        Card {
            HStack(alignment: .center, spacing: 12) {
                Image(systemName: model.provider?.state.symbol ?? "bolt.circle")
                    .font(.system(size: 26))
                    .foregroundStyle(model.provider?.state.color ?? .secondary)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Share this Mac")
                        .font(.headline)
                    Text(stateText)
                        .font(.callout)
                        .foregroundStyle(Color.keetaGray40)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 8)
                Toggle("Share this Mac", isOn: providingBinding)
                    .toggleStyle(.switch)
                    .labelsHidden()
                    .disabled(model.provider == nil || model.provider?.state == .notEligible)
            }
            if let provider = model.provider, provider.state == .noOffers {
                Button("Choose models to offer") { openPage(.models) }
                    .buttonStyle(.keetaPrimary)
            }
        }
    }

    private var stateText: String {
        guard let provider = model.provider else {
            return model.connection.isRunning ? "Loading…" : "Waiting for the background service."
        }
        if provider.state == .online, provider.activeJobs > 0 {
            return "\(provider.state.title) · serving \(provider.activeJobs) request\(provider.activeJobs == 1 ? "" : "s") now"
        }
        return "\(provider.state.title). \(provider.state.explanation)"
    }

    private var providingBinding: Binding<Bool> {
        Binding(
            get: { model.provider?.policy.enabled ?? false },
            set: { enabled in Task { await model.setProviderPolicy(ProviderPolicyUpdate(enabled: enabled)) } }
        )
    }

    // MARK: Jobs

    private var activeJobsCard: some View {
        Card("Running now", systemImage: "waveform.path.ecg") {
            let jobs = model.runningJobs
            ForEach(jobs) { job in
                JobRow(job: job, money: model.money)
                if job.id != jobs.last?.id { Divider() }
            }
        }
    }

    // MARK: Screens

    private var menuCard: some View {
        Card {
            VStack(spacing: 2) {
                ForEach(Page.allCases) { page in
                    NavRow(
                        title: page.title,
                        systemImage: page.systemImage,
                        detail: detail(for: page),
                        detailColor: page == .use && model.buyer?.error != nil ? Color.red : Color.keetaGray40
                    ) {
                        openPage(page)
                    }
                    if page != Page.allCases.last { Divider() }
                }
            }
        }
    }

    private func detail(for page: Page) -> String {
        switch page {
        case .wallet:
            if !model.hasOperator { return "Set up your wallet" }
            if let budget = model.wallet?.balances?.spend.credits {
                return "Buy credits, cash out · \(model.money.string(budget)) agent budget"
            }
            return "Buy credits, cash out, agent budget"
        case .models:
            let installed = model.catalog.filter { $0.installed != nil }
            let offered = installed.filter { $0.installed?.offer.offered == true }
            if installed.isEmpty { return "Install models to offer" }
            return "\(installed.count) installed · \(offered.count) offered"
        case .provide:
            return model.provider.map { "\($0.state.title) · schedule, capacity, access" } ?? "Schedule, capacity, access"
        case .use:
            if let error = model.buyer?.error { return error }
            return "Local endpoint for your tools · spending limits"
        case .fleet:
            if model.fleet.isEmpty { return "Add Linux machines as extra capacity" }
            let online = model.fleet.filter { $0.status == .online }.count
            return "\(model.fleet.count) Linux helper\(model.fleet.count == 1 ? "" : "s") · \(online) online"
        case .settings:
            return model.isTestNetwork ? "Test network · identity · logs" : "Main network · identity · logs"
        }
    }
}
