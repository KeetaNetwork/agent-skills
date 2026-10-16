import Foundation
import KeetaComputeKit
import os

/// Where the app is in its relationship with the bundled agent process.
enum AgentConnectionState: Equatable, Sendable {
    case stopped
    case starting
    case running
    /// The agent exited unexpectedly; it will be started again after `delay` seconds.
    case restarting(attempt: Int, delay: Int)
    /// The helper executable is not in the app bundle (e.g. a Debug build without bundle-agent.sh).
    case missingExecutable
    case failed(String)

    var isRunning: Bool { self == .running }
}

enum AgentClientError: LocalizedError {
    case notRunning
    case exited
    case timedOut(String)
    case invalidResponse(String)

    var errorDescription: String? {
        switch self {
        case .notRunning: return "Keeta Compute's background service isn't running."
        case .exited: return "Keeta Compute's background service stopped. It is restarting."
        case .timedOut(let method): return "The background service didn't answer in time (\(method))."
        case .invalidResponse(let detail): return "Unexpected reply from the background service: \(detail)"
        }
    }
}

/// Finds the `keeta-compute-agent` executable.
enum AgentLocator {
    static let executableName = "keeta-compute-agent"

    /// `KEETA_COMPUTE_AGENT_PATH` overrides the bundled helper (useful during development).
    static func executableURL() -> URL? {
        let fileManager = FileManager.default
        if let override = ProcessInfo.processInfo.environment["KEETA_COMPUTE_AGENT_PATH"], !override.isEmpty,
           fileManager.isExecutableFile(atPath: override) {
            return URL(fileURLWithPath: override)
        }
        if let url = Bundle.main.url(forResource: executableName, withExtension: nil),
           fileManager.isExecutableFile(atPath: url.path) {
            return url
        }
        return nil
    }

    /// ~/Library/Application Support/Keeta Compute
    static func dataDirectory() throws -> URL {
        let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let directory = base.appendingPathComponent("Keeta Compute", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }
}

/// Reads one pipe and turns its bytes into lines, in order.
private final class PipeLineReader: @unchecked Sendable {
    private var framer = LineFramer()
    private let handle: FileHandle
    let lines: AsyncStream<Data>
    private let continuation: AsyncStream<Data>.Continuation

    init(handle: FileHandle) {
        self.handle = handle
        let (stream, continuation) = AsyncStream.makeStream(of: Data.self, bufferingPolicy: .unbounded)
        self.lines = stream
        self.continuation = continuation
        // readabilityHandler runs on a private serial queue, so `framer` is only touched from there.
        handle.readabilityHandler = { [weak self] handle in
            guard let self else { return }
            let chunk = handle.availableData
            if chunk.isEmpty {
                handle.readabilityHandler = nil
                if let rest = self.framer.finish() {
                    self.continuation.yield(rest)
                }
                self.continuation.finish()
                return
            }
            for line in self.framer.append(chunk) {
                self.continuation.yield(line)
            }
        }
    }

    func cancel() {
        handle.readabilityHandler = nil
        continuation.finish()
    }
}

/// JSON-RPC 2.0 client for the bundled agent, over its stdin/stdout.
///
/// - The app calls `AppToAgent` methods with `call(_:_:timeout:)`.
/// - The agent calls `signer.signDigest` on the app; `requestHandler` answers it.
/// - Notifications go to `notificationHandler` in arrival order.
/// - If the process exits unexpectedly it is restarted with exponential backoff,
///   and `launchHandler` runs again so the app can re-initialize it.
actor AgentRPCClient {
    typealias RequestHandler = @Sendable (_ id: RPCID, _ method: String, _ raw: Data) async -> Data
    typealias NotificationHandler = @MainActor @Sendable (AgentNotification) -> Void
    typealias StateHandler = @MainActor @Sendable (AgentConnectionState) -> Void
    typealias LogHandler = @MainActor @Sendable (_ level: LogLevel, _ message: String) -> Void
    typealias LaunchHandler = @Sendable () async -> Void

    private struct Pending {
        let method: String
        let continuation: CheckedContinuation<Data, Error>
        let timeout: Task<Void, Never>
    }

    private let log = Logger(subsystem: "ai.keeta.compute", category: "agent")
    private let agentLog = Logger(subsystem: "ai.keeta.compute", category: "agent-stderr")

    private var requestHandler: RequestHandler?
    private var notificationHandler: NotificationHandler?
    private var stateHandler: StateHandler?
    private var logHandler: LogHandler?
    private var launchHandler: LaunchHandler?

    private var process: Process?
    private var stdin: FileHandle?
    private var readers: [PipeLineReader] = []
    private var pending: [RPCID: Pending] = [:]
    private var nextID = 1
    /// Bumped on every launch so callbacks from an old process are ignored.
    private var generation = 0
    private var stopping = false
    private var restartAttempt = 0
    private var launchedAt = Date.distantPast
    private(set) var state: AgentConnectionState = .stopped

    func configure(
        requests: @escaping RequestHandler,
        notifications: @escaping NotificationHandler,
        state: @escaping StateHandler,
        logs: @escaping LogHandler,
        launched: @escaping LaunchHandler
    ) {
        requestHandler = requests
        notificationHandler = notifications
        stateHandler = state
        logHandler = logs
        launchHandler = launched
    }

    // MARK: Lifecycle

    func start() async {
        guard process == nil else { return }
        stopping = false
        restartAttempt = 0
        await launch()
    }

    /// Asks the agent to shut down, then makes sure it is gone.
    func stop() async {
        stopping = true
        if process != nil, state == .running {
            _ = try? await call(AgentRPC.Shutdown.self, EmptyParams(), timeout: .seconds(3))
        }
        try? stdin?.close()
        if let process {
            for _ in 0..<20 where process.isRunning {
                try? await Task.sleep(for: .milliseconds(100))
            }
            if process.isRunning {
                process.terminate()
            }
        }
        await teardown(error: AgentClientError.notRunning)
        await setState(.stopped)
    }

    /// Stops the current process and starts a fresh one (e.g. after the control URLs change).
    func restart() async {
        await stop()
        await start()
    }

    private func launch() async {
        generation += 1
        let currentGeneration = generation
        guard let executable = AgentLocator.executableURL() else {
            log.error("keeta-compute-agent not found in the app bundle")
            await setState(.missingExecutable)
            return
        }
        let dataDirectory: URL
        do {
            dataDirectory = try AgentLocator.dataDirectory()
        } catch {
            await setState(.failed("Couldn't create the data folder: \(error.localizedDescription)"))
            return
        }

        await setState(.starting)
        let process = Process()
        process.executableURL = executable
        process.arguments = ["app", "--data-dir", dataDirectory.path]
        let input = Pipe()
        let output = Pipe()
        let errors = Pipe()
        process.standardInput = input
        process.standardOutput = output
        process.standardError = errors
        process.terminationHandler = { [weak self] finished in
            guard let client = self else { return }
            let status = finished.terminationStatus
            let reason = finished.terminationReason
            Task { await client.processExited(generation: currentGeneration, status: status, reason: reason) }
        }

        // Set before running so a binary that fails to launch still backs off.
        launchedAt = Date()
        do {
            try process.run()
        } catch {
            log.error("Failed to launch agent: \(error.localizedDescription, privacy: .public)")
            await scheduleRestart(after: "launch failed: \(error.localizedDescription)", generation: currentGeneration)
            return
        }

        self.process = process
        self.stdin = input.fileHandleForWriting
        let stdoutReader = PipeLineReader(handle: output.fileHandleForReading)
        let stderrReader = PipeLineReader(handle: errors.fileHandleForReading)
        readers = [stdoutReader, stderrReader]
        log.info("Agent launched, pid \(process.processIdentifier)")

        Task { [weak self] in
            for await line in stdoutReader.lines {
                await self?.handleLine(line, generation: currentGeneration)
            }
        }
        Task { [weak self] in
            for await line in stderrReader.lines {
                await self?.handleStderr(line)
            }
        }

        await setState(.running)
        if let launchHandler {
            Task { await launchHandler() }
        }
    }

    private func processExited(generation exitedGeneration: Int, status: Int32, reason: Process.TerminationReason) async {
        guard exitedGeneration == generation else { return }
        log.notice("Agent exited (status \(status), \(reason == .uncaughtSignal ? "signal" : "exit", privacy: .public))")
        await teardown(error: AgentClientError.exited)
        if stopping {
            await setState(.stopped)
            return
        }
        await scheduleRestart(after: "exited with status \(status)", generation: exitedGeneration)
    }

    private func scheduleRestart(after reason: String, generation scheduledGeneration: Int) async {
        // A process that stayed up for a minute counts as healthy: start the backoff over.
        if Date().timeIntervalSince(launchedAt) > 60 {
            restartAttempt = 0
        }
        restartAttempt += 1
        let delay = min(60, 1 << min(restartAttempt - 1, 6))
        log.notice("Restarting agent in \(delay)s (\(reason, privacy: .public))")
        await setState(.restarting(attempt: restartAttempt, delay: delay))
        try? await Task.sleep(for: .seconds(delay))
        guard !stopping, scheduledGeneration == generation, process == nil else { return }
        await launch()
    }

    private func teardown(error: Error) async {
        for reader in readers {
            reader.cancel()
        }
        readers = []
        try? stdin?.close()
        stdin = nil
        process = nil
        let failed = pending
        pending = [:]
        for (_, entry) in failed {
            entry.timeout.cancel()
            entry.continuation.resume(throwing: error)
        }
    }

    private func setState(_ newState: AgentConnectionState) async {
        state = newState
        if let stateHandler {
            await stateHandler(newState)
        }
    }

    // MARK: Calls

    func call<M: RPCMethod>(_ method: M.Type, _ params: M.Params, timeout: Duration = .seconds(30)) async throws -> M.Result {
        let raw = try await send(method: M.name, params: params, timeout: timeout)
        do {
            return try RPCCodec.decodeResult(M.Result.self, from: raw)
        } catch {
            log.error("Could not decode \(M.name, privacy: .public) result: \(String(describing: error), privacy: .public)")
            throw AgentClientError.invalidResponse(M.name)
        }
    }

    private func send<P: Encodable>(method: String, params: P, timeout: Duration) async throws -> Data {
        guard let stdin, process != nil else { throw AgentClientError.notRunning }
        let id = RPCID.number(nextID)
        nextID += 1
        var message = try RPCCodec.encodeRequest(id: id, method: method, params: params)
        // Requests can carry passkey entropy: wipe the encoded bytes once written.
        defer { message.resetBytes(in: 0..<message.count) }

        return try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Data, Error>) in
            let timeoutTask = Task { [weak self] in
                try? await Task.sleep(for: timeout)
                guard !Task.isCancelled else { return }
                await self?.expire(id)
            }
            pending[id] = Pending(method: method, continuation: continuation, timeout: timeoutTask)
            do {
                try stdin.write(contentsOf: message)
            } catch {
                timeoutTask.cancel()
                pending.removeValue(forKey: id)
                continuation.resume(throwing: AgentClientError.notRunning)
            }
        }
    }

    private func expire(_ id: RPCID) {
        guard let entry = pending.removeValue(forKey: id) else { return }
        log.error("RPC \(entry.method, privacy: .public) timed out")
        entry.continuation.resume(throwing: AgentClientError.timedOut(entry.method))
    }

    private func write(_ data: Data) {
        guard let stdin else { return }
        do {
            try stdin.write(contentsOf: data)
        } catch {
            log.error("Write to agent failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    // MARK: Inbound

    private func handleLine(_ line: Data, generation lineGeneration: Int) async {
        guard lineGeneration == generation else { return }
        let message: RPCInbound
        do {
            message = try RPCCodec.parse(line)
        } catch {
            log.error("Unreadable line from agent: \(error.localizedDescription, privacy: .public)")
            return
        }

        switch message {
        case .success(let id, let raw):
            guard let entry = pending.removeValue(forKey: id) else { return }
            entry.timeout.cancel()
            entry.continuation.resume(returning: raw)

        case .failure(let id, let error):
            guard let id, let entry = pending.removeValue(forKey: id) else {
                log.error("Agent error without a matching request: \(error.message, privacy: .public)")
                return
            }
            entry.timeout.cancel()
            entry.continuation.resume(throwing: error)

        case .request(let id, let method, let raw):
            guard let requestHandler else {
                write(RPCCodec.encodeError(id: id, code: RPCErrorCode.methodNotFound, message: "No handler for \(method)"))
                return
            }
            // Answer concurrently: a signature may take a moment and must not hold up other messages.
            Task { [weak self] in
                let response = await requestHandler(id, method, raw)
                await self?.respond(response, generation: lineGeneration)
            }

        case .notification(let method, let raw):
            do {
                let notification = try AgentNotification.decode(method: method, raw: raw)
                if let notificationHandler {
                    await notificationHandler(notification)
                }
            } catch {
                log.error("Could not decode \(method, privacy: .public): \(String(describing: error), privacy: .public)")
            }
        }
    }

    private func respond(_ data: Data, generation responseGeneration: Int) {
        guard responseGeneration == generation else { return }
        write(data)
    }

    private func handleStderr(_ line: Data) async {
        let text = String(decoding: line, as: UTF8.self)
        agentLog.info("\(text, privacy: .public)")
        if let logHandler {
            await logHandler(.debug, text)
        }
    }
}
