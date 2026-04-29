import Foundation

/// HTTP client for `/api/proactive/recent`. Used by both the in-app
/// proactive feed (foreground refresh) and the background fetch
/// handler. Returns the decoded `[ProactiveMoment]` ordered by
/// `createdAt` descending.

struct ProactiveMomentAction: Codable, Equatable {
    let label: String
    /// Optional deeplink URL — when present, the action button taps
    /// open the linked surface.
    let deeplink: String?
    /// Optional chat prefill — when present, the action button taps
    /// the Chat tab and pre-fills the composer with this string.
    let chatPrefill: String?

    enum CodingKeys: String, CodingKey {
        case label
        case deeplink
        case chatPrefill
    }
}

struct ProactiveMoment: Codable, Identifiable, Equatable {
    let id: String
    /// Backend category — matches `NotificationCategory.rawValue` for
    /// the categories that surface as proactive moments. The fourth
    /// category (`alert`) is push-only and never appears in the feed.
    let category: String
    let headline: String
    let body: String
    let primaryAction: ProactiveMomentAction
    let createdAt: Date
    let expiresAt: Date

    /// Convenience: maps the string category to the typed enum, or nil
    /// if the server emits a category we don't recognize. UI ignores
    /// nil-typed moments.
    var typedCategory: NotificationCategory? {
        NotificationCategory(rawValue: category)
    }

    /// True when the server-issued expiry is in the past. The view
    /// filters these out on every render.
    func isExpired(now: Date = Date()) -> Bool {
        expiresAt < now
    }
}

struct ProactiveMomentsResponse: Codable, Equatable {
    let generatedAt: Date
    let moments: [ProactiveMoment]
}

protocol ProactiveMomentsFetching: AnyObject {
    func fetchRecent() async throws -> ProactiveMomentsResponse
}

final class ProactiveMomentsClient: ProactiveMomentsFetching {
    private let baseURL: URL
    private let session: URLSession
    private let userIDProvider: () -> String?

    init(
        baseURL: URL,
        userIDProvider: @escaping () -> String?,
        session: URLSession = .shared
    ) {
        self.baseURL = baseURL
        self.session = session
        self.userIDProvider = userIDProvider
    }

    func fetchRecent() async throws -> ProactiveMomentsResponse {
        let url = baseURL.appendingPathComponent("api/proactive/recent")
        var req = URLRequest(url: url)
        req.httpMethod = "GET"
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let userID = userIDProvider(), !userID.isEmpty {
            req.setValue(userID, forHTTPHeaderField: "x-lumo-user-id")
        }
        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw NotificationServiceError.badStatus(
                (response as? HTTPURLResponse)?.statusCode ?? -1,
                String(data: data, encoding: .utf8)
            )
        }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let raw = try container.decode(String.self)
            if let d = ProactiveMomentsClient.iso8601Fractional.date(from: raw) { return d }
            if let d = ProactiveMomentsClient.iso8601Plain.date(from: raw) { return d }
            throw NotificationServiceError.badStatus(0, "invalid iso8601: \(raw)")
        }
        return try decoder.decode(ProactiveMomentsResponse.self, from: data)
    }

    private static let iso8601Fractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static let iso8601Plain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()
}

/// Test stub — drives ViewModel + background-fetch logic deterministically.
final class FakeProactiveMomentsFetcher: ProactiveMomentsFetching {
    var nextResult: Result<ProactiveMomentsResponse, Error> = .success(
        ProactiveMomentsResponse(generatedAt: Date(), moments: [])
    )
    private(set) var fetchCallCount = 0

    func fetchRecent() async throws -> ProactiveMomentsResponse {
        fetchCallCount += 1
        switch nextResult {
        case .success(let r): return r
        case .failure(let e): throw e
        }
    }
}
