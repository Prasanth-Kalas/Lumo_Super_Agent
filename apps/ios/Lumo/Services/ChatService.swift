import Foundation

enum ChatEvent: Equatable {
    case text(String)
    case error(String)
    case done
    case suggestions(turnID: String, items: [AssistantSuggestion])
    case selection(InteractiveSelection)
    case summary(ConfirmationSummary)
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
        case "selection":
            // Frame value shape (canonical contract — see
            // apps/web/lib/orchestrator.ts InteractiveSelection):
            //   { kind: "flight_offers" | "food_menu" | "time_slots",
            //     payload: <kind-specific> }
            // Only flight_offers decodes to a typed payload today;
            // unknown kinds round-trip via .unsupported so future
            // surfaces (food, time slots) can land without re-routing
            // the SSE plumbing.
            guard
                let value = json["value"] as? [String: Any],
                let kind = value["kind"] as? String
            else {
                return .other(type: type)
            }
            if kind == "flight_offers" {
                guard let payload = decodeFlightOffersPayload(value["payload"]) else {
                    return .other(type: type)
                }
                return .selection(.flightOffers(payload))
            }
            return .selection(.unsupported(kind: kind))
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
