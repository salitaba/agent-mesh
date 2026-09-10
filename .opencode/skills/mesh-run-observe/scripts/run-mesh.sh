#!/usr/bin/env bash
# Run one agent-mesh mission headless to termination, with a hard wall-clock cap.
# Prints STATE_DIR=<path> as its last line so the digest step needs no guessing.
#
# usage: run-mesh.sh [config.yaml] [timeout-seconds]
#   defaults: examples/demo-stub/mesh.yaml, 180s
set -uo pipefail

CONFIG="${1:-examples/demo-stub/mesh.yaml}"
CAP="${2:-180}"

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
cd "$REPO" || exit 2

if [ ! -f "$CONFIG" ]; then
  echo "RUN_STATUS=config-missing ($CONFIG)" >&2
  exit 2
fi

# Build only the TS graph. `npm run build` also runs vite, which observation never needs.
if [ ! -f dist/apps/mesh-cli/src/index.js ] || [ -n "${MESH_FORCE_BUILD:-}" ]; then
  echo "building (npx tsc -p tsconfig.json, ~30s)..." >&2
  npx tsc -p tsconfig.json >/tmp/mesh-build.log 2>&1 || {
    echo "RUN_STATUS=build-failed (see /tmp/mesh-build.log)" >&2
    tail -20 /tmp/mesh-build.log >&2
    exit 2
  }
fi

read -r STATE_DIR PORT <<EOF
$(python3 - "$CONFIG" <<'PY'
import os, socket, sys, yaml
cfg = sys.argv[1]
raw = yaml.safe_load(open(cfg)) or {}
d = os.path.dirname(os.path.abspath(cfg))
sd = (raw.get("server") or {}).get("state_dir") \
     or os.path.join(((raw.get("mesh") or {}).get("workspace") or {}).get("path", "./workspace"), ".mesh-state")
s = socket.socket(); s.bind(("127.0.0.1", 0)); port = s.getsockname()[1]; s.close()
print(os.path.abspath(os.path.join(d, sd)), port)
PY
)
EOF

if [ -z "${STATE_DIR:-}" ]; then
  echo "RUN_STATUS=state-dir-unresolved" >&2
  exit 2
fi

LOG=/tmp/mesh-run.log
# --fresh wipes prior state so two runs are comparable. --no-tui keeps it headless:
# the CLI polls /status every 2s and exits itself once the goal is
# COMPLETED / FAILED / ESCALATED. There is no --max-turns flag, so `timeout` is
# the only backstop against an idling mesh.
timeout --signal=INT --kill-after=10 "$CAP" \
  node dist/apps/mesh-cli/src/index.js run "$CONFIG" --no-tui --fresh --port "$PORT" \
  >"$LOG" 2>&1
RC=$?

case "$RC" in
  0)   STATUS=completed ;;
  124|130) STATUS="timeout-after-${CAP}s" ;;
  *)   STATUS="exit-$RC" ;;
esac

tail -5 "$LOG" >&2
echo "RUN_STATUS=$STATUS"
echo "RUN_LOG=$LOG"
echo "STATE_DIR=$STATE_DIR"
