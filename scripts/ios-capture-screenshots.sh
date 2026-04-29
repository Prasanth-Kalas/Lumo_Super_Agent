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
    *)
        echo "unknown variant: $variant"
        exit 1
        ;;
esac

echo "[shots] all captured to $out_full"
ls "$out_full"
