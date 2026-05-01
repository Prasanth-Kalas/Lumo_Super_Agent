import Foundation

/// Mirror of the web/SDK `ConfirmationSummary` envelope used to gate
/// money-moving tool calls. Source of truth lives in
/// `node_modules/@lumo/agent-sdk/src/confirmation.ts`. The orchestrator
/// emits one of these via the `summary` SSE frame whenever a tool's
/// response should render as a structured booking gate (flight, trip,
/// reservation, cart, generic booking).
///
/// Today the iOS shell only renders `structured-itinerary` (the
/// flight-pricing card behind `flight_price_offer`). Other kinds
/// round-trip via `.unsupported(kind:)` so future cards can land
/// without re-routing the SSE plumbing — same pattern as the
/// `selection` envelope in Selection.swift.
enum ConfirmationSummary: Equatable {
    case itinerary(ItineraryPayload, envelope: ConfirmationEnvelope)
    case unsupported(kind: String, envelope: ConfirmationEnvelope)

    var envelope: ConfirmationEnvelope {
        switch self {
        case .itinerary(_, let env), .unsupported(_, let env): return env
        }
    }
}

/// The non-payload metadata on every summary frame. The hash + offer
/// ids are what the orchestrator's `evaluateConfirmation` gate uses
/// to verify a confirm-turn matches the rendered card. iOS doesn't
/// re-hash payloads — we treat them as opaque data.
struct ConfirmationEnvelope: Equatable {
    let hash: String
    let session_id: String
    let turn_id: String
    let rendered_at: String
}

/// Terminal label state for a confirmation card once the user has
/// acted. Drives the footer copy ("Confirmed — booking…" /
/// "Cancelled") and disables the Confirm/Cancel buttons. Mirrors web's
/// `decidedLabel: "confirmed" | "cancelled" | null` prop.
enum ConfirmationDecision: String, Equatable {
    case confirmed
    case cancelled
}

/// Payload of a `structured-itinerary` summary. Mirrors
/// `ItineraryPayload` in apps/web/components/ItineraryConfirmationCard.tsx
/// — same field names, same order, so the card renders the same
/// content on both surfaces.
struct ItineraryPayload: Equatable {
    let kind: String              // always "structured-itinerary"
    let offer_id: String
    let total_amount: String      // decimal string, e.g. "287.00"
    let total_currency: String    // ISO 4217
    let slices: [ItinerarySlice]
}

struct ItinerarySlice: Equatable {
    let origin: String            // IATA
    let destination: String       // IATA
    let segments: [ItinerarySegment]
}

struct ItinerarySegment: Equatable {
    let origin: String            // IATA
    let destination: String       // IATA
    let departing_at: String      // ISO 8601
    let arriving_at: String       // ISO 8601
    let carrier: String           // IATA, e.g. "UA"
    let flight_number: String
}

/// Pure helpers shared by the SwiftUI view and unit tests. Submit
/// strings match the web shell's existing `sendText` payloads in
/// apps/web/app/page.tsx so the orchestrator's confirm-turn gate
/// (`isAffirmative` regex + `evaluateConfirmation`) treats web and
/// iOS confirms identically.
enum BookingConfirmationSubmit {
    static let confirmText: String = "Yes, book it."
    static let cancelText: String = "Cancel — don't book that."

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
            return String(format: "%.0f %@", n, currency)
        }
        return "\(sym)\(String(format: "%.0f", n))"
    }

    /// Light IATA → city map. Display-only; hash stability is
    /// the orchestrator's job, not iOS's. Intentionally identical
    /// to the web `CITY_BY_IATA` so paired screenshots line up.
    static let cityByIATA: [String: String] = [
        "SFO": "San Francisco",
        "LAS": "Las Vegas",
        "JFK": "New York",
        "LAX": "Los Angeles",
        "SEA": "Seattle",
        "ORD": "Chicago",
        "LHR": "London",
        "NRT": "Tokyo",
        "SJC": "San Jose",
        "BOS": "Boston",
        "AUS": "Austin",
        "DEN": "Denver",
    ]

    static func cityFor(_ iata: String) -> String {
        cityByIATA[iata] ?? iata
    }

    static let carrierNames: [String: String] = [
        "UA": "United",
        "AS": "Alaska",
        "DL": "Delta",
        "AA": "American",
        "BA": "British Airways",
        "B6": "JetBlue",
        "F9": "Frontier",
    ]

    static func carrierFor(_ iata: String) -> String {
        carrierNames[iata] ?? iata
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
        if let range = iso.range(of: #"T(\d{2}):(\d{2})"#, options: .regularExpression) {
            return String(iso[range].dropFirst())
        }
        return iso
    }

    static func formatDate(_ iso: String) -> String {
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime]
        if let d = parser.date(from: iso) {
            let fmt = DateFormatter()
            fmt.dateFormat = "EEE, MMM d"
            fmt.timeZone = TimeZone(identifier: "UTC")
            return fmt.string(from: d)
        }
        return String(iso.prefix(10))
    }
}
