import AppKit
import Foundation
import KeetaComputeKit
import os

struct LogLine: Identifiable, Equatable {
    enum Source: String { case app, agent }

    let id = UUID()
    let date: Date
    let source: Source
    let level: LogLevel
    let message: String
}

struct AppAlert: Identifiable, Equatable {
    let id = UUID()
    let title: String
    let message: String
}

/// The app's single source of truth. Agent state arrives through `event.state`
/// notifications and call results; views read it and call the async actions below.
@MainActor
final class AppModel: ObservableObject {
    // MARK: Agent-driven state

    @Published private(set) var connection: AgentConnectionState = .stopped
    @Published private(set) var agent: AgentState?
    @Published private(set) var catalog: [CatalogEntry] = []
    @Published private(set) var catalogLoaded = false
    @Published private(set) var installProgress: [String: InstallProgress] = [:]
    @Published private(set) var networkModels: [NetworkModel] = []
    @Published private(set) var fleet: [FleetHelper] = []
    @Published private(set) var hardwareCheck: HardwareCheck?
    /// Jobs reported through `event.job`, newest state per job id.
    @Published private(set) var liveJobs: [String: JobSummary] = [:]
    @Published private(set) var logs: [LogLine] = []
    @Published var alert: AppAlert?
    /// Short confirmation shown at the bottom of the window.
    @Published var notice: String?

    // MARK: App settings (persisted)

    @Published var onboardingComplete: Bool {
        didSet { defaults.set(onboardingComplete, forKey: Keys.onboardingComplete) }
    }
    @Published private(set) var network: NetworkName {
        didSet { defaults.set(network.rawValue, forKey: Keys.network) }
    }
    @Published private(set) var controlURL: String {
        didSet { defaults.set(controlURL, forKey: Keys.controlURL) }
    }
    @Published private(set) var relayURL: String {
        didSet { defaults.set(relayURL, forKey: Keys.relayURL) }
    }
    /// Model ids whose license terms the operator acknowledged before first offering them.
    @Published private(set) var acknowledgedLicenses: Set<String> {
        didSet { defaults.set(Array(acknowledgedLicenses), forKey: Keys.acknowledgedLicenses) }
    }

    // MARK: Services

    let client = AgentRPCClient()
    let passkeys = PasskeyWallet()
    let signer: NodeKeySigner?
    let signerError: String?

    private let defaults: UserDefaults
    private let log = Logger(subsystem: "ai.keeta.compute", category: "app")
    private var started = false
    private var noticeTask: Task<Void, Never>?

    private enum Keys {
        static let onboardingComplete = "onboardingComplete"
        static let network = "network"
        static let controlURL = "controlURL"
        static let relayURL = "relayURL"
        static let acknowledgedLicenses = "acknowledgedLicenses"
    }

    init() {
        // A local copy: stored properties can't be read through `self` until all are initialized.
        let defaults = UserDefaults.standard
        self.defaults = defaults
        onboardingComplete = defaults.bool(forKey: Keys.onboardingComplete)
        network = defaults.string(forKey: Keys.network).flatMap(NetworkName.init(rawValue:)) ?? .test
        controlURL = defaults.string(forKey: Keys.controlURL) ?? ProtocolConstants.defaultControlURL
        relayURL = defaults.string(forKey: Keys.relayURL) ?? ProtocolConstants.defaultRelayURL
        acknowledgedLicenses = Set(defaults.stringArray(forKey: Keys.acknowledgedLicenses) ?? [])
        do {
            signer = try NodeKeySigner.loadOrCreate()
            signerError = nil
        } catch {
            signer = nil
            signerError = error.localizedDescription
        }
    }

    #if DEBUG
    /// Sample state for screenshots (`--snapshot`): no keychain, agent or network,
    /// and settings go to a throwaway defaults domain.
    init(sample: Void) {
        let suite = "ai.keeta.compute.snapshots"
        let defaults = UserDefaults(suiteName: suite) ?? .standard
        defaults.removePersistentDomain(forName: suite)
        self.defaults = defaults
        onboardingComplete = true
        network = .test
        controlURL = ProtocolConstants.defaultControlURL
        relayURL = ProtocolConstants.defaultRelayURL
        acknowledgedLicenses = []
        signer = nil
        signerError = nil
    }

    func loadSample(state: AgentState, catalog: [CatalogEntry], progress: [InstallProgress], networkModels: [NetworkModel], fleet: [FleetHelper], running: [JobSummary]) {
        connection = .running
        agent = state
        self.catalog = catalog
        catalogLoaded = true
        installProgress = Dictionary(uniqueKeysWithValues: progress.map { ($0.modelId, $0) })
        self.networkModels = networkModels
        self.fleet = fleet
        liveJobs = Dictionary(uniqueKeysWithValues: running.map { ($0.jobId, $0) })
    }
    #endif

    // MARK: Derived values

    var wallet: WalletState? { agent?.wallet }
    var provider: ProviderStatus? { agent?.provider }
    var buyer: BuyerStatus? { agent?.buyer }
    var hasOperator: Bool { wallet?.operatorAddress != nil }
    var isTestNetwork: Bool { (agent?.network ?? network) == .test }

    /// Formats Keeta Compute Credits (one credit is one US dollar), which prices, costs and earnings are in.
    var money: AssetFormatter {
        AssetFormatter(asset: wallet?.asset ?? ProtocolConstants.fallbackCreditAsset)
    }

    /// Every credit this Mac holds, read from the ledger: the operator account's and the agent budget's.
    var creditBalance: String? {
        guard let balances = wallet?.balances else { return nil }
        return BaseUnits.add(balances.operatorBalance?.credits ?? "0", balances.spend.credits)
    }

    /// Keeta stablecoins that buy credits and that credits cash out to, KUSD first.
    var stablecoins: [StablecoinInfo] { wallet?.stablecoins ?? [] }

    func formatter(for stablecoin: StablecoinInfo) -> AssetFormatter {
        AssetFormatter(symbol: stablecoin.symbol, decimals: stablecoin.decimals)
    }

    /// KTA pays network fees; it is only shown in small print.
    var feeToken: AssetFormatter {
        AssetFormatter(symbol: "KTA", decimals: ProtocolConstants.ktaDecimals)
    }

    var localEndpoint: String {
        if let endpoint = buyer?.endpoint, !endpoint.isEmpty { return endpoint }
        return ProtocolConstants.defaultLocalEndpoint
    }

    var runningJobs: [JobSummary] {
        liveJobs.values.filter { $0.status == .running }.sorted { $0.at > $1.at }
    }

    var appVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev"
    }

    // MARK: Lifecycle

    func start() async {
        guard !started else { return }
        started = true
        let signer = self.signer
        await client.configure(
            requests: { id, method, raw in
                await AgentRequestRouter.handle(id: id, method: method, raw: raw, signer: signer)
            },
            notifications: { [weak self] notification in
                self?.handle(notification)
            },
            state: { [weak self] state in
                self?.connection = state
            },
            logs: { [weak self] level, message in
                self?.appendLog(.agent, level, message)
            },
            launched: { [weak self] in
                await self?.agentLaunched()
            }
        )
        if signer == nil {
            appendLog(.app, .error, "Node key unavailable: \(signerError ?? "unknown error")")
            connection = .failed("This Mac's node key couldn't be created: \(signerError ?? "unknown error")")
            return
        }
        await client.start()
    }

    func shutdown() async {
        passkeys.cancelPending()
        await client.stop()
    }

    private func agentLaunched() async {
        guard let signer else { return }
        let params = InitializeParams(
            network: network,
            controlUrl: controlURL,
            relayUrl: relayURL,
            nodePublicKey: signer.publicKeyHex,
            appVersion: appVersion,
            machineName: Host.current().localizedName ?? "Mac"
        )
        do {
            agent = try await client.call(AgentRPC.Initialize.self, params, timeout: .seconds(60))
            appendLog(.app, .info, "Connected to the background service \(agent?.version ?? "")")
            await refreshCatalog()
            if onboardingComplete {
                await refreshNetworkModels()
                await refreshFleet()
            }
        } catch {
            appendLog(.app, .error, "Initialize failed: \(error.localizedDescription)")
            show(error, title: "Couldn't start Keeta Compute")
        }
    }

    // MARK: Notifications

    private func handle(_ notification: AgentNotification) {
        switch notification {
        case .state(let state):
            agent = state
        case .installProgress(let progress):
            installProgress[progress.modelId] = progress
            if !progress.isActive {
                if progress.phase == .failed {
                    appendLog(.app, .error, "Install of \(progress.modelId) failed: \(progress.message ?? "unknown error")")
                }
                Task { await refreshCatalog() }
            }
        case .job(let job):
            liveJobs[job.jobId] = job
            pruneLiveJobs()
        case .log(let event):
            appendLog(.agent, event.level, event.message)
        case .unknown(let method):
            log.debug("Ignoring notification \(method, privacy: .public)")
        }
    }

    private func pruneLiveJobs() {
        guard liveJobs.count > 200 else { return }
        let keep = liveJobs.values.sorted { $0.at > $1.at }.prefix(100)
        liveJobs = Dictionary(uniqueKeysWithValues: keep.map { ($0.jobId, $0) })
    }

    func appendLog(_ source: LogLine.Source, _ level: LogLevel, _ message: String) {
        logs.append(LogLine(date: Date(), source: source, level: level, message: message))
        // Mirrored to the unified log, so `log stream --predicate 'subsystem == "ai.keeta.compute"'` shows it too.
        let type: OSLogType = switch level {
        case .debug: .debug
        case .info: .info
        case .warn: .default
        case .error: .error
        }
        log.log(level: type, "[\(String(describing: source), privacy: .public)] \(message, privacy: .public)")
        if logs.count > 2000 {
            logs.removeFirst(logs.count - 2000)
        }
    }

    // MARK: Errors and notices

    func show(_ error: Error, title: String = "Something went wrong") {
        if let walletError = error as? PasskeyWallet.WalletError, case .canceled = walletError { return }
        alert = AppAlert(title: title, message: Self.friendlyMessage(for: error))
    }

    func flash(_ message: String) {
        notice = message
        noticeTask?.cancel()
        noticeTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(3))
            guard !Task.isCancelled else { return }
            self?.notice = nil
        }
    }

    static func friendlyMessage(for error: Error) -> String {
        if let rpc = error as? RPCError {
            switch rpc.code {
            case RPCErrorCode.insufficientFunds: return "Not enough balance for this. \(rpc.message)"
            case RPCErrorCode.noOperator: return "Set up your wallet first."
            case RPCErrorCode.network: return "Couldn't reach the network. Check your connection and try again."
            case RPCErrorCode.policyDenied: return "Blocked by your spending limits. \(rpc.message)"
            case RPCErrorCode.notEligible: return "This Mac can't provide right now. \(rpc.message)"
            case RPCErrorCode.notInitialized: return "Keeta Compute is still starting. Try again in a moment."
            default: return rpc.message
            }
        }
        return error.localizedDescription
    }

    /// Runs an agent action, reporting failures as an alert. Returns nil on failure.
    @discardableResult
    func perform<T>(_ title: String, _ action: () async throws -> T) async -> T? {
        do {
            return try await action()
        } catch {
            show(error, title: title)
            return nil
        }
    }

    // MARK: Refresh

    func refreshState() async {
        if let state = try? await client.call(AgentRPC.State.self, EmptyParams()) {
            agent = state
        }
    }

    func refreshCatalog() async {
        do {
            catalog = try await client.call(AgentRPC.ModelsList.self, EmptyParams())
            catalogLoaded = true
        } catch {
            appendLog(.app, .warn, "Model list unavailable: \(error.localizedDescription)")
        }
    }

    func refreshNetworkModels() async {
        do {
            networkModels = try await client.call(AgentRPC.BuyerNetworkModels.self, EmptyParams()).elements
        } catch {
            appendLog(.app, .warn, "Network models unavailable: \(error.localizedDescription)")
        }
    }

    func refreshFleet() async {
        do {
            fleet = try await client.call(AgentRPC.FleetList.self, EmptyParams())
        } catch {
            appendLog(.app, .warn, "Fleet unavailable: \(error.localizedDescription)")
        }
    }

    func refreshWallet() async {
        do {
            let wallet = try await client.call(AgentRPC.WalletRefresh.self, EmptyParams())
            agent?.wallet = wallet
        } catch {
            appendLog(.app, .warn, "Balance refresh failed: \(error.localizedDescription)")
        }
    }

    func checkHardware() async throws -> HardwareCheck {
        let check = try await client.call(AgentRPC.HardwareProfileCheck.self, EmptyParams())
        hardwareCheck = check
        return check
    }

    // MARK: Wallet

    /// Creates the wallet passkey, then derives the operator account from it.
    func createWallet() async throws {
        // A passkey made on an earlier attempt is reused rather than creating a second one.
        if !passkeys.hasPasskey {
            try await passkeys.register(accountName: "Keeta Compute wallet")
        }
        try await connectOperator(anyPasskey: false)
    }

    /// Uses a passkey that already exists (e.g. synced from another Mac through iCloud Keychain).
    func restoreWallet() async throws {
        try await connectOperator(anyPasskey: true)
    }

    private func connectOperator(anyPasskey: Bool) async throws {
        let client = self.client
        _ = try await passkeys.withEntropy(anyPasskey: anyPasskey) { entropy in
            try await client.call(AgentRPC.WalletSetOperator.self, SetOperatorParams(entropy: entropy))
        }
        await refreshState()
        await refreshWallet()
    }

    func send(to address: String, amount: String, asset: WalletAsset, memo: String?) async throws -> String {
        let client = self.client
        let result = try await passkeys.withEntropy { entropy in
            try await client.call(AgentRPC.WalletSend.self, WalletSendParams(entropy: entropy, to: address, amount: amount, asset: asset, memo: memo), timeout: .seconds(90))
        }
        await refreshWallet()
        return result.blockHash
    }

    func fundBudget(amount: String) async throws {
        let client = self.client
        _ = try await passkeys.withEntropy { entropy in
            try await client.call(AgentRPC.WalletFundBudget.self, FundBudgetParams(entropy: entropy, amount: amount, asset: .credits), timeout: .seconds(90))
        }
        await refreshWallet()
    }

    func drainBudget(amount: String) async throws {
        _ = try await client.call(AgentRPC.WalletDrainBudget.self, DrainBudgetParams(amount: amount, asset: .credits), timeout: .seconds(90))
        await refreshWallet()
    }

    /// What `amount` credits cost in a stablecoin ('buy'), or bring when cashed out ('sell'), without swapping, and the limit to confirm with it.
    func creditQuote(side: CreditSide, amount: String, stablecoin: String) async throws -> CreditQuoteResult {
        try await client.call(AgentRPC.WalletCreditQuote.self, CreditQuoteParams(side: side, amount: amount, stablecoin: stablecoin), timeout: .seconds(30))
    }

    /// Buy credits with a stablecoin from the operator account through the FX service, paying at most `maxPay`; they go to the agent budget unless `toBudget` is false.
    func buyCredits(amount: String, with stablecoin: String, maxPay: String, toBudget: Bool) async throws -> BuyCreditsResult {
        let client = self.client
        let result = try await passkeys.withEntropy { entropy in
            try await client.call(AgentRPC.WalletBuyCredits.self, BuyCreditsParams(entropy: entropy, amount: amount, with: stablecoin, maxPay: maxPay, toBudget: toBudget), timeout: .seconds(120))
        }
        await refreshWallet()
        return result
    }

    /// Cash out credits from the operator account for a stablecoin, receiving at least `minReceive`.
    func sellCredits(amount: String, to stablecoin: String, minReceive: String) async throws -> SellCreditsResult {
        let client = self.client
        let result = try await passkeys.withEntropy { entropy in
            try await client.call(AgentRPC.WalletSellCredits.self, SellCreditsParams(entropy: entropy, amount: amount, to: stablecoin, minReceive: minReceive), timeout: .seconds(120))
        }
        await refreshWallet()
        return result
    }

    func requestTestFunds() async throws -> String {
        let result = try await client.call(AgentRPC.WalletRequestTestFunds.self, EmptyParams(), timeout: .seconds(90))
        await refreshWallet()
        return result.message
    }

    // MARK: Models

    func install(_ modelId: String) async {
        await perform("Couldn't start the download") {
            installProgress[modelId] = InstallProgress(modelId: modelId, phase: .queued, bytesDone: 0, bytesTotal: 0)
            _ = try await client.call(AgentRPC.ModelsInstall.self, ModelIDParams(modelId: modelId))
        }
    }

    func installCustom(repo: String, name: String, contextLength: Int?) async throws {
        let result = try await client.call(AgentRPC.ModelsInstallCustom.self, InstallCustomParams(repo: repo, name: name, contextLength: contextLength))
        installProgress[result.modelId] = InstallProgress(modelId: result.modelId, phase: .queued, bytesDone: 0, bytesTotal: 0)
        await refreshCatalog()
    }

    func cancelInstall(_ modelId: String) async {
        await perform("Couldn't cancel the download") {
            _ = try await client.call(AgentRPC.ModelsCancelInstall.self, ModelIDParams(modelId: modelId))
            installProgress[modelId] = nil
        }
    }

    func remove(_ modelId: String) async {
        await perform("Couldn't remove the model") {
            _ = try await client.call(AgentRPC.ModelsRemove.self, ModelIDParams(modelId: modelId))
            installProgress[modelId] = nil
            await refreshCatalog()
        }
    }

    func setOffer(modelId: String, offered: Bool, price: Price? = nil, access: OfferAccessUpdate = .unchanged) async {
        await perform("Couldn't update the offer") {
            let installed = try await client.call(AgentRPC.ModelsSetOffer.self, SetOfferParams(modelId: modelId, offered: offered, price: price, access: access))
            if let index = catalog.firstIndex(where: { $0.model.id == modelId }) {
                catalog[index].installed = installed
            }
        }
    }

    func acknowledgeLicense(for modelId: String) {
        acknowledgedLicenses.insert(modelId)
    }

    // MARK: Provide

    func setProviderPolicy(_ update: ProviderPolicyUpdate) async {
        await perform("Couldn't update sharing settings") {
            let status = try await client.call(AgentRPC.ProviderSetPolicy.self, update)
            agent?.provider = status
        }
    }

    // MARK: Use

    func setBuyerPolicy(_ update: BuyerPolicyUpdate) async {
        await perform("Couldn't update spending limits") {
            let status = try await client.call(AgentRPC.BuyerSetPolicy.self, update)
            agent?.buyer = status
        }
    }

    func rotateToken() async {
        await perform("Couldn't create a new token") {
            let status = try await client.call(AgentRPC.BuyerRotateToken.self, EmptyParams())
            agent?.buyer = status
            flash("New API token created. Update your tools.")
        }
    }

    // MARK: Fleet

    /// The Linux pairing code on screen. Kept while the popover is closed (it
    /// closes as soon as the operator clicks into a terminal), so reopening it
    /// carries on with the code the machine was given.
    var openPairing: PairingCreated?

    func createPairing() async throws -> PairingCreated {
        let created = try await client.call(AgentRPC.FleetCreatePairing.self, EmptyParams())
        openPairing = created
        return created
    }

    func pairingStatus(_ pairingId: String) async throws -> PairingRecord {
        try await client.call(AgentRPC.FleetPairingStatus.self, PairingIDParams(pairingId: pairingId))
    }

    func approvePairing(_ pairingId: String) async throws {
        _ = try await client.call(AgentRPC.FleetApprove.self, PairingIDParams(pairingId: pairingId))
        openPairing = nil
        await refreshFleet()
    }

    func rejectPairing(_ pairingId: String) async throws {
        _ = try await client.call(AgentRPC.FleetReject.self, PairingIDParams(pairingId: pairingId))
        openPairing = nil
    }

    func revokeHelper(_ nodeKey: String) async {
        await perform("Couldn't remove the machine") {
            _ = try await client.call(AgentRPC.FleetRevoke.self, NodeKeyParams(nodeKey: nodeKey))
            await refreshFleet()
        }
    }

    // MARK: Settings

    func setNetwork(_ newNetwork: NetworkName) async {
        guard newNetwork != network else { return }
        let previous = network
        network = newNetwork
        let ok = await perform("Couldn't switch networks") {
            agent = try await client.call(AgentRPC.SetNetwork.self, SetNetworkParams(network: newNetwork), timeout: .seconds(60))
        }
        if ok == nil {
            network = previous
            return
        }
        catalogLoaded = false
        await refreshCatalog()
        await refreshNetworkModels()
        await refreshFleet()
    }

    /// Changing the service URLs requires re-initializing, so the agent is restarted.
    func setEndpoints(control: String, relay: String) async {
        controlURL = control
        relayURL = relay
        await client.restart()
    }

    func restartAgent() async {
        await client.restart()
    }

    func finishOnboarding() {
        onboardingComplete = true
        Task {
            await refreshNetworkModels()
            await refreshFleet()
        }
    }
}

/// Answers requests the agent sends to the app. Today that is only `signer.signDigest`.
enum AgentRequestRouter {
    static func handle(id: RPCID, method: String, raw: Data, signer: NodeKeySigner?) async -> Data {
        switch method {
        case AppRPC.signDigest:
            let params: SignDigestParams
            do {
                params = try RPCCodec.decodeParams(SignDigestParams.self, from: raw)
            } catch {
                return RPCCodec.encodeError(id: id, code: RPCErrorCode.invalidParams, message: "Expected { digest: hex }")
            }
            guard let digest = Hex.decode(params.digest), digest.count == 32 else {
                return RPCCodec.encodeError(id: id, code: RPCErrorCode.invalidParams, message: "digest must be 32 bytes of hex")
            }
            guard let signer else {
                return RPCCodec.encodeError(id: id, code: RPCErrorCode.internal, message: "Node key unavailable")
            }
            do {
                let signature = try signer.sign(digest: digest)
                return try RPCCodec.encodeResult(id: id, result: SignDigestResult(signature: Hex.encode(signature)))
            } catch {
                return RPCCodec.encodeError(id: id, code: RPCErrorCode.internal, message: error.localizedDescription)
            }
        default:
            return RPCCodec.encodeError(id: id, code: RPCErrorCode.methodNotFound, message: "Unknown method \(method)")
        }
    }
}
