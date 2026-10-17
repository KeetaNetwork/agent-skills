import KeetaComputeKit
import SwiftUI

struct UseView: View {
    enum Snippet: String, CaseIterable, Identifiable {
        case curl, python, environment
        var id: String { rawValue }
        var title: String {
            switch self {
            case .curl: return "curl"
            case .python: return "Python"
            case .environment: return "Environment"
            }
        }
    }

    @EnvironmentObject var model: AppModel
    @State var revealToken = false
    @State var snippet: Snippet = .curl
    @State var confirmingRotate = false
    @State var draft: BuyerPolicy?
    @State var editingLimits = false

    private var buyer: BuyerStatus? { model.buyer }
    private var hasChanges: Bool { draft != nil && draft != buyer?.policy }

    var body: some View {
        Screen("Use", subtitle: "Run models on other Macs from your own tools and agents. Requests are paid from your agent budget.") {
            endpointCard
            snippetsCard
            limitsCard
            networkModelsCard
            recentCard
        }
        .task { await model.refreshNetworkModels() }
        .onAppear { draft = buyer?.policy }
        .onChange(of: buyer?.policy) { oldValue, newValue in
            if draft == nil || draft == oldValue { draft = newValue }
        }
        .panel(isPresented: $editingLimits) {
            limitsPanel
        }
        .confirmationDialog("Create a new API token?", isPresented: $confirmingRotate) {
            Button("Create new token", role: .destructive) { Task { await model.rotateToken() } }
        } message: {
            Text("The current token stops working right away. Tools using it need the new one.")
        }
    }

    // MARK: Endpoint

    private var token: String { buyer?.token ?? "" }
    private var maskedToken: String {
        guard !token.isEmpty else { return "—" }
        return revealToken ? token : String(repeating: "•", count: min(24, token.count))
    }

    private var endpointCard: some View {
        Card("Local endpoint", systemImage: "network") {
            if let error = buyer?.error {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(.red)
            } else {
                Text("OpenAI-compatible. Only apps on this Mac can reach it.")
                    .foregroundStyle(.secondary)
            }
            VStack(alignment: .leading, spacing: 4) {
                Text("Base URL")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                CopyField(value: model.localEndpoint)
            }
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text("API token")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer()
                    Button {
                        revealToken.toggle()
                    } label: {
                        Image(systemName: revealToken ? "eye.slash" : "eye")
                    }
                    .buttonStyle(.borderless)
                    .help(revealToken ? "Hide token" : "Show token")
                    Button("Rotate…") { confirmingRotate = true }
                        .buttonStyle(.borderless)
                        .disabled(buyer == nil)
                }
                .foregroundStyle(Color.keetaRed)
                CopyField(value: token, display: maskedToken)
            }
        }
    }

    // MARK: Snippets

    private var exampleModel: String {
        model.networkModels.first?.id ?? model.catalog.first(where: { $0.installed != nil })?.id ?? "qwen3-8b"
    }

    private func snippetText(token: String) -> String {
        let base = model.localEndpoint
        switch snippet {
        case .curl:
            return """
            curl \(base)/chat/completions \\
              -H "Authorization: Bearer \(token)" \\
              -H "Content-Type: application/json" \\
              -d '{"model": "\(exampleModel)", "messages": [{"role": "user", "content": "Hello"}]}'
            """
        case .python:
            return """
            from openai import OpenAI

            client = OpenAI(base_url="\(base)", api_key="\(token)")
            reply = client.chat.completions.create(
                model="\(exampleModel)",
                messages=[{"role": "user", "content": "Hello"}],
            )
            print(reply.choices[0].message.content)
            """
        case .environment:
            return """
            export OPENAI_BASE_URL=\(base)
            export OPENAI_API_KEY=\(token)
            """
        }
    }

    private var snippetsCard: some View {
        Card("Connect a tool", systemImage: "chevron.left.forwardslash.chevron.right") {
            Picker("Snippet", selection: $snippet) {
                ForEach(Snippet.allCases) { Text($0.title).tag($0) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            CodeBlock(
                code: snippetText(token: revealToken ? token : "YOUR_TOKEN"),
                copyValue: snippetText(token: token.isEmpty ? "YOUR_TOKEN" : token)
            )
            Text("The copy button includes your real token. Most tools that work with an OpenAI base URL work here.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    // MARK: Limits

    private var limitsCard: some View {
        Card("Spending limits", systemImage: "hand.raised") {
            if let policy = buyer?.policy {
                VStack(alignment: .leading, spacing: 6) {
                    limitRow("Per request", model.money.string(policy.perRequestMax))
                    limitRow("Per day", model.money.string(policy.dailyMax))
                    limitRow("Highest price", "\(model.money.number(policy.maxPrice.inputPerMillion)) in · \(model.money.number(policy.maxPrice.outputPerMillion)) out per 1M")
                    limitRow("Models", policy.allowedModels.isEmpty ? "Any" : policy.allowedModels.joined(separator: ", "))
                    limitRow("Providers", policy.allowedProviders.isEmpty ? "Any" : "\(policy.allowedProviders.count) listed")
                }
                if let spent = buyer?.spentToday {
                    Text("Spent today: \(model.money.string(spent)). Days reset at midnight UTC.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Button("Change limits…") {
                    draft = buyer?.policy
                    editingLimits = true
                }
                .buttonStyle(.keetaSecondary)
            } else {
                ProgressView().frame(maxWidth: .infinity)
            }
        }
    }

    private func limitRow(_ title: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title)
                .foregroundStyle(.secondary)
                .frame(width: 96, alignment: .leading)
            Text(value)
                .lineLimit(2)
        }
        .font(.callout)
    }

    private var limitsPanel: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Spending limits")
                .font(.title2.weight(.semibold))
                .padding([.horizontal, .top], 16)
            if draft != nil {
                Form {
                    Section {
                        LabeledContent("Most per request") {
                            AmountField("Per request", baseUnits: policyBinding(\.perRequestMax), formatter: model.money)
                        }
                        LabeledContent("Most per day") {
                            AmountField("Per day", baseUnits: policyBinding(\.dailyMax), formatter: model.money)
                        }
                        if let spent = buyer?.spentToday {
                            Text("Spent today: \(model.money.string(spent)). Days reset at midnight UTC.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    Section("Highest price to accept, per million tokens") {
                        LabeledContent("Input") {
                            AmountField("Input", baseUnits: policyBinding(\.maxPrice.inputPerMillion), formatter: model.money)
                        }
                        LabeledContent("Output") {
                            AmountField("Output", baseUnits: policyBinding(\.maxPrice.outputPerMillion), formatter: model.money)
                        }
                    }
                    Section {
                        StringListEditor(values: policyBinding(\.allowedModels), placeholder: "Model id", suggestions: model.networkModels.map(\.id))
                    } header: {
                        Text("Allowed models")
                    } footer: {
                        Text("Leave empty to allow any model.").font(.caption).foregroundStyle(.secondary)
                    }
                    Section {
                        AddressListEditor(addresses: policyBinding(\.allowedProviders), emptyText: "Any provider.")
                    } header: {
                        Text("Allowed providers")
                    } footer: {
                        Text("Leave empty to use any provider, or list provider addresses to use only those.").font(.caption).foregroundStyle(.secondary)
                    }
                }
                .formStyle(.grouped)
                .scrollContentBackground(.hidden)
            }
            HStack {
                Button("Cancel", role: .cancel) {
                    draft = buyer?.policy
                    editingLimits = false
                }
                .keyboardShortcut(.cancelAction)
                Spacer()
                Button("Save") { saveLimits() }
                    .buttonStyle(.keetaPrimary)
                    .keyboardShortcut(.defaultAction)
                    .disabled(!hasChanges)
            }
            .padding([.horizontal, .bottom], 16)
        }
    }

    private func policyBinding<T>(_ keyPath: WritableKeyPath<BuyerPolicy, T>) -> Binding<T> {
        Binding(
            get: { (draft ?? buyer?.policy ?? Self.fallbackPolicy)[keyPath: keyPath] },
            set: { draft?[keyPath: keyPath] = $0 }
        )
    }

    /// Only read if the policy disappears while the editor is on screen.
    static let fallbackPolicy = BuyerPolicy(perRequestMax: "0", dailyMax: "0", allowedModels: [], allowedProviders: [], maxPrice: Price(inputPerMillion: "0", outputPerMillion: "0"))

    private func saveLimits() {
        guard let draft else { return }
        Task {
            await model.setBuyerPolicy(BuyerPolicyUpdate(
                perRequestMax: draft.perRequestMax,
                dailyMax: draft.dailyMax,
                allowedModels: draft.allowedModels,
                allowedProviders: draft.allowedProviders,
                maxPrice: draft.maxPrice
            ))
            self.draft = model.buyer?.policy
            editingLimits = false
        }
    }

    // MARK: Network models

    private var networkModelsCard: some View {
        Card("Models on the network", systemImage: "globe") {
            if model.networkModels.isEmpty {
                EmptyNote(title: "No models available right now", systemImage: "globe", message: model.connection.isRunning ? "When providers come online, their models and prices show up here." : nil)
            } else {
                ForEach(model.networkModels) { item in
                    HStack(alignment: .top) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(item.name)
                            Text(item.id)
                                .font(.system(.caption, design: .monospaced))
                                .foregroundStyle(.secondary)
                                .textSelection(.enabled)
                        }
                        Spacer(minLength: 8)
                        VStack(alignment: .trailing, spacing: 2) {
                            Text("\(model.money.number(item.lowestPrice.inputPerMillion)) / \(model.money.number(item.lowestPrice.outputPerMillion))")
                                .monospacedDigit()
                            Text("\(item.providers) provider\(item.providers == 1 ? "" : "s") · \(Abbreviate.tokens(item.contextLength)) context")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    if item.id != model.networkModels.last?.id { Divider() }
                }
                Text("Lowest price in \(model.money.symbol), input / output per million tokens.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Button("Refresh") { Task { await model.refreshNetworkModels() } }
                .buttonStyle(.keetaSecondary)
        }
    }

    // MARK: Recent

    private var recentCard: some View {
        Card("Recent requests", systemImage: "clock.arrow.circlepath") {
            Text("Each request sets aside its most possible cost in credits from the agent budget before it runs. When it finishes, the provider is paid what it billed and the rest comes straight back.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Divider()
            let jobs = buyer?.recentJobs ?? []
            if jobs.isEmpty {
                EmptyNote(title: "No requests yet", systemImage: "tray", message: "Requests your tools send through the local endpoint, and what each one cost, show up here.")
            } else {
                ForEach(jobs) { job in
                    JobRow(job: job, money: model.money)
                    if job.id != jobs.last?.id { Divider() }
                }
            }
        }
    }
}
