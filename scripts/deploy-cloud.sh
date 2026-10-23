#!/usr/bin/env bash
# Full deploy of the hosted service on this machine.
#
# A release alone is not a deploy. Three different things run a customer's workspace, and a person
# only notices the one that was missed:
#
#   1. the release             what curule-control serves: the account pages, the API, the proxy
#   2. the workspace image     what every workspace host runs, baked at build time
#   3. the workspace container what is running right now, created from the image when the workspace began
#
# This script does all three, then proves the new code is actually live: each container must report
# the release it was built from and the default team it would give a new project. It also reports
# any registered project whose mesh.yaml still has fewer seats than the default. Existing projects
# are never rewritten behind their owner's back; that upgrade is deliberate, from the Designer.
#
# It refuses an uncommitted tree because the release is built from a commit (git archive), so
# uncommitted changes would silently not be in it.
set -euo pipefail

usage() {
  cat <<'EOF'
Full deploy of the hosted service on this machine.

  npm run deploy:cloud                  deploy the current commit (it must be committed)
  npm run deploy:cloud -- --ref <sha>   deploy another commit
  npm run deploy:cloud -- --dry-run     print the plan and check prerequisites, change nothing
  npm run deploy:cloud -- --verify      check what is running now; build nothing, restart nothing
  npm run deploy:cloud -- --help        this text

  --deploy <folder>      the operator's deploy folder (default ~/deploy/curule-cloud)
  --image <tag>          the workspace image (default curule-workspace:launch)
  --skip-image           do not rebuild the workspace image
  --skip-containers      do not recreate running workspace containers

Environment:
  DEPLOY=~/deploy/curule-cloud          releases/, current, bin/build-release.sh
  REPO=<this checkout>                  the git repository the release is built from
  IMAGE=curule-workspace:launch         the image every workspace runs
  UNITS="curule-control curule-egress"  systemd --user units that run the release
  CONTROL_HEALTH=http://127.0.0.1:7500/healthz

A full deploy: builds the release, rebuilds the workspace image (tagging the old one for rollback),
restarts the active units, recreates every container labelled curule.workspace from that image with
its environment, volumes, network address and limits carried over, then verifies health, the release
each container was built from, and the default team it serves.
EOF
}

DEPLOY="${DEPLOY:-$HOME/deploy/curule-cloud}"
REPO="${REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
IMAGE="${IMAGE:-curule-workspace:launch}"
UNITS="${UNITS:-curule-control curule-egress}"
CONTROL_HEALTH="${CONTROL_HEALTH:-http://127.0.0.1:7500/healthz}"
WORKSPACE_LABEL="curule.workspace"
REVISION_LABEL="org.opencontainers.image.revision"

REF="HEAD"
DRY=0
VERIFY=0
SKIP_IMAGE=0
SKIP_CONTAINERS=0

note() { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'deploy: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --ref) shift; [ $# -gt 0 ] || die "--ref needs a commit"; REF="$1" ;;
    --deploy) shift; [ $# -gt 0 ] || die "--deploy needs a folder"; DEPLOY="$1" ;;
    --image) shift; [ $# -gt 0 ] || die "--image needs a tag"; IMAGE="$1" ;;
    --skip-image) SKIP_IMAGE=1 ;;
    --skip-containers) SKIP_CONTAINERS=1 ;;
    --dry-run) DRY=1 ;;
    --verify) VERIFY=1 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument '$1' (try --help)" ;;
  esac
  shift
done

# ---------------------------------------------------------------- prerequisites

command -v docker >/dev/null 2>&1 || die "docker is not on PATH"
command -v node >/dev/null 2>&1 || die "node is not on PATH"
command -v curl >/dev/null 2>&1 || die "curl is not on PATH"
[ -d "$DEPLOY/releases" ] || die "no deploy folder at $DEPLOY (releases/ is missing)"
[ -x "$DEPLOY/bin/build-release.sh" ] || die "no $DEPLOY/bin/build-release.sh to build the release with"
[ -f "$DEPLOY/current/Dockerfile" ] || die "$DEPLOY/current does not hold a built release"
docker info >/dev/null 2>&1 || die "cannot talk to the container engine (is this user in the docker group?)"

git -C "$REPO" rev-parse --verify "$REF^{commit}" >/dev/null 2>&1 || die "not a commit: $REF"
SHA="$(git -C "$REPO" rev-parse "$REF^{commit}")"
SHORT="$(git -C "$REPO" rev-parse --short=12 "$SHA")"
REL="$DEPLOY/releases/$SHORT"

if [ "$VERIFY" = 1 ]; then
  # What is running is what `current` names, not necessarily HEAD.
  DEPLOYED="$(basename "$(readlink -f "$DEPLOY/current")")"
  [ -f "$DEPLOY/releases/$DEPLOYED/Dockerfile" ] || die "current points at $DEPLOYED, which is not a release"
  REL="$DEPLOY/releases/$DEPLOYED"
  SHORT="$DEPLOYED"
  [ "$REF" = "HEAD" ] || warn "--ref is ignored with --verify; verifying the deployed release $SHORT"
elif ! git -C "$REPO" diff --quiet --ignore-submodules HEAD; then
  die "the working tree has uncommitted changes, and the release is built from a commit; commit them first (use --verify to only check what is running)"
fi

if [ "$VERIFY" = 0 ]; then
  untracked="$(git -C "$REPO" ls-files --others --exclude-standard | head -5)"
  [ -z "$untracked" ] || warn "untracked files are not in the release: $(echo "$untracked" | tr '\n' ' ')"
fi

mapfile -t PLANNED < <(docker ps -a --filter "label=$WORKSPACE_LABEL" --format '{{.Names}}')
OLD_REL="$(basename "$(readlink -f "$DEPLOY/current")")"
OLD_IMAGE_ID="$(docker image inspect -f '{{.Id}}' "$IMAGE" 2>/dev/null || true)"
ROLLBACK_IMAGE=""
# An image reference holds at most one tag after its last slash; `repo:tag:rollback` is not a name
# the engine parses. Split the name and put the rollback suffix on the tag.
image_rollback_tag() {
  local last="${IMAGE##*/}" repo tag
  if [[ "$last" == *:* ]]; then repo="${IMAGE%:*}"; tag="${IMAGE##*:}"; else repo="$IMAGE"; tag="latest"; fi
  printf '%s:%s-rollback-%s' "$repo" "$tag" "$(date +%Y%m%d-%H%M%S)"
}
if [ -n "$OLD_IMAGE_ID" ]; then
  ROLLBACK_IMAGE="$(image_rollback_tag)"
fi

if [ "$VERIFY" = 0 ]; then
  step "plan"
  note "  commit          $SHORT ($SHA)"
  note "  release         $REL"
  note "  workspaces      $IMAGE"
  if [ -n "$OLD_REL" ]; then note "  currently       releases/$OLD_REL"; fi
  if [ -n "$ROLLBACK_IMAGE" ]; then note "  rollback image  $ROLLBACK_IMAGE"; fi
  note "  units           $UNITS"
  if [ "${#PLANNED[@]}" -eq 0 ]; then
    note "  containers      none labelled $WORKSPACE_LABEL; the next workspace uses the new image"
  else
    note "  containers      ${PLANNED[*]}"
  fi
fi
if [ "$DRY" = 1 ]; then
  note ""
  note "dry run: nothing was built, restarted or recreated."
  exit 0
fi

TMP_DIR="$(umask 077; mktemp -d "${TMPDIR:-/tmp}/curule-deploy.XXXXXX")"
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

units_active() {
  local u out=""
  for u in $UNITS; do
    if systemctl --user is-active --quiet "$u" 2>/dev/null; then out="$out $u"; fi
  done
  printf '%s' "${out# }"
}

restart_units() {
  local active
  active="$(units_active)"
  [ -n "$active" ] || die "none of these units is active: $UNITS"
  case " $active " in
    *" curule-control "*) ;;
    *) die "curule-control is not active, so restarting would not serve the new release (active: $active)" ;;
  esac
  step "restarting $active"
  # shellcheck disable=SC2086
  systemctl --user restart $active
  sleep 2
  for u in $active; do
    systemctl --user is-active --quiet "$u" || die "$u did not come back after the restart"
  done
}

# ---------------------------------------------------------------- release and image

if [ "$VERIFY" = 0 ]; then
  step "building release $SHORT"
  REPO="$REPO" "$DEPLOY/bin/build-release.sh" "$SHA"
  [ -f "$REL/Dockerfile" ] || die "the build said it wrote $REL, but there is no Dockerfile there"
fi
[ -d "$REL" ] || die "no release at $REL"

if [ "$VERIFY" = 0 ] && [ "$SKIP_IMAGE" = 0 ]; then
  step "building workspace image $IMAGE"
  if [ -n "$ROLLBACK_IMAGE" ]; then
    docker tag "$IMAGE" "$ROLLBACK_IMAGE"
    note "  the image that was serving is tagged $ROLLBACK_IMAGE"
  fi
  docker build -t "$IMAGE" --label "$REVISION_LABEL=$SHORT" "$REL"
fi

if [ "$VERIFY" = 0 ]; then
  restart_units
fi

# ---------------------------------------------------------------- workspace containers

# The fields the provisioner does not use. If a container has one, recreating it by hand would drop
# it silently, so say so instead: the provisioner owns that container's shape.
unsupported_spec() {
  local name="$1" found
  found="$(docker inspect -f '{{if or .HostConfig.PortBindings .HostConfig.ExtraHosts .HostConfig.Dns .HostConfig.Devices .HostConfig.Ulimits .HostConfig.Links}}yes{{end}}' "$name")"
  [ "$found" = "yes" ] && { echo "it has ports, extra hosts, DNS, devices, ulimits or links"; return 0; }
  if [ "$(docker inspect -f '{{len .NetworkSettings.Networks}}' "$name")" != "1" ]; then
    echo "it is on more than one network"; return 0
  fi
  return 1
}

wait_healthy() {
  local name="$1" status="" i
  for i in $(seq 1 60); do
    status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$name" 2>/dev/null || echo missing)"
    case "$status" in
      healthy|running) return 0 ;;
      exited|dead|missing) break ;;
    esac
    sleep 2
  done
  printf 'deploy: %s is %s after 120s\n' "$name" "$status" >&2
  docker logs --tail 30 "$name" 2>&1 | sed -E 's/(sk-|curule_vk_)[A-Za-z0-9_-]+/[REDACTED]/g' >&2 || true
  return 1
}

recreate_container() {
  local name="$1" reason
  if reason="$(unsupported_spec "$name")"; then
    warn "not recreating $name: $reason. The provisioner must make that container."
    return 1
  fi

  local net hostname user ro stop restart pids mem swap nano ip envfile
  net="$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$name")"
  hostname="$(docker inspect -f '{{.Config.Hostname}}' "$name")"
  user="$(docker inspect -f '{{.Config.User}}' "$name")"
  ro="$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}}' "$name")"
  stop="$(docker inspect -f '{{.Config.StopTimeout}}' "$name")"
  restart="$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$name")"
  pids="$(docker inspect -f '{{.HostConfig.PidsLimit}}' "$name")"
  mem="$(docker inspect -f '{{.HostConfig.Memory}}' "$name")"
  swap="$(docker inspect -f '{{.HostConfig.MemorySwap}}' "$name")"
  nano="$(docker inspect -f '{{.HostConfig.NanoCpus}}' "$name")"
  ip="$(docker inspect -f "{{with index .NetworkSettings.Networks \"$net\"}}{{with .IPAMConfig}}{{.IPv4Address}}{{end}}{{end}}" "$name")"
  envfile="$TMP_DIR/env.$name"
  docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$name" > "$envfile"
  chmod 600 "$envfile"

  local -a args=(--detach --name "$name" --hostname "$hostname" --network "$net")
  [ -z "$ip" ] || args+=(--ip "$ip")
  [ "$ro" = "true" ] && args+=(--read-only)
  [ -z "$user" ] || args+=(--user "$user")
  if [ -n "$stop" ] && [ "$stop" != "0" ]; then args+=(--stop-timeout "$stop"); fi
  if [ -n "$restart" ] && [ "$restart" != "no" ]; then args+=(--restart "$restart"); fi
  if [ -n "$pids" ] && [ "$pids" != "0" ] && [ "$pids" != "<nil>" ]; then args+=(--pids-limit "$pids"); fi
  if [ -n "$mem" ] && [ "$mem" != "0" ]; then args+=(--memory "$mem"); fi
  if [ -n "$swap" ] && [ "$swap" != "0" ]; then args+=(--memory-swap "$swap"); fi
  if [ -n "$nano" ] && [ "$nano" != "0" ]; then args+=(--cpus "$(awk -v n="$nano" 'BEGIN { printf "%.3f", n / 1000000000 }')"); fi

  local line
  while IFS= read -r line; do [ -z "$line" ] || args+=(--tmpfs "$line"); done \
    < <(docker inspect -f '{{range $k,$v := .HostConfig.Tmpfs}}{{println (printf "%s:%s" $k $v)}}{{end}}' "$name")
  while IFS= read -r line; do [ -z "$line" ] || args+=(--cap-drop "$line"); done \
    < <(docker inspect -f '{{range .HostConfig.CapDrop}}{{println .}}{{end}}' "$name")
  while IFS= read -r line; do [ -z "$line" ] || args+=(--security-opt "$line"); done \
    < <(docker inspect -f '{{range .HostConfig.SecurityOpt}}{{println .}}{{end}}' "$name")
  while IFS= read -r line; do [ -z "$line" ] || args+=(--volume "$line"); done \
    < <(docker inspect -f '{{range .HostConfig.Binds}}{{println .}}{{end}}' "$name")
  # Only the labels the control plane put on the container. The rest came from the old image, and
  # copying them would pin a stale revision on the container the new image just made.
  while IFS= read -r line; do
    case "$line" in curule.*=*) args+=(--label "$line") ;; esac
  done < <(docker inspect -f '{{range $k,$v := .Config.Labels}}{{println (printf "%s=%s" $k $v)}}{{end}}' "$name")

  local -a cmd=()
  while IFS= read -r line; do [ -z "$line" ] || cmd+=("$line"); done \
    < <(docker inspect -f '{{range .Config.Cmd}}{{println .}}{{end}}' "$name")

  docker stop "$name" >/dev/null 2>&1 || true
  docker rm "$name" >/dev/null 2>&1 || true
  # shellcheck disable=SC2086
  docker run "${args[@]}" --env-file "$envfile" "$IMAGE" ${cmd[@]+"${cmd[@]}"} >/dev/null
  wait_healthy "$name"
  note "  $name: recreated from $IMAGE"
}

templates_summary() {
  local name="$1" json
  json="$(docker exec "$name" sh -lc 'curl -fsS -H "Authorization: Bearer $MESH_API_TOKEN" http://127.0.0.1:7420/api/templates' 2>/dev/null)" || true
  if [ -z "$json" ]; then echo "could not read /api/templates"; return; fi
  printf '%s' "$json" | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try {
        const t = JSON.parse(s).templates.find((x) => x.kind === "default");
        process.stdout.write(t ? `${t.seats} seats, ${t.rolePrompts} role prompts` : "no default team");
      } catch { process.stdout.write("could not read /api/templates"); }
    });'
}

# Projects keep their own mesh.yaml when the default changes. Say which are behind it, so the gap is
# a sentence in the deploy output rather than a surprise in a console later.
project_report() {
  local name="$1" defaultSeats="$2" json id path status seats
  json="$(docker exec "$name" sh -lc 'curl -fsS -H "Authorization: Bearer $MESH_API_TOKEN" http://127.0.0.1:7420/api/projects' 2>/dev/null)" || true
  if [ -z "$json" ]; then note "  projects: could not read /api/projects"; return; fi
  printf '%s' "$json" | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try {
        for (const p of JSON.parse(s).projects ?? []) process.stdout.write(`${p.id}\t${p.configPath ?? ""}\t${p.status ?? ""}\n`);
      } catch {}
    });' > "$TMP_DIR/projects.$name"
  while IFS=$'\t' read -r id path status; do
    [ -n "$id" ] || continue
    [ -n "$path" ] || { note "  project $id: no config path"; continue; }
    seats="$(docker exec "$name" node -e 'const c = require("/app/dist/packages/config/src/index.js"); try { console.log(c.resolveConfig(process.argv[1]).agentOrder.length); } catch { console.log("?"); }' "$path" 2>/dev/null | tail -1)"
    if [ "$seats" = "?" ] || [ -z "$seats" ]; then
      note "  project $id: could not read $path"
    elif [ -n "$defaultSeats" ] && [ "$seats" -lt "$defaultSeats" ]; then
      note "  project $id: $seats seats ($status), behind the default $defaultSeats — open it and add seats in the Designer"
    else
      note "  project $id: $seats seats ($status)"
    fi
  done < "$TMP_DIR/projects.$name"
}

if [ "$VERIFY" = 0 ] && [ "$SKIP_CONTAINERS" = 0 ]; then
  step "recreating workspace containers from $IMAGE"
  mapfile -t to_recreate < <(docker ps -a --filter "label=$WORKSPACE_LABEL" --format '{{.Names}}')
  if [ "${#to_recreate[@]}" -eq 0 ]; then
    note "  none labelled $WORKSPACE_LABEL; the next workspace this account makes uses the new image"
  fi
  recreate_failures=0
  for name in "${to_recreate[@]}"; do
    if ! recreate_container "$name"; then recreate_failures=$((recreate_failures + 1)); fi
  done
  [ "$recreate_failures" -eq 0 ] || die "$recreate_failures workspace container(s) did not come back"
fi

# ---------------------------------------------------------------- verify

step "verifying what is running"
active="$(units_active)"
[ -n "$active" ] || die "no units are active: $UNITS"
case " $active " in *" curule-control "*) ;; *) die "curule-control is not active" ;; esac
for u in $active; do note "  unit $u: active"; done

code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$CONTROL_HEALTH" || true)"
[ "$code" = "200" ] || die "the control plane did not answer $CONTROL_HEALTH (HTTP $code)"
note "  control health: 200"

mapfile -t containers < <(docker ps -a --filter "label=$WORKSPACE_LABEL" --format '{{.Names}}')
failures=0
if [ "${#containers[@]}" -eq 0 ]; then
  note "  workspaces: none running or stopped"
fi
for name in "${containers[@]}"; do
  status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$name" 2>/dev/null || echo missing)"
  revision="$(docker inspect -f "{{index .Config.Labels \"$REVISION_LABEL\"}}" "$name" 2>/dev/null || true)"
  if [ "$status" != "healthy" ] && [ "$status" != "running" ]; then
    warn "$name is $status"
    failures=$((failures + 1))
    continue
  fi
  if [ -n "$revision" ] && [ "$revision" != "$SHORT" ]; then
    if [ "$VERIFY" = 0 ] && [ "$SKIP_CONTAINERS" = 1 ]; then
      note "  $name: built from $revision (containers were skipped)"
    else
      warn "$name was built from $revision, not $SHORT"
      failures=$((failures + 1))
      continue
    fi
  fi
  summary="$(templates_summary "$name")"
  note "  container $name: $status, default team $summary"
  [ -z "$revision" ] || note "  container $name: release $revision"
  if [ "$summary" = "could not read /api/templates" ]; then failures=$((failures + 1)); continue; fi
  seats="$(echo "$summary" | sed -n 's/^\([0-9][0-9]*\) seats.*/\1/p')"
  project_report "$name" "$seats"
done

[ "$failures" -eq 0 ] || die "$failures workspace check(s) failed"

step "deployed"
note "  release $SHORT is live in $active"
if [ "$SKIP_IMAGE" = 0 ]; then
  img_rev="$(docker image inspect -f "{{index .Config.Labels \"$REVISION_LABEL\"}}" "$IMAGE" 2>/dev/null || true)"
  img_id="$(docker image inspect -f '{{.Id}}' "$IMAGE" 2>/dev/null | cut -c1-19 || true)"
  note "  image $IMAGE: $img_rev $img_id"
fi
if [ -n "$OLD_REL" ] && [ "$OLD_REL" != "$SHORT" ]; then
  note "  rollback: ln -sfn releases/$OLD_REL $DEPLOY/current && systemctl --user restart $active"
  [ -z "$ROLLBACK_IMAGE" ] || note "            recreate the workspaces from $ROLLBACK_IMAGE"
fi
