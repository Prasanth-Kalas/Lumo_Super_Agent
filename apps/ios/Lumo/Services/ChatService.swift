import Foundation

enum ChatEvent: Equatable {
    case text(String)
    case error(String)
    case done
    case suggestions(turnID: String, items: [AssistantSuggestion])
    case selection(InteractiveSelection)
    case summary(ConfirmationSummary)
    case compoundDispatch(CompoundDispatchPayload)
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
    private let userIDProvider: () -> String?
    private let accessTokenProvider: () -> String?

    init(
        baseURL: URL,
        userIDProvider: @escaping () -> String? = { nil },
        accessTokenProvider: @escaping () -> String? = { nil },
        session: URLSession = .shared
    ) {
        self.baseURL = baseURL
        self.userIDProvider = userIDProvider
        self.accessTokenProvider = accessTokenProvider
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
        if let userID = userIDProvider(), !userID.isEmpty {
            request.setValue(userID, forHTTPHeaderField: "x-lumo-user-id")
        }
        if let token = accessTokenProvider(), !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
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
        case "selection":
            // Frame value shape (canonical contract — see
            // apps/web/lib/orchestrator.ts InteractiveSelection):
            //   { kind: "flight_offers" | "food_menu" | "time_slots",
            //     payload: <kind-specific> }
            // Three known kinds decode to typed payloads. Future
            // kinds round-trip via `.unsupported(kind:)` (forward-
            // compat). A known kind whose payload fails decoding
            // returns `.malformed(kind:reason:)` so callers can
            // distinguish "we don't know this kind yet" from "we
            // recognised the kind but the data was bad".
            guard
                let value = json["value"] as? [String: Any],
                let kind = value["kind"] as? String
            else {
                return .other(type: type)
            }
            switch kind {
            case "flight_offers":
                guard let payload = decodeFlightOffersPayload(value["payload"]) else {
                    return .selection(.malformed(kind: kind, reason: "flight_offers payload missing required fields"))
                }
                return .selection(.flightOffers(payload))
            case "food_menu":
                guard let payload = decodeFoodMenuPayload(value["payload"]) else {
                    return .selection(.malformed(kind: kind, reason: "food_menu payload missing required fields (restaurant_id, restaurant_name, menu)"))
                }
                return .selection(.foodMenu(payload))
            case "time_slots":
                guard let payload = decodeTimeSlotsPayload(value["payload"]) else {
                    return .selection(.malformed(kind: kind, reason: "time_slots payload missing required fields (restaurant_id, slots)"))
                }
                return .selection(.timeSlots(payload))
            default:
                return .selection(.unsupported(kind: kind))
            }
        case "summary":
            // Frame value shape (canonical contract — see
            // node_modules/@lumo/agent-sdk/src/confirmation.ts):
            //   { kind: "structured-itinerary" | "structured-trip" | …,
            //     hash, payload, session_id, turn_id, rendered_at }
            // Only structured-itinerary decodes today; future kinds
            // (trip, reservation, cart, generic booking) round-trip
            // via .summary(.unsupported(kind:)) so the wiring is
            // ready when their cards land.
            guard
                let value = json["value"] as? [String: Any],
                let kind = value["kind"] as? String,
                let hash = value["hash"] as? String,
                let session_id = value["session_id"] as? String,
                let turn_id = value["turn_id"] as? String,
                let rendered_at = value["rendered_at"] as? String
            else {
                return .other(type: type)
            }
            let envelope = ConfirmationEnvelope(
                hash: hash,
                session_id: session_id,
                turn_id: turn_id,
                rendered_at: rendered_at
            )
            if kind == "structured-itinerary" {
                guard let payload = decodeItineraryPayload(value["payload"]) else {
                    return .other(type: type)
                }
                return .summary(.itinerary(payload, envelope: envelope))
            }
            return .summary(.unsupported(kind: kind, envelope: envelope))
        case "assistant_compound_dispatch":
            // Frame value shape (canonical contract — see
            // apps/web/lib/compound/dispatch-frame.ts):
            //   { kind: "assistant_compound_dispatch",
            //     compound_transaction_id: string,
            //     legs: [{ leg_id, agent_id, agent_display_name,
            //              description, status }] }
            // Drop frames with empty legs (web's CompoundLegStrip
            // would render an empty strip; better to suppress at
            // the parser).
            guard let payload = decodeCompoundDispatchPayload(json["value"]) else {
                return .other(type: type)
            }
            return .compoundDispatch(payload)
        case "assistant_suggestions":
            // Frame value shape (canonical contract — see
            // apps/web/lib/chat-suggestions.ts):
            //   { kind: "assistant_suggestions",
            //     turn_id: string,
            //     suggestions: [{ id, label, value }] }
            // Drop frames with a missing turn_id or empty list — the
            // server already enforces the ≥2 minimum, but defending
            // here keeps the view layer free of conditional checks.
            guard
                let value = json["value"] as? [String: Any],
                let turnID = value["turn_id"] as? String,
                let raw = value["suggestions"] as? [[String: Any]]
            else {
                return .other(type: type)
            }
            let items: [AssistantSuggestion] = raw.compactMap { entry in
                guard
                    let id = entry["id"] as? String,
                    let label = entry["label"] as? String,
                    let val = entry["value"] as? String,
                    !label.isEmpty, !val.isEmpty
                else { return nil }
                return AssistantSuggestion(id: id, label: label, value: val)
            }
            guard !items.isEmpty else { return .other(type: type) }
            return .suggestions(turnID: turnID, items: items)
        default:
            return .other(type: type)
        }
    }

    /// Pure decoder for an `InteractiveSelection.flightOffers` payload.
    /// Internal so unit tests can exercise it with raw JSON shapes.
    /// Tolerant of shape drift — drops malformed offers / segments
    /// rather than failing the whole frame, so a single bad row
    /// from Duffel doesn't blank the whole card.
    static func decodeFlightOffersPayload(_ raw: Any?) -> FlightOffersPayload? {
        guard let dict = raw as? [String: Any],
              let rawOffers = dict["offers"] as? [[String: Any]] else {
            return nil
        }
        let offers: [FlightOffer] = rawOffers.compactMap { entry in
            guard
                let offer_id = entry["offer_id"] as? String,
                let total_amount = entry["total_amount"] as? String,
                let total_currency = entry["total_currency"] as? String,
                let ownerDict = entry["owner"] as? [String: Any],
                let ownerName = ownerDict["name"] as? String,
                let ownerIATA = ownerDict["iata_code"] as? String,
                let rawSlices = entry["slices"] as? [[String: Any]]
            else { return nil }
            let slices: [FlightOffer.Slice] = rawSlices.compactMap { decodeSlice($0) }
            guard !slices.isEmpty else { return nil }
            return FlightOffer(
                offer_id: offer_id,
                total_amount: total_amount,
                total_currency: total_currency,
                owner: .init(name: ownerName, iata_code: ownerIATA),
                slices: slices
            )
        }
        guard !offers.isEmpty else { return nil }
        return FlightOffersPayload(offers: offers)
    }

    /// Pure decoder for an `InteractiveSelection.foodMenu` payload.
    /// Mirrors `apps/web/components/FoodMenuSelectCard.tsx::FoodMenuSelection`
    /// (the wire shape from `food_get_restaurant_menu`).
    ///
    /// Tolerance rules:
    /// - Required: `restaurant_id`, `restaurant_name`, `menu` (array, may be empty).
    /// - Drops menu items missing `item_id`, `name`, or `unit_price_cents`
    ///   (rather than failing the whole payload — matches the web card's
    ///   `payload.menu ?? []` posture).
    /// - Returns nil only when the envelope itself is unusable.
    static func decodeFoodMenuPayload(_ raw: Any?) -> FoodMenuPayload? {
        guard
            let dict = raw as? [String: Any],
            let restaurantID = dict["restaurant_id"] as? String,
            let restaurantName = dict["restaurant_name"] as? String,
            let menuArray = dict["menu"] as? [[String: Any]]
        else {
            return nil
        }
        let isOpen = dict["is_open"] as? Bool
        let items: [FoodMenuItem] = menuArray.compactMap { row in
            guard
                let itemID = row["item_id"] as? String, !itemID.isEmpty,
                let name = row["name"] as? String, !name.isEmpty,
                let priceCents = row["unit_price_cents"] as? Int
            else {
                return nil
            }
            return FoodMenuItem(
                item_id: itemID,
                name: name,
                description: row["description"] as? String,
                unit_price_cents: priceCents,
                category: row["category"] as? String
            )
        }
        return FoodMenuPayload(
            restaurant_id: restaurantID,
            restaurant_name: restaurantName,
            is_open: isOpen,
            menu: items
        )
    }

    /// Pure decoder for an `InteractiveSelection.timeSlots` payload.
    /// Mirrors `apps/web/components/TimeSlotsSelectCard.tsx::TimeSlotsSelection`
    /// (the wire shape from `restaurant_check_availability`).
    ///
    /// Tolerance rules:
    /// - Required: `restaurant_id`, `slots` (array; may be empty).
    /// - Drops slot rows missing `slot_id`, `starts_at`, or `party_size`.
    /// - Returns nil when the envelope itself is unusable.
    static func decodeTimeSlotsPayload(_ raw: Any?) -> TimeSlotsPayload? {
        guard
            let dict = raw as? [String: Any],
            let restaurantID = dict["restaurant_id"] as? String,
            let slotsArray = dict["slots"] as? [[String: Any]]
        else {
            return nil
        }
        let slots: [TimeSlotOption] = slotsArray.compactMap { row in
            guard
                let slotID = row["slot_id"] as? String, !slotID.isEmpty,
                let startsAt = row["starts_at"] as? String, !startsAt.isEmpty,
                let partySize = row["party_size"] as? Int
            else {
                return nil
            }
            return TimeSlotOption(
                slot_id: slotID,
                starts_at: startsAt,
                party_size: partySize,
                table_type: row["table_type"] as? String,
                deposit_amount: row["deposit_amount"] as? String,
                deposit_currency: row["deposit_currency"] as? String,
                expires_at: row["expires_at"] as? String
            )
        }
        return TimeSlotsPayload(
            restaurant_id: restaurantID,
            restaurant_name: dict["restaurant_name"] as? String,
            date: dict["date"] as? String,
            party_size: dict["party_size"] as? Int,
            slots: slots
        )
    }

    /// Pure decoder for a `structured-itinerary` summary payload.
    /// Mirrors the web `ItineraryPayload` shape exactly (see
    /// apps/web/components/ItineraryConfirmationCard.tsx). Tolerant
    /// of shape drift — drops malformed slices/segments rather than
    /// failing the whole frame.
    ///
    /// The four trailing fields (`traveler_summary`, `payment_summary`,
    /// `prefilled`, `missing_fields`) are optional on the wire; older
    /// summaries decode the same as before with all four absent.
    /// Added in CHAT-CONFIRMATION-PAYLOAD-EXTEND-1 (web) /
    /// IOS-CONFIRMATION-RICH-PAYLOAD-1 (iOS).
    static func decodeItineraryPayload(_ raw: Any?) -> ItineraryPayload? {
        guard
            let dict = raw as? [String: Any],
            let kind = dict["kind"] as? String, kind == "structured-itinerary",
            let offer_id = dict["offer_id"] as? String,
            let total_amount = dict["total_amount"] as? String,
            let total_currency = dict["total_currency"] as? String,
            let rawSlices = dict["slices"] as? [[String: Any]]
        else { return nil }
        let slices: [ItinerarySlice] = rawSlices.compactMap(decodeItinerarySlice)
        guard !slices.isEmpty else { return nil }
        // Trailing autofill metadata — optional + tolerant. Web emits
        // `null` for the strings when the orchestrator didn't autofill
        // them; treat null, missing, and empty-string identically.
        let travelerSummary: String? = {
            guard let s = dict["traveler_summary"] as? String, !s.isEmpty else { return nil }
            return s
        }()
        let paymentSummary: String? = {
            guard let s = dict["payment_summary"] as? String, !s.isEmpty else { return nil }
            return s
        }()
        let prefilled = (dict["prefilled"] as? Bool) ?? false
        let rawMissing = (dict["missing_fields"] as? [String]) ?? []
        let missing = rawMissing
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        return ItineraryPayload(
            kind: kind,
            offer_id: offer_id,
            total_amount: total_amount,
            total_currency: total_currency,
            slices: slices,
            traveler_summary: travelerSummary,
            payment_summary: paymentSummary,
            prefilled: prefilled,
            missing_fields: dedupePreservingOrder(missing)
        )
    }

    /// Pure decoder for an `assistant_compound_dispatch` frame value.
    /// Mirrors web's `AssistantCompoundDispatchFrameValue` shape
    /// (apps/web/lib/compound/dispatch-frame.ts) — same field
    /// names, same status enum spelling. Tolerant of shape drift:
    /// drops malformed legs, treats unknown statuses as
    /// `manual_review` (matching web's `normalizeDispatchStatus`
    /// fallback). Returns nil when the dispatch carries no usable
    /// legs, so the view never renders an empty strip.
    static func decodeCompoundDispatchPayload(_ raw: Any?) -> CompoundDispatchPayload? {
        guard
            let dict = raw as? [String: Any],
            let kind = dict["kind"] as? String, kind == "assistant_compound_dispatch",
            let compound_transaction_id = dict["compound_transaction_id"] as? String,
            let rawLegs = dict["legs"] as? [[String: Any]]
        else { return nil }
        let legs: [CompoundLeg] = rawLegs.compactMap { leg in
            guard
                let leg_id = leg["leg_id"] as? String,
                let agent_id = leg["agent_id"] as? String,
                let agent_display_name = leg["agent_display_name"] as? String,
                let description = leg["description"] as? String,
                let status = leg["status"] as? String
            else { return nil }
            // Unknown statuses fall through to `manual_review` so
            // they decode rather than dropping the leg — matches
            // web's normalizeDispatchStatus fallback.
            let resolved = CompoundLegStatus(rawValue: status) ?? .manual_review
            // depends_on is optional on the wire (older frames
            // emitted by the dispatch helper before
            // IOS-COMPOUND-ROLLBACK-VIEW-1 omitted it). Default
            // to [] so the cascade compute treats the leg as a
            // root with no dependents.
            let depends_on: [String]
            if let raw = leg["depends_on"] as? [String] {
                depends_on = raw.filter { !$0.isEmpty }
            } else {
                depends_on = []
            }
            return CompoundLeg(
                leg_id: leg_id,
                agent_id: agent_id,
                agent_display_name: agent_display_name,
                description: description,
                status: resolved,
                depends_on: depends_on
            )
        }
        guard !legs.isEmpty else { return nil }
        return CompoundDispatchPayload(
            kind: kind,
            compound_transaction_id: compound_transaction_id,
            legs: legs
        )
    }

    /// Web's `normalizeMissingFields` dedupes while preserving order.
    /// Tiny helper here to keep iOS byte-identical.
    private static func dedupePreservingOrder(_ values: [String]) -> [String] {
        var seen = Set<String>()
        var out: [String] = []
        for v in values where !seen.contains(v) {
            seen.insert(v)
            out.append(v)
        }
        return out
    }

    private static func decodeItinerarySlice(_ raw: [String: Any]) -> ItinerarySlice? {
        guard
            let origin = raw["origin"] as? String,
            let destination = raw["destination"] as? String,
            let rawSegs = raw["segments"] as? [[String: Any]]
        else { return nil }
        let segments: [ItinerarySegment] = rawSegs.compactMap { seg in
            guard
                let segOrigin = seg["origin"] as? String,
                let segDest = seg["destination"] as? String,
                let dep = seg["departing_at"] as? String,
                let arr = seg["arriving_at"] as? String,
                let carrier = seg["carrier"] as? String,
                let flight_number = seg["flight_number"] as? String
            else { return nil }
            return ItinerarySegment(
                origin: segOrigin,
                destination: segDest,
                departing_at: dep,
                arriving_at: arr,
                carrier: carrier,
                flight_number: flight_number
            )
        }
        guard !segments.isEmpty else { return nil }
        return ItinerarySlice(origin: origin, destination: destination, segments: segments)
    }

    private static func decodeSlice(_ raw: [String: Any]) -> FlightOffer.Slice? {
        guard
            let originDict = raw["origin"] as? [String: Any],
            let originIATA = originDict["iata_code"] as? String,
            let destinationDict = raw["destination"] as? [String: Any],
            let destinationIATA = destinationDict["iata_code"] as? String,
            let duration = raw["duration"] as? String,
            let rawSegs = raw["segments"] as? [[String: Any]]
        else { return nil }
        let segments: [FlightOffer.Segment] = rawSegs.compactMap { seg in
            guard
                let dep = seg["departing_at"] as? String,
                let arr = seg["arriving_at"] as? String,
                let carrierDict = seg["marketing_carrier"] as? [String: Any],
                let iata = carrierDict["iata_code"] as? String,
                let flightNumber = seg["marketing_carrier_flight_number"] as? String
            else { return nil }
            return FlightOffer.Segment(
                departing_at: dep,
                arriving_at: arr,
                marketing_carrier_iata: iata,
                marketing_carrier_flight_number: flightNumber
            )
        }
        guard !segments.isEmpty else { return nil }
        return FlightOffer.Slice(
            origin: .init(iata_code: originIATA, city_name: originDict["city_name"] as? String),
            destination: .init(iata_code: destinationIATA, city_name: destinationDict["city_name"] as? String),
            duration: duration,
            segments: segments
        )
    }
}
