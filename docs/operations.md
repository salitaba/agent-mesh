# Operating Agent Mesh

For the person who runs it. This is the reference and the runbooks: what every setting does, how to upgrade,
how to back up and restore, how to watch it, and what its refusals mean. Getting it running in the first place
is [commercial/deployment.md](commercial/deployment.md); what it protects and what it does not is
[commercial/security.md](commercial/security.md).

Commands below use Docker Compose (`docker compose exec mesh …`). On Kubernetes the same commands are
`kubectl exec deploy/<release> -- …`, and the settings are the chart's `values.yaml`.

## What is running

One **host** process per instance. It serves the dashboard and the API, keeps the project registry
(`<MESH_HOME>/projects.json`), and runs one child process per *open* project. A child is one mesh: its seats
(agents), its scheduler, its event log. The agents run commands, so a container or a pod is the isolation
boundary: one instance is one tenant. For many customers, run many instances (see
[Fleets](commercial/deployment.md#fleets)).

| Where | What |
|---|---|
| `/data/home` (`MESH_HOME`) | `projects.json` (the registry), `host.yaml` (limits), `license.key` (if installed with `mesh license install`) |
| `/data/projects/<name>/` (`MESH_PROJECTS_ROOT`) | one project: `mesh.yaml`, `roles/`, and `workspace/` |
| `…/workspace/.mesh-state/` | that project's state: `logs/events.jsonl` (the append-only event log, the source of truth), `artifacts/`, `sessions.json`, a snapshot and an index |
| `/data/user` (`HOME`) | the agents' own CLI sessions: without them a restarted seat cannot resume its conversation |

Every view is a projection of the event log. Nothing is updated in place: to change what happened, the system
appends an event. That is what makes the backup and restore below simple.

## Settings

Everything is environment variables, plus `host.yaml` for the host's resource limits
([configuration.md](configuration.md#hostyaml--the-multi-project-host)). A blank value is treated as unset,
except `MESH_API_TOKEN`: blank on a network address is a refusal, so a Secret that expanded to nothing cannot
start an open server.

### Reachability and sign-in

| Variable | Default | Meaning |
|---|---|---|
| `MESH_API_TOKEN` | none | The operator's credential. **Required** to listen on anything but loopback, and then it must be at least 32 characters (`openssl rand -hex 32`). An empty value is refused, not ignored. It is the password at the dashboard's sign-in and the bearer token for the API and CLI. |
| `MESH_ALLOW_INSECURE_BIND` | unset | `1` lets the server listen on the network with no strong token, and says so on stderr. For a server whose only way in is a proxy that authenticates every request itself. |
| `MESH_ALLOWED_HOSTS` | any, on a network interface | Comma-separated host names the server answers to (`mesh.example.com`). When set, any other `Host` is refused with 421. Loopback names still work on a connection that arrives on loopback inside the container (which is how `kubectl port-forward` arrives); a published Docker port arrives on the container's own address, so list `127.0.0.1` and `localhost` too if you also reach it that way. |
| `MESH_ALLOWED_ORIGINS` | the page's own origin | Comma-separated origins (`https://mesh.example.com`) allowed to make state-changing requests besides the server's own page. |
| `MESH_TRUST_PROXY` | unset | `1` trusts `X-Forwarded-For` (the client address, for sign-in rate limiting and the audit log) and `X-Forwarded-Proto` from the proxy in front. Set it only when a proxy you control is the only way in. |
| `MESH_COOKIE_SECURE` | unset | `1` marks the dashboard's session cookie `Secure`. Set it whenever the browser reaches you over HTTPS. |
| `MESH_MAX_BODY_BYTES` | 1 MiB | Largest request body accepted; larger is refused with 413. |
| `MESH_MAX_SSE_CLIENTS` | 256 | Live-stream subscribers (open dashboards) per server. |

### Where things live

| Variable | Default | Meaning |
|---|---|---|
| `MESH_HOME` | `~/.agent-mesh` (`/data/home` in the image) | The registry, `host.yaml` and a saved licence. |
| `MESH_PROJECTS_ROOT` | unset (`/data/projects` in the image) | Projects can only be registered, browsed and opened under here (several, separated like `PATH`). Unset means no confinement, which is right on a laptop and wrong on a server. |
| `MESH_INSTANCE_ID` | the hostname (the release name in the chart) | Who the state-lock holder is. Keep it **stable across restarts of one deployment** and **different between deployments**. See [A lock left behind](#a-lock-left-behind). |
| `MESH_LOCK_STALE_MS` | 120000 | How long another instance's heartbeat may be silent before its lock is taken over. |
| `MESH_LOCK_RECLAIM_FOREIGN` | on | `0` never takes over a lock held by a different `MESH_INSTANCE_ID`. |

### Licence

| Variable | Default | Meaning |
|---|---|---|
| `MESH_LICENSE` | none | The licence key itself. Takes precedence over a file. |
| `MESH_LICENSE_FILE` | none | Path of a file holding the key. Otherwise `<MESH_HOME>/license.key`, which `mesh license install` writes. |
| `MESH_LICENSE_ENFORCEMENT` | `warn` | `off`, `warn` or `enforce`. See [Licence](#licence-1). |

### The agents' model access

The agents run on **your** credentials, billed to you by the provider. Pass `ANTHROPIC_API_KEY`, or the
variables for Bedrock, Vertex or Foundry; they reach the agents, and the operator token, the licence and the
other `MESH_*` secrets do not: those are removed from the environment the agents' commands run in.
Use an API key or your cloud provider's credentials, not a Claude subscription's sign-in: Anthropic's terms for
products built on the SDK ask for the former.

`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is `1` in the image: the Claude Code binary the agents run makes no
telemetry, error-report, update or feature-flag calls. Set it to an empty value to let it. It is kept even under
`isolate_host`.

### Limits that protect the bill

Set in `host.yaml` (editable in the dashboard under *Host settings*). They apply to every open project at once:

- `spend_ceiling_usd` (default **50**): parks every open project when estimated spend reaches it. The
  estimate prices all four token classes (fresh input, output, cache writes, cache reads) at Anthropic's
  published list prices, or at `model_prices` where you set your own rate; a model with neither is priced at
  `default_usd_per_mtok`. The provider's invoice is the authoritative bill, and the ceiling is a backstop, not
  an accounting system.
- `max_concurrent_turns`: how many agent turns may run at once. A plan can tighten it (only under
  `MESH_LICENSE_ENFORCEMENT=enforce`), never loosen it.
- `project_memory_mb`: the memory cap handed to each project process.

## Upgrade

An upgrade replaces the image and restarts the host. The state is on the volume, so it carries over, and each
project comes back in the mode it was in (a live mission returns live, a parked one parked).

What a restart costs: a turn that is running when the host stops is **discarded**, and the seat takes it
again from where its session left off. The tokens that turn had spent are still billed by the provider. So
upgrade when the missions are idle if you can, and the work is not lost if you cannot.

1. **Read the release notes** for the version you are going to. There is no supported downgrade: the event log
   is append-only and a newer build may have appended events an older one does not know.
2. **Take a snapshot** of the data volume (see [Back up](#back-up-and-restore)).
3. **Quiet the missions** (optional, and worth it for long turns). Park each project from the dashboard
   (*Pause*) or with `POST /api/p/<project>/mission/park`. Parking stops new turns from starting and waits up
   to five seconds for running ones; a long turn can outlast that, and a restart will then discard it.
4. **Replace the image.**
   - Compose: `docker compose pull && docker compose up -d`.
   - Helm: `helm upgrade <release> deploy/helm/agent-mesh --reuse-values --set image.tag=<version>`. The
     chart uses the `Recreate` strategy with one replica, so the old pod stops before the new one starts: the
     two never hold the event log at once.
5. **Watch it come up.** `/healthz` answers as soon as the process is serving; `/readyz` answers 200 `ready`
   until the host begins to shut down, then 503 `draining`. In the dashboard the projects reopen on their own.
6. **Check the licence** (`mesh license status`) and that the projects are in the modes you expect.
7. If it is wrong: restore the snapshot and start the previous image. Do not start the old image on the
   upgraded volume.

The host drains on `SIGTERM` (Compose `stop_grace_period` and the chart's `terminationGracePeriodSeconds`
are 60 seconds). Give it that long; `SIGKILL` skips the drain and leaves locks for the next start to reclaim.

## Back up and restore

**What to back up: the data volume.** It holds everything: the registry, every project's event log,
workspaces and artifacts, and the agents' sessions. The model provider keeps nothing of yours.

A **volume snapshot** (a CSI `VolumeSnapshot`, an EBS or disk snapshot, `restic` of `/data`) is enough, and it
may be taken while the host runs:

- The event log is replayed on start, and a torn final line left by the moment of the snapshot is discarded.
- The query index and snapshot files beside it are caches, rebuilt from the log.
- Git workspaces survive a crash the way any git repository does.

For a copy that is consistent by construction, stop the host first (`docker compose stop`, or scale the
Deployment to zero), copy `/data`, and start it again.

**Restore** by putting the snapshot on a volume and starting the instance on it. A restored volume carries the
lock of the instance that wrote it; if it came from a different `MESH_INSTANCE_ID`, the new instance takes the
lock over after `MESH_LOCK_STALE_MS` (two minutes) of heartbeat silence, and says so. Until then a project
shows as *locked* and retries. Restore only onto a stopped instance.

**Mission archives are a different thing.** *Reset mission* archives the mission's log, product checkout and
agent worktrees under the project's `.mesh-backups` before it clears them. List them with
`mesh backups <mesh.yaml>`; put one back, with the mesh stopped, with `mesh restore <mesh.yaml> <stamp>`.
Those are for undoing a reset, not for disaster recovery: they sit on the same volume as the thing they
protect.

**Test your restore.** A backup that has never been restored is a hope. Restore into a scratch instance
(Compose: a second project name) and open a project: the dashboard should show the mission as you left it.

## Licence

Without a licence an instance is on the **Community** plan. To install one:

```
docker compose exec mesh mesh license install <key>     # verifies it, saves it owner-only to $MESH_HOME/license.key
docker compose exec mesh mesh license status            # the plan, the limits, what is in use
```

A running host picks up a new licence within 30 seconds, with no restart. A licence in `MESH_LICENSE` or
`MESH_LICENSE_FILE` takes precedence over the saved one; `mesh license install` tells you when that is so.

`MESH_LICENSE_ENFORCEMENT` decides what a plan limit does:

- `warn` (the default): a limit that is exceeded is reported (the log, `/license`, the dashboard's banner) and
  **nothing is refused**.
- `enforce`: what the plan does not allow does not **start**: a mesh with more seats than the plan, a project
  beyond the plan's open-project cap, an export the plan lacks. Nothing that is running is ever stopped or
  touched, and no data is deleted.
- `off`: nothing is checked.

An expired licence keeps its plan for a 14-day grace period, then the instance is on Community. Expiry is in
the log at start, in the dashboard's banner, and in the metrics (`agent_mesh_license_expires_timestamp_seconds`):
alert on it.

## Rotating the token

Change `MESH_API_TOKEN` (the Secret, in Kubernetes) and restart the host. Sessions live in the host's memory,
so everyone is signed out and signs in with the new token. The CLI and scripts use the new value from their
environment. The agents never hold the operator token; their per-seat credentials are created at each start
and die with it.

## Watching it

### Probes

| Path | Use | Answers |
|---|---|---|
| `/healthz` | liveness | `200 {"status":"ok"}` from the event loop. Reveals nothing, needs no token. |
| `/readyz` | readiness | `200 {"status":"ready"}`; `503 {"status":"draining"}` while the host shuts down. |
| `/health` | the detailed check | needs the token |

### Metrics

`GET /metrics/prometheus` (Team plan and above; needs the token as a bearer token). The host answers for
itself: projects by status, spend, turns, the licence. Each open project answers for its own mesh (seats by state,
events, escalations, loop lag) at `/api/p/<project>/metrics/prometheus`, through the host.

| Metric | What to alert on |
|---|---|
| `agent_mesh_up` | `== 0` or absent: the host is down |
| `agent_mesh_projects{status=…}` | `status="crashed"` or `"error"` above 0 for 5 minutes |
| `agent_mesh_project_up{project=…}` | a project that should be open is `0` |
| `agent_mesh_projects_tripped` | above 0: a project's restart breaker is open and it needs a person |
| `agent_mesh_spend_usd`, `agent_mesh_spend_ceiling_usd` | spend above 80% of the ceiling |
| `agent_mesh_spend_ceiling_tripped` | `== 1`: the ceiling has parked every open project |
| `agent_mesh_running_turns`, `agent_mesh_max_concurrent_turns` | running at the cap for a long time (turns are queueing) |
| `agent_mesh_license_expires_timestamp_seconds` | less than 30 days away |
| `agent_mesh_license_in_use{what=…}`, `agent_mesh_license_limit{limit=…}` | in use at or above the limit |
| `agent_mesh_event_loop_lag_seconds` (per project) | above 1 for a minute: something is blocking the loop |
| `agent_mesh_escalations_open` (per project) | above 0 for longer than your response time: a mission is waiting for a person |

Scrape config, with the token from a file: one job for the host, and one per project whose own metrics you want.

```yaml
scrape_configs:
  - job_name: agent-mesh
    metrics_path: /metrics/prometheus
    authorization: { credentials_file: /etc/prometheus/agent-mesh-token }
    static_configs: [{ targets: ["mesh.internal:7420"] }]
  - job_name: agent-mesh-project-hello
    metrics_path: /api/p/hello/metrics/prometheus
    authorization: { credentials_file: /etc/prometheus/agent-mesh-token }
    static_configs: [{ targets: ["mesh.internal:7420"] }]
```

### Usage and cost

`mesh usage --all` (or `--csv`, `--json`, `--by day,project,agent,model`) reads the event logs and reports
what each project, seat and model consumed, with an estimate in dollars. Tokens are exact; dollars are an
estimate at list prices or your `model_prices`. Reading is safe beside a running mesh.

## When something is refused

| You see | It means | Do |
|---|---|---|
| the process exits **78** at start, `MESH_API_TOKEN …` | it would listen on the network without a strong token | set `MESH_API_TOKEN` to 32+ random characters |
| exit **78**, `license` | `MESH_LICENSE_ENFORCEMENT=enforce` and the plan does not allow what was started | install a licence for the plan you need, or set `warn` |
| exit **70** | another process took this instance's state lock (a pause longer than the stale window) | check that two instances are not running on the same volume; start one |
| exit **79** (a project) | its `mesh.yaml` is missing or invalid | `mesh validate <mesh.yaml>` |
| **421** `host_not_allowed` | the `Host` header is not one the server answers to | add the name to `MESH_ALLOWED_HOSTS` |
| **403** `cross_origin` | a state-changing request from a page that is not the server's own | add that origin to `MESH_ALLOWED_ORIGINS` if it is yours |
| **403** `outside_projects_root` | a folder outside `MESH_PROJECTS_ROOT` | put the project under it |
| **403** `license_limit` / `license_feature` | `enforce` and the plan lacks it | the message names the plan that has it |
| **401** | no token, a wrong one, or an ended session | sign in again; repeated wrong tokens are slowed down |
| **413** | a request body over `MESH_MAX_BODY_BYTES` | send less, or raise it |
| a project is *locked* | its state lock is held by something | see below |

### A lock left behind

Each project's state directory has a lock naming its holder, kept fresh by a heartbeat. A holder that is gone
is detected and replaced:

- **the same instance** (an earlier life of this deployment, for instance an OOM-killed pod): taken over at
  once, because the old process is provably not running;
- **another instance:** taken over after `MESH_LOCK_STALE_MS` of silence, because a machine that has gone
  quiet cannot be told from one that is slow.

This is why `MESH_INSTANCE_ID` must be stable across restarts of one deployment. If a lock is held by an
instance you know is gone and you cannot wait, remove the lock file named in the message from the state
directory, with the instance stopped.

## Running more than one

One host owns one volume. Do not run two hosts on the same `/data`, and do not scale the Deployment past one
replica: the second writer is refused (and the first exits with code 70 if its lock is taken). To serve more
teams, run more instances. [commercial/deployment.md](commercial/deployment.md#fleets) shows how.
