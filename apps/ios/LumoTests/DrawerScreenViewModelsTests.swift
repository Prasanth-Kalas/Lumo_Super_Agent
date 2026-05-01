import XCTest
@testable import Lumo

/// IOS-COMPOSER-AND-DRAWER-SCREENS-1 Phase B — Memory / Marketplace /
/// History contract tests.
///
/// Three slices:
///
///   1. DTO decode — assert each `/api/{memory,marketplace,history}`
///      response shape decodes from a representative JSON payload,
///      and tolerates older snapshots that omit optional fields.
///
///   2. ViewModel state machine — `idle → loading → loaded` on
///      success, `idle → loading → error` on failure. PATCH path on
///      MemoryScreenViewModel surfaces save errors without losing
///      the loaded profile.
///
///   3. HistoryTimeFormatter — mirrors web's `format-time-since.ts`
///      contract bucket-by-bucket: `now`, "<n> min, <s> sec",
///      "<h> hr, <m> min", "<d> day, <h> hr", date for >7d. Tested
///      via `relativeTo:` so we don't depend on the wall clock.
@MainActor
final class DrawerScreenViewModelsTests: XCTestCase {

    // MARK: - 1. DTO decode

    func test_memoryResponse_decodes_withFullProfile() throws {
        let json = """
        {
          "profile": {
            "display_name": "Alex",
            "timezone": "America/Chicago",
            "preferred_language": "en",
            "home_address": {"line1": "1 Market St", "city": "SF"},
            "work_address": null,
            "dietary_flags": ["vegetarian"],
            "allergies": ["shellfish"],
            "preferred_airline_class": "economy",
            "preferred_airline_seat": "aisle",
            "preferred_hotel_chains": [],
            "budget_tier": "standard",
            "preferred_payment_hint": null
          }
        }
        """.data(using: .utf8)!
        let decoded = try JSONDecoder().decode(MemoryResponseDTO.self, from: json)
        XCTAssertEqual(decoded.profile?.display_name, "Alex")
        XCTAssertEqual(decoded.profile?.dietary_flags, ["vegetarian"])
        XCTAssertEqual(decoded.profile?.home_address?.line1, "1 Market St")
    }

    func test_memoryResponse_decodes_withNullProfile() throws {
        let json = #"{"profile": null}"#.data(using: .utf8)!
        let decoded = try JSONDecoder().decode(MemoryResponseDTO.self, from: json)
        XCTAssertNil(decoded.profile)
    }

    func test_marketplaceResponse_decodes_subsetOfWebSchema() throws {
        // Web returns much more (risk_badge, connect_model, MCP, etc).
        // iOS only consumes a subset; the decoder must NOT throw on
        // the extra unknown keys.
        let json = """
        {
          "agents": [
            {
              "agent_id": "lumo-flights",
              "display_name": "Lumo Flights",
              "one_liner": "Search and book flights via Duffel.",
              "domain": "flights",
              "intents": ["book_flight"],
              "install": {"status": "installed", "installed_at": "2026-04-30T12:00:00Z"},
              "listing": {"category": "travel", "pricing_note": null},
              "version": "0.1.0",
              "connect_model": "none",
              "required_scopes": [],
              "health_score": 1,
              "risk_badge": {"level": "low", "score": 0.1, "reasons": [], "mitigations": [], "source": "ml", "latency_ms": 50}
            }
          ]
        }
        """.data(using: .utf8)!
        let decoded = try JSONDecoder().decode(MarketplaceResponseDTO.self, from: json)
        XCTAssertEqual(decoded.agents.count, 1)
        XCTAssertEqual(decoded.agents[0].agent_id, "lumo-flights")
        XCTAssertEqual(decoded.agents[0].isInstalled, true)
    }

    func test_historyResponse_decodes_sessionsAndIgnoresTrips() throws {
        // iOS-v1 only renders sessions; the trips array is part of
        // the wire contract but not consumed here. Decoder should
        // happily ignore trips presence.
        let json = """
        {
          "sessions": [
            {
              "session_id": "s1",
              "started_at": "2026-04-30T10:00:00Z",
              "last_activity_at": "2026-04-30T10:08:00Z",
              "user_message_count": 4,
              "preview": "Plan a Vegas trip",
              "trip_ids": ["t1", "t2"]
            }
          ],
          "trips": [{"trip_id": "t1"}]
        }
        """.data(using: .utf8)!
        let decoded = try JSONDecoder().decode(HistoryResponseDTO.self, from: json)
        XCTAssertEqual(decoded.sessions.count, 1)
        XCTAssertEqual(decoded.sessions[0].tripCount, 2)
        XCTAssertEqual(decoded.sessions[0].preview, "Plan a Vegas trip")
    }

    // MARK: - 2. ViewModel state machines

    func test_memoryVM_load_success_transitionsToLoaded() async {
        let fake = FakeDrawerScreensFetcher()
        fake.memoryResult = .success(
            MemoryResponseDTO(profile: MemoryProfileDTO(display_name: "Alex"))
        )
        let vm = MemoryScreenViewModel(fetcher: fake)
        XCTAssertEqual(vm.state, .idle)
        await vm.load()
        guard case .loaded(let profile) = vm.state else {
            return XCTFail("expected .loaded; got \(vm.state)")
        }
        XCTAssertEqual(profile.display_name, "Alex")
        XCTAssertEqual(fake.memoryFetchCount, 1)
    }

    func test_memoryVM_load_failure_transitionsToError() async {
        let fake = FakeDrawerScreensFetcher()
        fake.memoryResult = .failure(DrawerScreensError.badStatus(503))
        let vm = MemoryScreenViewModel(fetcher: fake)
        await vm.load()
        guard case .error(let msg) = vm.state else {
            return XCTFail("expected .error; got \(vm.state)")
        }
        XCTAssertTrue(msg.contains("503"), "error message should surface the HTTP code")
    }

    func test_memoryVM_save_success_updatesLoadedProfile() async {
        let fake = FakeDrawerScreensFetcher()
        fake.memoryResult = .success(
            MemoryResponseDTO(profile: MemoryProfileDTO(display_name: "Alex"))
        )
        fake.memoryUpdateResult = .success(MemoryProfileDTO(display_name: "Lex"))
        let vm = MemoryScreenViewModel(fetcher: fake)
        await vm.load()

        let patch = MemoryProfilePatchDTO(display_name: .some("Lex"))
        await vm.save(patch)

        guard case .loaded(let p) = vm.state else {
            return XCTFail("expected .loaded after save; got \(vm.state)")
        }
        XCTAssertEqual(p.display_name, "Lex")
        XCTAssertNil(vm.saveError)
        XCTAssertEqual(fake.memoryUpdateCalls.count, 1)
    }

    func test_memoryVM_save_failure_surfacesErrorWithoutLosingProfile() async {
        let fake = FakeDrawerScreensFetcher()
        fake.memoryResult = .success(
            MemoryResponseDTO(profile: MemoryProfileDTO(display_name: "Alex"))
        )
        fake.memoryUpdateResult = .failure(DrawerScreensError.transport("network"))
        let vm = MemoryScreenViewModel(fetcher: fake)
        await vm.load()

        await vm.save(MemoryProfilePatchDTO(display_name: .some("Lex")))

        XCTAssertNotNil(vm.saveError, "save error should surface")
        guard case .loaded(let p) = vm.state else {
            return XCTFail("loaded profile must survive a failed save")
        }
        XCTAssertEqual(p.display_name, "Alex", "failed save must not blank the loaded profile")
    }

    func test_marketplaceVM_load_success_listsAgents() async {
        let fake = FakeDrawerScreensFetcher()
        fake.marketplaceResult = .success(MarketplaceResponseDTO(agents: [
            MarketplaceAgentDTO(agent_id: "a", display_name: "A", one_liner: "x", domain: "flights"),
        ]))
        let vm = MarketplaceScreenViewModel(fetcher: fake)
        await vm.load()
        guard case .loaded(let agents) = vm.state else {
            return XCTFail("expected loaded; got \(vm.state)")
        }
        XCTAssertEqual(agents.count, 1)
    }

    func test_marketplaceVM_load_emptyAgents_loadsEmptyArray() async {
        // Empty array distinct from .loading — the view's empty-state
        // branch keys off `loaded([])`, not `loaded(_) where isEmpty`.
        let fake = FakeDrawerScreensFetcher()
        fake.marketplaceResult = .success(MarketplaceResponseDTO(agents: []))
        let vm = MarketplaceScreenViewModel(fetcher: fake)
        await vm.load()
        guard case .loaded(let agents) = vm.state else {
            return XCTFail("expected loaded([]); got \(vm.state)")
        }
        XCTAssertTrue(agents.isEmpty)
    }

    func test_historyVM_load_success_listsSessions() async {
        let fake = FakeDrawerScreensFetcher()
        fake.historyResult = .success(HistoryResponseDTO(sessions: [
            HistorySessionDTO(
                session_id: "s1",
                started_at: "2026-04-30T10:00:00Z",
                last_activity_at: "2026-04-30T10:08:00Z",
                user_message_count: 4,
                preview: "x",
                trip_ids: []
            )
        ]))
        let vm = HistoryScreenViewModel(fetcher: fake)
        await vm.load()
        guard case .loaded(let sessions) = vm.state else {
            return XCTFail("expected loaded; got \(vm.state)")
        }
        XCTAssertEqual(sessions.count, 1)
    }

    func test_historyVM_load_failure_surfacesError() async {
        let fake = FakeDrawerScreensFetcher()
        fake.historyResult = .failure(DrawerScreensError.transport("offline"))
        let vm = HistoryScreenViewModel(fetcher: fake)
        await vm.load()
        guard case .error = vm.state else {
            return XCTFail("expected .error; got \(vm.state)")
        }
    }

    // MARK: - 3. HistoryTimeFormatter

    func test_timeFormatter_under60s_isNow() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        let then = now.addingTimeInterval(-30)
        let iso = ISO8601DateFormatter().string(from: then)
        XCTAssertEqual(HistoryTimeFormatter.formatTimeSince(iso, relativeTo: now), "now")
    }

    func test_timeFormatter_under60min_returnsMinSec() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        let then = now.addingTimeInterval(-(12 * 60 + 3))
        let iso = ISO8601DateFormatter().string(from: then)
        XCTAssertEqual(HistoryTimeFormatter.formatTimeSince(iso, relativeTo: now), "12 min, 3 sec")
    }

    func test_timeFormatter_under24h_returnsHrMin() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        let then = now.addingTimeInterval(-(4 * 3_600))
        let iso = ISO8601DateFormatter().string(from: then)
        XCTAssertEqual(HistoryTimeFormatter.formatTimeSince(iso, relativeTo: now), "4 hr, 0 min")
    }

    func test_timeFormatter_under7d_returnsDayHr() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        let then = now.addingTimeInterval(-(86_400 + 2 * 3_600))
        let iso = ISO8601DateFormatter().string(from: then)
        XCTAssertEqual(HistoryTimeFormatter.formatTimeSince(iso, relativeTo: now), "1 day, 2 hr")
    }

    func test_timeFormatter_over7d_returnsMonthDay() {
        let now = Date(timeIntervalSince1970: 1_714_435_200) // 2024-04-30
        let then = now.addingTimeInterval(-(8 * 86_400))
        let iso = ISO8601DateFormatter().string(from: then)
        let result = HistoryTimeFormatter.formatTimeSince(iso, relativeTo: now)
        XCTAssertEqual(result, "Apr 22")
    }

    func test_timeFormatter_invalidISO_returnsEmpty() {
        XCTAssertEqual(
            HistoryTimeFormatter.formatTimeSince("not-an-iso-date"),
            ""
        )
    }

    // MARK: - 4. MemoryCategory summary derivation

    func test_memoryCategory_preferences_summary() {
        let p = MemoryProfileDTO(
            preferred_airline_class: "economy",
            preferred_airline_seat: "aisle",
            budget_tier: "standard"
        )
        XCTAssertEqual(MemoryCategory.preferences.summary(from: p), "economy · aisle · standard")
    }

    func test_memoryCategory_dietary_summary_combinesFlagsAndAllergies() {
        let p = MemoryProfileDTO(dietary_flags: ["vegetarian"], allergies: ["shellfish"])
        XCTAssertEqual(MemoryCategory.dietary.summary(from: p), "vegetarian, shellfish")
    }

    func test_memoryCategory_emptyProfile_returnsNotSet() {
        let p = MemoryProfileDTO()
        for cat in MemoryCategory.allCases {
            XCTAssertEqual(cat.summary(from: p), "Not set", "empty profile must surface 'Not set' on \(cat.label)")
        }
    }
}
