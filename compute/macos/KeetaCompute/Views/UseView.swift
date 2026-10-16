import KeetaComputeKit
import SwiftUI

struct UseView: View {
    enum Snippet: String, CaseIterable, Identifiable {
        case curl, python, environment
        var id: String { rawValue }
        var title: String {
            switch self {
            case .curl: return "curl"
            case .python: return "Python (OpenAI SDK)"
            case .environment: return "Environment variables"
            }
        }
    }

    @EnvironmentObject var model: AppModel
    @State var revealToken = false
    @State var snippet: Snippet = .curl
    @State var confirmingRotate = false
    @State var draft: BuyerPolicy?

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
            Text("OpenAI-compatible. Only apps on this Mac can reach it.")
                .foregroundStyle(.secondary)
            LabeledContent("Base URL") {
                CopyField(value: model.localEndpoint)
            }
            LabeledContent("API token") {
                HStack {
                    CopyField(value: token, display: maskedToken)
                    Button {
                        revealToken.toggle()
                    } label: {
                        Image(systemName: revealToken ? "eye.slash" : "eye")
                    }
                    .help(revealToken ? "Hide token" : "Show token")
                    Button("Rotate…") { confirmingRotate = true }
                        .disabled(buyer == nil)
                }
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
                .scrollDisabled(true)
                .frame(minHeight: 520)
                HStack {
                    Spacer()
                    Button("Revert") { draft = buyer?.policy }
                        .disabled(!hasChanges)
                    Button("Save") { saveLimits() }
                        .buttonStyle(.borderedProminent)
                        .disabled(!hasChanges)
                }
            } else {
                ProgressView().frame(maxWidth: .infinity)
            }
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
        }
    }

    // MARK: Network models

    private var networkModelsCard: some View {
        Card("Models on the network", systemImage: "globe") {
            if model.networkModels.isEmpty {
                EmptyNote(title: "No models available right now", systemImage: "globe", message: model.connection.isRunning ? "When providers come online, their models and prices show up here." : nil)
            } else {
                Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 8) {
                    GridRow {
                        Text("Model")
                        Text("Lowest price (in / out per 1M)")
                        Text("Providers")
                        Text("Context")
                    }
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    Divider()
                    ForEach(model.networkModels) { item in
                        GridRow {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(item.name)
                                Text(item.id)
                                    .font(.system(.caption, design: .monospaced))
                                    .foregroundStyle(.secondary)
                                    .textSelection(.enabled)
                            }
                            Text("\(model.money.number(item.lowestPrice.inputPerMillion)) / \(model.money.number(item.lowestPrice.outputPerMillion)) \(model.money.symbol)")
                                .monospacedDigit()
                            Text("\(item.providers)")
                                .monospacedDigit()
                            Text(Abbreviate.tokens(item.contextLength))
                                .monospacedDigit()
                        }
                    }
                }
            }
            Button("Refresh") { Task { await model.refreshNetworkModels() } }
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
