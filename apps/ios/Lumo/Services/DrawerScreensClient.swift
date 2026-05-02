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
/// actually renders. Web's richer schemas (memory facts + patterns,
/// marketplace risk badges + OAuth, history sessions+trips merged
/// timeline) are filed deferred — see the lane's progress note.

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
        preferred_payment_hint: String? = nil
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

/// Web returns `{ profile, facts, patterns }`. iOS-v1 only renders
/// the profile section; facts + patterns drop on the floor here and
/// IOS-MEMORY-FACTS-1 will pick them up.
struct MemoryResponseDTO: Codable, Equatable {
    let profile: MemoryProfileDTO?
}

/// Subset of web's `/api/marketplace` agent shape that iOS-v1 lists.
/// We drop risk badges, OAuth `connect_model`, MCP fields,
/// `coming_soon` metadata, etc — IOS-MARKETPLACE-RICH-CARDS-1 picks
/// those up.
struct MarketplaceAgentDTO: Codable, Equatable, Identifiable {
    let agent_id: String
    let display_name: String
    let one_liner: String
    let domain: String
    let intents: [String]
    let install: MarketplaceInstallStateDTO?
    let listing: MarketplaceListingDTO?

    var id: String { agent_id }

    var isInstalled: Bool { install?.status == "installed" }

    var category: String? { listing?.category }

    init(
        agent_id: String,
        display_name: String,
        one_liner: String,
        domain: String,
        intents: [String] = [],
        install: MarketplaceInstallStateDTO? = nil,
        listing: MarketplaceListingDTO? = nil
    ) {
        self.agent_id = agent_id
        self.display_name = display_name
        self.one_liner = one_liner
        self.domain = domain
        self.intents = intents
        self.install = install
        self.listing = listing
    }
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

/// History sessions list. iOS-v1 only renders the `sessions` array;
/// the merged sessions+trips timeline is IOS-HISTORY-TIMELINE-1.
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

struct HistoryResponseDTO: Codable, Equatable {
    let sessions: [HistorySessionDTO]
}

// MARK: - Errors

enum DrawerScreensError: Error, Equatable {
    case badStatus(Int)
    case decode(String)
    case transport(String)
}

// MARK: - Protocol

protocol DrawerScreensFetching: AnyObject {
    func fetchMemory() async throws -> MemoryResponseDTO
    func fetchMarketplace() async throws -> MarketplaceResponseDTO
    func fetchHistory(limitSessions: Int) async throws -> HistoryResponseDTO
    func updateMemoryProfile(_ patch: MemoryProfilePatchDTO) async throws -> MemoryProfileDTO
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

    private(set) var memoryFetchCount = 0
    private(set) var marketplaceFetchCount = 0
    private(set) var historyFetchCount = 0
    private(set) var memoryUpdateCalls: [MemoryProfilePatchDTO] = []

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
}
