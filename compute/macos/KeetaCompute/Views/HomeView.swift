import KeetaComputeKit
import SwiftUI

struct HomeView: View {
    @EnvironmentObject var model: AppModel
    @Binding var selection: SidebarItem

    init(selection: Binding<SidebarItem>) {
        self._selection = selection
    }

    var body: some View {
        Screen("Home") {
            balanceCard
            provideCard
            activeJobsCard
            useCard
        }
        .task { await model.refreshWallet() }
    }

    // MARK: Balance

    private var balanceCard: some View {
        Card {
            HStack(alignment: .top, spacing: 24) {
                Stat(
                    title: "Credits",
                    value: model.creditBalance.map { model.money.string($0) } ?? "—",
                    detail: model.wallet?.error ?? (model.hasOperator ? nil : "Set up your wallet to see your balance.")
                )
                Stat(
                    title: "Earned today",
                    value: model.provider.map { model.money.string($0.earnedToday) } ?? "—",
                    detail: model.provider.map { "\(Abbreviate.tokens($0.tokensServedToday)) tokens served" }
                )
                Stat(
                    title: "Earned in total",
                    value: model.provider.map { model.money.string($0.earnedTotal) } ?? "—"
                )
            }
            HStack {
                Button("Open wallet") { selection = .wallet }
                if model.isTestNetwork {
                    Text("Test network: balances here aren't real money.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    // MARK: Provide

    private var provideCard: some View {
        Card {
            HStack(alignment: .center, spacing: 16) {
                Image(systemName: model.provider?.state.symbol ?? "bolt.circle")
                    .font(.system(size: 34))
                    .foregroundStyle(model.provider?.state.color ?? .secondary)
                VStack(alignment: .leading, spacing: 4) {
                    Text("Share this Mac")
                        .font(.title2.weight(.semibold))
                    Text(stateText)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer()
                Toggle("Share this Mac", isOn: providingBinding)
                    .toggleStyle(.switch)
                    .controlSize(.large)
                    .labelsHidden()
                    .disabled(model.provider == nil || model.provider?.state == .notEligible)
            }
            if let provider = model.provider, provider.state == .noOffers {
                Button("Choose models to offer") { selection = .models }
            }
        }
    }

    private var stateText: String {
        guard let provider = model.provider else {
            return model.connection.isRunning ? "Loading…" : "Waiting for the background service."
        }
        let title = provider.state.title
        if provider.state == .online, provider.activeJobs > 0 {
            return "\(title) · serving \(provider.activeJobs) request\(provider.activeJobs == 1 ? "" : "s") now. \(provider.state.explanation)"
        }
        return "\(title). \(provider.state.explanation)"
    }

    private var providingBinding: Binding<Bool> {
        Binding(
            get: { model.provider?.policy.enabled ?? false },
            set: { enabled in Task { await model.setProviderPolicy(ProviderPolicyUpdate(enabled: enabled)) } }
        )
    }

    // MARK: Jobs

    private var activeJobsCard: some View {
        Card("Active requests", systemImage: "waveform.path.ecg") {
            let jobs = model.runningJobs
            if jobs.isEmpty {
                EmptyNote(title: "Nothing running", systemImage: "moon.zzz", message: "Requests your Mac serves, and requests your tools send, show up here while they run.")
            } else {
                ForEach(jobs) { job in
                    JobRow(job: job, money: model.money)
                    if job.id != jobs.last?.id { Divider() }
                }
            }
        }
    }

    // MARK: Use

    private var useCard: some View {
        Card("Use from your agents", systemImage: "terminal") {
            Text("Point any OpenAI-compatible tool at this address. Requests run on other Macs and are paid from your agent budget.")
                .foregroundStyle(.secondary)
            if let error = model.buyer?.error {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(.red)
            }
            CopyField(value: model.localEndpoint)
            Button("Set up tools and limits") { selection = .use }
        }
    }
}
