import Foundation

/// Mirror of the web `InteractiveSelection` envelope (see
/// `apps/web/lib/orchestrator.ts`). The orchestrator emits these
/// alongside text frames when a tool result should render as a
/// pickable card rather than as plain prose.
///
/// Three known kinds today — flight_offers (FlightOffersPayload),
/// food_menu (FoodMenuPayload), time_slots (TimeSlotsPayload). Only
/// flight_offers has its SwiftUI card mounted in ChatView; the food
/// and time-slots cards land when web's parallel lanes ship
/// (IOS-SELECT-CLICKABLE-FOOD-1 / -RESTAURANT-1). Until then the
/// parser still produces typed payloads so the wiring is ready.
///
/// Two non-rendering cases:
///   • `.unsupported(kind:)` — known frame envelope, kind we don't
///     handle yet. Forward-compat when web ships a new kind before
///     iOS catches up.
///   • `.malformed(kind:reason:)` — known kind, payload failed
///     decoding. Distinct from `.unsupported` so callers can log the
///     decode failure separately and surface a "couldn't read this"
///     surface; today no card consumes this case but the contract is
///     reserved for it.
enum InteractiveSelection: Equatable {
    case flightOffers(FlightOffersPayload)
    case foodMenu(FoodMenuPayload)
    case timeSlots(TimeSlotsPayload)
    case unsupported(kind: String)
    case malformed(kind: String, reason: String)

    /// Latest-wins dedupe key — when a turn re-emits a selection of
    /// the same kind, the new one replaces the old. Mirrors web's
    /// `selections.filter((x) => x.kind !== s.kind)` upsert.
    func sameKind(as other: InteractiveSelection) -> Bool {
        switch (self, other) {
        case (.flightOffers, .flightOffers): return true
        case (.foodMenu, .foodMenu): return true
        case (.timeSlots, .timeSlots): return true
        case let (.unsupported(a), .unsupported(b)): return a == b
        case let (.malformed(a, _), .malformed(b, _)): return a == b
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

// MARK: - Food menu

/// Mirror of `apps/web/components/FoodMenuSelectCard.tsx::FoodMenuSelection`.
/// Wire shape uses `menu` (canonical from `food_get_restaurant_menu`);
/// we keep that field name here so JSON decode is straight-through.
///
/// IOS-FOOD-MENU-TIME-SLOTS-PARSE-1 introduces the typed payload at
/// the parser boundary; the SwiftUI card lands in
/// IOS-SELECT-CLICKABLE-FOOD-1.
struct FoodMenuPayload: Equatable {
    let restaurant_id: String
    let restaurant_name: String
    let is_open: Bool?
    let menu: [FoodMenuItem]
}

struct FoodMenuItem: Identifiable, Equatable {
    let item_id: String
    let name: String
    let description: String?
    let unit_price_cents: Int
    let category: String?

    var id: String { item_id }
}

// MARK: - Time slots

/// Mirror of `apps/web/components/TimeSlotsSelectCard.tsx::TimeSlotsSelection`.
/// Wire shape from `restaurant_check_availability` — single-select
/// list of slot rows, each with starts_at + party_size + optional
/// deposit details.
///
/// IOS-FOOD-MENU-TIME-SLOTS-PARSE-1 introduces the typed payload at
/// the parser boundary; the SwiftUI card lands in
/// IOS-SELECT-CLICKABLE-RESTAURANT-1.
struct TimeSlotsPayload: Equatable {
    let restaurant_id: String
    let restaurant_name: String?
    let date: String?
    let party_size: Int?
    let slots: [TimeSlotOption]
}

struct TimeSlotOption: Identifiable, Equatable {
    let slot_id: String
    /// Local wall-clock ISO, e.g. "2026-05-15T19:30:00-07:00".
    let starts_at: String
    let party_size: Int
    let table_type: String?
    /// Deposit the venue holds at booking. "0" when free.
    let deposit_amount: String?
    let deposit_currency: String?
    let expires_at: String?

    var id: String { slot_id }
}
