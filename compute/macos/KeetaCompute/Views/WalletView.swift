import KeetaComputeKit
import SwiftUI

struct WalletView: View {
    @EnvironmentObject var model: AppModel
    @State var sheet: WalletSheet?
    @State var requestingFunds = false
    @State var settingUp = false

    enum WalletSheet: String, Identifiable {
        case buyCredits, cashOut, send, receive, addBudget, moveBack
        var id: String { rawValue }
    }

    var body: some View {
        Screen("Wallet", subtitle: "Keeta Compute Credits pay for requests and are what you earn. Buy them with Keeta stablecoins, KUSD first, and cash out any time.") {
            if model.hasOperator {
                balanceCard
                budgetCard
                if model.isTestNetwork { testFundsCard }
            } else {
                setupCard
            }
            bankCard
        }
        .task { await model.refreshWallet() }
        .panel(item: $sheet) { sheet in
            Group {
                switch sheet {
                case .buyCredits: CreditSwapSheet(side: .buy)
                case .cashOut: CreditSwapSheet(side: .sell)
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
    /// Stablecoins the operator account holds, in lead order (KUSD first).
    private var heldStablecoins: [StablecoinInfo] {
        model.stablecoins.filter { !BaseUnits.isZero(operatorBalance?.stablecoins[$0.symbol] ?? "0") }
    }

    // MARK: Cards

    private var setupCard: some View {
        Card("Set up your wallet", systemImage: "person.badge.key") {
            Text("Your wallet is protected by a passkey that syncs with iCloud Keychain. There is no recovery phrase.")
                .foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Button("Create wallet with passkey") {
                        setUp { try await model.createWallet() }
                    }
                    .buttonStyle(.keetaPrimary)
                    if settingUp { ProgressView().controlSize(.small) }
                }
                Button("Use my existing passkey") {
                    setUp { try await model.restoreWallet() }
                }
                .buttonStyle(.link)
            }
            .disabled(settingUp || !model.connection.isRunning)
        }
    }

    private var balanceCard: some View {
        Card {
            HStack(alignment: .top) {
                Stat(
                    title: "Credits",
                    value: operatorBalance.map { model.money.string($0.credits) } ?? "—",
                    detail: model.wallet?.error ?? (model.wallet?.creditsAvailable == false ? "Credits aren't available on this network yet." : nil),
                    size: 30
                )
                Button {
                    Task { await model.refreshWallet() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .buttonStyle(.borderless)
                .foregroundStyle(Color.keetaGray40)
                .help("Refresh balances")
            }
            HStack(spacing: 8) {
                Button("Buy credits") { sheet = .buyCredits }
                    .buttonStyle(.keetaPrimary)
                Button("Cash out") { sheet = .cashOut }
                    .buttonStyle(.keetaSecondary)
                    .disabled(operatorBalance.map { BaseUnits.isZero($0.credits) } ?? true)
            }
            .disabled(model.wallet?.creditsAvailable != true || model.stablecoins.isEmpty)
            HStack(spacing: 16) {
                Button {
                    sheet = .send
                } label: {
                    Label("Send", systemImage: "arrow.up.right")
                }
                Button {
                    sheet = .receive
                } label: {
                    Label("Receive", systemImage: "arrow.down.left")
                }
            }
            .buttonStyle(.borderless)
            .foregroundStyle(Color.keetaRed)
            if !heldStablecoins.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Stablecoins")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    ForEach(heldStablecoins) { coin in
                        HStack {
                            Text(coin.name)
                            Spacer()
                            Text(model.formatter(for: coin).string(operatorBalance?.stablecoins[coin.symbol] ?? "0"))
                                .monospacedDigit()
                        }
                        .font(.callout)
                    }
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
            Text("Your tools and agents pay for requests from these credits, so they never touch your main balance. Each request sets aside its most possible cost and gets back what it didn't use. Move credits in and out any time.")
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Stat(title: "Available to agents", value: spendBalance.map { model.money.string($0.credits) } ?? "—")
            HStack(spacing: 8) {
                Button("Add…") { sheet = .addBudget }
                    .buttonStyle(.keetaPrimary)
                Button("Move back…") { sheet = .moveBack }
                    .buttonStyle(.keetaSecondary)
                    .disabled(spendBalance.map { BaseUnits.isZero($0.credits) } ?? true)
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
            Text("You're on the test network. Get free test KTA for network fees here; test stablecoins come from their issuers (test USDC from Circle's faucet, bridged to Keeta). Test funds have no value.")
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
            Text("Until then you can buy credits with Keeta stablecoins, earn and spend them, and cash them out to stablecoins, without verification.")
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
    @Environment(\.closePanel) var dismiss
    @State var address = ""
    @State var amountText = ""
    @State var memo = ""
    @State var sending = false
    @State var error: String?

    private var available: String { model.wallet?.balances?.operatorBalance?.credits ?? "0" }

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
            Text("Send credits")
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
            .scrollContentBackground(.hidden)
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
                    .buttonStyle(.keetaSecondary)
                    .keyboardShortcut(.cancelAction)
                Spacer()
                if sending { ProgressView().controlSize(.small) }
                Button("Send") { send() }
                    .buttonStyle(.keetaPrimary)
                    .keyboardShortcut(.defaultAction)
                    .disabled(!canSend)
            }
        }
        .padding(16)
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
                _ = try await model.send(to: to, amount: amount, asset: .credits, memo: note.isEmpty ? nil : note)
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
    @Environment(\.closePanel) var dismiss

    var body: some View {
        VStack(spacing: 16) {
            Text("Receive")
                .font(.title2.weight(.semibold))
            if let address = model.wallet?.operatorAddress {
                if let image = QRCode.image(for: address) {
                    Image(nsImage: image)
                        .interpolation(.none)
                        .resizable()
                        .frame(width: 150, height: 150)
                        .padding(12)
                        .background(Color.white, in: RoundedRectangle(cornerRadius: 12))
                }
                Text("Share this address to receive credits, or Keeta stablecoins (KUSD, KEUR, KJPY, KMXN, KCAD, KAED, KGBP, USDC) to buy credits with. Send only from a Keeta wallet.")
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
        .padding(16)
    }
}

// MARK: - Agent budget

struct BudgetSheet: View {
    enum Direction { case add, moveBack }

    @EnvironmentObject var model: AppModel
    @Environment(\.closePanel) var dismiss
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
        case .add: return balances?.operatorBalance?.credits ?? "0"
        case .moveBack: return balances?.spend.credits ?? "0"
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
                 ? "Moves credits from your balance into the budget your tools spend from. You'll confirm with Touch ID."
                 : "Moves credits from the agent budget back to your balance.")
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
                    .buttonStyle(.keetaSecondary)
                    .keyboardShortcut(.cancelAction)
                Spacer()
                if working { ProgressView().controlSize(.small) }
                Button(direction == .add ? "Add" : "Move back") { submit() }
                    .buttonStyle(.keetaPrimary)
                    .keyboardShortcut(.defaultAction)
                    .disabled(parsed == nil || working)
            }
        }
        .padding(16)
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

// MARK: - Buy credits and cash out

/// Swaps credits with a Keeta stablecoin through keeta.ai's FX service. Buying
/// pays from the operator account and (by default) puts the credits in the
/// agent budget; cashing out sells credits from the operator account. KUSD is
/// the default stablecoin when it is available.
struct CreditSwapSheet: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.closePanel) var dismiss
    let side: CreditSide
    @State var symbol = ""
    @State var amountText = ""
    @State var toBudget = true
    @State var quote: CreditQuoteResult?
    @State var quoting = false
    @State var working = false
    @State var error: String?

    init(side: CreditSide) {
        self.side = side
    }

    private var coin: StablecoinInfo? { model.stablecoins.first { $0.symbol == symbol } ?? model.stablecoins.first }
    private var coinMoney: AssetFormatter? { coin.map { model.formatter(for: $0) } }
    private var operatorBalance: AssetBalance? { model.wallet?.balances?.operatorBalance }
    /// The stablecoin held, when buying.
    private var heldCoin: String { coin.flatMap { operatorBalance?.stablecoins[$0.symbol] } ?? "0" }
    /// The credits held, when cashing out.
    private var heldCredits: String { operatorBalance?.credits ?? "0" }

    private var parsed: String? {
        guard let amount = try? model.money.parse(amountText), !BaseUnits.isZero(amount) else { return nil }
        return amount
    }

    private var shortfall: String? {
        switch side {
        case .buy:
            if let quote, BaseUnits.compare(quote.amount, heldCoin) > 0 { return "That costs more \(coin?.symbol ?? "") than you have." }
        case .sell:
            if let parsed, BaseUnits.compare(parsed, heldCredits) > 0 { return "That's more than your credits (\(model.money.string(heldCredits)))." }
        }
        return nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(side == .buy ? "Buy credits" : "Cash out")
                .font(.title2.weight(.semibold))
            Text(side == .buy
                 ? "One credit is one US dollar. Pay with a Keeta stablecoin from your balance at the rate keeta.ai's exchange quotes. You'll confirm with Touch ID."
                 : "Sell credits from your balance for a Keeta stablecoin at the rate keeta.ai's exchange quotes. You'll confirm with Touch ID.")
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Form {
                Picker(side == .buy ? "Pay with" : "Receive", selection: $symbol) {
                    ForEach(model.stablecoins) { coin in
                        Text("\(coin.symbol) · \(coin.name)").tag(coin.symbol)
                    }
                }
                HStack {
                    TextField("Credits", text: $amountText, prompt: Text("0.00"))
                    Text(model.money.symbol).foregroundStyle(.secondary)
                    if side == .sell {
                        Button("Max") { amountText = model.money.editable(heldCredits) }
                            .buttonStyle(.link)
                    }
                }
                if side == .buy {
                    Toggle("Put them in the agent budget", isOn: $toBudget)
                }
            }
            .formStyle(.grouped)
            .scrollContentBackground(.hidden)
            if let coinMoney {
                Group {
                    switch side {
                    case .buy:
                        Text(quote.map { "You pay about \(coinMoney.string($0.amount)), at most \(coinMoney.string($0.limit)). You have \(coinMoney.string(heldCoin))." } ?? "You have \(coinMoney.string(heldCoin)).")
                    case .sell:
                        Text(quote.map { "You receive about \(coinMoney.string($0.amount)), at least \(coinMoney.string($0.limit)). You have \(model.money.string(heldCredits))." } ?? "You have \(model.money.string(heldCredits)).")
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            if let message = error ?? shortfall {
                Text(message)
                    .font(.callout)
                    .foregroundStyle(.red)
            }
            HStack {
                Button("Cancel", role: .cancel) { dismiss() }
                    .buttonStyle(.keetaSecondary)
                    .keyboardShortcut(.cancelAction)
                Spacer()
                if quoting || working { ProgressView().controlSize(.small) }
                Button(side == .buy ? "Buy" : "Cash out") { submit() }
                    .buttonStyle(.keetaPrimary)
                    .keyboardShortcut(.defaultAction)
                    .disabled(parsed == nil || quote == nil || shortfall != nil || working)
            }
        }
        .padding(16)
        .onAppear {
            if symbol.isEmpty { symbol = model.stablecoins.first?.symbol ?? "" }
        }
        .task(id: "\(symbol)|\(amountText)") { await requote() }
    }

    private func requote() async {
        quote = nil
        guard let amount = parsed, let coin else { return }
        // Wait for typing to settle before asking for a rate.
        try? await Task.sleep(for: .milliseconds(300))
        if Task.isCancelled { return }
        quoting = true
        defer { quoting = false }
        do {
            let amountOut = try await model.creditQuote(side: side, amount: amount, stablecoin: coin.symbol)
            if Task.isCancelled { return }
            quote = amountOut
            error = nil
        } catch {
            if !Task.isCancelled { self.error = AppModel.friendlyMessage(for: error) }
        }
    }

    private func submit() {
        guard let amount = parsed, let coin, let coinMoney, let quote else { return }
        working = true
        error = nil
        Task {
            defer { working = false }
            do {
                switch side {
                case .buy:
                    let result = try await model.buyCredits(amount: amount, with: coin.symbol, maxPay: quote.limit, toBudget: toBudget)
                    model.flash("Bought \(model.money.string(result.credits)) for \(coinMoney.string(result.paid))\(result.budgetBlockHash == nil ? "" : " into the agent budget").")
                case .sell:
                    let result = try await model.sellCredits(amount: amount, to: coin.symbol, minReceive: quote.limit)
                    model.flash("Cashed out \(model.money.string(result.credits)) for \(coinMoney.string(result.received)).")
                }
                dismiss()
            } catch {
                if let walletError = error as? PasskeyWallet.WalletError, case .canceled = walletError { return }
                self.error = AppModel.friendlyMessage(for: error)
            }
        }
    }
}
