// JSON-RPC 2.0 over newline-delimited JSON: envelopes, framing and the
// inbound message classifier. Pure Foundation; no process or I/O here.

import Foundation

/// JSON-RPC ids may be numbers or strings. The app always sends numbers;
/// the agent may use either for its own requests.
public enum RPCID: Hashable, Sendable, Codable, CustomStringConvertible {
    case number(Int)
    case string(String)

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let int = try? container.decode(Int.self) {
            self = .number(int)
        } else {
            self = .string(try container.decode(String.self))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .number(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        }
    }

    public var description: String {
        switch self {
        case .number(let value): return String(value)
        case .string(let value): return value
        }
    }
}

/// A JSON-RPC error object, also thrown to callers when the agent replies with an error.
public struct RPCError: Error, Codable, Sendable, Equatable, LocalizedError {
    public var code: Int
    public var message: String

    public init(code: Int, message: String) {
        self.code = code
        self.message = message
    }

    public var errorDescription: String? { message }

    public var isNoOperator: Bool { code == RPCErrorCode.noOperator }
    public var isInsufficientFunds: Bool { code == RPCErrorCode.insufficientFunds }
}

// MARK: - Outbound envelopes

public struct RPCRequestEnvelope<Params: Encodable>: Encodable {
    public let jsonrpc = "2.0"
    public let id: RPCID
    public let method: String
    public let params: Params

    public init(id: RPCID, method: String, params: Params) {
        self.id = id
        self.method = method
        self.params = params
    }

    private enum CodingKeys: String, CodingKey { case jsonrpc, id, method, params }
}

public struct RPCNotificationEnvelope<Params: Encodable>: Encodable {
    public let jsonrpc = "2.0"
    public let method: String
    public let params: Params

    public init(method: String, params: Params) {
        self.method = method
        self.params = params
    }

    private enum CodingKeys: String, CodingKey { case jsonrpc, method, params }
}

public struct RPCResultEnvelope<Result: Encodable>: Encodable {
    public let jsonrpc = "2.0"
    public let id: RPCID
    public let result: Result

    public init(id: RPCID, result: Result) {
        self.id = id
        self.result = result
    }

    private enum CodingKeys: String, CodingKey { case jsonrpc, id, result }
}

public struct RPCErrorEnvelope: Encodable {
    public let jsonrpc = "2.0"
    /// `null` when the request id could not be read.
    public let id: RPCID?
    public let error: RPCError

    public init(id: RPCID?, error: RPCError) {
        self.id = id
        self.error = error
    }

    private enum CodingKeys: String, CodingKey { case jsonrpc, id, error }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(jsonrpc, forKey: .jsonrpc)
        try container.encode(id, forKey: .id)
        try container.encode(error, forKey: .error)
    }
}

// MARK: - Inbound

/// One message read from the agent, classified. `raw` is the whole line so
/// the caller can decode `params` or `result` into the type it expects.
public enum RPCInbound: Sendable, Equatable {
    case request(id: RPCID, method: String, raw: Data)
    case notification(method: String, raw: Data)
    case success(id: RPCID, raw: Data)
    case failure(id: RPCID?, error: RPCError)
}

public enum RPCCodecError: Error, Equatable, LocalizedError {
    case notAnObject
    case wrongVersion
    case malformed(String)
    case missingResult

    public var errorDescription: String? {
        switch self {
        case .notAnObject: return "Message is not a JSON object."
        case .wrongVersion: return "Message is not JSON-RPC 2.0."
        case .malformed(let detail): return "Malformed message: \(detail)"
        case .missingResult: return "Response has no result."
        }
    }
}

private struct InboundHeader: Decodable {
    var jsonrpc: String?
    var id: RPCID?
    var method: String?
    var hasResult: Bool
    var error: RPCError?

    private enum CodingKeys: String, CodingKey { case jsonrpc, id, method, result, error }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        jsonrpc = try container.decodeIfPresent(String.self, forKey: .jsonrpc)
        if container.contains(.id), try container.decodeNil(forKey: .id) == false {
            id = try container.decode(RPCID.self, forKey: .id)
        } else {
            id = nil
        }
        method = try container.decodeIfPresent(String.self, forKey: .method)
        hasResult = container.contains(.result)
        error = try container.decodeIfPresent(RPCError.self, forKey: .error)
    }
}

private struct ParamsBox<Params: Decodable>: Decodable {
    var params: Params
}

private struct ResultBox<Result: Decodable>: Decodable {
    var result: Result
}

public enum RPCCodec {
    static func makeEncoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        // Never `.prettyPrinted`: a message must stay on one line.
        encoder.outputFormatting = [.withoutEscapingSlashes, .sortedKeys]
        return encoder
    }

    /// Encodes one message and appends the trailing newline.
    public static func frame<T: Encodable>(_ message: T) throws -> Data {
        var data = try makeEncoder().encode(message)
        data.append(0x0A)
        return data
    }

    public static func encodeRequest<P: Encodable>(id: RPCID, method: String, params: P) throws -> Data {
        try frame(RPCRequestEnvelope(id: id, method: method, params: params))
    }

    public static func encodeResult<R: Encodable>(id: RPCID, result: R) throws -> Data {
        try frame(RPCResultEnvelope(id: id, result: result))
    }

    public static func encodeError(id: RPCID?, code: Int, message: String) -> Data {
        // Encoding an error envelope cannot fail: every field is a plain string or int.
        (try? frame(RPCErrorEnvelope(id: id, error: RPCError(code: code, message: message))))
            ?? Data("{\"jsonrpc\":\"2.0\",\"id\":null,\"error\":{\"code\":-32603,\"message\":\"internal\"}}\n".utf8)
    }

    /// Classifies one line (without its newline).
    public static func parse(_ line: Data) throws -> RPCInbound {
        let header: InboundHeader
        do {
            header = try JSONDecoder().decode(InboundHeader.self, from: line)
        } catch DecodingError.typeMismatch {
            throw RPCCodecError.notAnObject
        } catch {
            throw RPCCodecError.malformed(String(describing: error))
        }
        guard header.jsonrpc == "2.0" else { throw RPCCodecError.wrongVersion }
        if let method = header.method {
            if let id = header.id {
                return .request(id: id, method: method, raw: line)
            }
            return .notification(method: method, raw: line)
        }
        if let error = header.error {
            return .failure(id: header.id, error: error)
        }
        guard let id = header.id else { throw RPCCodecError.malformed("response without id") }
        guard header.hasResult else { throw RPCCodecError.missingResult }
        return .success(id: id, raw: line)
    }

    public static func decodeParams<P: Decodable>(_ type: P.Type, from raw: Data) throws -> P {
        try JSONDecoder().decode(ParamsBox<P>.self, from: raw).params
    }

    public static func decodeResult<R: Decodable>(_ type: R.Type, from raw: Data) throws -> R {
        try JSONDecoder().decode(ResultBox<R>.self, from: raw).result
    }
}

// MARK: - Framing

/// Splits a byte stream into newline-terminated lines. Carriage returns
/// before the newline are dropped; empty lines are skipped.
public struct LineFramer: Sendable {
    private var buffer = Data()
    /// Lines longer than this are discarded (a runaway writer must not exhaust memory).
    public let maxLineBytes: Int

    public init(maxLineBytes: Int = 16 * 1024 * 1024) {
        self.maxLineBytes = maxLineBytes
    }

    public mutating func append(_ chunk: Data) -> [Data] {
        buffer.append(chunk)
        var lines: [Data] = []
        while let newline = buffer.firstIndex(of: 0x0A) {
            var line = buffer[buffer.startIndex..<newline]
            buffer = Data(buffer[buffer.index(after: newline)...])
            if line.last == 0x0D {
                line = line.dropLast()
            }
            if !line.isEmpty {
                lines.append(Data(line))
            }
        }
        if buffer.count > maxLineBytes {
            buffer.removeAll(keepingCapacity: false)
        }
        return lines
    }

    /// Whatever is left when the stream ends (a final line without a newline).
    public mutating func finish() -> Data? {
        defer { buffer.removeAll() }
        return buffer.isEmpty ? nil : buffer
    }
}

// MARK: - Notifications

public enum AgentNotification: Sendable, Equatable {
    case state(AgentState)
    case installProgress(InstallProgress)
    case job(JobSummary)
    case log(LogEvent)
    case unknown(method: String)

    public static func decode(method: String, raw: Data) throws -> AgentNotification {
        switch method {
        case AgentNotificationName.state:
            return .state(try RPCCodec.decodeParams(AgentState.self, from: raw))
        case AgentNotificationName.installProgress:
            return .installProgress(try RPCCodec.decodeParams(InstallProgress.self, from: raw))
        case AgentNotificationName.job:
            return .job(try RPCCodec.decodeParams(JobSummary.self, from: raw))
        case AgentNotificationName.log:
            return .log(try RPCCodec.decodeParams(LogEvent.self, from: raw))
        default:
            return .unknown(method: method)
        }
    }
}
