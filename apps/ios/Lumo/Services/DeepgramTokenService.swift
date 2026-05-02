import Foundation

/// DEEPGRAM-IOS-IMPL-1 Phase 1 — short-lived token cache for the
/// Deepgram realtime APIs.
///
/// **Privacy contract (`docs/contracts/deepgram-token.md`):**
///   - The long-lived `LUMO_DEEPGRAM_API_KEY` lives only on the
///     server. iOS calls `POST /api/audio/deepgram-token` to mint a
///     short-lived (60s TTL) Deepgram bearer token via Deepgram's
///     Auth Grant endpoint.
///   - Token kept in memory only — never Keychain, never logs,
///     never crash reports.
///   - Refresh-ahead at 50s elapsed.
///   - 401 from Deepgram → re-fetch token and retry **the
///     reconnect (new WSS handshake)**, not an audio-replay path
///     — partial transcript is acceptably lost on mid-stream 401.
///   - Refresh-ahead is gated to **WebSocket-idle only**. Callers
///     drive the idle window via `markStreamActive(_:)` before
///     opening a WSS and `markStreamActive(false)` after closing.
///
/// **Endpoint contract:**
///   - `POST /api/audio/deepgram-token` (Supabase session cookie auth).
///   - Response: `{ token: String, expires_at: ISO8601 }`.
///   - Errors: `401 not_authenticated`, `403 forbidden`,
///     `429 rate_limited` (with `retry_after_seconds`),
///     `503 deepgram_not_configured`, `502 deepgram_token_error`.
///   - On `401` the iOS app must enter the sign-in/session-refresh
///     flow; this service surfaces the error and lets
///     VoiceComposerViewModel decide.
///
/// All network goes through an injectable `URLSessionProtocol` so
/// tests can stub responses via a `URLProtocol`-free fake.
@MainActor
protocol DeepgramTokenServicing: AnyObject {
    /// Returns a token guaranteed-fresh for the next ~10 seconds.
    /// Throws if the network or token mint fails.
    func currentToken() async throws -> String

    /// Force-refresh on the next `currentToken()` call. Used after
    /// a Deepgram 401 reconnect path: if the WSS server reports
    /// auth expiry, the next handshake should mint a fresh token
    /// even if the cached one looks valid.
    func invalidate()

    /// Idle-gating hook for the refresh-ahead policy. While a
    /// stream is active, refresh-ahead suppresses itself (we don't
    /// hot-swap tokens during an in-flight stream).
    func markStreamActive(_ active: Bool)
}

enum DeepgramTokenError: Error, Equatable {
    case notAuthenticated
    case forbidden
    case rateLimited(retryAfter: Int?)
    case deepgramNotConfigured
    case deepgramMintFailed
    case badStatus(Int)
    case decode(String)
    case transport(String)
    case missingExpiresAt
}

@MainActor
final class DeepgramTokenService: DeepgramTokenServicing {
    /// Refresh strictly before this many seconds remain — matches
    /// the contract's "refresh at 50s elapsed" rule for a 60s TTL.
    static let refreshLeadSeconds: TimeInterval = 10

    private let baseURL: URL
    private let session: URLSessionProtocol
    private let userIDProvider: () -> String?
    private let accessTokenProvider: () -> String?

    private var cachedToken: String?
    private var cachedExpiresAt: Date?
    private var streamActive: Bool = false

    init(
        baseURL: URL,
        userIDProvider: @escaping () -> String? = { nil },
        accessTokenProvider: @escaping () -> String? = { nil },
        session: URLSessionProtocol = URLSession.shared
    ) {
        self.baseURL = baseURL
        self.userIDProvider = userIDProvider
        self.accessTokenProvider = accessTokenProvider
        self.session = session
    }

    func currentToken() async throws -> String {
        if let token = cachedToken,
           let expiresAt = cachedExpiresAt,
           !needsRefresh(expiresAt: expiresAt)
        {
            return token
        }
        return try await mint()
    }

    func invalidate() {
        cachedToken = nil
        cachedExpiresAt = nil
    }

    func markStreamActive(_ active: Bool) {
        streamActive = active
    }

    /// Whether the current cached token is within the refresh
    /// window. Public for testability.
    func needsRefresh(expiresAt: Date, now: Date = Date()) -> Bool {
        // While a stream is active, refresh-ahead is suppressed —
        // we only mint a new token when the cached one is fully
        // expired (treat the old token as good until the WSS
        // server itself rejects). This matches the reviewer's
        // "refresh only at idle" rule for RISK 2.
        if streamActive {
            return now >= expiresAt
        }
        return now.addingTimeInterval(Self.refreshLeadSeconds) >= expiresAt
    }

    private func mint() async throws -> String {
        let url = baseURL.appendingPathComponent("api/audio/deepgram-token")
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let userID = userIDProvider(), !userID.isEmpty {
            req.setValue(userID, forHTTPHeaderField: "x-lumo-user-id")
        }
        if let token = accessTokenProvider(), !token.isEmpty {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.dataForRequest(req)
        } catch {
            throw DeepgramTokenError.transport(String(describing: error))
        }

        guard let http = response as? HTTPURLResponse else {
            throw DeepgramTokenError.transport("non-http response")
        }
        switch http.statusCode {
        case 200..<300:
            break
        case 401:
            throw DeepgramTokenError.notAuthenticated
        case 403:
            throw DeepgramTokenError.forbidden
        case 429:
            let retry = parseRetryAfter(data: data, response: http)
            throw DeepgramTokenError.rateLimited(retryAfter: retry)
        case 502:
            throw DeepgramTokenError.deepgramMintFailed
        case 503:
            throw DeepgramTokenError.deepgramNotConfigured
        default:
            throw DeepgramTokenError.badStatus(http.statusCode)
        }

        struct Wire: Decodable {
            let token: String
            let expires_at: String
        }
        let wire: Wire
        do {
            wire = try JSONDecoder().decode(Wire.self, from: data)
        } catch {
            throw DeepgramTokenError.decode(String(describing: error))
        }
        guard let expiresAt = parseISO(wire.expires_at) else {
            throw DeepgramTokenError.missingExpiresAt
        }
        cachedToken = wire.token
        cachedExpiresAt = expiresAt
        return wire.token
    }

    private func parseRetryAfter(data: Data, response: HTTPURLResponse) -> Int? {
        if let header = response.value(forHTTPHeaderField: "Retry-After"),
           let secs = Int(header)
        {
            return secs
        }
        if let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let secs = parsed["retry_after_seconds"] as? Int
        {
            return secs
        }
        return nil
    }

    private func parseISO(_ raw: String) -> Date? {
        if let d = Self.isoFractional.date(from: raw) { return d }
        if let d = Self.isoPlain.date(from: raw) { return d }
        return nil
    }

    private static let isoFractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let isoPlain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()
}

// MARK: - Network seam

/// Thin protocol over the one URLSession method DeepgramTokenService
/// actually uses, so tests can stub without dragging URLProtocol in.
protocol URLSessionProtocol {
    func dataForRequest(_ req: URLRequest) async throws -> (Data, URLResponse)
}

extension URLSession: URLSessionProtocol {
    func dataForRequest(_ req: URLRequest) async throws -> (Data, URLResponse) {
        try await self.data(for: req)
    }
}

/// Test stub used by DeepgramTokenServiceTests + (future)
/// DeepgramSTTClient/DeepgramTTSClient integration tests.
final class FakeURLSession: URLSessionProtocol, @unchecked Sendable {
    var nextResults: [(Data, URLResponse)] = []
    var nextErrors: [Error] = []
    private(set) var requests: [URLRequest] = []

    func dataForRequest(_ req: URLRequest) async throws -> (Data, URLResponse) {
        requests.append(req)
        if !nextErrors.isEmpty {
            throw nextErrors.removeFirst()
        }
        guard !nextResults.isEmpty else {
            throw URLError(.badServerResponse)
        }
        return nextResults.removeFirst()
    }
}
