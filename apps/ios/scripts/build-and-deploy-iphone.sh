#!/usr/bin/env bash
# build-and-deploy-iphone.sh
#
# Builds Lumo (Debug) for a physical iPhone and installs via devicectl.
#
# project.yml has CODE_SIGNING_ALLOWED: NO baked in for the simulator-only
# bootstrap sprint. We override that on the xcodebuild command line so device
# builds work without committing a config change. project.yml is untouched
# by this script.
#
# Required:
#   - Xcode 17+
#   - xcodegen on $PATH       (`brew install xcodegen`)
#   - Apple Developer account signed in to Xcode (Xcode → Settings → Accounts)
#   - iPhone paired + trusted, Developer Mode ON
#     (Settings → Privacy & Security → Developer Mode)
#
# Usage:
#   cd apps/ios
#   bash scripts/build-and-deploy-iphone.sh
#
# Override defaults via env:
#   LUMO_IPHONE_UDID=...       (default: Kalas's primary test iPhone)
#   LUMO_APPLE_TEAM_ID=...     (default: Kalas's Apple Developer team)

set -euo pipefail

UDID="${LUMO_IPHONE_UDID:-00008120-001A51910228C01E}"
TEAM_ID="${LUMO_APPLE_TEAM_ID:-566C8U27UY}"

# Move to apps/ios/ regardless of where the user invoked from
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR/.."

if [ ! -f project.yml ]; then
  echo "ERROR: project.yml not found. Expected to run from apps/ios/."
  exit 1
fi

echo "iPhone UDID:  $UDID"
echo "Team ID:      $TEAM_ID"
echo

# 1. Verify the device is actually visible to the host
echo "→ xcrun devicectl list devices"
if ! xcrun devicectl list devices 2>/dev/null | grep -q "$UDID"; then
  echo
  echo "WARNING: device $UDID not currently visible to xcrun."
  echo "Possible causes:"
  echo "  - iPhone not connected via USB / not paired via Wi-Fi"
  echo "  - iPhone locked (unlock and tap 'Trust this Mac')"
  echo "  - Developer Mode not enabled in iOS Settings"
  echo
  echo "Continuing anyway — xcodebuild will fail clearly if the device isn't reachable."
  echo
fi

# 2. Generate Xcode project from XcodeGen spec
echo "→ xcodegen generate"
xcodegen generate

# 3. Resolve SwiftPM dependencies (Supabase, Stripe).
#    Resolved versions aren't committed; this populates DerivedData.
echo "→ xcodebuild -resolvePackageDependencies"
xcodebuild \
  -project Lumo.xcodeproj \
  -scheme Lumo \
  -destination "id=$UDID" \
  -resolvePackageDependencies \
  -allowProvisioningUpdates >/dev/null

# 4. Build for device with signing overrides.
#    -allowProvisioningUpdates lets Xcode fetch / register a provisioning
#    profile that includes this UDID under your team, without manual setup.
echo "→ xcodebuild build (Debug | iphoneos | id=$UDID)"
xcodebuild \
  -project Lumo.xcodeproj \
  -scheme Lumo \
  -configuration Debug \
  -destination "id=$UDID" \
  -allowProvisioningUpdates \
  CODE_SIGNING_ALLOWED=YES \
  CODE_SIGN_STYLE=Automatic \
  DEVELOPMENT_TEAM="$TEAM_ID" \
  PROVISIONING_PROFILE_SPECIFIER="" \
  build \
  | xcpretty 2>/dev/null || true

# Re-run without xcpretty to get a real exit code if xcpretty is missing
xcodebuild \
  -project Lumo.xcodeproj \
  -scheme Lumo \
  -configuration Debug \
  -destination "id=$UDID" \
  -allowProvisioningUpdates \
  CODE_SIGNING_ALLOWED=YES \
  CODE_SIGN_STYLE=Automatic \
  DEVELOPMENT_TEAM="$TEAM_ID" \
  PROVISIONING_PROFILE_SPECIFIER="" \
  build \
  -quiet

# 5. Locate the built .app
APP_PATH=$(find ~/Library/Developer/Xcode/DerivedData -name "Lumo.app" -path "*/Debug-iphoneos/*" -not -path "*/Index.noindex/*" -print 2>/dev/null | head -n1)
if [ -z "$APP_PATH" ]; then
  echo "ERROR: Built Lumo.app not found under DerivedData."
  echo "Check the build output above; signing or provisioning likely failed."
  exit 1
fi
echo "→ Built at: $APP_PATH"

# 6. Install via devicectl (Xcode 15+ replacement for ios-deploy)
echo "→ xcrun devicectl device install"
xcrun devicectl device install app \
  --device "$UDID" \
  "$APP_PATH"

echo
echo "✓ Lumo installed on iPhone $UDID."
echo
echo "First launch only:"
echo "  Settings → General → VPN & Device Management → trust the developer cert."
echo
echo "Then run the device smoke per IOS-DEEPGRAM-DEVICE-SMOKE-1:"
echo "  - Voice mode ON"
echo "  - 'describe the ocean in three short sentences'"
echo "  - confirm all three sentences play end-to-end"
echo "  - confirm Stop affordance appears during agent speech"
echo "  - 5x repeat with 'tell me a fun fact'"
echo "  - Bluetooth headphones probe (IOS-DEEPGRAM-BLUETOOTH-FALLBACK-1)"
