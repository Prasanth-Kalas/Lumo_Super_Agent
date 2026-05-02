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

    // MARK: - IOS-ONBOARDING-1

    func test_memoryProfile_isOnboarded_trueWhenExtraOnboardedAtPresent() {
        let p = MemoryProfileDTO(
            extra: MemoryProfileExtraDTO(onboarded_at: "2026-05-03T10:00:00Z", onboarded_via: "continue")
        )
        XCTAssertTrue(p.isOnboarded)
    }

    func test_memoryProfile_isOnboarded_falseWhenExtraMissing() {
        let p = MemoryProfileDTO()
        XCTAssertFalse(p.isOnboarded)
    }

    func test_memoryProfile_isOnboarded_falseWhenOnboardedAtEmptyString() {
        let p = MemoryProfileDTO(extra: MemoryProfileExtraDTO(onboarded_at: ""))
        XCTAssertFalse(p.isOnboarded)
    }

    func test_memoryProfile_extraDecodes_fromWebShape() throws {
        let json = """
        {
          "profile": {
            "display_name": "Alex",
            "timezone": null,
            "preferred_language": null,
            "home_address": null,
            "work_address": null,
            "dietary_flags": [],
            "allergies": [],
            "preferred_airline_class": null,
            "preferred_airline_seat": null,
            "preferred_hotel_chains": [],
            "budget_tier": null,
            "preferred_payment_hint": null,
            "extra": {
              "onboarded_at": "2026-05-03T10:00:00Z",
              "onboarded_via": "continue",
              "connectors_at_onboarding": 3
            }
          }
        }
        """.data(using: .utf8)!
        let decoded = try JSONDecoder().decode(MemoryResponseDTO.self, from: json)
        XCTAssertTrue(decoded.profile?.isOnboarded == true)
        XCTAssertEqual(decoded.profile?.extra?.connectors_at_onboarding, 3)
    }

    func test_onboardingVM_check_onboardedProfile_transitionsToComplete() async {
        let fake = FakeDrawerScreensFetcher()
        fake.memoryResult = .success(MemoryResponseDTO(profile: MemoryProfileDTO(
            extra: MemoryProfileExtraDTO(onboarded_at: "2026-05-03T10:00:00Z")
        )))
        let vm = OnboardingViewModel(fetcher: fake)
        await vm.check()
        XCTAssertEqual(vm.state, .complete)
    }

    func test_onboardingVM_check_freshProfile_transitionsToNeedsOnboarding() async {
        let fake = FakeDrawerScreensFetcher()
        fake.memoryResult = .success(MemoryResponseDTO(profile: MemoryProfileDTO()))
        let vm = OnboardingViewModel(fetcher: fake)
        await vm.check()
        XCTAssertEqual(vm.state, .needsOnboarding)
    }

    func test_onboardingVM_check_networkFailure_biasesToComplete() async {
        let fake = FakeDrawerScreensFetcher()
        fake.memoryResult = .failure(DrawerScreensError.transport("offline"))
        let vm = OnboardingViewModel(fetcher: fake)
        await vm.check()
        XCTAssertEqual(vm.state, .complete,
                       "network failures must NOT trap the user on the welcome screen")
    }

    func test_onboardingVM_finish_callsMarkAndTransitions() async {
        let fake = FakeDrawerScreensFetcher()
        fake.memoryResult = .success(MemoryResponseDTO(profile: MemoryProfileDTO()))
        let vm = OnboardingViewModel(fetcher: fake)
        await vm.check()
        XCTAssertEqual(vm.state, .needsOnboarding)

        await vm.finish(via: "continue")

        XCTAssertEqual(fake.markOnboardedCalls, ["continue"])
        XCTAssertEqual(vm.state, .complete)
    }

    func test_onboardingVM_finish_failedPATCH_stillTransitions() async {
        // Web's "best-effort PATCH" posture — a dropped write
        // shouldn't trap the user on the welcome screen.
        let fake = FakeDrawerScreensFetcher()
        fake.memoryResult = .success(MemoryResponseDTO(profile: MemoryProfileDTO()))
        fake.markOnboardedResult = .failure(DrawerScreensError.transport("offline"))
        let vm = OnboardingViewModel(fetcher: fake)
        await vm.check()

        await vm.finish(via: "skip")

        XCTAssertEqual(vm.state, .complete)
        XCTAssertEqual(fake.markOnboardedCalls, ["skip"])
    }

    func test_onboardingVM_check_isReentrantAfterUserSwitch() async {
        // Sign out → sign in as different user must re-check.
        // The first user is onboarded, the second isn't.
        let fake = FakeDrawerScreensFetcher()
        fake.memoryResult = .success(MemoryResponseDTO(profile: MemoryProfileDTO(
            extra: MemoryProfileExtraDTO(onboarded_at: "2026-05-03T10:00:00Z")
        )))
        let vm = OnboardingViewModel(fetcher: fake)
        await vm.check()
        XCTAssertEqual(vm.state, .complete)

        // User switch — fetcher now returns a fresh profile.
        fake.memoryResult = .success(MemoryResponseDTO(profile: MemoryProfileDTO()))
        await vm.check()
        XCTAssertEqual(vm.state, .needsOnboarding,
                       "re-check must surface the second user's missing flag")
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

    func test_marketplaceResponse_decodes_richCardFields() throws {
        // IOS-MARKETPLACE-RICH-CARDS-1 — verify risk_badge,
        // connect_model, source/coming_soon fields decode and the
        // computed flags (requiresOAuth, isComingSoon) reflect them.
        let json = """
        {
          "agents": [
            {
              "agent_id": "lumo-google",
              "display_name": "Lumo Google",
              "one_liner": "Reads your calendar.",
              "domain": "calendar",
              "intents": ["read_calendar"],
              "connect_model": "oauth2",
              "source": "lumo",
              "risk_badge": {
                "level": "medium",
                "score": 0.42,
                "reasons": ["reads private calendar"],
                "mitigations": [],
                "source": "ml",
                "latency_ms": 120
              }
            },
            {
              "agent_id": "lumo-airbnb",
              "display_name": "Lumo Airbnb",
              "one_liner": "Coming soon.",
              "domain": "stays",
              "intents": [],
              "source": "coming_soon",
              "coming_soon_label": "In review",
              "coming_soon_rationale": "Airbnb partner App Store review"
            }
          ]
        }
        """.data(using: .utf8)!
        let decoded = try JSONDecoder().decode(MarketplaceResponseDTO.self, from: json)
        XCTAssertEqual(decoded.agents.count, 2)
        let google = decoded.agents[0]
        XCTAssertEqual(google.connect_model, "oauth2")
        XCTAssertTrue(google.requiresOAuth)
        XCTAssertFalse(google.isComingSoon)
        XCTAssertEqual(google.risk_badge?.level, "medium")
        XCTAssertEqual(google.risk_badge?.reasons.first, "reads private calendar")
        let airbnb = decoded.agents[1]
        XCTAssertTrue(airbnb.isComingSoon)
        XCTAssertEqual(airbnb.coming_soon_label, "In review")
    }

    func test_marketplaceUI_riskStyle_branchesMatchWeb() {
        XCTAssertEqual(MarketplaceUI.riskStyle("low").label, "low risk")
        XCTAssertEqual(MarketplaceUI.riskStyle("medium").label, "medium risk")
        XCTAssertEqual(MarketplaceUI.riskStyle("high").label, "high risk")
        XCTAssertEqual(MarketplaceUI.riskStyle("review_required").label, "review")
        XCTAssertEqual(MarketplaceUI.riskStyle("custom").label, "custom",
                       "unknown levels surface raw label, matching web fallback")
    }

    func test_marketplaceAgent_oldSnapshotDecodes_withoutNewFields() throws {
        // Backwards-compat: a snapshot from before IOS-MARKETPLACE-RICH-CARDS-1
        // shipped (no connect_model / source / risk_badge) must still decode.
        let json = """
        {
          "agents": [
            {
              "agent_id": "old",
              "display_name": "Old",
              "one_liner": "Legacy.",
              "domain": "flights",
              "intents": []
            }
          ]
        }
        """.data(using: .utf8)!
        let decoded = try JSONDecoder().decode(MarketplaceResponseDTO.self, from: json)
        XCTAssertEqual(decoded.agents.count, 1)
        XCTAssertNil(decoded.agents[0].risk_badge)
        XCTAssertNil(decoded.agents[0].connect_model)
        XCTAssertFalse(decoded.agents[0].requiresOAuth)
        XCTAssertFalse(decoded.agents[0].isComingSoon)
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

    func test_historyResponse_decodes_sessionsAndTrips() throws {
        let json = """
        {
          "sessions": [
            {
              "session_id": "s1",
              "started_at": "2026-04-30T10:00:00Z",
              "last_activity_at": "2026-04-30T10:08:00Z",
              "user_message_count": 4,
              "preview": "Plan a Vegas trip",
              "trip_ids": ["t1"]
            }
          ],
          "trips": [
            {
              "trip_id": "t1",
              "session_id": "s1",
              "status": "committed",
              "payload": {
                "trip_title": "Vegas weekend",
                "total_amount": "1200.00",
                "currency": "USD",
                "legs": [
                  {"order": 1, "agent_id": "lumo.flight", "tool_name": "search_offers"},
                  {"order": 2, "agent_id": "lumo.hotel"}
                ]
              },
              "created_at": "2026-04-29T10:00:00Z",
              "updated_at": "2026-04-30T10:08:00Z",
              "cancel_requested_at": null
            }
          ]
        }
        """.data(using: .utf8)!
        let decoded = try JSONDecoder().decode(HistoryResponseDTO.self, from: json)
        XCTAssertEqual(decoded.sessions.count, 1)
        XCTAssertEqual(decoded.sessions[0].tripCount, 1)
        XCTAssertEqual(decoded.trips.count, 1)
        XCTAssertEqual(decoded.trips[0].trip_id, "t1")
        XCTAssertEqual(decoded.trips[0].payload.trip_title, "Vegas weekend")
        XCTAssertEqual(decoded.trips[0].payload.total_amount, "1200.00")
        XCTAssertEqual(decoded.trips[0].payload.legs?.count, 2)
        XCTAssertEqual(decoded.trips[0].payload.legs?[0].agent_id, "lumo.flight")
        XCTAssertEqual(decoded.trips[0].payload.legs?[0].tool_name, "search_offers")
        XCTAssertNil(decoded.trips[0].payload.legs?[1].tool_name)
    }

    func test_historyResponse_decodes_oldSnapshotWithoutTripsKey() throws {
        // Backwards-compat: a response missing the trips key must
        // still decode.
        let json = #"{"sessions": []}"#.data(using: .utf8)!
        let decoded = try JSONDecoder().decode(HistoryResponseDTO.self, from: json)
        XCTAssertTrue(decoded.sessions.isEmpty)
        XCTAssertTrue(decoded.trips.isEmpty)
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

    // MARK: - IOS-MCP-CONNECT-1

    func test_marketplaceAgent_requiresMcpToken_trueWhenConnectModelMatches() {
        let mcp = MarketplaceAgentDTO(
            agent_id: "mcp:slack",
            display_name: "Slack",
            one_liner: "x",
            domain: "messaging",
            connect_model: "mcp_bearer",
            source: "mcp"
        )
        XCTAssertTrue(mcp.requiresMcpToken)
        let oauth = MarketplaceAgentDTO(
            agent_id: "lumo-google",
            display_name: "Google",
            one_liner: "x",
            domain: "calendar",
            connect_model: "oauth2"
        )
        XCTAssertFalse(oauth.requiresMcpToken)
    }

    func test_marketplaceVM_connectMcp_emptyToken_setsError_doesNotCallAPI() async {
        let fake = FakeDrawerScreensFetcher()
        let agent = MarketplaceAgentDTO(
            agent_id: "mcp:slack",
            display_name: "Slack",
            one_liner: "x",
            domain: "messaging",
            connect_model: "mcp_bearer",
            source: "mcp"
        )
        fake.marketplaceResult = .success(MarketplaceResponseDTO(agents: [agent]))
        let vm = MarketplaceScreenViewModel(fetcher: fake)
        await vm.load()

        let ok = await vm.connectMcp(agent: agent, token: "   ")

        XCTAssertFalse(ok)
        XCTAssertEqual(fake.connectMcpCalls.count, 0)
        XCTAssertNotNil(vm.mcpConnectError)
    }

    func test_marketplaceVM_connectMcp_success_strippsMcpPrefix_andReloads() async {
        let fake = FakeDrawerScreensFetcher()
        let agent = MarketplaceAgentDTO(
            agent_id: "mcp:slack",
            display_name: "Slack",
            one_liner: "x",
            domain: "messaging",
            connect_model: "mcp_bearer",
            source: "mcp"
        )
        fake.marketplaceResult = .success(MarketplaceResponseDTO(agents: [agent]))
        let vm = MarketplaceScreenViewModel(fetcher: fake)
        await vm.load()
        XCTAssertEqual(fake.marketplaceFetchCount, 1)

        let ok = await vm.connectMcp(agent: agent, token: "  abc-token  ")

        XCTAssertTrue(ok)
        XCTAssertEqual(fake.connectMcpCalls.count, 1)
        XCTAssertEqual(fake.connectMcpCalls[0].serverID, "slack",
                       "the `mcp:` prefix must be stripped before POST")
        XCTAssertEqual(fake.connectMcpCalls[0].accessToken, "abc-token",
                       "token must be trimmed before submit")
        XCTAssertEqual(vm.mcpConnectSuccessAgentID, "mcp:slack")
        XCTAssertNil(vm.mcpConnectError)
        XCTAssertEqual(fake.marketplaceFetchCount, 2,
                       "successful connect must trigger a catalog reload")
    }

    func test_marketplaceVM_connectMcp_failure_surfacesError_noSuccessFlag() async {
        let fake = FakeDrawerScreensFetcher()
        let agent = MarketplaceAgentDTO(
            agent_id: "mcp:slack",
            display_name: "Slack",
            one_liner: "x",
            domain: "messaging",
            connect_model: "mcp_bearer",
            source: "mcp"
        )
        fake.marketplaceResult = .success(MarketplaceResponseDTO(agents: [agent]))
        fake.connectMcpResult = .failure(DrawerScreensError.badStatus(400))
        let vm = MarketplaceScreenViewModel(fetcher: fake)
        await vm.load()

        let ok = await vm.connectMcp(agent: agent, token: "abc")

        XCTAssertFalse(ok)
        XCTAssertNil(vm.mcpConnectSuccessAgentID)
        XCTAssertNotNil(vm.mcpConnectError)
    }

    func test_marketplaceVM_connectMcp_agentIdWithoutMcpPrefix_passesThroughVerbatim() async {
        let fake = FakeDrawerScreensFetcher()
        let agent = MarketplaceAgentDTO(
            agent_id: "slack",
            display_name: "Slack",
            one_liner: "x",
            domain: "messaging",
            connect_model: "mcp_bearer",
            source: "mcp"
        )
        fake.marketplaceResult = .success(MarketplaceResponseDTO(agents: [agent]))
        let vm = MarketplaceScreenViewModel(fetcher: fake)
        await vm.load()

        _ = await vm.connectMcp(agent: agent, token: "abc")

        XCTAssertEqual(fake.connectMcpCalls.first?.serverID, "slack")
    }

    func test_marketplaceVM_clearMcpConnectSuccess_resetsFlag() {
        let fake = FakeDrawerScreensFetcher()
        let vm = MarketplaceScreenViewModel(fetcher: fake)
        vm.mcpConnectSuccessAgentID = "mcp:slack"
        vm.clearMcpConnectSuccess()
        XCTAssertNil(vm.mcpConnectSuccessAgentID)
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

    func test_historyVM_load_populatesTripsAlongsideSessions() async {
        let fake = FakeDrawerScreensFetcher()
        let trip = HistoryTripDTO(
            trip_id: "t1",
            session_id: "s1",
            status: "committed",
            payload: HistoryTripPayloadDTO(
                trip_title: "Vegas weekend",
                total_amount: "1200.00",
                currency: "USD",
                legs: [HistoryTripLegDTO(order: 1, agent_id: "lumo.flight", tool_name: "search_offers")]
            ),
            created_at: "2026-04-29T10:00:00Z",
            updated_at: "2026-04-30T10:08:00Z",
            cancel_requested_at: nil
        )
        fake.historyResult = .success(HistoryResponseDTO(sessions: [], trips: [trip]))
        let vm = HistoryScreenViewModel(fetcher: fake)
        await vm.load()
        XCTAssertEqual(vm.trips.count, 1)
        XCTAssertEqual(vm.trips[0].trip_id, "t1")
    }

    func test_historyVM_toggleTripExpanded_addsAndRemoves() {
        let vm = HistoryScreenViewModel(fetcher: FakeDrawerScreensFetcher())
        XCTAssertFalse(vm.expandedTripIDs.contains("t1"))
        vm.toggleTripExpanded("t1")
        XCTAssertTrue(vm.expandedTripIDs.contains("t1"))
        vm.toggleTripExpanded("t1")
        XCTAssertFalse(vm.expandedTripIDs.contains("t1"))
    }

    // MARK: - IOS-HISTORY-SEARCH-1

    private static func makeSession(
        id: String,
        preview: String? = "preview"
    ) -> HistorySessionDTO {
        HistorySessionDTO(
            session_id: id,
            started_at: "2026-04-30T10:00:00Z",
            last_activity_at: "2026-04-30T10:08:00Z",
            user_message_count: 1,
            preview: preview,
            trip_ids: []
        )
    }

    private static func makeTrip(
        id: String,
        title: String? = "Trip",
        status: String = "committed"
    ) -> HistoryTripDTO {
        HistoryTripDTO(
            trip_id: id,
            session_id: "s",
            status: status,
            payload: HistoryTripPayloadDTO(trip_title: title),
            created_at: "2026-04-29T10:00:00Z",
            updated_at: "2026-04-30T10:08:00Z",
            cancel_requested_at: nil
        )
    }

    func test_historyFilters_all_emptyQuery_passesEverything() {
        let sessions = [Self.makeSession(id: "s1"), Self.makeSession(id: "s2")]
        let trips = [Self.makeTrip(id: "t1"), Self.makeTrip(id: "t2")]
        XCTAssertEqual(
            HistoryFilters.matching(sessions: sessions, query: "", filter: .all).map(\.id),
            ["s1", "s2"]
        )
        XCTAssertEqual(
            HistoryFilters.matching(trips: trips, query: "", filter: .all).map(\.id),
            ["t1", "t2"]
        )
    }

    func test_historyFilters_conversations_dropsTrips() {
        let trips = [Self.makeTrip(id: "t1")]
        XCTAssertTrue(
            HistoryFilters.matching(trips: trips, query: "", filter: .conversations).isEmpty,
            "Conversations filter must hide all trips"
        )
    }

    func test_historyFilters_tripsFilter_dropsSessions() {
        let sessions = [Self.makeSession(id: "s1")]
        XCTAssertTrue(
            HistoryFilters.matching(sessions: sessions, query: "", filter: .trips).isEmpty,
            "Trips filter must hide all sessions"
        )
    }

    func test_historyFilters_query_matchesSessionPreview_caseInsensitively() {
        let sessions = [
            Self.makeSession(id: "vegas", preview: "Plan a Vegas trip"),
            Self.makeSession(id: "japan", preview: "Sushi place in Tokyo"),
        ]
        let r = HistoryFilters.matching(sessions: sessions, query: "VEGAS", filter: .all)
        XCTAssertEqual(r.map(\.id), ["vegas"])
    }

    func test_historyFilters_query_matchesTripTitle() {
        let trips = [
            Self.makeTrip(id: "t1", title: "Vegas weekend"),
            Self.makeTrip(id: "t2", title: "Tokyo dinner"),
        ]
        let r = HistoryFilters.matching(trips: trips, query: "tokyo", filter: .all)
        XCTAssertEqual(r.map(\.id), ["t2"])
    }

    func test_historyFilters_query_matchesTripStatus() {
        // "rolled_back" / "committed" / etc. — typing "refund" wouldn't
        // match because the stored status is "rolled_back" not the
        // pill's "refunded" label. iOS-v1 filters on the raw status
        // string; mapping to display labels is a follow-up if the
        // user feedback says it matters.
        let trips = [
            Self.makeTrip(id: "t1", title: "Trip A", status: "committed"),
            Self.makeTrip(id: "t2", title: "Trip B", status: "rolled_back"),
        ]
        let r = HistoryFilters.matching(trips: trips, query: "rolled", filter: .all)
        XCTAssertEqual(r.map(\.id), ["t2"])
    }

    func test_historyFilters_query_trimsWhitespace() {
        let sessions = [Self.makeSession(id: "s1", preview: "Vegas")]
        let r = HistoryFilters.matching(sessions: sessions, query: "  vegas  ", filter: .all)
        XCTAssertEqual(r.map(\.id), ["s1"])
    }

    func test_historyTripFormatter_statusStyle_knownAndUnknown() {
        XCTAssertEqual(HistoryTripFormatter.statusStyle("committed").label, "booked")
        XCTAssertEqual(HistoryTripFormatter.statusStyle("dispatching").label, "booking…")
        XCTAssertEqual(HistoryTripFormatter.statusStyle("rolled_back").label, "refunded")
        XCTAssertEqual(HistoryTripFormatter.statusStyle("rollback_failed").label, "needs attention")
        // Unknown statuses fall through to the raw string (matches web).
        XCTAssertEqual(HistoryTripFormatter.statusStyle("processing").label, "processing")
    }

    func test_historyTripFormatter_legFriendly_mapsAgents() {
        XCTAssertEqual(HistoryTripFormatter.legFriendly("lumo.flight"), "Flight")
        XCTAssertEqual(HistoryTripFormatter.legFriendly("hotel-agent"), "Hotel")
        XCTAssertEqual(HistoryTripFormatter.legFriendly("food-agent"), "Food")
        XCTAssertEqual(HistoryTripFormatter.legFriendly("custom.agent"), "custom.agent")
    }

    func test_historyTripFormatter_shortID_truncatesPast12Chars() {
        XCTAssertEqual(HistoryTripFormatter.shortID("trip_abc"), "trip_abc")
        XCTAssertEqual(HistoryTripFormatter.shortID("trip_abcdefghijklmnop"), "trip_abcdefg…")
    }

    func test_historyMoneyFormatter_formatsValidAmount() {
        let result = HistoryMoneyFormatter.formatMoney("1234.50", currency: "USD")
        // Locale-sensitive, but a USD format will always include "$" and the digits.
        XCTAssertTrue(result.contains("$"))
        XCTAssertTrue(result.contains("1,234.50"))
    }

    func test_historyMoneyFormatter_invalidAmount_fallsBackToRawConcat() {
        XCTAssertEqual(HistoryMoneyFormatter.formatMoney("not-a-number", currency: "USD"), "not-a-number USD")
    }

    // MARK: - IOS-TRIP-CANCEL-1

    func test_historyVM_canCancel_branchesMatchWebRoute() {
        XCTAssertTrue(HistoryScreenViewModel.canCancel(status: "draft"))
        XCTAssertTrue(HistoryScreenViewModel.canCancel(status: "confirmed"))
        XCTAssertTrue(HistoryScreenViewModel.canCancel(status: "dispatching"))
        XCTAssertTrue(HistoryScreenViewModel.canCancel(status: "committed"))
        XCTAssertFalse(HistoryScreenViewModel.canCancel(status: "rolled_back"))
        XCTAssertFalse(HistoryScreenViewModel.canCancel(status: "rollback_failed"))
        XCTAssertFalse(HistoryScreenViewModel.canCancel(status: "anything-else"))
    }

    func test_historyVM_cancelTrip_success_recordsMessageAndReloads() async {
        let fake = FakeDrawerScreensFetcher()
        let trip = HistoryTripDTO(
            trip_id: "t1",
            session_id: "s1",
            status: "committed",
            payload: HistoryTripPayloadDTO(),
            created_at: "2026-04-29T10:00:00Z",
            updated_at: "2026-04-30T10:08:00Z",
            cancel_requested_at: nil
        )
        fake.historyResult = .success(HistoryResponseDTO(sessions: [], trips: [trip]))
        fake.cancelTripResult = .success(CancelTripResultDTO(
            trip_id: "t1",
            prior_status: "committed",
            action: "compensation_dispatched",
            new_status: "rolled_back",
            message: "Refund issued for 2 of 2 legs."
        ))
        let vm = HistoryScreenViewModel(fetcher: fake)
        await vm.load()
        XCTAssertEqual(fake.historyFetchCount, 1)

        await vm.cancelTrip(id: "t1", reason: "changed plans")

        XCTAssertEqual(fake.cancelTripCalls.count, 1)
        XCTAssertEqual(fake.cancelTripCalls[0].id, "t1")
        XCTAssertEqual(fake.cancelTripCalls[0].reason, "changed plans")
        XCTAssertEqual(vm.tripCancelMessage?.tripID, "t1")
        XCTAssertEqual(vm.tripCancelMessage?.text, "Refund issued for 2 of 2 legs.")
        XCTAssertNil(vm.tripCancelError)
        XCTAssertNil(vm.cancellingTripID, "cancelling flag must clear after the call")
        XCTAssertEqual(fake.historyFetchCount, 2, "successful cancel must trigger a reload")
    }

    func test_historyVM_cancelTrip_skipsTerminalStatusWithoutCallingAPI() async {
        let fake = FakeDrawerScreensFetcher()
        let trip = HistoryTripDTO(
            trip_id: "t1",
            session_id: "s1",
            status: "rolled_back",
            payload: HistoryTripPayloadDTO(),
            created_at: "2026-04-29T10:00:00Z",
            updated_at: "2026-04-30T10:08:00Z",
            cancel_requested_at: nil
        )
        fake.historyResult = .success(HistoryResponseDTO(sessions: [], trips: [trip]))
        let vm = HistoryScreenViewModel(fetcher: fake)
        await vm.load()

        await vm.cancelTrip(id: "t1")

        XCTAssertTrue(fake.cancelTripCalls.isEmpty, "must not POST cancel for terminal trips")
    }

    func test_historyVM_cancelTrip_409_surfacesAlreadyFinalizedMessage() async {
        let fake = FakeDrawerScreensFetcher()
        let trip = HistoryTripDTO(
            trip_id: "t1",
            session_id: "s1",
            status: "committed",
            payload: HistoryTripPayloadDTO(),
            created_at: "2026-04-29T10:00:00Z",
            updated_at: "2026-04-30T10:08:00Z",
            cancel_requested_at: nil
        )
        fake.historyResult = .success(HistoryResponseDTO(sessions: [], trips: [trip]))
        fake.cancelTripResult = .failure(DrawerScreensError.tripAlreadyTerminal(currentStatus: "rolled_back"))
        let vm = HistoryScreenViewModel(fetcher: fake)
        await vm.load()

        await vm.cancelTrip(id: "t1")

        XCTAssertNil(vm.tripCancelMessage)
        XCTAssertNotNil(vm.tripCancelError)
        XCTAssertEqual(vm.tripCancelError?.tripID, "t1")
        XCTAssertTrue(vm.tripCancelError!.text.lowercased().contains("finalized"))
    }

    func test_historyVM_cancelTrip_404_surfacesUnknownTripMessage() async {
        let fake = FakeDrawerScreensFetcher()
        let trip = HistoryTripDTO(
            trip_id: "t1",
            session_id: "s1",
            status: "committed",
            payload: HistoryTripPayloadDTO(),
            created_at: "2026-04-29T10:00:00Z",
            updated_at: "2026-04-30T10:08:00Z",
            cancel_requested_at: nil
        )
        fake.historyResult = .success(HistoryResponseDTO(sessions: [], trips: [trip]))
        fake.cancelTripResult = .failure(DrawerScreensError.unknownTrip)
        let vm = HistoryScreenViewModel(fetcher: fake)
        await vm.load()

        await vm.cancelTrip(id: "t1")

        XCTAssertNotNil(vm.tripCancelError)
    }

    func test_historyVM_cancelTrip_falsesNetworkError() async {
        let fake = FakeDrawerScreensFetcher()
        let trip = HistoryTripDTO(
            trip_id: "t1",
            session_id: "s1",
            status: "committed",
            payload: HistoryTripPayloadDTO(),
            created_at: "2026-04-29T10:00:00Z",
            updated_at: "2026-04-30T10:08:00Z",
            cancel_requested_at: nil
        )
        fake.historyResult = .success(HistoryResponseDTO(sessions: [], trips: [trip]))
        fake.cancelTripResult = .failure(DrawerScreensError.transport("offline"))
        let vm = HistoryScreenViewModel(fetcher: fake)
        await vm.load()

        await vm.cancelTrip(id: "t1")

        XCTAssertNotNil(vm.tripCancelError)
        XCTAssertNil(vm.tripCancelMessage)
    }

    func test_cancelTripResultDTO_decodes_committedRolledBack() throws {
        let json = """
        {
          "trip_id": "t1",
          "prior_status": "committed",
          "action": "compensation_dispatched",
          "new_status": "rolled_back",
          "message": "Refund issued.",
          "legs": [
            {"order": 1, "status": "rolled_back"},
            {"order": 2, "status": "rolled_back"}
          ]
        }
        """.data(using: .utf8)!
        // legs is on the wire but iOS-v1 doesn't model it (the
        // post-cancel reload reflects each leg's status anyway).
        let decoded = try JSONDecoder().decode(CancelTripResultDTO.self, from: json)
        XCTAssertEqual(decoded.trip_id, "t1")
        XCTAssertEqual(decoded.action, "compensation_dispatched")
        XCTAssertEqual(decoded.new_status, "rolled_back")
        XCTAssertEqual(decoded.message, "Refund issued.")
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

    // MARK: - IOS-CONNECTIONS-1

    private static func makeConnection(
        id: String = "conn-1",
        agent_id: String = "lumo-google",
        status: String = "active",
        source: String? = "oauth",
        scopes: [String] = ["calendar.read"]
    ) -> ConnectionMetaDTO {
        ConnectionMetaDTO(
            id: id,
            agent_id: agent_id,
            display_name: "Lumo Google",
            one_liner: "Reads your calendar.",
            source: source,
            status: status,
            scopes: scopes,
            expires_at: nil,
            connected_at: "2026-04-30T10:00:00Z",
            last_used_at: "2026-05-02T08:00:00Z",
            revoked_at: nil,
            updated_at: "2026-05-02T08:00:00Z"
        )
    }

    func test_connectionsResponse_decodes_systemAndOauthRows() throws {
        let json = """
        {
          "connections": [
            {
              "id": "system:lumo.flight",
              "agent_id": "lumo.flight",
              "display_name": "Lumo Flight",
              "one_liner": "First-party.",
              "source": "system",
              "status": "active",
              "scopes": ["system"],
              "expires_at": null,
              "connected_at": "2026-04-01T00:00:00Z",
              "last_used_at": null,
              "revoked_at": null,
              "updated_at": "2026-04-01T00:00:00Z"
            },
            {
              "id": "abc",
              "agent_id": "lumo-google",
              "source": "oauth",
              "status": "active",
              "scopes": ["calendar.read"],
              "expires_at": "2026-06-01T00:00:00Z",
              "connected_at": "2026-04-30T10:00:00Z",
              "last_used_at": "2026-05-02T08:00:00Z",
              "revoked_at": null,
              "updated_at": "2026-05-02T08:00:00Z"
            }
          ]
        }
        """.data(using: .utf8)!
        let decoded = try JSONDecoder().decode(ConnectionsResponseDTO.self, from: json)
        XCTAssertEqual(decoded.connections.count, 2)
        XCTAssertTrue(decoded.connections[0].isSystem)
        XCTAssertFalse(decoded.connections[1].isSystem)
        XCTAssertTrue(decoded.connections[1].isActive)
    }

    func test_connectionsVM_load_success_listsConnections() async {
        let fake = FakeDrawerScreensFetcher()
        let conn = Self.makeConnection()
        fake.connectionsResult = .success(ConnectionsResponseDTO(connections: [conn]))
        let vm = ConnectionsScreenViewModel(fetcher: fake)
        await vm.load()
        guard case .loaded(let list) = vm.state else {
            return XCTFail("expected loaded; got \(vm.state)")
        }
        XCTAssertEqual(list.count, 1)
        XCTAssertEqual(fake.connectionsFetchCount, 1)
    }

    func test_connectionsVM_load_failure_surfacesError() async {
        let fake = FakeDrawerScreensFetcher()
        fake.connectionsResult = .failure(DrawerScreensError.badStatus(503))
        let vm = ConnectionsScreenViewModel(fetcher: fake)
        await vm.load()
        guard case .error = vm.state else {
            return XCTFail("expected error; got \(vm.state)")
        }
    }

    func test_connectionsVM_disconnect_success_optimisticallyRemoves() async {
        let fake = FakeDrawerScreensFetcher()
        let a = Self.makeConnection(id: "a", agent_id: "lumo-google")
        let b = Self.makeConnection(id: "b", agent_id: "lumo-stripe")
        fake.connectionsResult = .success(ConnectionsResponseDTO(connections: [a, b]))
        let vm = ConnectionsScreenViewModel(fetcher: fake)
        await vm.load()

        await vm.disconnect(id: "a")

        XCTAssertEqual(fake.disconnectCalls, ["a"])
        XCTAssertNil(vm.disconnectingID)
        XCTAssertNil(vm.disconnectError)
        guard case .loaded(let remaining) = vm.state else {
            return XCTFail("expected loaded; got \(vm.state)")
        }
        XCTAssertEqual(remaining.map(\.id), ["b"])
    }

    func test_connectionsVM_disconnect_failure_restoresAtSameIndex() async {
        let fake = FakeDrawerScreensFetcher()
        let conns = [
            Self.makeConnection(id: "a"),
            Self.makeConnection(id: "b"),
            Self.makeConnection(id: "c"),
        ]
        fake.connectionsResult = .success(ConnectionsResponseDTO(connections: conns))
        fake.disconnectResult = .failure(DrawerScreensError.transport("offline"))
        let vm = ConnectionsScreenViewModel(fetcher: fake)
        await vm.load()

        await vm.disconnect(id: "b")

        guard case .loaded(let restored) = vm.state else {
            return XCTFail("loaded state must survive disconnect failure")
        }
        XCTAssertEqual(restored.map(\.id), ["a", "b", "c"], "rolled-back row must return to its original slot")
        XCTAssertNotNil(vm.disconnectError)
    }

    func test_connectionsVM_disconnect_systemRow_isNoOp() async {
        let fake = FakeDrawerScreensFetcher()
        let sys = Self.makeConnection(id: "system:lumo.flight", source: "system")
        fake.connectionsResult = .success(ConnectionsResponseDTO(connections: [sys]))
        let vm = ConnectionsScreenViewModel(fetcher: fake)
        await vm.load()

        await vm.disconnect(id: "system:lumo.flight")

        XCTAssertTrue(fake.disconnectCalls.isEmpty, "must not POST disconnect for system rows")
    }

    func test_connectionsUI_statusStyle_branchesMatchWeb() {
        XCTAssertEqual(ConnectionsUI.statusStyle("active").label, "active")
        XCTAssertEqual(ConnectionsUI.statusStyle("expired").label, "expired")
        XCTAssertEqual(ConnectionsUI.statusStyle("revoked").label, "revoked")
        XCTAssertEqual(ConnectionsUI.statusStyle("error").label, "error")
        XCTAssertEqual(ConnectionsUI.statusStyle("anything-else").label, "anything-else")
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
