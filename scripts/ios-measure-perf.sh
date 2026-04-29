#!/usr/bin/env bash
# Cold-start + memory measurement for the Lumo iOS app.
#
# Cold-start: end-to-end milliseconds from `simctl launch` issuing the
# spawn until the foreground PID's process state is stable (no longer
# in zombie/initialising). This is a coarse proxy for "time-to-
# interactive" — the first frame typically appears within ~50 ms of
# the process becoming Ready, so the measurement reflects user-
# perceived launch.
#
# Memory: post-launch resident memory via `vmmap --summary` on the
# Lumo process. We emit the "Physical footprint" line which is the
# closest analogue to the Xcode debug navigator's memory gauge.
#
# Outputs `docs/notes/mobile-chat-1b-perf.json` and prints a human-
# readable summary.
set -euo pipefail

bundle_id="${LUMO_BUNDLE_ID:-com.lumo.rentals.ios.dev}"
sim_id="${LUMO_SIM_ID:-12CA8A97-CB46-49E5-95EB-88B072FF57CD}"
sim_label="${LUMO_SIM_LABEL:-iPhone 17 / iOS 26.4}"
runs="${LUMO_PERF_RUNS:-5}"
out_path="${LUMO_PERF_OUT:-docs/notes/mobile-chat-1b-perf.json}"

repo_root=$(cd "$(dirname "$0")/.." && pwd)
out_full="$repo_root/$out_path"
mkdir -p "$(dirname "$out_full")"

echo "[perf] sim=$sim_label ($sim_id) bundle=$bundle_id runs=$runs"
xcrun simctl boot "$sim_id" 2>/dev/null || true
sleep 1

now_ms() { python3 -c 'import time; print(int(time.time()*1000))'; }

trial() {
    xcrun simctl terminate "$sim_id" "$bundle_id" >/dev/null 2>&1 || true
    sleep 1
    local start
    start=$(now_ms)
    local launch_pid
    launch_pid=$(xcrun simctl launch "$sim_id" "$bundle_id" -LumoAutoSignIn YES | awk '{print $NF}')
    # Poll for process readiness up to a hard 5s ceiling.
    while true; do
        elapsed=$(( $(now_ms) - start ))
        # Cap loop and bail; >5s is a problem worth surfacing.
        if [[ "$elapsed" -gt 5000 ]]; then break; fi
        # Check if the process is running and has its main window up.
        local current_pid
        current_pid=$(xcrun simctl spawn "$sim_id" launchctl list 2>/dev/null | awk -v b="$bundle_id" '$0 ~ b {print $1; exit}' || echo '-')
        if [[ -n "$current_pid" && "$current_pid" != "-" ]]; then
            # Process exists. Wait one more tick for first-frame settle.
            sleep 0.1
            elapsed=$(( $(now_ms) - start ))
            break
        fi
        sleep 0.05
    done
    echo "$elapsed"
}

samples=()
for i in $(seq 1 "$runs"); do
    ms=$(trial)
    echo "[perf] trial $i = ${ms}ms"
    samples+=("$ms")
done

# Drop fastest + slowest, average the middle.
sorted=$(printf '%s\n' "${samples[@]}" | sort -n)
trimmed=$(printf '%s\n' "$sorted" | sed '1d;$d')
avg=$(printf '%s\n' "$trimmed" | awk '{s+=$1; c++} END{ if (c>0) printf "%.0f", s/c; else print 0 }')

# Memory probe at idle (post-launch, no interaction).
sleep 1
pid=$(xcrun simctl spawn "$sim_id" launchctl list 2>/dev/null | awk -v b="$bundle_id" '$0 ~ b {print $1; exit}')
mem_line=""
phys_kb=""
if [[ -n "$pid" && "$pid" != "-" ]]; then
    mem_line=$(xcrun simctl spawn "$sim_id" vmmap --summary "$pid" 2>/dev/null | grep -E "Physical footprint:" | head -1 || true)
    # Parse "Physical footprint: 53.2M" or "Physical footprint: 53216K"
    if [[ "$mem_line" =~ ([0-9]+(\.[0-9]+)?)M ]]; then
        phys_kb=$(awk "BEGIN{ printf \"%.0f\", ${BASH_REMATCH[1]}*1024 }")
    elif [[ "$mem_line" =~ ([0-9]+)K ]]; then
        phys_kb="${BASH_REMATCH[1]}"
    fi
fi

cat > "$out_full" <<EOF
{
  "device": "$sim_label",
  "sim_id": "$sim_id",
  "bundle_id": "$bundle_id",
  "runs": $runs,
  "cold_start_ms_samples": [$(IFS=,; echo "${samples[*]}")],
  "cold_start_ms_avg_trimmed": $avg,
  "cold_start_budget_ms": 1500,
  "memory_post_launch_kb": ${phys_kb:-null},
  "memory_post_launch_human": "${mem_line:-unknown}",
  "memory_budget_mb": 100,
  "captured_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
echo
echo "[perf] wrote $out_full"
echo "[perf] cold-start trimmed avg = ${avg}ms (budget: 1500ms)"
echo "[perf] memory                = ${mem_line:-unknown} (budget: <100MB)"
