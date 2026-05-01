import SwiftUI

/// BookingConfirmationCard — SwiftUI counterpart to the web component
/// at `apps/web/components/ItineraryConfirmationCard.tsx`. Mounts in
/// the chat thread when the orchestrator emits a `summary` SSE frame
/// with `kind: "structured-itinerary"`. Renders the canonical
/// itinerary payload (route + per-segment carrier + times + total)
/// plus the Confirm / Cancel money-gate buttons.
///
/// Confirm + Cancel both route through `ChatViewModel.sendSuggestion`
/// — the same entry point chip taps and flight-row taps use — so the
/// orchestrator's `isAffirmative` regex sees an indistinguishable
/// user turn whether the user typed "Yes, book it." or tapped
/// Confirm here. The exact strings live in `BookingConfirmationSubmit`
/// so iOS and web stay byte-identical.
///
/// Once the user has acted, the card transitions into a decided-label
/// state ("Confirmed — booking…" / "Cancelled") instead of vanishing
/// — the user just sent the confirm/cancel turn, so the rendered card
/// is the receipt of their action while the next assistant turn
/// streams in. Mirrors web's `decidedLabel` prop behaviour exactly.
///
/// CHAT-PROFILE-AUTOFILL-1's autofill effect is upstream and invisible
/// to this card: the orchestrator now skips the "give me your name /
/// email / payment" turn when scopes are connected, so the user
/// lands directly on this confirmation card from the offer-select
/// step. The traveler/payment summary rows the original brief
/// envisioned require an orchestrator-side payload extension and
/// land in IOS-CONFIRMATION-RICH-PAYLOAD-1.
struct BookingConfirmationCard: View {
    let payload: ItineraryPayload
    let decision: ConfirmationDecision?
    let isDisabled: Bool
    let onConfirm: () -> Void
    let onCancel: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider().background(LumoColors.separator)
            slicesView
            Divider().background(LumoColors.separator)
            footer
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
        .accessibilityLabel("Flight booking confirmation")
        .accessibilityIdentifier("booking-confirmation-card")
    }

    private var header: some View {
        HStack(alignment: .top, spacing: LumoSpacing.md) {
            VStack(alignment: .leading, spacing: 4) {
                Text("CONFIRM BOOKING")
                    .font(LumoFonts.caption.weight(.medium))
                    .tracking(1.4)
                    .foregroundStyle(LumoColors.labelSecondary)
                Text(routeSummary)
                    .font(LumoFonts.headline.weight(.semibold))
                    .foregroundStyle(LumoColors.label)
                    .lineLimit(2)
            }
            Spacer(minLength: LumoSpacing.sm)
            VStack(alignment: .trailing, spacing: 4) {
                Text("TOTAL")
                    .font(LumoFonts.caption.weight(.medium))
                    .tracking(1.4)
                    .foregroundStyle(LumoColors.labelSecondary)
                Text(BookingConfirmationSubmit.formatMoney(payload.total_amount, currency: payload.total_currency))
                    .font(.system(size: 22, weight: .semibold))
                    .foregroundStyle(LumoColors.label)
                    .accessibilityIdentifier("booking-confirmation-total")
            }
        }
        .padding(.horizontal, LumoSpacing.md)
        .padding(.vertical, LumoSpacing.sm + 4)
    }

    private var routeSummary: String {
        payload.slices
            .map { slice in
                "\(BookingConfirmationSubmit.cityFor(slice.origin)) → \(BookingConfirmationSubmit.cityFor(slice.destination))"
            }
            .joined(separator: "  ·  ")
    }

    private var slicesView: some View {
        VStack(alignment: .leading, spacing: LumoSpacing.sm) {
            ForEach(Array(payload.slices.enumerated()), id: \.offset) { idx, slice in
                if payload.slices.count > 1 {
                    Text(idx == 0 ? "OUTBOUND" : (idx == 1 ? "RETURN" : "LEG \(idx + 1)"))
                        .font(LumoFonts.caption.weight(.medium))
                        .tracking(1.4)
                        .foregroundStyle(LumoColors.labelSecondary)
                }
                ForEach(Array(slice.segments.enumerated()), id: \.offset) { _, seg in
                    segmentRow(seg)
                }
            }
        }
        .padding(.horizontal, LumoSpacing.md)
        .padding(.vertical, LumoSpacing.sm + 2)
    }

    private func segmentRow(_ seg: ItinerarySegment) -> some View {
        HStack(alignment: .top, spacing: LumoSpacing.sm) {
            // Carrier chip — mono letters on inset square, mirrors
            // the web `h-8 w-10 rounded-md bg-lumo-inset` look.
            Text(seg.carrier)
                .font(.system(size: 10.5, weight: .medium, design: .monospaced))
                .tracking(1.2)
                .foregroundStyle(LumoColors.label)
                .frame(width: 40, height: 32)
                .background(
                    RoundedRectangle(cornerRadius: 6)
                        .fill(LumoColors.surfaceElevated)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 6)
                        .stroke(LumoColors.separator, lineWidth: 1)
                )

            VStack(alignment: .leading, spacing: 2) {
                (
                    Text("\(seg.origin) → \(seg.destination)")
                        .font(.system(size: 13.5, weight: .medium, design: .monospaced))
                        .foregroundColor(.primary)
                    + Text("  ·  \(BookingConfirmationSubmit.carrierFor(seg.carrier)) ")
                        .font(.system(size: 13.5))
                        .foregroundColor(.secondary)
                    + Text("\(seg.carrier)\(seg.flight_number)")
                        .font(.system(size: 13.5, design: .monospaced))
                        .foregroundColor(.secondary)
                )
                .foregroundStyle(LumoColors.label)
                .lineLimit(1)
                .truncationMode(.tail)

                Text("\(BookingConfirmationSubmit.formatDate(seg.departing_at)) · \(BookingConfirmationSubmit.formatTime(seg.departing_at)) → \(BookingConfirmationSubmit.formatTime(seg.arriving_at))")
                    .font(LumoFonts.footnote)
                    .foregroundStyle(LumoColors.labelSecondary)
            }
        }
    }

    private var footer: some View {
        HStack(alignment: .center, spacing: LumoSpacing.sm) {
            (
                Text("Offer ")
                    .font(LumoFonts.caption)
                    .foregroundColor(.secondary)
                + Text(payload.offer_id)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundColor(.primary)
            )
            .lineLimit(1)
            .truncationMode(.middle)
            .layoutPriority(0)
            Spacer(minLength: LumoSpacing.xs)
            footerActions
                .layoutPriority(1)
        }
        .padding(.horizontal, LumoSpacing.md)
        .padding(.vertical, LumoSpacing.sm)
    }

    @ViewBuilder
    private var footerActions: some View {
        if let decision {
            Text(decision == .confirmed ? "Confirmed — booking…" : "Cancelled")
                .font(LumoFonts.footnote.weight(.medium))
                .foregroundStyle(decision == .confirmed ? LumoColors.success : LumoColors.labelSecondary)
                .accessibilityIdentifier("booking-confirmation-decided")
        } else {
            HStack(spacing: 6) {
                Button(action: onCancel) {
                    Text("Cancel")
                        .font(LumoFonts.footnote.weight(.medium))
                        .foregroundStyle(LumoColors.labelSecondary)
                        .padding(.horizontal, 12)
                        .frame(height: 32)
                }
                .buttonStyle(.plain)
                .disabled(isDisabled)
                .accessibilityIdentifier("booking-confirmation-cancel")

                Button(action: onConfirm) {
                    Text("Confirm")
                        .font(LumoFonts.footnote.weight(.medium))
                        .foregroundStyle(LumoColors.background)
                        .fixedSize()
                        .padding(.horizontal, 14)
                        .frame(height: 32)
                        .background(
                            Capsule().fill(LumoColors.label)
                        )
                }
                .buttonStyle(.plain)
                .disabled(isDisabled)
                .accessibilityLabel("Confirm booking")
                .accessibilityIdentifier("booking-confirmation-confirm")
            }
        }
    }
}
