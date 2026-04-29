#!/usr/bin/env bash
# Capture light + dark screenshots of every Lumo iOS screen for the
# MOBILE-CHAT-1B review packet.
#
# Screens captured:
# 01-auth                 — pre-sign-in welcome
# 02-chat-empty           — chat tab, no messages (post auto sign-in)
# 03-trips-empty          — trips tab, empty state
# 04-settings             — settings tab, full content
#
# Each captured in both light and dark mode. The auth screen is taken
# without -LumoAutoSignIn so the welcome view is visible. The post-
# auth screens use -LumoAutoSignIn so the dev signed-in path is taken.
#
# Tab navigation between Chat/Trips/Settings is done via
# `xcrun simctl spawn launchctl` URL-style deep linking — but our app
# doesn't have one yet, so we capture all three by relaunching with
# different `LumoStartTab` defaults values (added below in
# AppRootView).
set -euo pipefail

bundle_id="com.lumo.rentals.ios.dev"
sim_id="${LUMO_SIM_ID:-12CA8A97-CB46-49E5-95EB-88B072FF57CD}"
out_dir="${LUMO_SHOTS_OUT:-docs/notes/mobile-chat-1b-screenshots}"

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

# 01 — Auth screen: launch without auto sign-in
echo "[shots] auth"
xcrun simctl uninstall "$sim_id" "$bundle_id" >/dev/null 2>&1 || true
xcrun simctl install "$sim_id" "$(find ~/Library/Developer/Xcode/DerivedData -name 'Lumo.app' -path '*Lumo-*Debug-iphonesimulator*' 2>/dev/null | head -1)"
capture 01-auth light
capture 01-auth dark

# 02 — Chat empty: with auto-sign-in, default tab is Chat
echo "[shots] chat-empty"
capture 02-chat-empty light -LumoAutoSignIn YES
capture 02-chat-empty dark  -LumoAutoSignIn YES

# 03 — Trips empty: launch with start-tab override
echo "[shots] trips-empty"
capture 03-trips-empty light -LumoAutoSignIn YES -LumoStartTab trips
capture 03-trips-empty dark  -LumoAutoSignIn YES -LumoStartTab trips

# 04 — Settings: launch with start-tab override
echo "[shots] settings"
capture 04-settings light -LumoAutoSignIn YES -LumoStartTab settings
capture 04-settings dark  -LumoAutoSignIn YES -LumoStartTab settings

echo "[shots] all captured to $out_full"
ls "$out_full"
