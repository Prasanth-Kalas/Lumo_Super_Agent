import Foundation

enum ChatEvent: Equatable {
    case text(String)
    case error(String)
    case done
    case other(type: String)
}

enum ChatServiceError: Error, LocalizedError {
    case invalidBaseURL
    case badStatus(Int)
    case decodingFailed(String)

    var errorDescription: String? {
        switch self {
        case .invalidBaseURL:
            return "Invalid LumoAPIBase URL — check Info.plist."
        case .badStatus(let code):
            return "Server returned HTTP \(code)."
        case .decodingFailed(let detail):
            return "Failed to decode SSE frame: \(detail)."
        }
    }
}

final class ChatService {
    private let baseURL: URL
    private let session: URLSession

    init(baseURL: URL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }

    static func makeFromBundle(_ bundle: Bundle = .main) -> ChatService? {
        let raw = bundle.object(forInfoDictionaryKey: "LumoAPIBase") as? String ?? "http://localhost:3000"
        guard let url = URL(string: raw) else { return nil }
        return ChatService(baseURL: url)
    }

    func stream(message: String, sessionID: String) -> AsyncThrowingStream<ChatEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let request = try makeRequest(message: message, sessionID: sessionID)
                    let (bytes, response) = try await session.bytes(for: request)
                    if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                        throw ChatServiceError.badStatus(http.statusCode)
                    }
                    for try await line in bytes.lines {
                        if Task.isCancelled { break }
                        guard let event = Self.parseFrame(line: line) else { continue }
                        continuation.yield(event)
                        if event == .done { break }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private func makeRequest(message: String, sessionID: String) throws -> URLRequest {
        let endpoint = baseURL.appendingPathComponent("api/chat")
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        let body = ChatRequest(
            session_id: sessionID,
            messages: [ChatRequestMessage(role: "user", content: message)],
            device_kind: "ios",
            region: nil
        )
        request.httpBody = try JSONEncoder().encode(body)
        return request
    }

    /// Parse a single SSE line into a ChatEvent. Returns nil for non-data
    /// lines (blank lines, comments, unknown event lines).
    static func parseFrame(line: String) -> ChatEvent? {
        guard line.hasPrefix("data: ") else { return nil }
        let payload = String(line.dropFirst("data: ".count))
        guard let data = payload.data(using: .utf8) else {
            return .error("non-utf8 frame")
        }
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return .error("malformed json frame")
        }
        guard let type = json["type"] as? String else {
            return .error("frame missing type")
        }
        switch type {
        case "text":
            let value = json["value"] as? String ?? ""
            return .text(value)
        case "done":
            return .done
        case "error":
            let valueDict = json["value"] as? [String: Any]
            let message = valueDict?["message"] as? String ?? "unknown server error"
            return .error(message)
        default:
            return .other(type: type)
        }
    }
}
