# Deploying Curule

For whoever installs it: a trial in a minute, a single server, a Kubernetes cluster, and many tenants. After it is
running, [operations.md](../operations.md) is the reference and the runbooks.

## What you need

- **Somewhere to run a container**: Docker (any machine) or Kubernetes 1.25 or later. The image is built for
  `linux/amd64` and `linux/arm64`.
- **Outbound HTTPS to a model provider**, and a credential for it that belongs to you: for the native runtime, a key
  for any OpenAI-compatible provider or the Anthropic API ([runtime-native.md](../runtime-native.md)); for Claude
  Code, an Anthropic API key or Amazon Bedrock, Google Cloud (Vertex) or Microsoft Foundry credentials. The agents
  use it; you are billed by the provider. Without one, the shipped demo still runs (see below).
- **For anything beyond your own laptop**: a host name and TLS in front of it, and a token of 32 or more random
  characters. The server refuses to listen on a network address without one.

The image is `ghcr.io/salitaba/curule` (the release workflow publishes it), or build your own:
`docker build -t curule .`.

## Try it in a minute, with no API key

```bash
docker run --rm -p 127.0.0.1:7420:7420 -v mesh-demo:/data \
  -e MESH_API_TOKEN="$(openssl rand -hex 32)" \
  ghcr.io/salitaba/curule:latest demo
```

Open <http://127.0.0.1:7420>, paste the token (it is the `MESH_API_TOKEN` you passed; print it first if you let the
shell generate it), open the **demo-stub** project, press **Start mission** and confirm. A scripted team of seven agents (a
product manager, architect, tech lead, developer, QA, security and an explorer) takes a payment-API mission from
requirements to a merged, reviewed, verified result in a few seconds, and QA blocks it once so you can watch the
conflict handling. It makes no model calls and needs no credentials; it exists so you can see the whole flow.

`demo` is the ordinary host with that one project scaffolded into the data volume and registered. Anything you do
next, you do in the same dashboard.

## One server: Docker Compose

```bash
export MESH_API_TOKEN="$(openssl rand -hex 32)"     # keep it: it is the password
export ANTHROPIC_API_KEY=sk-ant-...                 # yours, not ours; billed to you by Anthropic
docker compose up -d
```

`docker-compose.yml` publishes the port on `127.0.0.1` only, runs the container with a read-only root file system,
no extra capabilities and `no-new-privileges`, keeps everything that must survive a restart on one volume
(`/data`), and gives the host 60 seconds to drain its projects when it stops.

**Your first project.** On a host with no project the dashboard opens on a welcome page with three ways to start (the
same three are behind *New project* in the project strip afterwards): *Try the demo*, *Create a new mesh* (the default
team, in a folder you choose) and *Add an existing folder*. Each says what it needs, what it costs and which files it
writes. The folder field and the folder picker only accept paths under `/data/projects`, the one place the server will
register projects from. From a shell:

```bash
docker compose exec mesh curule init /data/projects/hello                     # the default team, on the Claude runtime
docker compose exec mesh curule init /data/projects/hello --runtime stub      # the same on the stub runtime, no key needed
docker compose exec mesh curule init /data/projects/hello --example payment-api   # a shipped example (see: curule init --list)
docker compose exec mesh curule project add /data/projects/hello
```

Then set the mission's goal in the project's `mesh.yaml` (or in the dashboard's designer) and start it.

**A licence**, if you have one: `docker compose exec mesh curule license install <key>`, or `MESH_LICENSE` in the
environment. Without one the instance is on the Community plan.

### TLS and a reverse proxy

Do not publish the port to a network without TLS in front. Two ways: the file below, if you want your own hostname over
HTTPS on one server and nothing more to maintain, or a proxy you already run.

**The short way: Caddy in the same Compose project.** `docker-compose.caddy.yml` puts Caddy in front of the host. It gets
a Let's Encrypt certificate for the hostname you give it, renews it, redirects http to https, passes the dashboard's live
stream through unbuffered, and sets the four settings under *Then tell the server it is behind one* below, so you do
not.

```bash
export CURULE_DOMAIN=app.example.com            # its DNS record must already point at this server
export ACME_EMAIL=you@example.com               # where Let's Encrypt writes if it cannot renew the certificate
export MESH_API_TOKEN="$(openssl rand -hex 32)"
export ANTHROPIC_API_KEY=sk-ant-...
docker compose -f docker-compose.yml -f docker-compose.caddy.yml up -d
scripts/smoke.sh url "https://$CURULE_DOMAIN" "$MESH_API_TOKEN"
```

Before the first start:

- **DNS.** An `A` record (and an `AAAA` if the server has an IPv6 address) for `CURULE_DOMAIN` must point at the server.
  If Caddy starts before the record resolves, the certificate request fails, and Let's Encrypt allows only a handful of
  failures per hostname per hour. To rehearse without spending that allowance, add
  `ACME_CA=https://acme-staging-v02.api.letsencrypt.org/directory` to the environment (browsers do not trust what it
  issues), then remove it and start again for the real certificate.
- **Ports.** 80 and 443 (and 443/udp, for HTTP/3) must reach the server from the internet. Port 80 stays open even
  though everything is served on 443: it redirects to https, and it is one of the two ways Let's Encrypt checks that the
  hostname is yours. The host's own port stays on `127.0.0.1`, so an SSH tunnel to it still works if DNS or the
  certificate does not.
- **The certificate** and its account key live in the `caddy-data` volume. Back it up with the rest: losing it means
  asking for new ones, under the same limits.

The overlay pins Caddy to its current major version (`caddy:2-alpine`); pin a version or a digest in the file when you want
upgrades to be your decision. It adds nothing to the host's own service except the four settings, and a test
(`tests/deploy/caddy-overlay.test.ts`) pins that. It has not been run against a live Docker daemon by the project's CI, which
builds and smoke-tests the image and renders the chart but does not start Compose with a domain: the first start on your
server, with the smoke test above, is what proves your DNS and ports.

**A proxy of your own.** On one server, a reverse proxy on the same machine is the simplest, and Caddy is the least to
configure:

```
mesh.example.com {
    reverse_proxy 127.0.0.1:7420 {
        flush_interval -1        # the console is a live event stream: do not buffer it
    }
}
```

nginx needs the stream left unbuffered and long-lived:

```nginx
server {
    listen 443 ssl http2;
    server_name mesh.example.com;
    # ssl_certificate / ssl_certificate_key …
    location / {
        proxy_pass http://127.0.0.1:7420;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

Then tell the server it is behind one, in the environment (Compose passes these through):

```bash
export MESH_ALLOWED_HOSTS=mesh.example.com,127.0.0.1,localhost   # who it answers to; keep the loopback names if you also use the local port
export MESH_ALLOWED_ORIGINS=https://mesh.example.com
export MESH_TRUST_PROXY=1        # believe X-Forwarded-For / -Proto from the proxy
export MESH_COOKIE_SECURE=1      # the session cookie only over HTTPS
```

## A cluster: Helm

One release is one instance for one tenant: one pod (the event log has one writer), one volume, one namespace.

```bash
kubectl create namespace mesh
kubectl -n mesh create secret generic mesh-credentials \
  --from-literal=MESH_API_TOKEN="$(openssl rand -hex 32)" \
  --from-literal=ANTHROPIC_API_KEY=sk-ant-... \
  --from-literal=MESH_LICENSE=AML1....            # optional

helm install mesh oci://ghcr.io/salitaba/charts/curule --version <version> --namespace mesh \
  --set auth.existingSecret=mesh-credentials \
  --set ingress.enabled=true --set ingress.host=mesh.example.com --set ingress.tlsSecretName=mesh-tls \
  --set ingress.className=nginx \
  --set persistence.size=50Gi
```

(From a checkout, replace the chart reference with `deploy/helm/curule`. The chart refuses to render without
`auth.existingSecret`: an instance with no token must not be installable. It never holds a credential itself.)

What the chart sets up, and why:

- **`Recreate`, one replica.** Two writers on one log is the failure that must not happen. To serve more teams,
  install more releases.
- **A network policy, on by default.** Ingress only from your ingress controller's namespace (set
  `networkPolicy.ingressFrom` if it is not `ingress-nginx`); egress only to DNS and to public HTTPS, with private
  ranges and the cloud metadata address excluded. The agents run commands, and this keeps them from reaching the
  rest of the cluster. If your agents need git over SSH, an internal package mirror or a private model endpoint,
  add it under `networkPolicy.extraEgress`.
- **A restricted pod.** Non-root (uid 10001), read-only root file system, every capability dropped, no privilege
  escalation, the default seccomp profile, no service-account token. It is written to meet the Pod Security
  Standards' *restricted* profile.
- **Probes** on `/healthz` (liveness) and `/readyz` (readiness, which turns to 503 while the host drains).
- **The ingress's host, origin and TLS** wired into the server's own Host and Origin checks and its Secure cookie.
- **The data volume is kept** if you uninstall the release. Delete the claim yourself to remove an instance for good.

Check it:

```bash
kubectl -n mesh rollout status deployment/mesh-curule
scripts/smoke.sh url https://mesh.example.com "$TOKEN"       # health, auth, headers, no CORS, projects-root confinement
```

## Fleets

Curule is one isolated instance per tenant, and `deploy/fleet/provision-tenant.sh` makes that repeatable. For
each tenant it creates a namespace (labelled for the restricted pod profile), a credentials Secret built from files
so no credential is ever on a command line, and a Helm release wired to that tenant's host name:

```bash
deploy/fleet/provision-tenant.sh --name acme --host mesh.acme.example.com \
    --licence-file acme.key --provider-key-file acme-anthropic.key --ingress-class nginx
```

Run it again for the same tenant to upgrade; the operator token already in the Secret is kept unless you pass
`--rotate-token`. `--dry-run` renders the chart with the tenant's values and changes nothing.

Things that make a fleet work, or not:

- **The tenant's model credential is the tenant's.** Their account, their bill, their rate limits. That is what
  keeps a fleet inside Anthropic's terms ([pricing.md](pricing.md)); do not put one shared key behind many tenants.
- **A licence per tenant**, issued with `tools/license/mesh-license.mjs` ([licensing.md](licensing.md)).
- **Upgrade in waves**: a few tenants first, then the rest, with `helm upgrade` in a loop. Quiet missions first
  ([operations.md](../operations.md#upgrade)).
- **Watch them all**: each instance exposes `/metrics/prometheus`; scrape each, label by tenant, and alert on
  crashed projects, the spend ceiling and licence expiry.
- **Bound the blast radius** with a `ResourceQuota` and `LimitRange` per namespace, and a spend limit at each
  tenant's provider.
- **Sizing.** The chart asks for 250m CPU and 1 GiB and limits to 2 CPU and 4 GiB. A project is a Node process,
  and each agent in it is a further process while it takes a turn, so memory follows how many projects are open
  and how many turns run at once. Start with the defaults, watch `rss` on the project list and
  `curule_running_turns`, and set `project_memory_mb` and the concurrent-turn cap (`host.yaml`) to what the
  pod can carry.

## Air-gapped

Nothing in the product needs the internet except the agents' own calls to a model provider. For a disconnected
cluster: mirror the image and chart into your registry, set `image.repository`, and give the agents a route to a
private model endpoint (Bedrock or Vertex over a private link, or an internal gateway) through `extraEnv` and
`networkPolicy.extraEgress`. A licence verifies offline.

## Building it yourself

`docker build -t curule .` builds the image from a checkout, pinned to the lockfile. Pass
`--build-arg NODE_IMAGE=node:22-bookworm-slim@sha256:…` to pin the base by digest. The release workflow builds the
published image the same way, adds an SBOM and provenance, and signs the digest keylessly:

```bash
cosign verify ghcr.io/salitaba/curule@sha256:<digest> \
  --certificate-identity-regexp 'https://github.com/salitaba/agent-mesh/.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```
