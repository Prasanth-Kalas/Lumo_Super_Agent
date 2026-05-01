import Foundation

/// Live-update subscription to `/api/compound/transactions/:id/stream`.
/// Mirrors the EventSource path web uses in
/// `apps/web/components/CompoundLegStrip.tsx`. The web component
/// listens specifically for the `leg_status` named event; iOS
/// parses the same SSE event-frame format using `URLSession.bytes`.
///
/// Stream protocol (from
/// `apps/web/lib/sse/leg-status.ts::serializeLegStatusSse`):
///
///     event: leg_status
///     data: {"leg_id":"…","transaction_id":"…",
///            "agent_id":"…","capability_id":"…",
///            "status":"…","timestamp":"…"}
///
/// Followed by an empty line to terminate the event. iOS only
/// needs `leg_id` + `status` from each frame; everything else is
/// metadata the strip doesn't render today.
///
/// Lifecycle: `subscribe(...)` returns an AsyncStream of typed
/// updates; cancellation propagates through Task cancellation,
/// matching the existing ChatService stream pattern.
struct CompoundLegStatusUpdate: Equatable {
    let leg_id: String
    let status: CompoundLegStatus
    /// Server-side wall-clock timestamp the saga emitted the
    /// frame, in ISO 8601. nil for older frames or
    /// `_applyCompoundLegStatusForTest` calls that don't supply
    /// one. The detail view's elapsed-time ticker pivots off this.
    let timestamp: String?
    /// Provider booking reference once the leg lands committed
    /// (e.g. Duffel order id, Booking.com confirmation id). nil
    /// for pre-terminal statuses.
    let provider_reference: String?
    /// Saga-supplied evidence dict — kind + value pairs the leg
    /// detail view surfaces verbatim (e.g. `{"reason":
    /// "rate_unavailable"}` on a failure). Stored as
    /// `[String: String]` rather than `[String: Any]` to keep
    /// the type Equatable; non-string values render as their
    /// JSON debug description.
    let evidence: [String: String]?

    init(
        leg_id: String,
        status: CompoundLegStatus,
        timestamp: String? = nil,
        provider_reference: String? = nil,
        evidence: [String: String]? = nil
    ) {
        self.leg_id = leg_id
        self.status = status
        self.timestamp = timestamp
        self.provider_reference = provider_reference
        self.evidence = evidence
    }
}

final class CompoundStreamService {
    private let baseURL: URL
    private let session: URLSession

    init(baseURL: URL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }

    static func makeFromBundle(_ bundle: Bundle = .main) -> CompoundStreamService? {
        let raw = bundle.object(forInfoDictionaryKey: "LumoAPIBase") as? String ?? "http://localhost:3000"
        guard let url = URL(string: raw) else { return nil }
        return CompoundStreamService(baseURL: url)
    }

    /// Subscribe to per-leg status updates for `compoundTransactionID`.
    /// The returned stream finishes naturally on terminal compound
    /// status (the server closes the connection) or when the
    /// caller cancels.
    func subscribe(compoundTransactionID: String) -> AsyncThrowingStream<CompoundLegStatusUpdate, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let request = try makeRequest(compoundTransactionID: compoundTransactionID)
                    let (bytes, response) = try await session.bytes(for: request)
                    if let http = response as? HTTPURLResponse,
                       !(200..<300).contains(http.statusCode) {
                        throw ChatServiceError.badStatus(http.statusCode)
                    }
                    var currentEvent: String? = nil
                    for try await line in bytes.lines {
                        if Task.isCancelled { break }
                        if line.isEmpty {
                            // Blank line terminates an event; reset.
                            currentEvent = nil
                            continue
                        }
                        if line.hasPrefix(":") {
                            // Comment line (server heartbeats look like
                            // `: heartbeat`). Skip.
                            continue
                        }
                        if line.hasPrefix("event: ") {
                            currentEvent = String(line.dropFirst("event: ".count))
                                .trimmingCharacters(in: .whitespaces)
                            continue
                        }
                        if line.hasPrefix("data: ") {
                            let payload = String(line.dropFirst("data: ".count))
                            // Only surface leg_status named-events.
                            // Error events the server emits (`event: error`)
                            // close the connection; the loop exits below.
                            if currentEvent == "leg_status",
                               let update = Self.parseLegStatusFrame(payload) {
                                continuation.yield(update)
                            }
                            continue
                        }
                        // Any other field (id:, retry:) — ignore.
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private func makeRequest(compoundTransactionID: String) throws -> URLRequest {
        let path = "api/compound/transactions/\(compoundTransactionID)/stream"
        let endpoint = baseURL.appendingPathComponent(path)
        var request = URLRequest(url: endpoint)
        request.httpMethod = "GET"
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        return request
    }

    /// Pure parser for a single `data: <payload>` line under an
    /// `event: leg_status` event. Tolerant of extra fields the
    /// server sends (transaction_id, agent_id, capability_id,
    /// timestamp, evidence). leg_id + status are the required
    /// fields — provider_reference + timestamp + evidence flow
    /// through to the detail view when present. Returns nil for
    /// malformed frames; tests exercise the edge cases.
    static func parseLegStatusFrame(_ data: String) -> CompoundLegStatusUpdate? {
        guard let utf8 = data.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: utf8) as? [String: Any],
              let leg_id = json["leg_id"] as? String, !leg_id.isEmpty,
              let statusRaw = json["status"] as? String,
              let status = CompoundLegStatus(rawValue: statusRaw)
        else { return nil }
        let timestamp = json["timestamp"] as? String
        let provider_reference = json["provider_reference"] as? String
        let evidence: [String: String]? = (json["evidence"] as? [String: Any]).map { dict in
            // Coerce non-string values (numbers, bools, nested
            // dicts) into their JSON-ish string form so the
            // detail view can surface them without a typed
            // decoder per kind. The saga's evidence shape varies
            // per agent — typically `reason` / `provider_status` /
            // small key-value pairs.
            var out: [String: String] = [:]
            for (key, value) in dict {
                if let s = value as? String { out[key] = s }
                else { out[key] = String(describing: value) }
            }
            return out
        }
        return CompoundLegStatusUpdate(
            leg_id: leg_id,
            status: status,
            timestamp: timestamp,
            provider_reference: provider_reference,
            evidence: evidence
        )
    }
}
