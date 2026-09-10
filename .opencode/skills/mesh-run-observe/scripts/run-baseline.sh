#!/usr/bin/env bash
# Run the mesh config's goal through ONE plain opencode session, headless, and
# save everything needed to compare it against the mesh run. Starts from a
# fresh mktemp sandbox (or BASELINE_SEED), so it never sees the mesh's answer.
#
# usage: run-baseline.sh [config.yaml] [timeout-seconds] [out-dir]
#   defaults: examples/demo-stub/mesh.yaml, 600s, <mesh state dir>/baseline
# env: BASELINE_SEED=<dir>            copy dir contents (minus .mesh-state) into sandbox
#      BASELINE_MODEL=provider/model  match the mesh adapter's model for cost
#      BASELINE_AGENT=<agent>         force an opencode agent (default: config default)
set -uo pipefail

CONFIG="${1:-examples/demo-stub/mesh.yaml}"
CAP="${2:-600}"

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
cd "$REPO" || exit 2

if [ ! -f "$CONFIG" ]; then
  echo "BASELINE_STATUS=config-missing ($CONFIG)" >&2
  exit 2
fi
if ! command -v opencode >/dev/null 2>&1; then
  echo "BASELINE_STATUS=opencode-missing" >&2
  exit 2
fi

# Same state-dir resolution as run-mesh.sh so the baseline lands beside its run.
read -r STATE_DIR <<EOF
$(python3 - "$CONFIG" <<'PY'
import os, sys, yaml
cfg = sys.argv[1]
raw = yaml.safe_load(open(cfg)) or {}
d = os.path.dirname(os.path.abspath(cfg))
sd = (raw.get("server") or {}).get("state_dir") \
     or os.path.join(((raw.get("mesh") or {}).get("workspace") or {}).get("path", "./workspace"), ".mesh-state")
print(os.path.abspath(os.path.join(d, sd)))
PY
)
EOF
if [ -z "${STATE_DIR:-}" ]; then
  echo "BASELINE_STATUS=state-dir-unresolved" >&2
  exit 2
fi

OUT_DIR="${3:-$STATE_DIR/baseline}"
SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/mesh-baseline.XXXXXX")"
mkdir -p "$OUT_DIR"

GOAL="$(python3 - "$CONFIG" "$OUT_DIR" "$SANDBOX" <<'PY'
import json, os, shutil, sys, yaml
cfg, out_dir, sandbox = sys.argv[1:4]
raw = yaml.safe_load(open(cfg)) or {}
goal = str(((raw.get("mesh") or {}).get("goal") or "")).strip()
if not goal:
    sys.exit(3)
criteria = ((raw.get("mesh") or {}).get("acceptance_criteria")) or []
with open(os.path.join(out_dir, "criteria.json"), "w", encoding="utf-8") as fh:
    json.dump(criteria, fh, indent=1)
seed = os.environ.get("BASELINE_SEED") or ""
if seed:
    if not os.path.isdir(seed):
        print(f"BASELINE_SEED is not a directory: {seed}", file=sys.stderr)
        sys.exit(4)
    for name in os.listdir(seed):
        if name in (".mesh-state", ".git"):
            continue
        src, dst = os.path.join(seed, name), os.path.join(sandbox, name)
        if os.path.isdir(src):
            shutil.copytree(src, dst)
        else:
            shutil.copy2(src, dst)
print(goal)
PY
)"
if [ -z "${GOAL:-}" ]; then
  echo "BASELINE_STATUS=goal-missing (mesh.goal empty, or bad BASELINE_SEED — see stderr)" >&2
  rm -rf "$SANDBOX"
  exit 2
fi

ARGS=()
[ -n "${BASELINE_MODEL:-}" ] && ARGS+=(--model "$BASELINE_MODEL")
[ -n "${BASELINE_AGENT:-}" ] && ARGS+=(--agent "$BASELINE_AGENT")

START=$(date +%s)
# opencode run is non-interactive: it does not prompt, and on this machine
# write/bash tools proceed without --auto. `timeout` is the only cap.
( cd "$SANDBOX" && \
  timeout --signal=INT --kill-after=10 "$CAP" \
    opencode run --format json --title "mesh-baseline $(basename "$CONFIG")" \
      "${ARGS[@]}" "$GOAL" \
) >"$OUT_DIR/baseline-events.json" 2>"$OUT_DIR/baseline-stderr.log"
RC=$?
END=$(date +%s)

case "$RC" in
  0)       STATUS=completed ;;
  124|130) STATUS="timeout-after-${CAP}s" ;;
  *)       STATUS="exit-$RC" ;;
esac

SID="$(python3 - "$OUT_DIR/baseline-events.json" <<'PY'
import json, sys
sid = ""
with open(sys.argv[1], encoding="utf-8", errors="replace") as fh:
    for line in fh:
        line = line.strip()
        if not line:
            continue
        try:
            e = json.loads(line)
        except json.JSONDecodeError:
            continue
        if e.get("sessionID"):
            sid = e["sessionID"]
            break
print(sid)
PY
)"
if [ -n "$SID" ]; then
  opencode export "$SID" >"$OUT_DIR/baseline-export.json" 2>/dev/null || true
fi

( cd "$SANDBOX" && find . -type f -not -path './.git/*' | sed 's|^\./||' | sort | head -50 ) >"$OUT_DIR/baseline-files.txt"

python3 - "$CONFIG" "$OUT_DIR" "$SANDBOX" "$SID" "$STATUS" "$RC" "$((END - START))" <<'PY'
import json, os, subprocess, sys, yaml
cfg, out_dir, sandbox, sid, status, rc, secs = sys.argv[1:8]
raw = yaml.safe_load(open(cfg)) or {}
try:
    version = subprocess.run(["opencode", "--version"], capture_output=True, text=True).stdout.strip()
except OSError:
    version = ""
meta = {
    "config": os.path.abspath(cfg),
    "goal": str(((raw.get("mesh") or {}).get("goal") or "")).strip(),
    "runtime_default": ((raw.get("mesh") or {}).get("runtime") or {}).get("default"),
    "status": status,
    "exit_code": int(rc),
    "wall_seconds": int(secs),
    "session": sid,
    "sandbox": sandbox,
    "model_env": os.environ.get("BASELINE_MODEL") or "",
    "agent_env": os.environ.get("BASELINE_AGENT") or "",
    "opencode_version": version,
}
with open(os.path.join(out_dir, "baseline-meta.json"), "w", encoding="utf-8") as fh:
    json.dump(meta, fh, indent=1)
PY

echo "BASELINE_STATUS=$STATUS"
echo "BASELINE_DIR=$OUT_DIR"
echo "BASELINE_SANDBOX=$SANDBOX"
echo "BASELINE_SESSION=$SID"
