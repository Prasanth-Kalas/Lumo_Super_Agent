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
///
/// The four trailing fields (`traveler_summary`, `payment_summary`,
/// `prefilled`, `missing_fields`) are display-only autofill metadata
/// added in CHAT-CONFIRMATION-PAYLOAD-EXTEND-1. They're optional on
/// the wire — older summaries decode fine with all four nil/empty.
/// The card's autofill block + Different-traveler affordance both
/// gate on these fields.
struct ItineraryPayload: Equatable {
    let kind: String              // always "structured-itinerary"
    let offer_id: String
    let total_amount: String      // decimal string, e.g. "287.00"
    let total_currency: String    // ISO 4217
    let slices: [ItinerarySlice]
    /// One-line traveler descriptor, e.g. "Prasanth Kalas · prasanth@…".
    /// nil when the orchestrator didn't autofill traveler details.
    let traveler_summary: String?
    /// One-line payment descriptor, e.g. "Visa ending in 4242".
    /// nil when the orchestrator didn't autofill payment.
    let payment_summary: String?
    /// True when the listed traveler/payment summaries came from the
    /// user's approved profile (drives the "Prefilled from approved
    /// profile" subheader). Defaults to false when omitted.
    let prefilled: Bool
    /// Field names the orchestrator still needs from the user before
    /// it can dispatch the booking, e.g. `["payment_method_id"]`.
    /// Empty when the autofill is complete.
    let missing_fields: [String]

    init(
        kind: String,
        offer_id: String,
        total_amount: String,
        total_currency: String,
        slices: [ItinerarySlice],
        traveler_summary: String? = nil,
        payment_summary: String? = nil,
        prefilled: Bool = false,
        missing_fields: [String] = []
    ) {
        self.kind = kind
        self.offer_id = offer_id
        self.total_amount = total_amount
        self.total_currency = total_currency
        self.slices = slices
        self.traveler_summary = traveler_summary
        self.payment_summary = payment_summary
        self.prefilled = prefilled
        self.missing_fields = missing_fields
    }

    /// Convenience: true when the autofill block (traveler row +
    /// payment row + missing-fields prompt) should render at all.
    /// Mirrors web's gate: any of traveler/payment/missing present.
    var hasAutofillBlock: Bool {
        traveler_summary != nil || payment_summary != nil || !missing_fields.isEmpty
    }
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
    /// Submit string for the "Different traveler" footer button.
    /// Byte-identical with apps/web/app/page.tsx onDifferentTraveler.
    /// Note: no trailing period — matches web exactly so the
    /// orchestrator's intent classifier sees the same turn.
    static let differentTravelerText: String = "Use a different traveler"

    /// Build the missing-fields submit string. Mirrors web's
    /// `submitMissingFields` in apps/web/components/ItineraryConfirmationCard.tsx
    /// exactly: `"Here are the missing booking details: <Label>: <value>; <Label>: <value>"`.
    /// Empty values drop. Returns nil when no fields have been
    /// filled in (caller suppresses the submit button in that case).
    static func missingFieldsText(_ entries: [(field: String, value: String)]) -> String? {
        let parts = entries
            .map { (field, value) in (field, value.trimmingCharacters(in: .whitespacesAndNewlines)) }
            .filter { !$0.1.isEmpty }
            .map { (field, value) in "\(missingFieldLabel(field)): \(value)" }
        guard !parts.isEmpty else { return nil }
        return "Here are the missing booking details: \(parts.joined(separator: "; "))"
    }

    /// Display label for a missing-field key. Mirrors web's
    /// `missingFieldLabel` mapping verbatim.
    static func missingFieldLabel(_ field: String) -> String {
        switch field {
        case "payment_method_id":  return "Payment method"
        case "traveler_profile":   return "Traveler profile"
        case "passport_optional":  return "Passport"
        case "dob":                return "Date of birth"
        default:
            return field
                .components(separatedBy: CharacterSet(charactersIn: "_- "))
                .filter { !$0.isEmpty }
                .map { $0.prefix(1).uppercased() + $0.dropFirst() }
                .joined(separator: " ")
        }
    }

    /// Placeholder hint for a missing-field input. Mirrors web's
    /// `missingFieldPlaceholder` mapping verbatim.
    static func missingFieldPlaceholder(_ field: String) -> String {
        switch field {
        case "payment_method_id":  return "Default card or payment method"
        case "traveler_profile":   return "Traveler name and details"
        case "email":              return "traveler@example.com"
        case "phone":              return "+1 ..."
        case "dob":                return "YYYY-MM-DD"
        default:                   return ""
        }
    }

    /// Initial-letter marker for the traveler row. Web uses
    /// `value.trim().charAt(0).toUpperCase() || "P"`.
    static func travelerInitial(_ value: String) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let first = trimmed.first else { return "P" }
        return String(first).uppercased()
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
