import Foundation

/// Mirror of the web `InteractiveSelection` envelope (see
/// `apps/web/lib/orchestrator.ts`). The orchestrator emits these
/// alongside text frames when a tool result should render as a
/// pickable card rather than as plain prose.
///
/// Only the `flight_offers` kind is surfaced on iOS today
/// (CHAT-FLIGHT-SELECT-CLICKABLE-1). The other kinds (`food_menu`,
/// `time_slots`) decode but render as nothing yet — when their
/// SwiftUI counterparts ship, the `kind` enum gains the matching
/// associated payload + ChatView mounts the card.
enum InteractiveSelection: Equatable {
    case flightOffers(FlightOffersPayload)
    case unsupported(kind: String)

    /// Latest-wins dedupe key — when a turn re-emits a selection of
    /// the same kind, the new one replaces the old. Mirrors web's
    /// `selections.filter((x) => x.kind !== s.kind)` upsert.
    func sameKind(as other: InteractiveSelection) -> Bool {
        switch (self, other) {
        case (.flightOffers, .flightOffers): return true
        case let (.unsupported(a), .unsupported(b)): return a == b
        default: return false
        }
    }
}

struct FlightOffersPayload: Equatable {
    var offers: [FlightOffer]
}

struct FlightOffer: Identifiable, Equatable {
    let offer_id: String
    let total_amount: String   // Duffel returns stringified decimal
    let total_currency: String
    let owner: Owner
    let slices: [Slice]

    /// `Identifiable` conformance — the offer_id is unique per Duffel
    /// pull, so SwiftUI can key by it directly.
    var id: String { offer_id }

    struct Owner: Equatable {
        let name: String
        let iata_code: String
    }

    struct Slice: Equatable {
        let origin: Endpoint
        let destination: Endpoint
        let duration: String   // ISO-8601 duration
        let segments: [Segment]
    }

    struct Endpoint: Equatable {
        let iata_code: String
        let city_name: String?
    }

    struct Segment: Equatable {
        let departing_at: String
        let arriving_at: String
        let marketing_carrier_iata: String
        let marketing_carrier_flight_number: String
    }
}

/// Pure helpers — kept on the model so both the SwiftUI view and the
/// unit tests share one source of truth for the orchestrator-handoff
/// submit string. The exact wording locks the orchestrator's
/// `flight_price_offer` parser in place; mirrors the web
/// `buildOfferSubmitText` in apps/web/lib/flight-offers-helpers.ts.
enum FlightOffersSubmit {
    static func text(for offer: FlightOffer) -> String {
        guard let firstSlice = offer.slices.first,
              let firstSeg = firstSlice.segments.first else {
            return "Go with offer \(offer.offer_id)."
        }
        let onward = firstSlice.segments.count > 1 ? " (with connection)" : " direct"
        return "Go with offer \(offer.offer_id) — the \(formatTime(firstSeg.departing_at)) \(offer.owner.name)\(onward) for \(formatMoney(offer.total_amount, currency: offer.total_currency))."
    }

    static func formatMoney(_ amount: String, currency: String) -> String {
        guard let n = Double(amount) else { return "\(amount) \(currency)" }
        let sym: String = {
            switch currency {
            case "USD": return "$"
            case "EUR": return "€"
            case "GBP": return "£"
            default:    return ""
            }
        }()
        if sym.isEmpty {
            return String(format: "%.2f %@", n, currency)
        }
        return "\(sym)\(String(format: "%.2f", n))"
    }

    static func formatTime(_ iso: String) -> String {
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime]
        if let d = parser.date(from: iso) {
            let fmt = DateFormatter()
            fmt.dateFormat = "h:mm a"
            fmt.timeZone = TimeZone(identifier: "UTC")
            return fmt.string(from: d)
        }
        // Fallback — slice HH:mm out of the raw string if ISO parsing
        // fails (older orchestrator paths sometimes emit non-Z tz).
        if let range = iso.range(of: #"T(\d{2}):(\d{2})"#, options: .regularExpression) {
            return String(iso[range].dropFirst())
        }
        return iso
    }

    static func formatIsoDuration(_ iso: String) -> String {
        guard let m = iso.range(of: #"^PT(?:(\d+)H)?(?:(\d+)M)?"#, options: .regularExpression) else {
            return iso
        }
        let s = String(iso[m])
        var out = ""
        if let h = s.range(of: #"\d+(?=H)"#, options: .regularExpression) {
            out += "\(s[h])h"
        }
        if let mn = s.range(of: #"\d+(?=M)"#, options: .regularExpression) {
            if !out.isEmpty { out += " " }
            out += "\(s[mn])m"
        }
        return out.isEmpty ? iso : out
    }
}
