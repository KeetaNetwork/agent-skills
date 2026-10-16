import KeetaComputeKit
import SwiftUI

struct WalletView: View {
    @EnvironmentObject var model: AppModel
    @State var sheet: WalletSheet?
    @State var requestingFunds = false
    @State var settingUp = false

    enum WalletSheet: String, Identifiable {
        case send, receive, addBudget, moveBack
        var id: String { rawValue }
    }

    var body: some View {
        Screen("Wallet", subtitle: "Your earnings and spending money, in USDC.") {
            if model.hasOperator {
                balanceCard
                budgetCard
                if model.isTestNetwork { testFundsCard }
            } else {
                setupCard
            }
            bankCard
        }
        .toolbar {
            ToolbarItem {
                Button {
                    Task { await model.refreshWallet() }
                } label: {
                    Label("Refresh", systemImage: "arrow.clockwise")
                }
                .help("Refresh balances")
            }
        }
        .task { await model.refreshWallet() }
        .sheet(item: $sheet) { sheet in
            Group {
                switch sheet {
                case .send: SendSheet()
                case .receive: ReceiveSheet()
                case .addBudget: BudgetSheet(direction: .add)
                case .moveBack: BudgetSheet(direction: .moveBack)
                }
            }
            .environmentObject(model)
        }
    }

    private var operatorBalance: AssetBalance? { model.wallet?.balances?.operatorBalance }
    private var spendBalance: AssetBalance? { model.wallet?.balances?.spend }

    // MARK: Cards

    private var setupCard: some View {
        Card("Set up your wallet", systemImage: "person.badge.key") {
            Text("Your wallet is protected by a passkey that syncs with iCloud Keychain. There is no recovery phrase.")
                .foregroundStyle(.secondary)
            HStack {
                Button("Create wallet with passkey") {
                    setUp { try await model.createWallet() }
                }
                .buttonStyle(.borderedProminent)
                Button("Use my existing passkey") {
                    setUp { try await model.restoreWallet() }
                }
                if settingUp { ProgressView().controlSize(.small) }
            }
            .disabled(settingUp || !model.connection.isRunning)
        }
    }

    private var balanceCard: some View {
        Card {
            HStack(alignment: .top) {
                Stat(
                    title: "Balance",
                    value: operatorBalance.map { model.money.string($0.usdc) } ?? "—",
                    detail: model.wallet?.error
                )
                Spacer()
                VStack(alignment: .trailing, spacing: 8) {
                    HStack {
                        Button {
                            sheet = .send
                        } label: {
                            Label("Send", systemImage: "arrow.up.right")
                        }
                        .buttonStyle(.borderedProminent)
                        Button {
                            sheet = .receive
                        } label: {
                            Label("Receive", systemImage: "arrow.down.left")
                        }
                    }
                    .controlSize(.large)
                }
            }
            if let address = model.wallet?.operatorAddress {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Your address")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    CopyField(value: address)
                }
            }
            if let kta = operatorBalance?.kta {
                Text("Network fee balance: \(model.feeToken.string(kta, minFractionDigits: 0)). Fees are tiny and paid automatically.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var budgetCard: some View {
        Card("Agent budget", systemImage: "gauge.with.dots.needle.33percent") {
            Text("Your tools and agents pay for requests from this budget, so they never touch your main balance. Move money in and out any time.")
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack(alignment: .center) {
                Stat(title: "Available to agents", value: spendBalance.map { model.money.string($0.usdc) } ?? "—")
                Spacer()
                Button("Add…") { sheet = .addBudget }
                    .buttonStyle(.borderedProminent)
                Button("Move back…") { sheet = .moveBack }
                    .disabled(spendBalance.map { BaseUnits.isZero($0.usdc) } ?? true)
            }
            if let spent = model.buyer?.spentToday {
                Text("Spent today: \(model.money.string(spent))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var testFundsCard: some View {
        Card("Test funds", systemImage: "drop") {
            Text("You're on the test network. Get free test USDC to try buying and selling. Test funds have no value.")
                .foregroundStyle(.secondary)
            HStack {
                Button("Get test funds") {
                    requestingFunds = true
                    Task {
                        defer { requestingFunds = false }
                        if let message = await model.perform("Couldn't get test funds", { try await model.requestTestFunds() }) {
                            model.flash(message)
                        }
                    }
                }
                .disabled(requestingFunds || !model.connection.isRunning)
                if requestingFunds { ProgressView().controlSize(.small) }
            }
        }
    }

    private var bankCard: some View {
        Card("Bank deposits and withdrawals", systemImage: "building.columns") {
            Text("Moving money between Keeta Compute and a bank account requires identity verification (KYC), as the law requires. This is coming in a later version.")
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Text("Until then you can earn, hold, send and receive USDC, and spend it on models, without verification.")
                .font(.callout)
                .foregroundStyle(.secondary)
        }
    }

    private func setUp(_ action: @escaping () async throws -> Void) {
        settingUp = true
        Task {
            defer { settingUp = false }
            do {
                try await action()
            } catch {
                model.show(error, title: "Couldn't set up your wallet")
            }
        }
    }
}

// MARK: - Send

struct SendSheet: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) var dismiss
    @State var address = ""
    @State var amountText = ""
    @State var memo = ""
    @State var sending = false
    @State var error: String?

    private var available: String { model.wallet?.balances?.operatorBalance?.usdc ?? "0" }

    private var parsedAmount: String? {
        guard let amount = try? model.money.parse(amountText), !BaseUnits.isZero(amount) else { return nil }
        return amount
    }

    private var validationMessage: String? {
        if !address.isEmpty && !WalletConstants.looksLikeAddress(address) {
            return "That doesn't look like a Keeta Compute address. Addresses start with keeta_."
        }
        if !amountText.isEmpty {
            do {
                let amount = try model.money.parse(amountText)
                if BaseUnits.compare(amount, available) > 0 {
                    return "That's more than your balance (\(model.money.string(available)))."
                }
            } catch {
                return error.localizedDescription
            }
        }
        return nil
    }

    private var canSend: Bool {
        WalletConstants.looksLikeAddress(address) && parsedAmount != nil && validationMessage == nil && !sending
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Send USDC")
                .font(.title2.weight(.semibold))
            Form {
                TextField("To address", text: $address, prompt: Text("keeta_…"))
                    .font(.system(.body, design: .monospaced))
                HStack {
                    TextField("Amount", text: $amountText, prompt: Text("0.00"))
                    Text(model.money.symbol).foregroundStyle(.secondary)
                    Button("Max") { amountText = model.money.editable(available) }
                        .buttonStyle(.link)
                }
                TextField("Note (optional)", text: $memo)
            }
            .formStyle(.grouped)
            Text("Available: \(model.money.string(available)). You'll confirm with Touch ID.")
                .font(.caption)
                .foregroundStyle(.secondary)
            if let message = validationMessage ?? error {
                Text(message)
                    .font(.callout)
                    .foregroundStyle(.red)
            }
            HStack {
                Button("Cancel", role: .cancel) { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Spacer()
                if sending { ProgressView().controlSize(.small) }
                Button("Send") { send() }
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.defaultAction)
                    .disabled(!canSend)
            }
        }
        .padding(24)
        .frame(width: 480)
    }

    private func send() {
        guard let amount = parsedAmount else { return }
        let to = address.trimmingCharacters(in: .whitespacesAndNewlines)
        let note = memo.trimmingCharacters(in: .whitespacesAndNewlines)
        sending = true
        error = nil
        Task {
            defer { sending = false }
            do {
                _ = try await model.send(to: to, amount: amount, asset: .usdc, memo: note.isEmpty ? nil : note)
                model.flash("Sent \(model.money.string(amount)).")
                dismiss()
            } catch {
                if let walletError = error as? PasskeyWallet.WalletError, case .canceled = walletError { return }
                self.error = AppModel.friendlyMessage(for: error)
            }
        }
    }
}

// MARK: - Receive

struct ReceiveSheet: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) var dismiss

    var body: some View {
        VStack(spacing: 16) {
            Text("Receive USDC")
                .font(.title2.weight(.semibold))
            if let address = model.wallet?.operatorAddress {
                if let image = QRCode.image(for: address) {
                    Image(nsImage: image)
                        .interpolation(.none)
                        .resizable()
                        .frame(width: 200, height: 200)
                        .padding(12)
                        .background(Color.white, in: RoundedRectangle(cornerRadius: 12))
                }
                Text("Share this address to receive USDC from other Keeta Compute users. Only send USDC from Keeta Compute or a compatible wallet.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                CopyField(value: address)
            } else {
                Text("Set up your wallet first.")
            }
            Button("Done") { dismiss() }
                .keyboardShortcut(.defaultAction)
        }
        .padding(24)
        .frame(width: 440)
    }
}

// MARK: - Agent budget

struct BudgetSheet: View {
    enum Direction { case add, moveBack }

    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) var dismiss
    let direction: Direction
    @State var amountText = ""
    @State var working = false
    @State var error: String?

    init(direction: Direction) {
        self.direction = direction
    }

    private var source: String {
        let balances = model.wallet?.balances
        switch direction {
        case .add: return balances?.operatorBalance?.usdc ?? "0"
        case .moveBack: return balances?.spend.usdc ?? "0"
        }
    }

    private var parsed: String? {
        guard let amount = try? model.money.parse(amountText), !BaseUnits.isZero(amount), BaseUnits.compare(amount, source) <= 0 else { return nil }
        return amount
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(direction == .add ? "Add to agent budget" : "Move back to balance")
                .font(.title2.weight(.semibold))
            Text(direction == .add
                 ? "Moves USDC from your balance into the budget your tools spend from. You'll confirm with Touch ID."
                 : "Moves USDC from the agent budget back to your balance.")
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack {
                TextField("Amount", text: $amountText, prompt: Text("0.00"))
                    .textFieldStyle(.roundedBorder)
                Text(model.money.symbol).foregroundStyle(.secondary)
                Button("Max") { amountText = model.money.editable(source) }
                    .buttonStyle(.link)
            }
            Text("Available: \(model.money.string(source))")
                .font(.caption)
                .foregroundStyle(.secondary)
            if let error {
                Text(error).foregroundStyle(.red).font(.callout)
            }
            HStack {
                Button("Cancel", role: .cancel) { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Spacer()
                if working { ProgressView().controlSize(.small) }
                Button(direction == .add ? "Add" : "Move back") { submit() }
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.defaultAction)
                    .disabled(parsed == nil || working)
            }
        }
        .padding(24)
        .frame(width: 440)
    }

    private func submit() {
        guard let amount = parsed else { return }
        working = true
        error = nil
        Task {
            defer { working = false }
            do {
                switch direction {
                case .add: try await model.fundBudget(amount: amount)
                case .moveBack: try await model.drainBudget(amount: amount)
                }
                model.flash(direction == .add ? "Added \(model.money.string(amount)) to the agent budget." : "Moved \(model.money.string(amount)) back.")
                dismiss()
            } catch {
                if let walletError = error as? PasskeyWallet.WalletError, case .canceled = walletError { return }
                self.error = AppModel.friendlyMessage(for: error)
            }
        }
    }
}
