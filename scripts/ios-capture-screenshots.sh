#!/usr/bin/env bash
# Capture light + dark screenshots of every Lumo iOS screen for the
# review packets.
#
# Default sprint: MOBILE-CHAT-1B — captures auth + chat-empty + trips
# + settings.
#
# Override sprint: pass LUMO_SHOTS_VARIANT=voice to capture the
# MOBILE-VOICE-1 additions (voice-idle composer, mid-listening with
# live transcript). The voice variants use DEBUG-only launch args
# (-LumoVoiceFixture {listening|transcript}) to deterministically
# render the listening state without a real microphone.
set -euo pipefail

bundle_id="com.lumo.rentals.ios.dev"
sim_id="${LUMO_SIM_ID:-12CA8A97-CB46-49E5-95EB-88B072FF57CD}"
out_dir="${LUMO_SHOTS_OUT:-docs/notes/mobile-chat-1b-screenshots}"
variant="${LUMO_SHOTS_VARIANT:-default}"

repo_root=$(cd "$(dirname "$0")/.." && pwd)
out_full="$repo_root/$out_dir"
mkdir -p "$out_full"

xcrun simctl boot "$sim_id" 2>/dev/null || true
sleep 1

capture() {
    local name="$1"; shift
    local appearance="$1"; shift  # light|dark
    local extra_args=("$@")

    xcrun simctl terminate "$sim_id" "$bundle_id" >/dev/null 2>&1 || true
    xcrun simctl ui "$sim_id" appearance "$appearance"
    sleep 0.5
    if [[ "${#extra_args[@]}" -gt 0 ]]; then
        xcrun simctl launch "$sim_id" "$bundle_id" "${extra_args[@]}" >/dev/null
    else
        xcrun simctl launch "$sim_id" "$bundle_id" >/dev/null
    fi
    # Time to first frame + post-auth navigation tasks settling
    sleep 4
    local out="$out_full/${name}-${appearance}.png"
    xcrun simctl io "$sim_id" screenshot "$out" 2>/dev/null
    echo "  → $name-$appearance"
}

xcrun simctl uninstall "$sim_id" "$bundle_id" >/dev/null 2>&1 || true
xcrun simctl install "$sim_id" "$(find ~/Library/Developer/Xcode/DerivedData -name 'Lumo.app' -path '*Lumo-*Debug-iphonesimulator*' 2>/dev/null | head -1)"

case "$variant" in
    default)
        echo "[shots] auth"
        capture 01-auth light
        capture 01-auth dark

        echo "[shots] chat-empty"
        capture 02-chat-empty light -LumoAutoSignIn YES
        capture 02-chat-empty dark  -LumoAutoSignIn YES

        echo "[shots] trips-empty"
        capture 03-trips-empty light -LumoAutoSignIn YES -LumoStartTab trips
        capture 03-trips-empty dark  -LumoAutoSignIn YES -LumoStartTab trips

        echo "[shots] settings"
        capture 04-settings light -LumoAutoSignIn YES -LumoStartTab settings
        capture 04-settings dark  -LumoAutoSignIn YES -LumoStartTab settings
        ;;
    voice)
        # Voice idle is the same layout as 1B's chat-empty since the
        # voice button replaces the send button when the field is
        # empty — that's already captured in 02-chat-empty-*.png.
        # Capture the listening + transcript + denied states here.
        echo "[shots] voice-listening (mic open, no transcript yet)"
        capture 05-voice-listening light -LumoAutoSignIn YES -LumoVoiceFixture listening
        capture 05-voice-listening dark  -LumoAutoSignIn YES -LumoVoiceFixture listening

        echo "[shots] voice-transcript (live partial transcript)"
        capture 06-voice-transcript light -LumoAutoSignIn YES -LumoVoiceFixture transcript
        capture 06-voice-transcript dark  -LumoAutoSignIn YES -LumoVoiceFixture transcript
        ;;
    payments)
        # MOBILE-PAYMENTS-1 fixtures. `-LumoPaymentsFixture <name>`
        # bypasses the normal app root and renders the targeted screen
        # with deterministic seeded data via PaymentsFixtureRoot
        # (compiled out of Release).
        echo "[shots] empty payment methods"
        capture 07-payment-methods-empty light -LumoPaymentsFixture empty-methods
        capture 07-payment-methods-empty dark  -LumoPaymentsFixture empty-methods

        echo "[shots] saved cards"
        capture 08-payment-methods-saved light -LumoPaymentsFixture saved-cards
        capture 08-payment-methods-saved dark  -LumoPaymentsFixture saved-cards

        echo "[shots] add-card sheet"
        capture 09-add-card light -LumoPaymentsFixture add-card
        capture 09-add-card dark  -LumoPaymentsFixture add-card

        echo "[shots] confirmation card — ready"
        capture 10-confirm-ready light -LumoPaymentsFixture confirm-ready
        capture 10-confirm-ready dark  -LumoPaymentsFixture confirm-ready

        echo "[shots] confirmation card — succeeded"
        capture 11-confirm-success light -LumoPaymentsFixture confirm-success
        capture 11-confirm-success dark  -LumoPaymentsFixture confirm-success

        echo "[shots] receipt history"
        capture 12-receipts-history light -LumoPaymentsFixture receipt-history
        capture 12-receipts-history dark  -LumoPaymentsFixture receipt-history

        echo "[shots] receipt detail"
        capture 13-receipt-detail light -LumoPaymentsFixture receipt-detail
        capture 13-receipt-detail dark  -LumoPaymentsFixture receipt-detail
        ;;
    ios-booking-confirm-autofill-1)
        # IOS-BOOKING-CONFIRM-AUTOFILL-1: pre-tap booking confirmation
        # card with both Confirm + Cancel visible. -LumoSeedBookingConfirmation
        # YES seeds a deterministic user/assistant pair plus a
        # structured-itinerary summary via RootView.seedBookingConfirmationFixture.
        echo "[shots] booking confirmation card · pre-tap"
        capture confirmation-card light \
            -LumoAutoSignIn YES -LumoSeedBookingConfirmation YES
        capture confirmation-card dark \
            -LumoAutoSignIn YES -LumoSeedBookingConfirmation YES
        ;;
    ios-dev-bypass-gate-1)
        # IOS-DEV-BYPASS-GATE-1: visual gate that the dev-bypass button
        # only appears in Debug-config builds. Capture pair:
        #   1. Debug build  → "Continue without signing in (dev)" visible
        #   2. Release build → button absent (compiler strips #if DEBUG)
        # The Release build needs to be produced first via:
        #   xcodebuild build -scheme Lumo -configuration Release \
        #     -sdk iphonesimulator -destination "id=$sim_id" \
        #     CODE_SIGNING_ALLOWED=NO -derivedDataPath /tmp/lumo-release-dd
        echo "[shots] auth · Debug build (bypass visible)"
        capture auth-debug-build-bypass-visible light
        echo "[shots] auth · Release build (bypass stripped)"
        release_app="${LUMO_RELEASE_APP:-/tmp/lumo-release-dd/Build/Products/Release-iphonesimulator/Lumo.app}"
        if [[ ! -d "$release_app" ]]; then
            echo "  ! Release build not found at $release_app — run xcodebuild Release first" >&2
            exit 1
        fi
        # Swap install: Release ships com.lumo.rentals.ios (no .dev),
        # so we uninstall both bundle IDs and install the Release .app.
        xcrun simctl terminate "$sim_id" "$bundle_id" >/dev/null 2>&1 || true
        xcrun simctl uninstall "$sim_id" "$bundle_id" >/dev/null 2>&1 || true
        xcrun simctl uninstall "$sim_id" com.lumo.rentals.ios >/dev/null 2>&1 || true
        xcrun simctl install "$sim_id" "$release_app"
        bundle_id="com.lumo.rentals.ios"
        capture auth-release-build-bypass-stripped light
        # Swap back to Debug install so the sim is left in its usual
        # state (otherwise subsequent default-variant runs break).
        xcrun simctl terminate "$sim_id" "$bundle_id" >/dev/null 2>&1 || true
        xcrun simctl uninstall "$sim_id" "$bundle_id" >/dev/null 2>&1 || true
        debug_app=$(find ~/Library/Developer/Xcode/DerivedData -name 'Lumo.app' -path '*Lumo-*Debug-iphonesimulator*' 2>/dev/null | head -1)
        xcrun simctl install "$sim_id" "$debug_app"
        ;;
    ios-compound-rollback-view-1)
        # IOS-COMPOUND-ROLLBACK-VIEW-1: rollback cascade visual on
        # failed legs + ROLLBACK PLAN branch on the failed leg's
        # detail panel. -LumoSeedCompoundRollback <state> seeds
        # the dispatch + overrides + metadata + auto-expands the
        # failed flight leg via RootView.seedCompoundRollbackFixture.
        # Brief calls for 4 PNGs covering the saga's terminal arc:
        #   failed_cascade   → flight failed, hotel + dinner mid-rollback
        #   rollback_pending → mid-state, dinner still pending
        #   rolled_back      → fully rolled back (strike-through visible)
        #   manual_review    → escalated dependent leg
        echo "[shots] rollback · failed-with-cascade"
        capture rollback-failed-cascade light \
            -LumoAutoSignIn YES -LumoSeedCompoundRollback failed_cascade
        echo "[shots] rollback · rollback_pending mid"
        capture rollback-pending-mid light \
            -LumoAutoSignIn YES -LumoSeedCompoundRollback rollback_pending
        echo "[shots] rollback · fully rolled back"
        capture rollback-rolled-back light \
            -LumoAutoSignIn YES -LumoSeedCompoundRollback rolled_back
        echo "[shots] rollback · manual_review escalation"
        capture rollback-manual-review light \
            -LumoAutoSignIn YES -LumoSeedCompoundRollback manual_review
        ;;
    ios-compound-leg-detail-1)
        # IOS-COMPOUND-LEG-DETAIL-1: tap-to-expand leg detail
        # panel in five status states. -LumoSeedCompoundLegDetail
        # <state> seeds the dispatch + per-leg metadata + auto-
        # expands the targeted leg via
        # RootView.seedCompoundLegDetailFixture. Brief calls for
        # one shot per status (light) plus a dark counterpart
        # for committed (the most common end state).
        echo "[shots] leg detail · pending"
        capture leg-detail-pending light \
            -LumoAutoSignIn YES -LumoSeedCompoundLegDetail pending
        echo "[shots] leg detail · in_flight"
        capture leg-detail-in-flight light \
            -LumoAutoSignIn YES -LumoSeedCompoundLegDetail in_flight
        echo "[shots] leg detail · committed (light + dark)"
        capture leg-detail-committed light \
            -LumoAutoSignIn YES -LumoSeedCompoundLegDetail committed
        capture leg-detail-committed dark \
            -LumoAutoSignIn YES -LumoSeedCompoundLegDetail committed
        echo "[shots] leg detail · failed"
        capture leg-detail-failed light \
            -LumoAutoSignIn YES -LumoSeedCompoundLegDetail failed
        echo "[shots] leg detail · manual_review"
        capture leg-detail-manual-review light \
            -LumoAutoSignIn YES -LumoSeedCompoundLegDetail manual_review
        ;;
    ios-compound-view-1)
        # IOS-COMPOUND-VIEW-1: per-leg compound-dispatch strip
        # in two states. -LumoSeedCompoundDispatch <state> seeds
        # a deterministic 3-leg payload via
        # RootView.seedCompoundDispatchFixture. State values:
        #   live    → flight committed, hotel in_flight, restaurant pending
        #   settled → all three committed
        echo "[shots] compound-dispatch strip · live (mid-dispatch)"
        capture compound-dispatch light \
            -LumoAutoSignIn YES -LumoSeedCompoundDispatch live
        capture compound-dispatch dark \
            -LumoAutoSignIn YES -LumoSeedCompoundDispatch live

        echo "[shots] compound-dispatch strip · settled (all committed)"
        capture compound-settled light \
            -LumoAutoSignIn YES -LumoSeedCompoundDispatch settled
        capture compound-settled dark \
            -LumoAutoSignIn YES -LumoSeedCompoundDispatch settled
        ;;
    ios-confirmation-rich-payload-1)
        # IOS-CONFIRMATION-RICH-PAYLOAD-1: confirmation card with the
        # rich autofill block visible (traveler row + payment row +
        # "PREFILLED FROM APPROVED PROFILE" subheader + Different-traveler
        # footer button). Reuses the same -LumoSeedBookingConfirmation
        # YES seam as IOS-BOOKING-CONFIRM-AUTOFILL-1; the fixture
        # payload in RootView.seedBookingConfirmationFixture now
        # populates traveler_summary / payment_summary / prefilled=true.
        echo "[shots] booking confirmation card · prefilled (rich payload)"
        capture confirmation-card-prefilled light \
            -LumoAutoSignIn YES -LumoSeedBookingConfirmation YES
        capture confirmation-card-prefilled dark \
            -LumoAutoSignIn YES -LumoSeedBookingConfirmation YES
        ;;
    chat-flight-select-clickable-1)
        # CHAT-FLIGHT-SELECT-CLICKABLE-1: post-tap selected state on the
        # FlightOffersSelectCard. -LumoSeedFlightOffers YES seeds a
        # user/assistant pair plus a 3-offer payload via
        # RootView.seedFlightOffersFixture; -LumoFlightOffersSelectedID
        # off_frontier_midmorning pre-commits the second row so the
        # capture lands the post-tap selected state without scripting
        # a touch event.
        echo "[shots] flight-offers card · selected state"
        capture flight-offers light \
            -LumoAutoSignIn YES -LumoSeedFlightOffers YES \
            -LumoFlightOffersSelectedID off_frontier_midmorning
        capture flight-offers dark \
            -LumoAutoSignIn YES -LumoSeedFlightOffers YES \
            -LumoFlightOffersSelectedID off_frontier_midmorning
        ;;
    chat-suggested-chips-1-ios)
        # CHAT-SUGGESTED-CHIPS-1-IOS: assistant_suggestions chip strip
        # below the assistant clarification message. -LumoSeedChips YES
        # seeds a deterministic user/assistant turn pair with three
        # date-suggestion chips via RootView.seedChipsFixture (DEBUG-only).
        echo "[shots] chips strip below assistant clarification"
        capture chips light -LumoAutoSignIn YES -LumoSeedChips YES
        capture chips dark  -LumoAutoSignIn YES -LumoSeedChips YES
        ;;
    ios-mirror-web-1)
        # IOS-MIRROR-WEB-1: drawer adopts the web mobile-drawer EXPLORE
        # order + account chip footer + ported color tokens. Same launch
        # args as chatgpt-ui — only the output filenames differ so the
        # progress doc can pair them with the web counterparts.
        echo "[shots] chat empty"
        capture chat-empty light -LumoAutoSignIn YES
        capture chat-empty dark  -LumoAutoSignIn YES

        echo "[shots] chat with text"
        capture chat-with-text light -LumoAutoSignIn YES \
            -LumoStartChatInput "Plan a weekend trip to Vegas"
        capture chat-with-text dark  -LumoAutoSignIn YES \
            -LumoStartChatInput "Plan a weekend trip to Vegas"

        echo "[shots] drawer open (no recents)"
        capture drawer-open light -LumoAutoSignIn YES -LumoStartDrawerOpen YES
        capture drawer-open dark  -LumoAutoSignIn YES -LumoStartDrawerOpen YES

        echo "[shots] drawer with recent chats seeded"
        capture drawer-with-recents light -LumoAutoSignIn YES \
            -LumoStartDrawerOpen YES -LumoSeedRecents YES
        capture drawer-with-recents dark  -LumoAutoSignIn YES \
            -LumoStartDrawerOpen YES -LumoSeedRecents YES
        ;;
    chatgpt-ui)
        # MOBILE-CHATGPT-UI-1: ChatGPT-style nav refactor.
        # `-LumoStartDrawerOpen YES` opens the side drawer on cold launch.
        # `-LumoStartChatInput "..."` pre-fills the chat composer.
        # `-LumoSeedRecents YES` seeds three deterministic recent-chat
        # rows so the drawer's "Recent" section renders predictably for
        # the shot.
        echo "[shots] chat empty (mic visible)"
        capture 18-chat-empty light -LumoAutoSignIn YES
        capture 18-chat-empty dark  -LumoAutoSignIn YES

        echo "[shots] composer with text (send button visible)"
        capture 19-composer-with-text light -LumoAutoSignIn YES \
            -LumoStartChatInput "Plan a weekend trip to Vegas"
        capture 19-composer-with-text dark  -LumoAutoSignIn YES \
            -LumoStartChatInput "Plan a weekend trip to Vegas"

        echo "[shots] drawer open (no recents)"
        capture 20-drawer-open light -LumoAutoSignIn YES -LumoStartDrawerOpen YES
        capture 20-drawer-open dark  -LumoAutoSignIn YES -LumoStartDrawerOpen YES

        echo "[shots] drawer open with recent chats seeded"
        capture 21-drawer-with-recents light -LumoAutoSignIn YES \
            -LumoStartDrawerOpen YES -LumoSeedRecents YES
        capture 21-drawer-with-recents dark  -LumoAutoSignIn YES \
            -LumoStartDrawerOpen YES -LumoSeedRecents YES
        ;;
    notifications)
        # MOBILE-NOTIF-1 fixtures. `-LumoNotificationsFixture <name>`
        # bypasses the normal app root and renders the targeted screen
        # with deterministic seeded data via NotificationsFixtureRoot
        # (compiled out of Release). System-level notification banners
        # require either real APNs or `xcrun simctl push` and are
        # captured manually — see the progress note for details.
        echo "[shots] proactive cards above chat empty state"
        capture 14-proactive-cards light -LumoNotificationsFixture proactive-cards
        capture 14-proactive-cards dark  -LumoNotificationsFixture proactive-cards

        echo "[shots] settings notifications section"
        capture 15-notifications-settings light -LumoAutoSignIn YES -LumoStartTab settings
        capture 15-notifications-settings dark  -LumoAutoSignIn YES -LumoStartTab settings

        echo "[shots] notifications section — master disabled"
        capture 16-notifications-disabled light -LumoNotificationsFixture permission-denied
        capture 16-notifications-disabled dark  -LumoNotificationsFixture permission-denied

        # Permission prompt — only renders when the OS thinks the app
        # has never asked. Reset notification permissions for the bundle
        # before each capture so the system prompt re-appears.
        echo "[shots] system permission prompt"
        xcrun simctl privacy "$sim_id" reset notifications "$bundle_id" 2>/dev/null || true
        capture 17-permission-prompt light -LumoNotificationsFixture permission-prompt
        xcrun simctl privacy "$sim_id" reset notifications "$bundle_id" 2>/dev/null || true
        capture 17-permission-prompt dark  -LumoNotificationsFixture permission-prompt
        ;;
    *)
        echo "unknown variant: $variant"
        exit 1
        ;;
esac

echo "[shots] all captured to $out_full"
ls "$out_full"
