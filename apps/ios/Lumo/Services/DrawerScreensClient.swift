import Foundation

/// Networking layer for the drawer destinations — Memory, Marketplace,
/// History — wired in IOS-COMPOSER-AND-DRAWER-SCREENS-1 Phase B.
///
/// Three endpoints, one client. Each is a thin async wrapper over
/// URLSession that builds the URL relative to `AppConfig.apiBaseURL`,
/// attaches the optional `x-lumo-user-id` header (matches
/// ProactiveMomentsClient's auth fallback for local dev), decodes the
/// response, and surfaces typed errors.
///
/// The brief is iOS-v1 scope: we only consume the fields the iOS UX
/// actually renders. Memory facts + patterns landed in
/// IOS-MEMORY-FACTS-1; marketplace risk badges + OAuth and the
/// history sessions+trips merged timeline are still deferred — see
/// the lane's progress note.

// MARK: - DTOs

/// Subset of web's `/api/memory` response that iOS-v1 consumes. We
/// fold the structured profile into the five categories the brief
/// names — Preferences (airline/seat/budget/payment), Addresses
/// (home/work), Dietary (flags + allergies), Traveler Profiles
/// (display_name + timezone + language), Frequent Flyer (preferred
/// hotel chains as a placeholder slot until full FF-numbers ship).
///
/// Fields default to nil/[] when missing so older snapshots without
/// every key still decode.
struct MemoryProfileDTO: Codable, Equatable {
    let display_name: String?
    let timezone: String?
    let preferred_language: String?
    let home_address: MemoryAddressDTO?
    let work_address: MemoryAddressDTO?
    let dietary_flags: [String]
    let allergies: [String]
    let preferred_airline_class: String?
    let preferred_airline_seat: String?
    let preferred_hotel_chains: [String]
    let budget_tier: String?
    let preferred_payment_hint: String?
    /// IOS-ONBOARDING-1 — narrow shape for the only `extra` keys
    /// iOS reads (the onboarded marker). Web's `extra` is an
    /// open record; iOS only consumes onboarded_at + onboarded_via.
    /// Every field optional so the doc decodes whether or not
    /// the user has been onboarded.
    let extra: MemoryProfileExtraDTO?

    init(
        display_name: String? = nil,
        timezone: String? = nil,
        preferred_language: String? = nil,
        home_address: MemoryAddressDTO? = nil,
        work_address: MemoryAddressDTO? = nil,
        dietary_flags: [String] = [],
        allergies: [String] = [],
        preferred_airline_class: String? = nil,
        preferred_airline_seat: String? = nil,
        preferred_hotel_chains: [String] = [],
        budget_tier: String? = nil,
        preferred_payment_hint: String? = nil,
        extra: MemoryProfileExtraDTO? = nil
    ) {
        self.display_name = display_name
        self.timezone = timezone
        self.preferred_language = preferred_language
        self.home_address = home_address
        self.work_address = work_address
        self.dietary_flags = dietary_flags
        self.allergies = allergies
        self.preferred_airline_class = preferred_airline_class
        self.preferred_airline_seat = preferred_airline_seat
        self.preferred_hotel_chains = preferred_hotel_chains
        self.budget_tier = budget_tier
        self.preferred_payment_hint = preferred_payment_hint
        self.extra = extra
    }

    /// Convenience for the AppRootView onboarding gate. Mirrors
    /// the web onboarding page's idempotency check.
    var isOnboarded: Bool {
        guard let value = extra?.onboarded_at else { return false }
        return !value.isEmpty
    }
}

struct MemoryProfileExtraDTO: Codable, Equatable {
    let onboarded_at: String?
    let onboarded_via: String?
    let connectors_at_onboarding: Int?

    init(
        onboarded_at: String? = nil,
        onboarded_via: String? = nil,
        connectors_at_onboarding: Int? = nil
    ) {
        self.onboarded_at = onboarded_at
        self.onboarded_via = onboarded_via
        self.connectors_at_onboarding = connectors_at_onboarding
    }
}

struct MemoryAddressDTO: Codable, Equatable {
    let label: String?
    let line1: String?
    let city: String?
    let region: String?
    let country: String?

    init(
        label: String? = nil,
        line1: String? = nil,
        city: String? = nil,
        region: String? = nil,
        country: String? = nil
    ) {
        self.label = label
        self.line1 = line1
        self.city = city
        self.region = region
        self.country = country
    }

    /// Single-line summary shown in the row when the user hasn't
    /// expanded the address into the edit form.
    var summary: String {
        if let line1, !line1.isEmpty {
            return [line1, city, region, country].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: ", ")
        }
        return ""
    }
}

/// Web returns `{ profile, facts, patterns }`; iOS now consumes all
/// three. Facts default to [] and patterns default to [] so older
/// snapshots from before facts/patterns shipped still decode.
struct MemoryResponseDTO: Codable, Equatable {
    let profile: MemoryProfileDTO?
    let facts: [MemoryFactDTO]
    let patterns: [MemoryPatternDTO]

    init(
        profile: MemoryProfileDTO? = nil,
        facts: [MemoryFactDTO] = [],
        patterns: [MemoryPatternDTO] = []
    ) {
        self.profile = profile
        self.facts = facts
        self.patterns = patterns
    }

    private enum CodingKeys: String, CodingKey {
        case profile, facts, patterns
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.profile = try c.decodeIfPresent(MemoryProfileDTO.self, forKey: .profile)
        self.facts = (try c.decodeIfPresent([MemoryFactDTO].self, forKey: .facts)) ?? []
        self.patterns = (try c.decodeIfPresent([MemoryPatternDTO].self, forKey: .patterns)) ?? []
    }
}

/// Mirrors web's `UserFact` shape returned from `GET /api/memory`. A
/// soft-deleted fact (web's "Forget" action) is filtered server-side,
/// so iOS only ever sees live facts.
struct MemoryFactDTO: Codable, Equatable, Identifiable {
    let id: String
    let fact: String
    let category: String
    let source: String
    let confidence: Double
    let first_seen_at: String
    let last_confirmed_at: String
}

/// Mirrors web's `BehaviorPattern`. Patterns are read-only — derived
/// nightly by the pattern detector. iOS surfaces them so the user
/// understands what inferences Lumo is drawing.
struct MemoryPatternDTO: Codable, Equatable, Identifiable {
    let id: String
    let pattern_kind: String
    let description: String
    let evidence_count: Int
    let confidence: Double
    let last_observed_at: String
}

/// Subset of web's `/api/marketplace` agent shape iOS renders.
/// IOS-MARKETPLACE-RICH-CARDS-1 added the rich-card fields
/// (risk_badge, connect_model, source/coming_soon) on top of the
/// initial iOS-v1 cut.
struct MarketplaceAgentDTO: Codable, Equatable, Identifiable {
    let agent_id: String
    let display_name: String
    let one_liner: String
    let domain: String
    let intents: [String]
    let install: MarketplaceInstallStateDTO?
    let listing: MarketplaceListingDTO?
    /// `"none" | "oauth2" | "mcp"` etc. — drives the install vs
    /// connect-via-web messaging. Optional for backwards-compat
    /// with older snapshots.
    let connect_model: String?
    /// `"lumo" | "mcp" | "coming_soon"`. When "coming_soon" the
    /// row renders a placeholder pill instead of Install.
    let source: String?
    let coming_soon_label: String?
    let coming_soon_rationale: String?
    let risk_badge: MarketplaceRiskBadgeDTO?

    var id: String { agent_id }

    var isInstalled: Bool { install?.status == "installed" }

    var isComingSoon: Bool { source == "coming_soon" }

    var requiresOAuth: Bool { connect_model == "oauth2" }

    /// True for MCP servers that use bearer-token auth — the only
    /// MCP connect model we ship on iOS today (mirrors web's Phase 1
    /// token-paste path). MCP OAuth (`mcp_oauth`) lands when the
    /// dynamic-client-registration flow ships on the server side.
    var requiresMcpToken: Bool { connect_model == "mcp_bearer" }

    var category: String? { listing?.category }

    init(
        agent_id: String,
        display_name: String,
        one_liner: String,
        domain: String,
        intents: [String] = [],
        install: MarketplaceInstallStateDTO? = nil,
        listing: MarketplaceListingDTO? = nil,
        connect_model: String? = nil,
        source: String? = nil,
        coming_soon_label: String? = nil,
        coming_soon_rationale: String? = nil,
        risk_badge: MarketplaceRiskBadgeDTO? = nil
    ) {
        self.agent_id = agent_id
        self.display_name = display_name
        self.one_liner = one_liner
        self.domain = domain
        self.intents = intents
        self.install = install
        self.listing = listing
        self.connect_model = connect_model
        self.source = source
        self.coming_soon_label = coming_soon_label
        self.coming_soon_rationale = coming_soon_rationale
        self.risk_badge = risk_badge
    }
}

/// Mirror of web's risk_badge shape. iOS renders the level pill +
/// surfaces the reasons via the row's accessibility hint so the
/// affordance is non-mystery for VoiceOver users.
struct MarketplaceRiskBadgeDTO: Codable, Equatable {
    let level: String
    let score: Double?
    let reasons: [String]
    let mitigations: [String]?
    let source: String?
    let latency_ms: Double?
}

struct MarketplaceInstallStateDTO: Codable, Equatable {
    let status: String
    let installed_at: String?
}

struct MarketplaceListingDTO: Codable, Equatable {
    let category: String?
    let pricing_note: String?
}

struct MarketplaceResponseDTO: Codable, Equatable {
    let agents: [MarketplaceAgentDTO]
}

/// History sessions list. The merged sessions+trips timeline (with
/// day grouping + search) is IOS-HISTORY-TIMELINE-1; this DTO carries
/// the raw sessions array.
struct HistorySessionDTO: Codable, Equatable, Identifiable {
    let session_id: String
    let started_at: String
    let last_activity_at: String
    let user_message_count: Int
    let preview: String?
    let trip_ids: [String]

    var id: String { session_id }

    var tripCount: Int { trip_ids.count }
}

/// IOS-HISTORY-TRIP-DETAIL-1 — Trips array returned alongside
/// sessions. Mirrors web's `TripHistoryRow`. iOS-v1 renders title,
/// status, total amount, and an expandable leg list. Trip cancel is
/// a separate lane.
struct HistoryTripDTO: Codable, Equatable, Identifiable {
    let trip_id: String
    let session_id: String
    let status: String
    let payload: HistoryTripPayloadDTO
    let created_at: String
    let updated_at: String
    let cancel_requested_at: String?

    var id: String { trip_id }
}

struct HistoryTripPayloadDTO: Codable, Equatable {
    let trip_title: String?
    let total_amount: String?
    let currency: String?
    let legs: [HistoryTripLegDTO]?

    init(
        trip_title: String? = nil,
        total_amount: String? = nil,
        currency: String? = nil,
        legs: [HistoryTripLegDTO]? = nil
    ) {
        self.trip_title = trip_title
        self.total_amount = total_amount
        self.currency = currency
        self.legs = legs
    }
}

/// Leg subset iOS renders. Web's `summary.payload` is unstructured
/// (`unknown`) and powers a per-leg amount display via best-effort
/// key lookups; iOS-v1 skips the amount until a typed payload
/// shape is available.
struct HistoryTripLegDTO: Codable, Equatable, Identifiable {
    let order: Int
    let agent_id: String
    let tool_name: String?

    var id: Int { order }
}

/// Response from `POST /api/trip/{id}/cancel`. iOS surfaces
/// `message` on success and uses `new_status` to know whether the
/// cancel was synchronous (rolled_back) vs queued (dispatching).
struct CancelTripResultDTO: Codable, Equatable {
    let trip_id: String
    let prior_status: String
    let action: String
    let new_status: String
    let message: String?
}

/// IOS-CONNECTIONS-1 — mirror of web's ConnectionMeta shape from
/// `GET /api/connections`. iOS-v1 renders status, scopes, source,
/// connected/last-used timestamps, and a Disconnect action gated on
/// source=="oauth" (system rows can't be revoked, matching web).
struct ConnectionMetaDTO: Codable, Equatable, Identifiable {
    let id: String
    let agent_id: String
    let display_name: String?
    let one_liner: String?
    let source: String?
    let status: String
    let scopes: [String]
    let expires_at: String?
    let connected_at: String
    let last_used_at: String?
    let revoked_at: String?
    let updated_at: String

    var isSystem: Bool { source == "system" }
    var isActive: Bool { status == "active" }
}

struct ConnectionsResponseDTO: Codable, Equatable {
    let connections: [ConnectionMetaDTO]
}

struct HistoryResponseDTO: Codable, Equatable {
    let sessions: [HistorySessionDTO]
    let trips: [HistoryTripDTO]

    init(sessions: [HistorySessionDTO] = [], trips: [HistoryTripDTO] = []) {
        self.sessions = sessions
        self.trips = trips
    }

    private enum CodingKeys: String, CodingKey { case sessions, trips }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.sessions = (try c.decodeIfPresent([HistorySessionDTO].self, forKey: .sessions)) ?? []
        self.trips = (try c.decodeIfPresent([HistoryTripDTO].self, forKey: .trips)) ?? []
    }
}

// MARK: - Errors

enum DrawerScreensError: Error, Equatable {
    case badStatus(Int)
    case decode(String)
    case transport(String)
    /// 409 from `POST /api/lumo/mission/install` — agent's
    /// `connect.model === "oauth2"` and Lumo isn't a first-party
    /// connection provider for it. iOS marketplace doesn't yet have
    /// the OAuth start flow (`IOS-MARKETPLACE-RICH-CARDS-1`), so we
    /// route this to a "install via web for now" UX.
    case oauthRequired
    /// 404 unknown_agent — the agent_id wasn't in the registry.
    case unknownAgent
    /// 404 trip_not_found — the trip_id is unknown.
    case unknownTrip
    /// 409 from `POST /api/trip/{id}/cancel` — the trip is already
    /// in a terminal state (rolled_back / rollback_failed) so cancel
    /// is a no-op. UI should fall through to escalation messaging
    /// rather than acting like the request failed.
    case tripAlreadyTerminal(currentStatus: String?)
}

// MARK: - Protocol

protocol DrawerScreensFetching: AnyObject {
    func fetchMemory() async throws -> MemoryResponseDTO
    func fetchMarketplace() async throws -> MarketplaceResponseDTO
    func fetchHistory(limitSessions: Int) async throws -> HistoryResponseDTO
    func updateMemoryProfile(_ patch: MemoryProfilePatchDTO) async throws -> MemoryProfileDTO
    func forgetMemoryFact(id: String) async throws
    /// Install the marketplace agent for the current user. Mirrors
    /// the chat install-card flow (`POST /api/lumo/mission/install`)
    /// minus the mission/session context — for standalone catalog
    /// installs. Returns the ISO timestamp the install was committed.
    func installAgent(id: String) async throws -> String
    /// User-initiated trip cancel/refund. Behavior depends on the
    /// trip's current status (see web's `/api/trip/{id}/cancel`
    /// route doc). Returns the server's structured response so
    /// the UI can surface the right message + new status.
    func cancelTrip(id: String, reason: String?) async throws -> CancelTripResultDTO
    /// IOS-CONNECTIONS-1 — list the user's connected agents
    /// (OAuth + system) for the Connections drawer destination.
    func fetchConnections() async throws -> ConnectionsResponseDTO
    /// Revoke a specific connection. System connections (id prefix
    /// `system:`) are not revocable on the server; iOS gates this
    /// at the UI layer to avoid the 404 round-trip.
    func disconnectConnection(id: String) async throws
    /// IOS-ONBOARDING-1 — PATCH the onboarded marker. Web sets
    /// `extra.onboarded_at` on the user_profile so the next
    /// /onboarding visit redirects out; iOS uses the same field.
    func markUserOnboarded(via: String) async throws
    /// IOS-MCP-CONNECT-1 — paste-bearer connect for MCP servers.
    /// Mirrors web's POST /api/mcp/connections {server_id, access_token}.
    func connectMcpServer(serverID: String, accessToken: String) async throws
}

/// PATCH body for `/api/memory/profile`. Only fields the iOS-v1 edit
/// form mutates land here. JSONEncoder skips nils when configured
/// with `keyEncodingStrategy = .useDefaultKeys` and a custom
/// `encode(to:)` — but we keep it simple and let server-side ignore
/// unknown keys.
struct MemoryProfilePatchDTO: Codable, Equatable {
    var display_name: String??
    var dietary_flags: [String]?
    var allergies: [String]?
    var preferred_airline_class: String??
    var preferred_airline_seat: String??
    var budget_tier: String??

    init(
        display_name: String?? = nil,
        dietary_flags: [String]? = nil,
        allergies: [String]? = nil,
        preferred_airline_class: String?? = nil,
        preferred_airline_seat: String?? = nil,
        budget_tier: String?? = nil
    ) {
        self.display_name = display_name
        self.dietary_flags = dietary_flags
        self.allergies = allergies
        self.preferred_airline_class = preferred_airline_class
        self.preferred_airline_seat = preferred_airline_seat
        self.budget_tier = budget_tier
    }

    func toJSONObject() -> [String: Any] {
        var dict: [String: Any] = [:]
        if let dn = display_name { dict["display_name"] = dn as Any? ?? NSNull() }
        if let df = dietary_flags { dict["dietary_flags"] = df }
        if let al = allergies { dict["allergies"] = al }
        if let pac = preferred_airline_class { dict["preferred_airline_class"] = pac as Any? ?? NSNull() }
        if let pas = preferred_airline_seat { dict["preferred_airline_seat"] = pas as Any? ?? NSNull() }
        if let bt = budget_tier { dict["budget_tier"] = bt as Any? ?? NSNull() }
        return dict
    }
}

// MARK: - Concrete client

final class DrawerScreensClient: DrawerScreensFetching {
    private let baseURL: URL
    private let session: URLSession
    private let userIDProvider: () -> String?
    private let accessTokenProvider: () -> String?

    init(
        baseURL: URL,
        userIDProvider: @escaping () -> String?,
        accessTokenProvider: @escaping () -> String? = { nil },
        session: URLSession = .shared
    ) {
        self.baseURL = baseURL
        self.session = session
        self.userIDProvider = userIDProvider
        self.accessTokenProvider = accessTokenProvider
    }

    func fetchMemory() async throws -> MemoryResponseDTO {
        try await get(path: "api/memory", as: MemoryResponseDTO.self)
    }

    func fetchMarketplace() async throws -> MarketplaceResponseDTO {
        try await get(path: "api/marketplace", as: MarketplaceResponseDTO.self)
    }

    func fetchHistory(limitSessions: Int = 30) async throws -> HistoryResponseDTO {
        try await get(path: "api/history?limit_sessions=\(limitSessions)", as: HistoryResponseDTO.self)
    }

    func connectMcpServer(serverID: String, accessToken: String) async throws {
        guard !serverID.isEmpty else { throw DrawerScreensError.transport("missing server id") }
        guard !accessToken.isEmpty else { throw DrawerScreensError.transport("missing access token") }
        let url = baseURL.appendingPathComponent("api/mcp/connections")
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let userID = userIDProvider(), !userID.isEmpty {
            req.setValue(userID, forHTTPHeaderField: "x-lumo-user-id")
        }
        if let token = accessTokenProvider(), !token.isEmpty {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        let body: [String: Any] = [
            "server_id": serverID,
            "access_token": accessToken,
        ]
        req.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await session.data(for: req)
        } catch {
            throw DrawerScreensError.transport("\(error)")
        }
        try Self.expectOK(response, data: data)
    }

    func markUserOnboarded(via: String) async throws {
        let url = baseURL.appendingPathComponent("api/memory/profile")
        var req = URLRequest(url: url)
        req.httpMethod = "PATCH"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let userID = userIDProvider(), !userID.isEmpty {
            req.setValue(userID, forHTTPHeaderField: "x-lumo-user-id")
        }
        if let token = accessTokenProvider(), !token.isEmpty {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        let extra: [String: Any] = [
            "onboarded_at": ISO8601DateFormatter().string(from: Date()),
            "onboarded_via": via,
        ]
        let body: [String: Any] = ["extra": extra]
        req.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await session.data(for: req)
        } catch {
            throw DrawerScreensError.transport("\(error)")
        }
        try Self.expectOK(response, data: data)
    }

    func fetchConnections() async throws -> ConnectionsResponseDTO {
        try await get(path: "api/connections", as: ConnectionsResponseDTO.self)
    }

    func disconnectConnection(id: String) async throws {
        guard !id.isEmpty else { throw DrawerScreensError.transport("missing connection id") }
        let url = baseURL.appendingPathComponent("api/connections/disconnect")
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let userID = userIDProvider(), !userID.isEmpty {
            req.setValue(userID, forHTTPHeaderField: "x-lumo-user-id")
        }
        if let token = accessTokenProvider(), !token.isEmpty {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        let body: [String: Any] = ["connection_id": id]
        req.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await session.data(for: req)
        } catch {
            throw DrawerScreensError.transport("\(error)")
        }
        try Self.expectOK(response, data: data)
    }

    func cancelTrip(id: String, reason: String?) async throws -> CancelTripResultDTO {
        guard !id.isEmpty else { throw DrawerScreensError.transport("missing trip id") }
        let url = baseURL.appendingPathComponent("api/trip/\(id)/cancel")
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let userID = userIDProvider(), !userID.isEmpty {
            req.setValue(userID, forHTTPHeaderField: "x-lumo-user-id")
        }
        if let token = accessTokenProvider(), !token.isEmpty {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let reason, !reason.isEmpty {
            let body: [String: Any] = ["reason": reason]
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        } else {
            // The endpoint accepts an empty POST; an explicit empty
            // body keeps proxies/CDNs that demand Content-Length happy.
            req.httpBody = Data("{}".utf8)
        }

        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await session.data(for: req)
        } catch {
            throw DrawerScreensError.transport("\(error)")
        }
        guard let http = response as? HTTPURLResponse else {
            throw DrawerScreensError.transport("non-http response")
        }
        // 202 (cancel_requested for dispatching) is a success.
        if (200..<300).contains(http.statusCode) {
            do {
                return try JSONDecoder().decode(CancelTripResultDTO.self, from: data)
            } catch {
                throw DrawerScreensError.decode("\(error)")
            }
        }
        switch http.statusCode {
        case 404: throw DrawerScreensError.unknownTrip
        case 409:
            // Pull current status out of the response when present so
            // the UI can show "Already cancelled" rather than a
            // generic error.
            struct TerminalBody: Decodable { let new_status: String? }
            let parsed = try? JSONDecoder().decode(TerminalBody.self, from: data)
            throw DrawerScreensError.tripAlreadyTerminal(currentStatus: parsed?.new_status)
        default:
            throw DrawerScreensError.badStatus(http.statusCode)
        }
    }

    func installAgent(id: String) async throws -> String {
        guard !id.isEmpty else { throw DrawerScreensError.transport("missing agent id") }
        let url = baseURL.appendingPathComponent("api/lumo/mission/install")
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let userID = userIDProvider(), !userID.isEmpty {
            req.setValue(userID, forHTTPHeaderField: "x-lumo-user-id")
        }
        if let token = accessTokenProvider(), !token.isEmpty {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        // Standalone marketplace install — no mission/session context.
        // The endpoint requires `user_approved: true`; iOS surfaces
        // the confirm via the Install button itself.
        let body: [String: Any] = ["agent_id": id, "user_approved": true]
        req.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await session.data(for: req)
        } catch {
            throw DrawerScreensError.transport("\(error)")
        }
        guard let http = response as? HTTPURLResponse else {
            throw DrawerScreensError.transport("non-http response")
        }
        if (200..<300).contains(http.statusCode) {
            struct Wrapped: Decodable {
                struct Install: Decodable { let installed_at: String? }
                let install: Install?
            }
            let parsed = try? JSONDecoder().decode(Wrapped.self, from: data)
            return parsed?.install?.installed_at ?? ISO8601DateFormatter().string(from: Date())
        }
        switch http.statusCode {
        case 409: throw DrawerScreensError.oauthRequired
        case 404: throw DrawerScreensError.unknownAgent
        default: throw DrawerScreensError.badStatus(http.statusCode)
        }
    }

    func forgetMemoryFact(id: String) async throws {
        guard !id.isEmpty else {
            throw DrawerScreensError.transport("missing fact id")
        }
        let url = baseURL.appendingPathComponent("api/memory/facts/\(id)")
        var req = URLRequest(url: url)
        req.httpMethod = "DELETE"
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let userID = userIDProvider(), !userID.isEmpty {
            req.setValue(userID, forHTTPHeaderField: "x-lumo-user-id")
        }
        if let token = accessTokenProvider(), !token.isEmpty {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await session.data(for: req)
        } catch {
            throw DrawerScreensError.transport("\(error)")
        }
        try Self.expectOK(response, data: data)
    }

    func updateMemoryProfile(_ patch: MemoryProfilePatchDTO) async throws -> MemoryProfileDTO {
        let url = baseURL.appendingPathComponent("api/memory/profile")
        var req = URLRequest(url: url)
        req.httpMethod = "PATCH"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let userID = userIDProvider(), !userID.isEmpty {
            req.setValue(userID, forHTTPHeaderField: "x-lumo-user-id")
        }
        if let token = accessTokenProvider(), !token.isEmpty {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        req.httpBody = try JSONSerialization.data(withJSONObject: patch.toJSONObject())

        let (data, response) = try await session.data(for: req)
        try Self.expectOK(response, data: data)

        struct Wrapped: Codable { let profile: MemoryProfileDTO }
        do {
            return try JSONDecoder().decode(Wrapped.self, from: data).profile
        } catch {
            throw DrawerScreensError.decode("\(error)")
        }
    }

    // MARK: - Helpers

    private func get<T: Decodable>(path: String, as: T.Type) async throws -> T {
        guard let url = URL(string: path, relativeTo: baseURL) else {
            throw DrawerScreensError.transport("invalid url path: \(path)")
        }
        var req = URLRequest(url: url)
        req.httpMethod = "GET"
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let userID = userIDProvider(), !userID.isEmpty {
            req.setValue(userID, forHTTPHeaderField: "x-lumo-user-id")
        }
        if let token = accessTokenProvider(), !token.isEmpty {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await session.data(for: req)
        } catch {
            throw DrawerScreensError.transport("\(error)")
        }
        try Self.expectOK(response, data: data)
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw DrawerScreensError.decode("\(error)")
        }
    }

    private static func expectOK(_ response: URLResponse, data: Data) throws {
        guard let http = response as? HTTPURLResponse else {
            throw DrawerScreensError.transport("non-http response")
        }
        guard (200..<300).contains(http.statusCode) else {
            throw DrawerScreensError.badStatus(http.statusCode)
        }
    }
}

// MARK: - Test stub

/// Test stub for DrawerScreensFetching. Each method has a settable
/// nextResult so tests can drive success and failure paths without a
/// real network. Used by both the unit tests and the DEBUG fixture
/// seed in RootView.
final class FakeDrawerScreensFetcher: DrawerScreensFetching {
    var memoryResult: Result<MemoryResponseDTO, Error> =
        .success(MemoryResponseDTO(profile: nil))
    var marketplaceResult: Result<MarketplaceResponseDTO, Error> =
        .success(MarketplaceResponseDTO(agents: []))
    var historyResult: Result<HistoryResponseDTO, Error> =
        .success(HistoryResponseDTO(sessions: []))
    var memoryUpdateResult: Result<MemoryProfileDTO, Error> =
        .success(MemoryProfileDTO())
    var forgetFactResult: Result<Void, Error> = .success(())
    var installAgentResult: Result<String, Error> =
        .success("2026-05-03T00:00:00Z")
    var cancelTripResult: Result<CancelTripResultDTO, Error> =
        .success(CancelTripResultDTO(
            trip_id: "t1",
            prior_status: "draft",
            action: "cancel_recorded",
            new_status: "draft",
            message: "Cancellation recorded."
        ))
    var connectionsResult: Result<ConnectionsResponseDTO, Error> =
        .success(ConnectionsResponseDTO(connections: []))
    var disconnectResult: Result<Void, Error> = .success(())
    var markOnboardedResult: Result<Void, Error> = .success(())
    var connectMcpResult: Result<Void, Error> = .success(())

    private(set) var memoryFetchCount = 0
    private(set) var marketplaceFetchCount = 0
    private(set) var historyFetchCount = 0
    private(set) var memoryUpdateCalls: [MemoryProfilePatchDTO] = []
    private(set) var forgetFactCalls: [String] = []
    private(set) var installAgentCalls: [String] = []
    private(set) var cancelTripCalls: [(id: String, reason: String?)] = []
    private(set) var connectionsFetchCount = 0
    private(set) var disconnectCalls: [String] = []
    private(set) var markOnboardedCalls: [String] = []
    private(set) var connectMcpCalls: [(serverID: String, accessToken: String)] = []

    func fetchMemory() async throws -> MemoryResponseDTO {
        memoryFetchCount += 1
        switch memoryResult {
        case .success(let r): return r
        case .failure(let e): throw e
        }
    }

    func fetchMarketplace() async throws -> MarketplaceResponseDTO {
        marketplaceFetchCount += 1
        switch marketplaceResult {
        case .success(let r): return r
        case .failure(let e): throw e
        }
    }

    func fetchHistory(limitSessions: Int) async throws -> HistoryResponseDTO {
        historyFetchCount += 1
        switch historyResult {
        case .success(let r): return r
        case .failure(let e): throw e
        }
    }

    func updateMemoryProfile(_ patch: MemoryProfilePatchDTO) async throws -> MemoryProfileDTO {
        memoryUpdateCalls.append(patch)
        switch memoryUpdateResult {
        case .success(let r): return r
        case .failure(let e): throw e
        }
    }

    func forgetMemoryFact(id: String) async throws {
        forgetFactCalls.append(id)
        switch forgetFactResult {
        case .success: return
        case .failure(let e): throw e
        }
    }

    func installAgent(id: String) async throws -> String {
        installAgentCalls.append(id)
        switch installAgentResult {
        case .success(let r): return r
        case .failure(let e): throw e
        }
    }

    func cancelTrip(id: String, reason: String?) async throws -> CancelTripResultDTO {
        cancelTripCalls.append((id, reason))
        switch cancelTripResult {
        case .success(let r): return r
        case .failure(let e): throw e
        }
    }

    func fetchConnections() async throws -> ConnectionsResponseDTO {
        connectionsFetchCount += 1
        switch connectionsResult {
        case .success(let r): return r
        case .failure(let e): throw e
        }
    }

    func disconnectConnection(id: String) async throws {
        disconnectCalls.append(id)
        switch disconnectResult {
        case .success: return
        case .failure(let e): throw e
        }
    }

    func markUserOnboarded(via: String) async throws {
        markOnboardedCalls.append(via)
        switch markOnboardedResult {
        case .success: return
        case .failure(let e): throw e
        }
    }

    func connectMcpServer(serverID: String, accessToken: String) async throws {
        connectMcpCalls.append((serverID, accessToken))
        switch connectMcpResult {
        case .success: return
        case .failure(let e): throw e
        }
    }
}

// MARK: - DTO helpers

extension MarketplaceAgentDTO {
    /// Returns a copy of this agent with `install` stamped to
    /// `installed` at the given ISO timestamp. Used by
    /// `MarketplaceScreenViewModel` to update the loaded list
    /// after a successful install without round-tripping the catalog.
    func markedInstalled(at iso: String) -> MarketplaceAgentDTO {
        MarketplaceAgentDTO(
            agent_id: agent_id,
            display_name: display_name,
            one_liner: one_liner,
            domain: domain,
            intents: intents,
            install: MarketplaceInstallStateDTO(status: "installed", installed_at: iso),
            listing: listing,
            connect_model: connect_model,
            source: source,
            coming_soon_label: coming_soon_label,
            coming_soon_rationale: coming_soon_rationale,
            risk_badge: risk_badge
        )
    }
}
