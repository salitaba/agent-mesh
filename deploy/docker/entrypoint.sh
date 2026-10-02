#!/bin/sh
# Container entrypoint for Ordane.
#
#   host            (default) supervise every registered project and serve the dashboard
#   serve           run one mesh from $MESH_CONFIG
#   demo            host, with the shipped demo project scaffolded and registered first: scripted agents on
#                   the stub runtime, so it needs no API key and makes no model calls
#   anything else   is executed as given, so `docker run … ordane status` and `sh` work
#
# Configuration is environment variables; see docs/commercial/deployment.md. This script only turns
# them into arguments and refuses the one combination that must never start: a server reachable from
# the network with no token. The server enforces the same rule; stopping here says how to fix it.
set -eu

# Compose and `docker run -e NAME` pass an unset variable as an empty one. For the settings below an empty
# value must mean "not set": an empty ANTHROPIC_API_KEY would be handed to every agent as a credential.
for name in ANTHROPIC_API_KEY MESH_LICENSE MESH_LICENSE_FILE MESH_ALLOWED_HOSTS MESH_ALLOWED_ORIGINS MESH_TRUST_PROXY MESH_COOKIE_SECURE MESH_PROJECTS_ROOT CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC; do
  eval "value=\${$name-}"
  if [ -z "$value" ]; then unset "$name"; fi
done

mode="${1:-host}"
bind="${MESH_BIND:-0.0.0.0}"
port="${MESH_PORT:-7420}"
node_cli="node /app/dist/apps/mesh-cli/src/index.js"

fail() {
  echo "ordane: $*" >&2
  exit 78 # EX_CONFIG
}

is_loopback() {
  case "$1" in
    127.*|localhost|::1|"[::1]") return 0 ;;
    *) return 1 ;;
  esac
}

case "$mode" in
  host|serve|demo)
    if ! is_loopback "$bind" && [ -z "${MESH_API_TOKEN:-}" ] && [ "${MESH_ALLOW_INSECURE_BIND:-}" != "1" ]; then
      fail "MESH_API_TOKEN is not set, and the server would listen on ${bind}:${port}. Anyone who can reach it could run commands as the agents. Generate a token (openssl rand -hex 32) and pass it as MESH_API_TOKEN."
    fi
    ;;
esac

case "$mode" in
  host)
    shift || true
    # shellcheck disable=SC2086
    exec $node_cli host --bind "$bind" --port "$port" --home "${MESH_HOME:-/data/home}" "$@"
    ;;
  demo)
    shift || true
    dir="${MESH_PROJECTS_ROOT:-/data/projects}/demo-stub"
    if [ ! -f "$dir/mesh.yaml" ]; then
      $node_cli init "$dir" --example demo-stub >/dev/null || fail "could not scaffold the demo project into $dir"
    fi
    # Offline and idempotent: registering a project that is already there changes nothing.
    $node_cli project add "$dir" >/dev/null || fail "could not register the demo project"
    echo "ordane: demo project ready at $dir. Open it in the dashboard, then press Start mission." >&2
    # shellcheck disable=SC2086
    exec $node_cli host --bind "$bind" --port "$port" --home "${MESH_HOME:-/data/home}" "$@"
    ;;
  serve)
    [ -n "${MESH_CONFIG:-}" ] || fail "MESH_CONFIG must name the mesh.yaml to serve (a path inside the container, for example /data/projects/demo/mesh.yaml)."
    shift || true
    # shellcheck disable=SC2086
    exec $node_cli serve "$MESH_CONFIG" --bind "$bind" --port "$port" "$@"
    ;;
  *)
    exec "$@"
    ;;
esac
