import KeetaComputeKit
import SwiftUI

struct ProvideView: View {
    @EnvironmentObject var model: AppModel
    @State var draft: ProviderPolicy?
    @State var saving = false
    @State var editing = false

    private var policy: ProviderPolicy? { model.provider?.policy }
    private var hasChanges: Bool { draft != nil && draft != policy }

    var body: some View {
        Screen("Provide", subtitle: "Share this Mac's spare AI capacity and get paid per request.") {
            statusCard
            if let policy {
                policySummaryCard(policy)
            } else {
                Card { ProgressView("Loading settings…").frame(maxWidth: .infinity) }
            }
            recentCard
        }
        .panel(isPresented: $editing) {
            policyPanel
        }
        .onAppear { resetDraft() }
        .onChange(of: policy) { oldValue, _ in
            // Follow agent updates unless the user has unsaved edits.
            if draft == nil || draft == oldValue { resetDraft() }
        }
    }

    private func resetDraft() {
        draft = policy
    }

    // MARK: Status

    private var statusCard: some View {
        Card {
            if let provider = model.provider {
                HStack(spacing: 12) {
                    Image(systemName: provider.state.symbol)
                        .font(.system(size: 26))
                        .foregroundStyle(provider.state.color)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(provider.state.title).font(.headline)
                        Text(provider.state.explanation)
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: 8)
                    Toggle("Share this Mac", isOn: Binding(
                        get: { provider.policy.enabled },
                        set: { enabled in Task { await model.setProviderPolicy(ProviderPolicyUpdate(enabled: enabled)) } }
                    ))
                    .toggleStyle(.switch)
                    .labelsHidden()
                    .disabled(provider.state == .notEligible)
                }
                Divider()
                Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 12) {
                    GridRow {
                        Stat(title: "Serving now", value: "\(provider.activeJobs)", size: 18)
                        Stat(title: "Tokens today", value: Abbreviate.tokens(provider.tokensServedToday), size: 18)
                    }
                    GridRow {
                        Stat(title: "Earned today", value: model.money.string(provider.earnedToday), size: 18)
                        Stat(title: "Earned in total", value: model.money.string(provider.earnedTotal), size: 18)
                    }
                }
            } else {
                EmptyNote(title: "Not connected", systemImage: "bolt.slash", message: "Sharing status appears once the background service is running.")
            }
        }
    }

    // MARK: Policy

    private func policySummaryCard(_ policy: ProviderPolicy) -> some View {
        Card("When and how to share", systemImage: "slider.horizontal.3") {
            VStack(alignment: .leading, spacing: 6) {
                summaryRow("Schedule", Self.scheduleSummary(policy))
                summaryRow("Capacity", "Up to \(policy.maxConcurrentJobs) request\(policy.maxConcurrentJobs == 1 ? "" : "s") at once")
                summaryRow("Access", policy.access.mode == .public ? "Anyone on the network" : "\(policy.access.allow.count) listed buyer\(policy.access.allow.count == 1 ? "" : "s")")
            }
            Button("Change…") {
                resetDraft()
                editing = true
            }
            .buttonStyle(.keetaSecondary)
        }
    }

    private func summaryRow(_ title: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title)
                .foregroundStyle(.secondary)
                .frame(width: 76, alignment: .leading)
            Text(value)
                .fixedSize(horizontal: false, vertical: true)
        }
        .font(.callout)
    }

    static func scheduleSummary(_ policy: ProviderPolicy) -> String {
        var text: String
        switch policy.schedule.mode {
        case .always:
            text = "Always"
        case .idle:
            text = "After \(policy.schedule.idleMinutes ?? 10) idle minutes"
        case .hours:
            text = "\(hourLabel(policy.schedule.startHour ?? 22)) to \(hourLabel(policy.schedule.endHour ?? 7))"
        }
        if policy.pauseOnBattery {
            text += ", not on battery"
        }
        return text
    }

    private var policyPanel: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("When and how to share")
                .font(.title2.weight(.semibold))
                .padding([.horizontal, .top], 16)
            Form {
                Section("Schedule") {
                    Picker("Share", selection: binding(\.schedule.mode)) {
                        Text("Always").tag(ScheduleMode.always)
                        Text("When this Mac is idle").tag(ScheduleMode.idle)
                        Text("During set hours").tag(ScheduleMode.hours)
                    }
                    switch draft?.schedule.mode {
                    case .idle:
                        Stepper(value: binding(\.schedule.idleMinutes, default: 10), in: 1...240, step: 1) {
                            Text("After \(draft?.schedule.idleMinutes ?? 10) idle minutes")
                        }
                    case .hours:
                        Picker("From", selection: binding(\.schedule.startHour, default: 22)) {
                            ForEach(0..<24, id: \.self) { hour in Text(Self.hourLabel(hour)).tag(hour) }
                        }
                        Picker("Until", selection: binding(\.schedule.endHour, default: 7)) {
                            ForEach(0..<24, id: \.self) { hour in Text(Self.hourLabel(hour)).tag(hour) }
                        }
                    default:
                        EmptyView()
                    }
                    Toggle("Pause when running on battery", isOn: binding(\.pauseOnBattery))
                }
                Section("Capacity") {
                    Stepper(value: binding(\.maxConcurrentJobs), in: 1...16) {
                        Text("Serve up to \(draft?.maxConcurrentJobs ?? 1) request\((draft?.maxConcurrentJobs ?? 1) == 1 ? "" : "s") at once")
                    }
                }
                Section {
                    Picker("Who can use this Mac", selection: binding(\.access.mode)) {
                        Text("Anyone on the network").tag(AccessMode.public)
                        Text("Only buyers I list").tag(AccessMode.allowlist)
                    }
                    .pickerStyle(.radioGroup)
                    if draft?.access.mode == .allowlist {
                        AddressListEditor(addresses: binding(\.access.allow), emptyText: "Add the addresses of buyers who may use this Mac, such as your own other machines or your company.")
                    }
                } header: {
                    Text("Access")
                } footer: {
                    Text("Each model can override this in its settings under Models.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .formStyle(.grouped)
            .scrollContentBackground(.hidden)
            HStack {
                Button("Cancel", role: .cancel) {
                    resetDraft()
                    editing = false
                }
                .keyboardShortcut(.cancelAction)
                Spacer()
                if saving { ProgressView().controlSize(.small) }
                Button("Save") { save() }
                    .buttonStyle(.keetaPrimary)
                    .keyboardShortcut(.defaultAction)
                    .disabled(!hasChanges || saving || (draft?.access.mode == .allowlist && (draft?.access.allow.isEmpty ?? true)))
            }
            .padding([.horizontal, .bottom], 16)
        }
    }

    private func save() {
        guard let draft else { return }
        saving = true
        Task {
            defer { saving = false }
            await model.setProviderPolicy(ProviderPolicyUpdate(
                enabled: draft.enabled,
                schedule: draft.schedule,
                pauseOnBattery: draft.pauseOnBattery,
                maxConcurrentJobs: draft.maxConcurrentJobs,
                access: draft.access
            ))
            resetDraft()
            editing = false
        }
    }

    private func binding<T>(_ keyPath: WritableKeyPath<ProviderPolicy, T>) -> Binding<T> where T: Equatable {
        Binding(
            get: { (draft ?? policy ?? Self.fallbackPolicy)[keyPath: keyPath] },
            set: { draft?[keyPath: keyPath] = $0 }
        )
    }

    private func binding(_ keyPath: WritableKeyPath<ProviderPolicy, Int?>, default value: Int) -> Binding<Int> {
        Binding(
            get: { draft?[keyPath: keyPath] ?? value },
            set: { draft?[keyPath: keyPath] = $0 }
        )
    }

    /// Only read if the policy disappears while the editor is on screen.
    static let fallbackPolicy = ProviderPolicy(enabled: false, schedule: ProviderSchedule(mode: .always), pauseOnBattery: true, maxConcurrentJobs: 1, access: .publicAccess)

    static func hourLabel(_ hour: Int) -> String {
        var components = DateComponents()
        components.hour = hour
        components.minute = 0
        let date = Calendar.current.date(from: components) ?? Date()
        return date.formatted(date: .omitted, time: .shortened)
    }

    // MARK: Recent

    private var recentCard: some View {
        Card("Recent requests served", systemImage: "list.bullet.rectangle") {
            let jobs = model.provider?.recentJobs ?? []
            if jobs.isEmpty {
                EmptyNote(title: "No requests yet", systemImage: "tray", message: "Once you offer a model and turn on sharing, the requests your Mac serves and what each one earned show up here.")
            } else {
                ForEach(jobs) { job in
                    JobRow(job: job, money: model.money)
                    if job.id != jobs.last?.id { Divider() }
                }
            }
        }
    }
}
