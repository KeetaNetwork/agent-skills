import KeetaComputeKit
import SwiftUI

/// Rounded panel used for every group of content.
struct Card<Content: View>: View {
    var title: String?
    var systemImage: String?
    @ViewBuilder var content: Content

    init(_ title: String? = nil, systemImage: String? = nil, @ViewBuilder content: () -> Content) {
        self.title = title
        self.systemImage = systemImage
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let title {
                Group {
                    if let systemImage {
                        Label(title, systemImage: systemImage)
                    } else {
                        Text(title)
                    }
                }
                .font(.headline)
            }
            content
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(.separator.opacity(0.6), lineWidth: 0.5)
        )
    }
}

/// A big number with a caption.
struct Stat: View {
    let title: String
    let value: String
    var detail: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Text(value)
                .font(.system(size: 26, weight: .semibold, design: .rounded))
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.6)
                .textSelection(.enabled)
            if let detail {
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Screen scaffold: a scrolling column with a title.
struct Screen<Content: View>: View {
    let title: String
    var subtitle: String?
    @ViewBuilder var content: Content

    init(_ title: String, subtitle: String? = nil, @ViewBuilder content: () -> Content) {
        self.title = title
        self.subtitle = subtitle
        self.content = content()
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(title)
                        .font(.largeTitle.weight(.semibold))
                    if let subtitle {
                        Text(subtitle)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.bottom, 4)
                content
            }
            .padding(24)
            .frame(maxWidth: 900, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// Monospaced value with a copy button.
struct CopyField: View {
    let value: String
    var display: String?
    var label: String
    @State private var copied = false

    init(value: String, display: String? = nil, label: String = "Copy") {
        self.value = value
        self.display = display
        self.label = label
    }

    var body: some View {
        HStack(spacing: 8) {
            Text(display ?? value)
                .font(.system(.body, design: .monospaced))
                .textSelection(.enabled)
                .lineLimit(1)
                .truncationMode(.middle)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 6))
            Button {
                Pasteboard.copy(value)
                copied = true
                Task {
                    try? await Task.sleep(for: .seconds(1.5))
                    copied = false
                }
            } label: {
                Label(copied ? "Copied" : label, systemImage: copied ? "checkmark" : "doc.on.doc")
            }
        }
    }
}

/// Code block with a copy button, for snippets.
struct CodeBlock: View {
    let code: String
    /// What the copy button copies, when it differs from what is shown (e.g. an unmasked token).
    var copyValue: String? = nil

    var body: some View {
        ZStack(alignment: .topTrailing) {
            ScrollView(.horizontal) {
                Text(code)
                    .font(.system(.callout, design: .monospaced))
                    .textSelection(.enabled)
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 8))
            Button {
                Pasteboard.copy(copyValue ?? code)
            } label: {
                Image(systemName: "doc.on.doc")
            }
            .buttonStyle(.borderless)
            .help("Copy")
            .padding(8)
        }
    }
}

/// Status pill.
struct Badge: View {
    let text: String
    var color: Color = .secondary

    var body: some View {
        Text(text)
            .font(.caption.weight(.medium))
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .foregroundStyle(color)
            .background(color.opacity(0.14), in: Capsule())
    }
}

/// Text field that edits a base-unit amount as a decimal in the asset's units.
struct AmountField: View {
    let title: String
    @Binding var baseUnits: String
    let formatter: AssetFormatter
    @State private var text = ""
    @State private var error: String?

    init(_ title: String, baseUnits: Binding<String>, formatter: AssetFormatter) {
        self.title = title
        self._baseUnits = baseUnits
        self.formatter = formatter
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                TextField(title, text: $text)
                    .textFieldStyle(.roundedBorder)
                    .multilineTextAlignment(.trailing)
                    .frame(minWidth: 90, maxWidth: 140)
                    .onSubmit(commit)
                Text(formatter.symbol)
                    .foregroundStyle(.secondary)
            }
            if let error {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        }
        .onAppear { text = formatter.editable(baseUnits) }
        .onChange(of: baseUnits) { _, newValue in
            if (try? formatter.parse(text)) != newValue {
                text = formatter.editable(newValue)
            }
        }
        .onChange(of: text) { _, _ in
            commit()
        }
    }

    private func commit() {
        guard !text.trimmingCharacters(in: .whitespaces).isEmpty else {
            error = nil
            return
        }
        do {
            let parsed = try formatter.parse(text)
            if parsed != baseUnits {
                baseUnits = parsed
            }
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// Editable list of Keeta addresses (allowlists).
struct AddressListEditor: View {
    @Binding var addresses: [String]
    var placeholder: String
    var emptyText: String
    @State private var draft = ""
    @State private var invalid = false

    init(addresses: Binding<[String]>, placeholder: String = "keeta_…", emptyText: String = "No addresses yet.") {
        self._addresses = addresses
        self.placeholder = placeholder
        self.emptyText = emptyText
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if addresses.isEmpty {
                Text(emptyText)
                    .foregroundStyle(.secondary)
                    .font(.callout)
            }
            ForEach(addresses, id: \.self) { address in
                HStack {
                    Text(address)
                        .font(.system(.callout, design: .monospaced))
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .textSelection(.enabled)
                    Spacer()
                    Button(role: .destructive) {
                        addresses.removeAll { $0 == address }
                    } label: {
                        Image(systemName: "minus.circle")
                    }
                    .buttonStyle(.borderless)
                    .help("Remove")
                }
            }
            HStack {
                TextField(placeholder, text: $draft)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(.callout, design: .monospaced))
                    .onSubmit(add)
                Button("Add", action: add)
                    .disabled(draft.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            if invalid {
                Text("That doesn't look like an address. Addresses start with keeta_.")
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        }
    }

    private func add() {
        let value = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard WalletConstants.looksLikeAddress(value) else {
            invalid = true
            return
        }
        invalid = false
        if !addresses.contains(value) {
            addresses.append(value)
        }
        draft = ""
    }
}

/// Editable list of free-form strings (model ids).
struct StringListEditor: View {
    @Binding var values: [String]
    var placeholder: String
    var suggestions: [String]
    @State private var draft = ""

    init(values: Binding<[String]>, placeholder: String, suggestions: [String] = []) {
        self._values = values
        self.placeholder = placeholder
        self.suggestions = suggestions
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(values, id: \.self) { value in
                HStack {
                    Text(value).font(.system(.callout, design: .monospaced))
                    Spacer()
                    Button(role: .destructive) {
                        values.removeAll { $0 == value }
                    } label: {
                        Image(systemName: "minus.circle")
                    }
                    .buttonStyle(.borderless)
                }
            }
            HStack {
                TextField(placeholder, text: $draft)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit(add)
                if !suggestions.isEmpty {
                    Menu("Choose") {
                        ForEach(suggestions.filter { !values.contains($0) }, id: \.self) { suggestion in
                            Button(suggestion) { values.append(suggestion) }
                        }
                    }
                    .fixedSize()
                }
                Button("Add", action: add)
                    .disabled(draft.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
    }

    private func add() {
        let value = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, !values.contains(value) else { return }
        values.append(value)
        draft = ""
    }
}

/// List row for a job.
struct JobRow: View {
    let job: JobSummary
    let money: AssetFormatter

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: job.role == .provider ? "arrow.down.circle" : "arrow.up.circle")
                .foregroundStyle(job.role == .provider ? Color.keetaGreen : Color.secondary)
                .font(.title3)
            VStack(alignment: .leading, spacing: 2) {
                Text(job.modelId)
                    .font(.body.weight(.medium))
                Text("\(Abbreviate.tokens(job.inputTokens)) in · \(Abbreviate.tokens(job.outputTokens)) out · \(job.date.relative)\(job.helper != nil ? " · Linux helper" : "")")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if let error = job.error {
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(.red)
                }
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 2) {
                Text((job.role == .provider ? "+" : "−") + money.string(job.amount))
                    .monospacedDigit()
                    .foregroundStyle(job.role == .provider ? Color.keetaGreen : Color.primary)
                Badge(text: job.status.title, color: job.status.color)
            }
        }
        .padding(.vertical, 4)
    }
}

/// Shown when there is nothing to list yet.
struct EmptyNote: View {
    let title: String
    let systemImage: String
    var message: String?

    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: systemImage)
                .font(.system(size: 28))
                .foregroundStyle(.tertiary)
            Text(title)
                .font(.headline)
            if let message {
                Text(message)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 20)
    }
}
