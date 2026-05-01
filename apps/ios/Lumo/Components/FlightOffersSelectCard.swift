import SwiftUI

/// FlightOffersSelectCard — SwiftUI counterpart to the web component
/// at `apps/web/components/FlightOffersSelectCard.tsx`. Renders the
/// orchestrator's `flight_offers` interactive-selection payload as a
/// stack of clickable rows with single-tap-to-submit behavior.
///
/// Interaction (mirrors web — CHAT-FLIGHT-SELECT-CLICKABLE-1):
///   - Tap a row → that row immediately shows a "Selected" pill +
///     the accent stripe, sibling rows fade to 40% opacity.
///   - After a short confirmation window (~280ms), the card calls
///     `onSubmit` with the natural-language submit text from
///     `FlightOffersSubmit.text(for:)` — same offer-id contract the
///     orchestrator's `flight_price_offer` handoff already understands.
///   - During the confirmation window, sibling-row taps are ignored
///     (the row buttons disable except the selected one).
///
/// There is no separate "Continue" CTA — the tap IS the commit.
/// Power users can still type the carrier name in the chat composer
/// as before; the orchestrator parses that path server-side.
struct FlightOffersSelectCard: View {
    let payload: FlightOffersPayload
    let isDisabled: Bool
    let onSubmit: (String) -> Void

    @State private var selectedOfferID: String?

    /// Submit window — perceptible enough for the user to register
    /// the row commit, short enough to feel responsive. Mirrors
    /// `SUBMIT_DELAY_MS = 280` in the web component.
    private static let submitDelay: TimeInterval = 0.28

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider().background(LumoColors.separator)
            ForEach(payload.offers) { offer in
                offerRow(offer)
                if offer.id != payload.offers.last?.id {
                    Divider().background(LumoColors.separator)
                }
            }
        }
        .background(
            RoundedRectangle(cornerRadius: LumoRadius.lg)
                .fill(LumoColors.surface)
        )
        .overlay(
            RoundedRectangle(cornerRadius: LumoRadius.lg)
                .stroke(LumoColors.separator, lineWidth: 1)
        )
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Flight offers")
        .accessibilityIdentifier("flight-offers-card")
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("FLIGHT OPTIONS")
                .font(LumoFonts.caption.weight(.medium))
                .tracking(1.4)
                .foregroundStyle(LumoColors.labelSecondary)
            HStack(spacing: 6) {
                Text("\(payload.offers.count) offer\(payload.offers.count == 1 ? "" : "s")")
                    .font(LumoFonts.callout.weight(.medium))
                    .foregroundStyle(LumoColors.label)
                Text("· tap to select")
                    .font(LumoFonts.callout)
                    .foregroundStyle(LumoColors.labelSecondary)
            }
        }
        .padding(.horizontal, LumoSpacing.md)
        .padding(.vertical, LumoSpacing.sm + 2)
    }

    private func offerRow(_ offer: FlightOffer) -> some View {
        let selected = offer.id == selectedOfferID
        let dimmed = selectedOfferID != nil && !selected
        let frozen = isDisabled || (selectedOfferID != nil && !selected)

        return Button(action: { pick(offer) }) {
            HStack(alignment: .top, spacing: LumoSpacing.sm) {
                // Accent stripe on the leading edge — exactly 2pt
                // wide, matches the web `w-[2px]` selection bar.
                Rectangle()
                    .fill(selected ? LumoColors.cyan : Color.clear)
                    .frame(width: 2)
                    .frame(maxHeight: .infinity)

                VStack(alignment: .leading, spacing: 4) {
                    timesRow(offer, selected: selected)
                    detailLine(offer)
                }
                .padding(.vertical, LumoSpacing.sm + 2)

                Spacer(minLength: LumoSpacing.sm)

                priceColumn(offer)
                    .padding(.trailing, LumoSpacing.md)
                    .padding(.vertical, LumoSpacing.sm + 2)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(selected ? LumoColors.surfaceElevated : Color.clear)
            .opacity(dimmed ? 0.4 : 1)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(frozen)
        .accessibilityIdentifier("flight-offers-row-\(offer.id)")
        .accessibilityLabel(accessibilityLabel(for: offer))
        .accessibilityHint(Text("Selects this flight"))
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private func timesRow(_ offer: FlightOffer, selected: Bool) -> some View {
        guard let firstSlice = offer.slices.first,
              let firstSeg = firstSlice.segments.first,
              let lastSeg = firstSlice.segments.last else {
            return AnyView(EmptyView())
        }
        return AnyView(
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(FlightOffersSubmit.formatTime(firstSeg.departing_at))
                    .font(LumoFonts.callout.weight(.medium))
                    .foregroundStyle(LumoColors.label)
                Text(firstSlice.origin.iata_code)
                    .font(.system(.footnote, design: .monospaced))
                    .foregroundStyle(LumoColors.labelSecondary)
                Text("→")
                    .foregroundStyle(LumoColors.labelTertiary)
                Text(FlightOffersSubmit.formatTime(lastSeg.arriving_at))
                    .font(LumoFonts.callout.weight(.medium))
                    .foregroundStyle(LumoColors.label)
                Text(firstSlice.destination.iata_code)
                    .font(.system(.footnote, design: .monospaced))
                    .foregroundStyle(LumoColors.labelSecondary)

                if selected {
                    Spacer(minLength: 6)
                    selectedPill
                        .accessibilityIdentifier("flight-offers-row-\(offer.id)-pill")
                }
            }
        )
    }

    private var selectedPill: some View {
        HStack(spacing: 4) {
            Circle()
                .fill(LumoColors.cyan)
                .frame(width: 6, height: 6)
            Text("SELECTED")
                .font(LumoFonts.caption.weight(.medium))
                .tracking(1.0)
        }
        .foregroundStyle(LumoColors.cyan)
        .padding(.horizontal, 8)
        .padding(.vertical, 2)
        .background(
            Capsule().fill(LumoColors.cyan.opacity(0.15))
        )
    }

    private func detailLine(_ offer: FlightOffer) -> some View {
        guard let firstSlice = offer.slices.first,
              let firstSeg = firstSlice.segments.first else {
            return AnyView(EmptyView())
        }
        let stops = firstSlice.segments.count - 1
        let flightNumbers = firstSlice.segments
            .map { "\($0.marketing_carrier_iata)\($0.marketing_carrier_flight_number)" }
            .joined(separator: " · ")
        let stopsText = stops == 0 ? " · nonstop" : " · \(stops) stop\(stops == 1 ? "" : "s")"

        return AnyView(
            (
                Text("\(formatDate(firstSeg.departing_at)) · \(offer.owner.name) ")
                + Text(flightNumbers).font(.system(.footnote, design: .monospaced))
                + Text(" · \(FlightOffersSubmit.formatIsoDuration(firstSlice.duration))\(stopsText)")
            )
            .font(LumoFonts.footnote)
            .foregroundStyle(LumoColors.labelSecondary)
        )
    }

    private func priceColumn(_ offer: FlightOffer) -> some View {
        VStack(alignment: .trailing, spacing: 2) {
            Text(FlightOffersSubmit.formatMoney(offer.total_amount, currency: offer.total_currency))
                .font(LumoFonts.callout.weight(.medium))
                .foregroundStyle(LumoColors.label)
            Text("TOTAL")
                .font(LumoFonts.caption)
                .tracking(1.0)
                .foregroundStyle(LumoColors.labelTertiary)
        }
    }

    private func formatDate(_ iso: String) -> String {
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

    private func accessibilityLabel(for offer: FlightOffer) -> Text {
        guard let firstSlice = offer.slices.first,
              let firstSeg = firstSlice.segments.first,
              let lastSeg = firstSlice.segments.last else {
            return Text(offer.owner.name)
        }
        let stops = firstSlice.segments.count - 1
        let stopsText = stops == 0 ? "nonstop" : "\(stops) stop"
        let dep = FlightOffersSubmit.formatTime(firstSeg.departing_at)
        let arr = FlightOffersSubmit.formatTime(lastSeg.arriving_at)
        let price = FlightOffersSubmit.formatMoney(offer.total_amount, currency: offer.total_currency)
        return Text(
            "\(offer.owner.name) flight, departing \(dep), arriving \(arr), \(stopsText), \(price)"
        )
    }

    private func pick(_ offer: FlightOffer) {
        guard !isDisabled, selectedOfferID == nil else { return }
        selectedOfferID = offer.id
        let submitText = FlightOffersSubmit.text(for: offer)
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.submitDelay) {
            onSubmit(submitText)
        }
    }
}
