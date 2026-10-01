#!/bin/sh
# Provision (or update) one tenant: one namespace, one credentials Secret, one Helm release.
#
#   deploy/fleet/provision-tenant.sh --name acme --host mesh.acme.example.com \
#       --licence-file acme.key --provider-key-file acme-anthropic.key
#
# Agent Mesh is one isolated instance per tenant: the agents run shell commands, so a pod and the namespace
# around it are the boundary. This makes that repeatable. Run it again for the same tenant to upgrade it: the
# operator token already in the Secret is kept, not rotated, unless --rotate-token says so.
#
# Credentials never appear on a command line (argv is readable by every process on the machine): they are
# written to a private temporary directory, handed to kubectl as files, and removed.
#
# Options
#   --name <tenant>            required. Lowercase letters, digits and dashes; names the namespace (mesh-<name>)
#   --host <fqdn>              required. Where the tenant reaches it; the chart wires it into the server's own checks
#   --namespace <ns>           default mesh-<name>
#   --release <name>           Helm release name, default mesh
#   --chart <path|oci-url>     default deploy/helm/agent-mesh beside this script
#   --version <v>              chart version (required for an oci:// chart)
#   --licence-file <file>      the tenant's licence key; omit for the Community plan
#   --provider-key-file <file> the tenant's own model-provider key (their account, their bill); omit if they bring Bedrock/Vertex
#   --values <file>            extra Helm values, repeatable
#   --tls-secret <name>        TLS Secret for the ingress, default <release>-tls
#   --ingress-class <class>    default none (the cluster default)
#   --rotate-token             generate a new operator token even if the Secret has one
#   --dry-run                  print what would run, render the chart, touch nothing
#   --print-token              print the operator token on stdout at the end (otherwise only how to read it)
set -eu

here="$(cd "$(dirname "$0")" && pwd)"
name=""; host=""; namespace=""; release="mesh"; chart="$(cd "$here/../helm/agent-mesh" 2>/dev/null && pwd || echo "$here/../helm/agent-mesh")"; version=""
licence_file=""; provider_file=""; tls_secret=""; ingress_class=""
rotate=0; dry=0; print_token=0
values=""

die() { echo "provision-tenant: $*" >&2; exit 2; }

while [ $# -gt 0 ]; do
  case "$1" in
    --name) name="${2:-}"; shift 2 ;;
    --host) host="${2:-}"; shift 2 ;;
    --namespace) namespace="${2:-}"; shift 2 ;;
    --release) release="${2:-}"; shift 2 ;;
    --chart) chart="${2:-}"; shift 2 ;;
    --version) version="${2:-}"; shift 2 ;;
    --licence-file|--license-file) licence_file="${2:-}"; shift 2 ;;
    --provider-key-file) provider_file="${2:-}"; shift 2 ;;
    --values) values="$values
${2:-}"; shift 2 ;;
    --tls-secret) tls_secret="${2:-}"; shift 2 ;;
    --ingress-class) ingress_class="${2:-}"; shift 2 ;;
    --rotate-token) rotate=1; shift ;;
    --dry-run) dry=1; shift ;;
    --print-token) print_token=1; shift ;;
    -h|--help) sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option '$1' (see --help)" ;;
  esac
done

[ -n "$name" ] || die "--name is required"
[ -n "$host" ] || die "--host is required"
case "$name" in
  *[!a-z0-9-]*|-*|*-) die "--name must be lowercase letters, digits and dashes, not starting or ending with a dash: '$name'" ;;
esac
[ "${#name}" -le 40 ] || die "--name is longer than 40 characters"
case "$host" in
  *[!A-Za-z0-9.-]*|.*|*.|"") die "--host must be a plain host name, without a scheme or a port: '$host'" ;;
esac
[ -n "$namespace" ] || namespace="mesh-$name"
[ -n "$tls_secret" ] || tls_secret="$release-tls"
case "$chart" in oci://*) [ -n "$version" ] || die "--version is required for an oci:// chart" ;; esac
[ -z "$licence_file" ] || [ -f "$licence_file" ] || die "no such file: $licence_file"
[ -z "$provider_file" ] || [ -f "$provider_file" ] || die "no such file: $provider_file"

run() { # a command that changes something
  if [ "$dry" = 1 ]; then printf '+ %s\n' "$*"; else "$@"; fi
}

tmp="$(mktemp -d)"
chmod 700 "$tmp"
trap 'rm -rf "$tmp"' EXIT INT TERM

# --- the operator token: kept if the Secret already has one
token=""
if [ "$rotate" = 0 ] && [ "$dry" = 0 ] && kubectl -n "$namespace" get secret mesh-credentials >/dev/null 2>&1; then
  token="$(kubectl -n "$namespace" get secret mesh-credentials -o 'jsonpath={.data.MESH_API_TOKEN}' | base64 -d 2>/dev/null || true)"
fi
if [ -z "$token" ]; then
  token="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
fi
[ "${#token}" -ge 32 ] || die "could not produce a 32+ character token"

umask 077
printf '%s' "$token" > "$tmp/MESH_API_TOKEN"
secret_args="--from-file=MESH_API_TOKEN=$tmp/MESH_API_TOKEN"
secret_keys="MESH_API_TOKEN"
if [ -n "$licence_file" ]; then
  tr -d '\n' < "$licence_file" > "$tmp/MESH_LICENSE"
  secret_args="$secret_args --from-file=MESH_LICENSE=$tmp/MESH_LICENSE"
  secret_keys="$secret_keys MESH_LICENSE"
fi
if [ -n "$provider_file" ]; then
  tr -d '\n' < "$provider_file" > "$tmp/ANTHROPIC_API_KEY"
  secret_args="$secret_args --from-file=ANTHROPIC_API_KEY=$tmp/ANTHROPIC_API_KEY"
  secret_keys="$secret_keys ANTHROPIC_API_KEY"
fi

# --- namespace, with the strictest pod security profile the chart is written to meet
if [ "$dry" = 1 ]; then
  echo "+ kubectl create namespace $namespace (labelled pod-security.kubernetes.io/enforce=restricted)"
else
  kubectl create namespace "$namespace" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
  kubectl label namespace "$namespace" pod-security.kubernetes.io/enforce=restricted --overwrite >/dev/null
fi

# --- the credentials Secret, from files
if [ "$dry" = 1 ]; then
  echo "+ kubectl -n $namespace create secret generic mesh-credentials (keys: $secret_keys)"
else
  # shellcheck disable=SC2086
  kubectl -n "$namespace" create secret generic mesh-credentials $secret_args --dry-run=client -o yaml | kubectl apply -f - >/dev/null
fi

# --- the release
set -- --namespace "$namespace" \
  --set "auth.existingSecret=mesh-credentials" \
  --set "ingress.enabled=true" \
  --set "ingress.host=$host" \
  --set "ingress.tlsSecretName=$tls_secret"
[ -z "$ingress_class" ] || set -- "$@" --set "ingress.className=$ingress_class"
[ -z "$version" ] || set -- "$@" --version "$version"
old_ifs="$IFS"; IFS='
'
for f in $values; do
  [ -n "$f" ] || continue
  [ -f "$f" ] || die "no such values file: $f"
  set -- "$@" --values "$f"
done
IFS="$old_ifs"

if [ "$dry" = 1 ]; then
  echo "+ helm template $release $chart $*"
  helm template "$release" "$chart" --kube-version 1.29.0 "$@" >/dev/null
  echo "rendered: the chart accepts these values"
else
  helm upgrade --install "$release" "$chart" "$@" --wait --timeout 5m
fi

echo "tenant '$name': namespace $namespace, release $release, https://$host/"
if [ "$print_token" = 1 ]; then
  printf '%s\n' "$token"
else
  echo "operator token: kubectl -n $namespace get secret mesh-credentials -o 'jsonpath={.data.MESH_API_TOKEN}' | base64 -d"
fi
