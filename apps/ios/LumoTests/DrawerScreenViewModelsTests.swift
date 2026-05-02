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
        XCTAssertEqual(decoded.facts, [])
        XCTAssertEqual(decoded.patterns, [])
    }

    func test_memoryResponse_decodes_factsAndPatterns() throws {
        let json = """
        {
          "profile": null,
          "facts": [
            {
              "id": "f1",
              "fact": "Window seat preference on long-haul.",
              "category": "preference",
              "source": "explicit",
              "confidence": 0.9,
              "first_seen_at": "2026-04-01T10:00:00Z",
              "last_confirmed_at": "2026-05-02T08:00:00Z"
            }
          ],
          "patterns": [
            {
              "id": "p1",
              "pattern_kind": "frequent_destination",
              "description": "Books LAS roughly monthly.",
              "evidence_count": 4,
              "confidence": 0.82,
              "last_observed_at": "2026-05-01T00:00:00Z"
            }
          ]
        }
        """.data(using: .utf8)!
        let decoded = try JSONDecoder().decode(MemoryResponseDTO.self, from: json)
        XCTAssertEqual(decoded.facts.count, 1)
        XCTAssertEqual(decoded.facts[0].id, "f1")
        XCTAssertEqual(decoded.facts[0].category, "preference")
        XCTAssertEqual(decoded.patterns.count, 1)
        XCTAssertEqual(decoded.patterns[0].evidence_count, 4)
    }

    func test_memoryResponse_decodes_oldSnapshotWithoutFactsKey() throws {
        // Backwards-compat: a response missing facts/patterns must
        // still decode (e.g. an older server build, or a cached
        // payload from before facts shipped).
        let json = #"{"profile": null}"#.data(using: .utf8)!
        let decoded = try JSONDecoder().decode(MemoryResponseDTO.self, from: json)
        XCTAssertEqual(decoded.facts, [])
        XCTAssertEqual(decoded.patterns, [])
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

    func test_memoryVM_load_populatesFactsAndPatterns() async {
        let fake = FakeDrawerScreensFetcher()
        let f = MemoryFactDTO(
            id: "f1",
            fact: "Likes window seats",
            category: "preference",
            source: "explicit",
            confidence: 0.9,
            first_seen_at: "2026-04-01T10:00:00Z",
            last_confirmed_at: "2026-05-02T08:00:00Z"
        )
        let p = MemoryPatternDTO(
            id: "p1",
            pattern_kind: "frequent_destination",
            description: "Books LAS roughly monthly",
            evidence_count: 4,
            confidence: 0.82,
            last_observed_at: "2026-05-01T00:00:00Z"
        )
        fake.memoryResult = .success(MemoryResponseDTO(profile: nil, facts: [f], patterns: [p]))
        let vm = MemoryScreenViewModel(fetcher: fake)
        await vm.load()
        XCTAssertEqual(vm.facts.count, 1)
        XCTAssertEqual(vm.facts[0].id, "f1")
        XCTAssertEqual(vm.patterns.count, 1)
        XCTAssertEqual(vm.patterns[0].id, "p1")
    }

    func test_memoryVM_forgetFact_optimisticallyRemovesAndCallsDelete() async {
        let fake = FakeDrawerScreensFetcher()
        let facts = (1...3).map {
            MemoryFactDTO(
                id: "f\($0)",
                fact: "fact \($0)",
                category: "preference",
                source: "explicit",
                confidence: 0.8,
                first_seen_at: "2026-04-01T10:00:00Z",
                last_confirmed_at: "2026-04-01T10:00:00Z"
            )
        }
        fake.memoryResult = .success(MemoryResponseDTO(profile: nil, facts: facts))
        let vm = MemoryScreenViewModel(fetcher: fake)
        await vm.load()
        XCTAssertEqual(vm.facts.count, 3)

        await vm.forgetFact(id: "f2")

        XCTAssertEqual(vm.facts.map(\.id), ["f1", "f3"], "f2 should be removed")
        XCTAssertEqual(fake.forgetFactCalls, ["f2"])
        XCTAssertNil(vm.forgettingFactID)
        XCTAssertNil(vm.factError)
    }

    func test_memoryVM_forgetFact_failureRestoresFactAtSameIndex() async {
        let fake = FakeDrawerScreensFetcher()
        let facts = (1...3).map {
            MemoryFactDTO(
                id: "f\($0)",
                fact: "fact \($0)",
                category: "preference",
                source: "explicit",
                confidence: 0.8,
                first_seen_at: "2026-04-01T10:00:00Z",
                last_confirmed_at: "2026-04-01T10:00:00Z"
            )
        }
        fake.memoryResult = .success(MemoryResponseDTO(profile: nil, facts: facts))
        fake.forgetFactResult = .failure(DrawerScreensError.transport("offline"))
        let vm = MemoryScreenViewModel(fetcher: fake)
        await vm.load()

        await vm.forgetFact(id: "f2")

        XCTAssertEqual(vm.facts.map(\.id), ["f1", "f2", "f3"], "rolled-back fact must return to its original slot")
        XCTAssertNotNil(vm.factError, "user-facing error must surface on failure")
    }

    func test_memoryUI_confidenceTone_thresholdsMatchWeb() {
        XCTAssertEqual(MemoryUI.confidenceTone(0.81), .high)
        XCTAssertEqual(MemoryUI.confidenceTone(0.80), .high)
        XCTAssertEqual(MemoryUI.confidenceTone(0.79), .medium)
        XCTAssertEqual(MemoryUI.confidenceTone(0.55), .medium)
        XCTAssertEqual(MemoryUI.confidenceTone(0.54), .low)
        XCTAssertEqual(MemoryUI.confidenceTone(0.0), .low)
    }

    func test_memoryUI_confidenceLabel_reportsPercentAndFraming() {
        XCTAssertEqual(MemoryUI.confidenceLabel(0.92), "92% confidence")
        XCTAssertEqual(MemoryUI.confidenceLabel(0.60), "60% confidence")
        XCTAssertEqual(MemoryUI.confidenceLabel(0.30), "30% needs review")
        XCTAssertEqual(MemoryUI.confidenceLabel(2.0), "100% confidence", "values >1 must clamp")
    }

    func test_memoryUI_sourceLabel_matchesWebStrings() {
        XCTAssertEqual(MemoryUI.sourceLabel("explicit"), "Told by you")
        XCTAssertEqual(MemoryUI.sourceLabel("inferred"), "Inferred")
        XCTAssertEqual(MemoryUI.sourceLabel("behavioral"), "Learned from activity")
        XCTAssertEqual(MemoryUI.sourceLabel("custom_source"), "Custom Source", "unknown sources should titleize")
    }

    func test_memoryUI_groupedAndSorted_isDeterministic() {
        let facts = [
            MemoryFactDTO(id: "f1", fact: "a", category: "habit", source: "x", confidence: 1, first_seen_at: "", last_confirmed_at: ""),
            MemoryFactDTO(id: "f2", fact: "b", category: "preference", source: "x", confidence: 1, first_seen_at: "", last_confirmed_at: ""),
            MemoryFactDTO(id: "f3", fact: "c", category: "habit", source: "x", confidence: 1, first_seen_at: "", last_confirmed_at: ""),
        ]
        let grouped = MemoryUI.groupedAndSorted(facts)
        XCTAssertEqual(grouped.map(\.0), ["habit", "preference"])
        XCTAssertEqual(grouped[0].1.map(\.id), ["f1", "f3"])
        XCTAssertEqual(grouped[1].1.map(\.id), ["f2"])
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

    func test_marketplaceVM_install_success_marksAgentInstalled() async {
        let fake = FakeDrawerScreensFetcher()
        let agent = MarketplaceAgentDTO(
            agent_id: "lumo-flights",
            display_name: "Lumo Flights",
            one_liner: "Search and book flights.",
            domain: "flights",
            install: nil
        )
        fake.marketplaceResult = .success(MarketplaceResponseDTO(agents: [agent]))
        fake.installAgentResult = .success("2026-05-03T12:00:00Z")
        let vm = MarketplaceScreenViewModel(fetcher: fake)
        await vm.load()
        XCTAssertEqual(vm.state, .loaded([agent]))

        await vm.installAgent(id: "lumo-flights")

        XCTAssertEqual(fake.installAgentCalls, ["lumo-flights"])
        XCTAssertNil(vm.installError)
        guard case .loaded(let updated) = vm.state else {
            return XCTFail("expected loaded state; got \(vm.state)")
        }
        XCTAssertEqual(updated.count, 1)
        XCTAssertTrue(updated[0].isInstalled, "agent must flip to installed")
        XCTAssertEqual(updated[0].install?.installed_at, "2026-05-03T12:00:00Z")
    }

    func test_marketplaceVM_install_alreadyInstalled_isNoOp() async {
        let fake = FakeDrawerScreensFetcher()
        let agent = MarketplaceAgentDTO(
            agent_id: "lumo-flights",
            display_name: "Lumo Flights",
            one_liner: "x",
            domain: "flights",
            install: MarketplaceInstallStateDTO(status: "installed", installed_at: "2026-04-01T00:00:00Z")
        )
        fake.marketplaceResult = .success(MarketplaceResponseDTO(agents: [agent]))
        let vm = MarketplaceScreenViewModel(fetcher: fake)
        await vm.load()

        await vm.installAgent(id: "lumo-flights")

        XCTAssertEqual(fake.installAgentCalls, [], "must not call install for an already-installed agent")
    }

    func test_marketplaceVM_install_oauthRequired_surfacesWebOnlyMessage() async {
        let fake = FakeDrawerScreensFetcher()
        let agent = MarketplaceAgentDTO(
            agent_id: "lumo-google",
            display_name: "Lumo Google",
            one_liner: "x",
            domain: "calendar",
            install: nil
        )
        fake.marketplaceResult = .success(MarketplaceResponseDTO(agents: [agent]))
        fake.installAgentResult = .failure(DrawerScreensError.oauthRequired)
        let vm = MarketplaceScreenViewModel(fetcher: fake)
        await vm.load()

        await vm.installAgent(id: "lumo-google")

        XCTAssertNotNil(vm.installError)
        XCTAssertTrue(vm.installError?.contains("OAuth") == true,
                      "OAuth-required error must mention OAuth")
        guard case .loaded(let agents) = vm.state else {
            return XCTFail("loaded state must survive a failed install")
        }
        XCTAssertFalse(agents[0].isInstalled, "failed install must not flip the local state")
    }

    func test_marketplaceVM_install_unknownAgent_surfacesRefreshMessage() async {
        let fake = FakeDrawerScreensFetcher()
        let agent = MarketplaceAgentDTO(
            agent_id: "removed",
            display_name: "Removed",
            one_liner: "x",
            domain: "flights",
            install: nil
        )
        fake.marketplaceResult = .success(MarketplaceResponseDTO(agents: [agent]))
        fake.installAgentResult = .failure(DrawerScreensError.unknownAgent)
        let vm = MarketplaceScreenViewModel(fetcher: fake)
        await vm.load()

        await vm.installAgent(id: "removed")

        XCTAssertNotNil(vm.installError)
        XCTAssertTrue(vm.installError?.lowercased().contains("refresh") == true)
    }

    func test_marketplaceVM_install_transportError_surfacesNetworkMessage() async {
        let fake = FakeDrawerScreensFetcher()
        let agent = MarketplaceAgentDTO(
            agent_id: "a",
            display_name: "A",
            one_liner: "x",
            domain: "flights",
            install: nil
        )
        fake.marketplaceResult = .success(MarketplaceResponseDTO(agents: [agent]))
        fake.installAgentResult = .failure(DrawerScreensError.transport("offline"))
        let vm = MarketplaceScreenViewModel(fetcher: fake)
        await vm.load()

        await vm.installAgent(id: "a")

        XCTAssertNotNil(vm.installError)
        guard case .loaded = vm.state else {
            return XCTFail("loaded state must survive a failed install")
        }
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
