#!/bin/sh
# Smoke test for a running Ordane host: the checks a deployment must pass before anyone is told it works.
#
#   scripts/smoke.sh native                 build output on this machine (after `npm run build`)
#   scripts/smoke.sh image <image-ref>      a container image (needs docker); also checks it runs unprivileged,
#                                           with a read-only root, and refuses to start without a token
#   scripts/smoke.sh url <base-url> <token> an instance that is already running
#
# Exit status is 0 only if every check passed. Each failure says what was expected.
set -eu

here="$(cd "$(dirname "$0")/.." && pwd)"
failures=0
tmp="$(mktemp -d)"
cleanup_cmds=""

cleanup() {
  eval "$cleanup_cmds" >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap cleanup EXIT INT TERM

pass() { printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1" >&2; failures=$((failures + 1)); }

free_port() {
  node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"
}

wait_ready() { # base-url
  i=0
  while [ "$i" -lt 90 ]; do
    if curl --silent --fail --max-time 2 "$1/healthz" >/dev/null 2>&1; then return 0; fi
    i=$((i + 1))
    sleep 1
  done
  return 1
}

status_of() { # curl args... -> HTTP status code
  curl --silent --output /dev/null --write-out '%{http_code}' --max-time 10 "$@" || true
}

checks() { # base-url token
  base="$1"
  token="$2"
  echo "checks against $base"

  body="$(curl --silent --max-time 5 "$base/healthz" || true)"
  if [ "$body" = '{"status":"ok"}' ]; then pass '/healthz answers {"status":"ok"} and nothing else'; else fail "/healthz body was '$body', expected {\"status\":\"ok\"}"; fi

  if [ "$(status_of "$base/readyz")" = 200 ]; then pass "/readyz is ready"; else fail "/readyz was not 200"; fi

  if [ "$(status_of "$base/api/projects")" = 401 ]; then pass "the API refuses a request with no token"; else fail "/api/projects without a token was not 401"; fi
  if [ "$(status_of -H 'Authorization: Bearer not-the-token' "$base/api/projects")" = 401 ]; then pass "the API refuses a wrong token"; else fail "/api/projects with a wrong token was not 401"; fi
  if [ "$(status_of -H "Authorization: Bearer $token" "$base/api/projects")" = 200 ]; then pass "the API accepts the token"; else fail "/api/projects with the token was not 200"; fi

  headers="$(curl --silent --dump-header - --output /dev/null --max-time 10 "$base/" | tr -d '\r' | tr '[:upper:]' '[:lower:]')"
  case "$headers" in
    *"content-type: text/html"*) pass "the dashboard is served" ;;
    *) fail "GET / was not text/html" ;;
  esac
  case "$headers" in *"x-content-type-options: nosniff"*) pass "nosniff" ;; *) fail "x-content-type-options: nosniff is missing" ;; esac
  case "$headers" in *"x-frame-options: deny"*) pass "framing refused" ;; *) fail "x-frame-options: DENY is missing" ;; esac
  case "$headers" in *"content-security-policy: "*"default-src 'self'"*) pass "content security policy" ;; *) fail "a content-security-policy with default-src 'self' is missing" ;; esac

  cors="$(curl --silent --dump-header - --output /dev/null --max-time 10 -H 'Origin: https://evil.example' -H "Authorization: Bearer $token" "$base/api/projects" | tr -d '\r' | tr '[:upper:]' '[:lower:]')"
  case "$cors" in
    *"access-control-allow-origin"*) fail "a foreign origin was granted CORS access: $(printf '%s' "$cors" | grep access-control-allow-origin)" ;;
    *) pass "a foreign origin is not granted CORS access" ;;
  esac
}

# An instance with MESH_PROJECTS_ROOT set must not register a folder outside it, whatever the caller asks for.
confinement_check() { # base-url token
  code="$(status_of -X POST -H "Authorization: Bearer $2" -H 'Content-Type: application/json' --data '{"root":"/etc"}' "$1/api/projects")"
  if [ "$code" = 403 ]; then pass "a folder outside MESH_PROJECTS_ROOT cannot be registered"; else fail "registering /etc answered $code, expected 403 (outside_projects_root)"; fi
}

mode="${1:-}"
case "$mode" in
  native)
    [ -f "$here/dist/apps/mesh-cli/src/index.js" ] || { echo "no build output: run npm run build first" >&2; exit 2; }
    port="$(free_port)"
    token="$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")"
    mkdir -p "$tmp/projects"
    MESH_HOME="$tmp/home" MESH_API_TOKEN="$token" MESH_PROJECTS_ROOT="$tmp/projects" \
      node "$here/dist/apps/mesh-cli/src/index.js" host --bind 127.0.0.1 --port "$port" --home "$tmp/home" >"$tmp/host.log" 2>&1 &
    pid=$!
    cleanup_cmds="kill $pid"
    if ! wait_ready "http://127.0.0.1:$port"; then
      echo "the host did not become healthy; its log:" >&2
      cat "$tmp/host.log" >&2
      exit 1
    fi
    checks "http://127.0.0.1:$port" "$token"
    confinement_check "http://127.0.0.1:$port" "$token"
    ;;
  image)
    image="${2:?usage: scripts/smoke.sh image <image-ref>}"
    port="$(free_port)"
    token="$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")"
    echo "starting $image"
    cid="$(docker run --detach --publish "127.0.0.1:$port:7420" --env "MESH_API_TOKEN=$token" --read-only --tmpfs /tmp:exec,mode=1777 --cap-drop ALL --security-opt no-new-privileges:true --volume "mesh-smoke-$$:/data" "$image")"
    cleanup_cmds="docker rm --force $cid; docker volume rm mesh-smoke-$$"
    if ! wait_ready "http://127.0.0.1:$port"; then
      echo "the container did not become healthy; its log:" >&2
      docker logs "$cid" >&2 || true
      exit 1
    fi
    checks "http://127.0.0.1:$port" "$token"
    confinement_check "http://127.0.0.1:$port" "$token"

    if [ "$(docker exec "$cid" id -u)" = 10001 ]; then pass "runs as the unprivileged user (uid 10001)"; else fail "the container does not run as uid 10001"; fi
    if docker exec "$cid" sh -c 'touch /app/.write-test' >/dev/null 2>&1; then fail "the image's own filesystem is writable"; else pass "the image's own filesystem is read-only"; fi
    if docker exec "$cid" sh -c 'touch /data/.write-test && rm /data/.write-test' >/dev/null 2>&1; then pass "the data volume is writable"; else fail "the data volume is not writable"; fi
    # Two different failures, said apart: a command that is not on the path, and one that is and does not run.
    # `mesh` is the name the product had before it was Ordane; it stays installed so an old script keeps working.
    for cmd in ordane mesh; do
      if ! docker exec "$cid" sh -c "command -v $cmd" >/dev/null 2>&1; then
        fail "the $cmd command is not on the path"
      elif docker exec "$cid" "$cmd" --help >/dev/null 2>&1; then
        pass "the $cmd command is on the path and \`$cmd --help\` exits 0"
      else
        fail "the $cmd command is on the path but \`$cmd --help\` exits non-zero"
      fi
    done

    # No token, reachable from the network: it must refuse to start, and say why.
    if out="$(docker run --rm --env MESH_BIND=0.0.0.0 "$image" 2>&1)"; then
      fail "the image started with no MESH_API_TOKEN"
    else
      case "$out" in *MESH_API_TOKEN*) pass "refuses to start without MESH_API_TOKEN, and says why" ;; *) fail "it refused to start but the message does not mention MESH_API_TOKEN: $out" ;; esac
    fi
    ;;
  url)
    base="${2:?usage: scripts/smoke.sh url <base-url> <token>}"
    token="${3:?usage: scripts/smoke.sh url <base-url> <token>}"
    checks "${base%/}" "$token"
    ;;
  *)
    sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac

echo
if [ "$failures" -gt 0 ]; then
  echo "$failures check(s) failed" >&2
  exit 1
fi
echo "all checks passed"
