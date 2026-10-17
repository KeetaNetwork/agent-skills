import KeetaComputeKit
import SwiftUI

struct ModelsView: View {
    @EnvironmentObject var model: AppModel
    @State var offerSettingsFor: String?
    @State var licenseFor: String?
    @State var showingCustom = false

    private var installed: [CatalogEntry] {
        model.catalog.filter { $0.installed != nil || (model.installProgress[$0.id]?.isActive ?? false) }
    }

    private var available: [CatalogEntry] {
        model.catalog.filter { $0.installed == nil && !(model.installProgress[$0.id]?.isActive ?? false) && $0.compatibility.fits }
    }

    private var tooBig: [CatalogEntry] {
        model.catalog.filter { $0.installed == nil && !$0.compatibility.fits }
    }

    var body: some View {
        Screen("Models", subtitle: "Install models on this Mac and choose which ones to offer to the network.") {
            if model.provider?.state == .notEligible {
                Card {
                    Label("This Mac can't serve the network (it needs 32 GB of memory or more). You can still use models from other Macs under Use.", systemImage: "info.circle")
                        .foregroundStyle(.secondary)
                }
            }

            Card("On this Mac", systemImage: "internaldrive") {
                if installed.isEmpty {
                    EmptyNote(title: "No models installed", systemImage: "shippingbox", message: "Install a model below. Large downloads continue in the background.")
                } else {
                    ForEach(installed) { entry in
                        ModelRow(entry: entry, progress: model.installProgress[entry.id], onOffer: { offer in
                            setOffered(entry, offer)
                        }, onSettings: {
                            offerSettingsFor = entry.id
                        })
                        if entry.id != installed.last?.id { Divider() }
                    }
                }
            }

            Card("Available for this Mac", systemImage: "square.and.arrow.down") {
                if !model.catalogLoaded {
                    ProgressView().frame(maxWidth: .infinity)
                } else if available.isEmpty {
                    EmptyNote(title: "Nothing else fits", systemImage: "checkmark.circle", message: "Every catalog model that fits this Mac is already installed.")
                } else {
                    ForEach(available) { entry in
                        ModelRow(entry: entry, progress: model.installProgress[entry.id], onOffer: { _ in }, onSettings: {})
                        if entry.id != available.last?.id { Divider() }
                    }
                }
                Divider()
                Button {
                    showingCustom = true
                } label: {
                    Label("Add a custom model from Hugging Face…", systemImage: "plus")
                }
                .buttonStyle(.borderless)
                .foregroundStyle(Color.keetaRed)
            }

            if !tooBig.isEmpty {
                Card("Needs more than this Mac has", systemImage: "rectangle.stack") {
                    ForEach(tooBig) { entry in
                        ModelRow(entry: entry, progress: nil, onOffer: { _ in }, onSettings: {})
                        if entry.id != tooBig.last?.id { Divider() }
                    }
                }
            }
        }
        .task { await model.refreshCatalog() }
        .panel(item: Binding(get: { offerSettingsFor.map(IdentifiedString.init) }, set: { offerSettingsFor = $0?.id })) { item in
            OfferSettingsSheet(modelId: item.id)
        }
        .panel(item: Binding(get: { licenseFor.map(IdentifiedString.init) }, set: { licenseFor = $0?.id })) { item in
            LicenseSheet(modelId: item.id)
        }
        .panel(isPresented: $showingCustom) {
            CustomModelSheet()
        }
    }

    private func setOffered(_ entry: CatalogEntry, _ offered: Bool) {
        if offered && !model.acknowledgedLicenses.contains(entry.id) {
            licenseFor = entry.id
            return
        }
        Task { await model.setOffer(modelId: entry.id, offered: offered) }
    }
}

struct IdentifiedString: Identifiable {
    let id: String
}

// MARK: - Row

struct ModelRow: View {
    @EnvironmentObject var model: AppModel
    let entry: CatalogEntry
    let progress: InstallProgress?
    let onOffer: (Bool) -> Void
    let onSettings: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(entry.model.name)
                    .font(.body.weight(.semibold))
                if entry.installed?.custom == true {
                    Badge(text: "Custom")
                }
                if entry.installed?.offer.offered == true {
                    Badge(text: "Offered", color: .keetaGreen)
                }
                Spacer(minLength: 8)
                if entry.installed == nil {
                    actions
                }
            }
            Text(details)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if let installed = entry.installed, installed.offer.offered {
                Text(model.money.priceSummary(installed.offer.price))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if let progress {
                InstallProgressView(progress: progress)
            }
            if entry.installed != nil {
                actions
                    .padding(.top, 2)
            }
        }
        .padding(.vertical, 4)
    }

    private var details: String {
        var parts = [entry.model.parameters, entry.model.quantization, ByteFormat.string(entry.installed?.sizeBytes ?? entry.model.diskBytes)]
        parts.append(entry.model.license.name)
        if entry.installed == nil {
            parts.append(entry.compatibility.summary)
        }
        return parts.filter { !$0.isEmpty }.joined(separator: " · ")
    }

    @ViewBuilder
    private var actions: some View {
        if let progress, progress.isActive {
            Button("Cancel") { Task { await model.cancelInstall(entry.id) } }
                .buttonStyle(.keetaCompact)
        } else if let installed = entry.installed {
            HStack(spacing: 10) {
                Toggle("Offer to the network", isOn: Binding(get: { installed.offer.offered }, set: { onOffer($0) }))
                    .toggleStyle(.switch)
                    .controlSize(.small)
                    .disabled(model.provider?.state == .notEligible)
                Spacer()
                Button("Settings…", action: onSettings)
                    .buttonStyle(.keetaCompact)
            }
        } else if entry.compatibility.fits {
            Button(progress?.phase == .failed ? "Retry" : "Install") {
                Task { await model.install(entry.id) }
            }
            .buttonStyle(.keetaCompact)
            .disabled(!model.connection.isRunning)
        }
    }
}

struct InstallProgressView: View {
    let progress: InstallProgress

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            switch progress.phase {
            case .failed:
                Text("Install failed\(progress.message.map { ": \($0)" } ?? "")")
                    .font(.caption)
                    .foregroundStyle(.red)
            case .done:
                EmptyView()
            default:
                if let fraction = progress.fraction, progress.phase == .downloading {
                    ProgressView(value: fraction)
                } else {
                    ProgressView()
                        .progressViewStyle(.linear)
                }
                Text(label)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var label: String {
        switch progress.phase {
        case .queued: return "Waiting to start…"
        case .runtime: return progress.message ?? "Setting up the model runtime…"
        case .downloading:
            if progress.bytesTotal > 0 {
                return "Downloading \(ByteFormat.string(progress.bytesDone)) of \(ByteFormat.string(progress.bytesTotal))"
            }
            return "Downloading…"
        case .verifying: return "Checking the download…"
        case .done: return "Installed"
        case .failed: return "Failed"
        }
    }
}

// MARK: - License acknowledgment

struct LicenseSheet: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.closePanel) var dismiss
    let modelId: String
    @State var accepted = false

    init(modelId: String) {
        self.modelId = modelId
    }

    private var entry: CatalogEntry? { model.catalog.first { $0.id == modelId } }

    var body: some View {
        ScrollView {
            licenseBody
        }
    }

    private var licenseBody: some View {
        VStack(alignment: .leading, spacing: 16) {
            if let entry {
                let license = entry.model.license
                Text("Before you offer \(entry.model.name)")
                    .font(.title2.weight(.semibold))
                Text("When you serve a model to others, you take on its license terms as the operator.")
                    .foregroundStyle(.secondary)
                Card {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Text(license.name).font(.headline)
                            Spacer()
                            if let url = URL(string: license.url) {
                                Link("Read the license", destination: url)
                            }
                        }
                        Text(license.operatorNotes)
                            .fixedSize(horizontal: false, vertical: true)
                        if let attribution = license.attribution {
                            Text("Required attribution: \u{201C}\(attribution)\u{201D}")
                                .font(.callout)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                Toggle("I've read these terms and will follow them when offering this model.", isOn: $accepted)
                    .toggleStyle(.checkbox)
                HStack {
                    Button("Cancel", role: .cancel) { dismiss() }
                        .buttonStyle(.keetaSecondary)
                        .keyboardShortcut(.cancelAction)
                    Spacer()
                    Button("Offer to the network") {
                        model.acknowledgeLicense(for: modelId)
                        Task { await model.setOffer(modelId: modelId, offered: true) }
                        dismiss()
                    }
                    .buttonStyle(.keetaPrimary)
                    .keyboardShortcut(.defaultAction)
                    .disabled(!accepted)
                }
            } else {
                Text("This model is no longer installed.")
                Button("Close") { dismiss() }
            }
        }
        .padding(16)
    }
}

// MARK: - Offer settings

struct OfferSettingsSheet: View {
    enum AccessChoice: String, CaseIterable, Identifiable {
        case inherit, publicAccess, allowlist
        var id: String { rawValue }
        var title: String {
            switch self {
            case .inherit: return "Same as Provide settings"
            case .publicAccess: return "Anyone on the network"
            case .allowlist: return "Only these buyers"
            }
        }
    }

    @EnvironmentObject var model: AppModel
    @Environment(\.closePanel) var dismiss
    let modelId: String
    @State var inputPrice = "0"
    @State var outputPrice = "0"
    @State var access: AccessChoice = .inherit
    @State var allow: [String] = []
    @State var loaded = false
    @State var confirmingRemove = false

    init(modelId: String) {
        self.modelId = modelId
    }

    private var entry: CatalogEntry? { model.catalog.first { $0.id == modelId } }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            if let entry, let installed = entry.installed {
                Text(entry.model.name)
                    .font(.title2.weight(.semibold))
                Form {
                    Section("Price per million tokens") {
                        LabeledContent("Input") {
                            AmountField("Input", baseUnits: $inputPrice, formatter: model.money)
                        }
                        LabeledContent("Output") {
                            AmountField("Output", baseUnits: $outputPrice, formatter: model.money)
                        }
                        Text("Suggested: \(model.money.priceSummary(entry.model.suggestedPrice))")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text("Buyers pay this price. You receive 99.75% of it; the network keeps 0.25%.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Section("Who can use this model") {
                        Picker("Access", selection: $access) {
                            ForEach(AccessChoice.allCases) { choice in
                                Text(choice.title).tag(choice)
                            }
                        }
                        if access == .allowlist {
                            AddressListEditor(addresses: $allow, emptyText: "Add the addresses of buyers who may use this model.")
                        }
                    }
                    Section("License") {
                        LabeledContent("License", value: entry.model.license.name)
                        Text(entry.model.license.operatorNotes)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Section("On disk") {
                        LabeledContent("Size", value: ByteFormat.string(installed.sizeBytes))
                        LabeledContent("Weights hash") {
                            Text(installed.weightsHash)
                                .font(.system(.caption, design: .monospaced))
                                .textSelection(.enabled)
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                        Button("Remove from this Mac…", role: .destructive) { confirmingRemove = true }
                    }
                }
                .formStyle(.grouped)
                .scrollContentBackground(.hidden)
                .onAppear { load(installed) }
                HStack {
                    Button("Cancel", role: .cancel) { dismiss() }
                        .buttonStyle(.keetaSecondary)
                        .keyboardShortcut(.cancelAction)
                    Spacer()
                    Button("Save") { save(installed) }
                        .buttonStyle(.keetaPrimary)
                        .keyboardShortcut(.defaultAction)
                        .disabled(access == .allowlist && allow.isEmpty)
                }
            } else {
                Text("This model is no longer installed.")
                Button("Close") { dismiss() }
            }
        }
        .padding(16)
        .confirmationDialog("Remove this model?", isPresented: $confirmingRemove) {
            Button("Remove", role: .destructive) {
                Task { await model.remove(modelId) }
                dismiss()
            }
        } message: {
            Text("It stops being offered and its files are deleted. You can install it again later.")
        }
    }

    private func load(_ installed: InstalledModel) {
        guard !loaded else { return }
        loaded = true
        inputPrice = installed.offer.price.inputPerMillion
        outputPrice = installed.offer.price.outputPerMillion
        if let policy = installed.offer.access {
            access = policy.mode == .public ? .publicAccess : .allowlist
            allow = policy.allow
        } else {
            access = .inherit
        }
    }

    private func save(_ installed: InstalledModel) {
        let price = Price(inputPerMillion: inputPrice, outputPerMillion: outputPrice)
        let accessUpdate: OfferAccessUpdate
        switch access {
        case .inherit: accessUpdate = .useDefault
        case .publicAccess: accessUpdate = .override(AccessPolicy(mode: .public, allow: []))
        case .allowlist: accessUpdate = .override(AccessPolicy(mode: .allowlist, allow: allow))
        }
        Task { await model.setOffer(modelId: modelId, offered: installed.offer.offered, price: price, access: accessUpdate) }
        dismiss()
    }
}

// MARK: - Custom model

struct CustomModelSheet: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.closePanel) var dismiss
    @State var repo = ""
    @State var name = ""
    @State var contextLength = ""
    @State var working = false
    @State var error: String?

    private var repoIsValid: Bool {
        let parts = repo.trimmingCharacters(in: .whitespaces).split(separator: "/")
        return parts.count == 2 && parts.allSatisfy { !$0.isEmpty && !$0.contains(" ") }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Add a custom model")
                .font(.title2.weight(.semibold))
            Text("Install MLX weights from a Hugging Face repository, for example mlx-community/Mistral-7B-Instruct-v0.3-4bit. You're responsible for following the model's license if you offer it.")
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Form {
                TextField("Hugging Face repository", text: $repo, prompt: Text("owner/name"))
                TextField("Display name", text: $name, prompt: Text("My model"))
                TextField("Context length (optional)", text: $contextLength, prompt: Text("32768"))
            }
            .formStyle(.grouped)
            .scrollContentBackground(.hidden)
            if let error {
                Text(error).foregroundStyle(.red).font(.callout)
            }
            HStack {
                Button("Cancel", role: .cancel) { dismiss() }
                    .buttonStyle(.keetaSecondary)
                    .keyboardShortcut(.cancelAction)
                Spacer()
                if working { ProgressView().controlSize(.small) }
                Button("Install") { install() }
                    .buttonStyle(.keetaPrimary)
                    .keyboardShortcut(.defaultAction)
                    .disabled(!repoIsValid || name.trimmingCharacters(in: .whitespaces).isEmpty || working)
            }
        }
        .padding(16)
    }

    private func install() {
        let context = Int(contextLength.trimmingCharacters(in: .whitespaces))
        if !contextLength.trimmingCharacters(in: .whitespaces).isEmpty && (context == nil || context! <= 0) {
            error = "Context length must be a whole number."
            return
        }
        working = true
        error = nil
        Task {
            defer { working = false }
            do {
                try await model.installCustom(
                    repo: repo.trimmingCharacters(in: .whitespaces),
                    name: name.trimmingCharacters(in: .whitespaces),
                    contextLength: context
                )
                dismiss()
            } catch {
                self.error = AppModel.friendlyMessage(for: error)
            }
        }
    }
}
