#!/usr/bin/env bash
# sync-env-from-vercel.sh
#
# Pulls all environment variables from Vercel and writes them to local files
# in the shape each surface expects:
#
#   apps/web/.env.local      — straight Vercel dump for Next.js
#   ~/.config/lumo/.env      — same dump, used by ios-write-xcconfig.sh
#                              and any other Mac-host tooling that reads
#                              ~/.config/lumo/.env
#
# Re-run any time Vercel env changes. Idempotent.
#
# Required:
#   - Vercel CLI installed (`npm install -g vercel`)
#   - Logged in (`vercel login`)
#   - apps/web linked to the project (`cd apps/web && vercel link`)
#
# Usage:
#   bash scripts/sync-env-from-vercel.sh                        # default: development
#   ENV=preview     bash scripts/sync-env-from-vercel.sh        # preview values
#   ENV=production  bash scripts/sync-env-from-vercel.sh        # production values

set -euo pipefail

ENV="${ENV:-development}"
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_ROOT="$( cd "$SCRIPT_DIR/.." && pwd )"
WEB_DIR="$REPO_ROOT/apps/web"
WEB_ENV_FILE="$WEB_DIR/.env.local"
IOS_ENV_DIR="$HOME/.config/lumo"
IOS_ENV_FILE="$IOS_ENV_DIR/.env"

if ! command -v vercel >/dev/null 2>&1; then
  echo "ERROR: Vercel CLI not installed. Run: npm install -g vercel"
  exit 1
fi

if [ ! -d "$WEB_DIR" ]; then
  echo "ERROR: apps/web/ not found at $WEB_DIR"
  exit 1
fi

if [ ! -d "$WEB_DIR/.vercel" ]; then
  echo "WARNING: $WEB_DIR is not linked to a Vercel project yet."
  echo "Run: cd $WEB_DIR && vercel link"
  echo "Then re-run this script."
  exit 1
fi

echo "→ Pulling $ENV env vars from Vercel into $WEB_ENV_FILE"
( cd "$WEB_DIR" && vercel env pull "$WEB_ENV_FILE" --environment "$ENV" --yes )

if [ ! -f "$WEB_ENV_FILE" ]; then
  echo "ERROR: vercel env pull did not produce $WEB_ENV_FILE"
  exit 1
fi

echo "→ Mirroring to $IOS_ENV_FILE"
mkdir -p "$IOS_ENV_DIR"

# Copy the full file to the iOS location.
# ios-write-xcconfig.sh handles the LUMO_SUPABASE_URL → SCHEME+HOST split
# at xcconfig-write time, so we don't need to pre-split here.
cp "$WEB_ENV_FILE" "$IOS_ENV_FILE"
chmod 600 "$IOS_ENV_FILE"

echo
echo "✓ Synced. Files written:"
echo "    $WEB_ENV_FILE          ($(wc -l < "$WEB_ENV_FILE" | tr -d ' ') lines)"
echo "    $IOS_ENV_FILE          ($(wc -l < "$IOS_ENV_FILE" | tr -d ' ') lines)"
echo
echo "Next:"
echo "  - Web dev:  cd $WEB_DIR && npm run dev"
echo "  - iOS dev:  cd $REPO_ROOT/apps/ios && bash scripts/ios-write-xcconfig.sh"
echo "              (this reads ~/.config/lumo/.env and writes Lumo.local.xcconfig)"
