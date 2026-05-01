import SwiftUI

/// BookingConfirmationCard — SwiftUI counterpart to the web component
/// at `apps/web/components/ItineraryConfirmationCard.tsx`. Mounts in
/// the chat thread when the orchestrator emits a `summary` SSE frame
/// with `kind: "structured-itinerary"`. Renders the canonical
/// itinerary payload (route + per-segment carrier + times + total)
/// plus the Confirm / Cancel money-gate buttons.
///
/// Confirm + Cancel + Different-traveler all route through
/// `ChatViewModel.sendSuggestion` — the same entry point chip taps
/// and flight-row taps use — so the orchestrator's intent classifier
/// sees an indistinguishable user turn whether the user typed the
/// reply or tapped a button. The exact strings live in
/// `BookingConfirmationSubmit` so iOS and web stay byte-identical.
///
/// Once the user has acted, the card transitions into a decided-label
/// state ("Confirmed — booking…" / "Cancelled") instead of vanishing
/// — the user just sent the confirm/cancel turn, so the rendered card
/// is the receipt of their action while the next assistant turn
/// streams in. Mirrors web's `decidedLabel` prop behaviour exactly.
///
/// IOS-CONFIRMATION-RICH-PAYLOAD-1 adds the autofill block
/// (traveler row + payment row + "Prefilled from approved profile"
/// subheader) and the missing-fields branch (per-field inputs +
/// Send-details button) that web shipped in
/// CHAT-CONFIRMATION-PAYLOAD-EXTEND-1. Same render gates as web:
/// the block renders only when the payload carries at least one
/// of `traveler_summary`, `payment_summary`, or
/// `missing_fields[…]`.
struct BookingConfirmationCard: View {
    let payload: ItineraryPayload
    let decision: ConfirmationDecision?
    let isDisabled: Bool
    let onConfirm: () -> Void
    let onCancel: () -> Void
    /// nil hides the Different-traveler footer button. Mirrors web's
    /// `onDifferentTraveler` prop semantics — present only when the
    /// parent wants to surface the override path.
    var onDifferentTraveler: (() -> Void)? = nil
    /// nil hides the Send-details button at the bottom of the
    /// missing-fields form. The fields themselves still render; the
    /// user just can't submit them. Mirrors web's `onMissingFieldsSubmit`.
    var onMissingFieldsSubmit: ((String) -> Void)? = nil

    @State private var missingValues: [String: String] = [:]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider().background(LumoColors.separator)
            if payload.hasAutofillBlock {
                autofillBlock
                Divider().background(LumoColors.separator)
            }
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

    // MARK: - Header

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

    // MARK: - Autofill block

    @ViewBuilder
    private var autofillBlock: some View {
        VStack(alignment: .leading, spacing: LumoSpacing.sm + 2) {
            if payload.prefilled {
                Text("PREFILLED FROM APPROVED PROFILE")
                    .font(LumoFonts.caption.weight(.medium))
                    .tracking(1.4)
                    .foregroundStyle(LumoColors.labelTertiary)
                    .accessibilityIdentifier("booking-confirmation-prefilled-label")
            }
            if let traveler = payload.traveler_summary {
                profileSummaryRow(
                    marker: BookingConfirmationSubmit.travelerInitial(traveler),
                    label: "Traveler",
                    value: traveler,
                    testid: "booking-confirmation-traveler"
                )
            }
            if let payment = payload.payment_summary {
                profileSummaryRow(
                    marker: "CARD",
                    label: "Payment",
                    value: payment,
                    testid: "booking-confirmation-payment"
                )
            }
            if !payload.missing_fields.isEmpty {
                missingFieldsForm
            }
        }
        .padding(.horizontal, LumoSpacing.md)
        .padding(.vertical, LumoSpacing.sm + 2)
    }

    private func profileSummaryRow(marker: String, label: String, value: String, testid: String) -> some View {
        HStack(alignment: .center, spacing: LumoSpacing.sm + 2) {
            // Marker chip — mono letters on inset surface, parity
            // with web's ProfileSummaryRow marker.
            Text(marker)
                .font(.system(size: 10, weight: .semibold, design: .monospaced))
                .foregroundStyle(LumoColors.labelSecondary)
                .padding(.horizontal, 8)
                .frame(minWidth: 32, minHeight: 32)
                .background(
                    RoundedRectangle(cornerRadius: 6)
                        .fill(LumoColors.surfaceElevated)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 6)
                        .stroke(LumoColors.separator, lineWidth: 1)
                )
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 1) {
                Text(label.uppercased())
                    .font(LumoFonts.caption.weight(.medium))
                    .tracking(1.4)
                    .foregroundStyle(LumoColors.labelTertiary)
                Text(value)
                    .font(.system(size: 13))
                    .foregroundStyle(LumoColors.label)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            Spacer(minLength: 0)
        }
        .accessibilityIdentifier(testid)
    }

    private var missingFieldsForm: some View {
        VStack(alignment: .leading, spacing: LumoSpacing.sm) {
            Text("Need: \(payload.missing_fields.map(BookingConfirmationSubmit.missingFieldLabel).joined(separator: ", "))")
                .font(LumoFonts.footnote.weight(.medium))
                .foregroundStyle(LumoColors.labelSecondary)
                .accessibilityIdentifier("booking-confirmation-missing-fields-summary")

            VStack(alignment: .leading, spacing: 8) {
                ForEach(payload.missing_fields, id: \.self) { field in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(BookingConfirmationSubmit.missingFieldLabel(field))
                            .font(LumoFonts.caption)
                            .foregroundStyle(LumoColors.labelTertiary)
                        TextField(
                            BookingConfirmationSubmit.missingFieldPlaceholder(field),
                            text: Binding(
                                get: { missingValues[field] ?? "" },
                                set: { missingValues[field] = $0 }
                            )
                        )
                        .font(.system(size: 12.5))
                        .padding(.horizontal, 10)
                        .frame(height: 32)
                        .background(
                            RoundedRectangle(cornerRadius: 6)
                                .fill(LumoColors.background)
                        )
                        .overlay(
                            RoundedRectangle(cornerRadius: 6)
                                .stroke(LumoColors.separator, lineWidth: 1)
                        )
                        .disabled(isDisabled)
                        .accessibilityIdentifier("booking-confirmation-missing-input-\(field)")
                    }
                }
            }

            if onMissingFieldsSubmit != nil {
                Button(action: submitMissingFields) {
                    Text("Send details")
                        .font(LumoFonts.footnote.weight(.medium))
                        .foregroundStyle(LumoColors.labelSecondary)
                        .padding(.horizontal, 12)
                        .frame(height: 32)
                        .background(
                            RoundedRectangle(cornerRadius: 6)
                                .fill(LumoColors.surface)
                        )
                        .overlay(
                            RoundedRectangle(cornerRadius: 6)
                                .stroke(LumoColors.separator, lineWidth: 1)
                        )
                }
                .buttonStyle(.plain)
                .disabled(isDisabled || !hasAnyMissingValue)
                .accessibilityIdentifier("booking-confirmation-missing-submit")
            }
        }
        .padding(LumoSpacing.sm + 2)
        .background(
            RoundedRectangle(cornerRadius: 8)
                .fill(LumoColors.surfaceElevated.opacity(0.5))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(LumoColors.separator, lineWidth: 1)
        )
    }

    private var hasAnyMissingValue: Bool {
        payload.missing_fields.contains { field in
            !(missingValues[field] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
    }

    private func submitMissingFields() {
        guard let handler = onMissingFieldsSubmit, !isDisabled else { return }
        let entries = payload.missing_fields.map { field in
            (field, missingValues[field] ?? "")
        }
        guard let text = BookingConfirmationSubmit.missingFieldsText(entries) else { return }
        handler(text)
    }

    // MARK: - Slices + footer

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

    // MARK: - Footer
    //
    // iPhone width can't host the offer_id + three buttons on a
    // single row, so the Different-traveler affordance stacks above
    // Cancel + Confirm when present. Web's wide-viewport layout
    // keeps all three on the same row; the visual outcome here is
    // semantically equivalent — same buttons, same submit strings,
    // just stacked for the narrower frame.

    private var footer: some View {
        VStack(alignment: .trailing, spacing: 8) {
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
                primaryActions
                    .layoutPriority(1)
            }
            if let onDifferentTraveler, decision == nil {
                Button(action: onDifferentTraveler) {
                    Text("Different traveler")
                        .font(LumoFonts.footnote.weight(.medium))
                        .foregroundStyle(LumoColors.labelSecondary)
                        .padding(.horizontal, 12)
                        .frame(height: 32)
                }
                .buttonStyle(.plain)
                .disabled(isDisabled)
                .accessibilityIdentifier("booking-confirmation-different-traveler")
            }
        }
        .padding(.horizontal, LumoSpacing.md)
        .padding(.vertical, LumoSpacing.sm)
    }

    @ViewBuilder
    private var primaryActions: some View {
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
