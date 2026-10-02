# Changelog

What changed between versions, for whoever runs Ordane. The format follows [Keep a Changelog](https://keepachangelog.com).
There is no supported downgrade: the event log is append-only and a newer build may append events an older one does
not know ([docs/operations.md](docs/operations.md#upgrade)). The fixes from the live Haiku runs (`NOTES-live-run-20260930-haiku.md`,
sections 1 to 18) are described there, run by run.

## Unreleased

### Changed: read this before upgrading a deployment

- **The product is called Ordane** (it was Agent Mesh). The command is `ordane`; `mesh` stays installed as the same
  command, so a script that says `mesh run` keeps working. `mesh.yaml`, the `MESH_*` variables, the `mesh_*` tools the
  agents use and the event log are unchanged. What a running deployment has to account for: the metrics are `ordane_*`
  (they were `agent_mesh_*`); the default state directory is `~/.ordane`, and an existing `~/.agent-mesh` is still used
  while there is no `~/.ordane` (nothing is moved for you); the image is `ghcr.io/<owner>/ordane`; the Helm chart is
  `ordane`, and a release installed from the old chart needs `--set nameOverride=agent-mesh` on its first upgrade (a
  Deployment's selector cannot change); the Compose project is `ordane`, and an existing deployment keeps its volume
  with `COMPOSE_PROJECT_NAME=agent-mesh`; the stamp the orphan reaper reads is `ORDANE_HOST_PID`, and seats stamped
  with the old name are still found. The licence's *Licensed Work* line now reads "Ordane (previously named Agent
  Mesh)"; the terms are unchanged. Details:
  [docs/operations.md](docs/operations.md#upgrading-from-a-version-named-agent-mesh).
- **The source is now under the Business Source License 1.1** (`LICENSE`); `package.json` used to say MIT, and there
  was no licence file. Everything up to and including commit `d03781c336a4081a446e8e9977fe15011bf66479` stays MIT for
  whoever received it; the next commit onward is BSL. Production use is free within the Community plan's limits, which
  the licence's grant spells out and `tests/build/source-licence.test.ts` keeps equal to the plan table; beyond them,
  and for hosting it for third parties or embedding it in a product, a commercial licence is needed. Each version
  becomes Apache 2.0 four years after it is published. `package.json`, the lockfile and the image's
  `org.opencontainers.image.licenses` label say `BUSL-1.1`, and the image carries the licence file
  ([docs/commercial/licensing.md](docs/commercial/licensing.md#the-source-licence)).
- **The server fails closed on the network.** It refuses to listen on any address but loopback unless
  `MESH_API_TOKEN` is set to 32 or more characters (`openssl rand -hex 32`). A blank token on a network address is a
  refusal, not "no authentication". `MESH_ALLOW_INSECURE_BIND=1` overrides it, loudly, for a server whose only way in is a
  proxy that authenticates every request. `ordane run|serve|console` take `--bind` (default loopback).
- **Browser requests are checked.** State-changing requests must be JSON and same-origin (`Origin`, `Sec-Fetch-Site`;
  more origins through `MESH_ALLOWED_ORIGINS`). The wildcard CORS header is gone. With `MESH_ALLOWED_HOSTS` set, any other
  `Host` is refused with 421. Responses carry a CSP, `nosniff` and frame protection; agent-written pages run in a sandbox.
- **Sign-in is a session.** The dashboard asks for the operator token once and keeps an `HttpOnly`, `SameSite=Strict`
  cookie (`MESH_COOKIE_SECURE=1` behind TLS). The token is no longer accepted in a URL.
- **`/health` needs the token.** Probes use `/healthz` (liveness) and `/readyz` (readiness, 503 while draining); both
  are open and answer with a one-word status.
- **Seats no longer inherit the operator's secrets.** The operator token, the licence and the other `MESH_*` secrets are
  removed from the environment the agents' commands run in. Provider credentials still reach them.
- **Projects are confined.** With `MESH_PROJECTS_ROOT` set (it is `/data/projects` in the image), a project can only be
  registered, browsed or opened under it.
- **The spend ceiling counts the whole bill.** It priced input and output tokens only, which left out about 80% of a
  measured run's bill (cache reads and writes). It now prices all four token classes at Anthropic's published list
  prices, or at your own `model_prices`.
- **The image keeps the Claude Code binary quiet.** `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` is set in the image
  (telemetry, error reports, update and feature-flag calls). Set it to an empty value to allow them.
- **Licence limits warn by default.** `MESH_LICENSE_ENFORCEMENT` is `warn`. `enforce` refuses to start what a plan does not
  allow; nothing ever stops a running mission or deletes data because a licence expired.

### Added

- **Licensing.** Offline Ed25519 licence keys (`AML1.…`) verified on the customer's machine with no call out; the plan table
  (Community, Team, Business, Enterprise) with its limits and entitlements; `ordane license status|install|verify|remove`;
  a licence card and an expiry banner in the dashboard; `tools/license/mesh-license.mjs` to generate and sign keys.
  See [docs/commercial/licensing.md](docs/commercial/licensing.md).
- **Usage and metrics.** `ordane usage` reports what the meshes consumed by day, project, seat and model from their own event
  logs, as a table, JSON or CSV, with a dollar estimate at list prices; `/metrics/prometheus` exposes projects, spend, turns
  and the licence. Both are Team-plan features.
- **Deployment.** A container image (unprivileged, read-only root, tini) with a keyless `demo` mode; a Compose file; a Helm
  chart (one replica, `Recreate`, network policy, restricted pod, probes); a fleet provisioning script that creates a namespace,
  a credentials Secret and a release per tenant; a release workflow that builds for amd64 and arm64, attaches an SBOM and
  provenance and signs the digest; CI and security workflows; Dependabot. See
  [docs/commercial/deployment.md](docs/commercial/deployment.md).
- **`ordane doctor`** prints what a support engineer needs and nothing that is yours: version, plan and licence state, the
  settings that are present (by name, never value), each project's configuration, lock and event-log size, disk space,
  and the host's probes with `--host`. No event content, prompt, credential, licensee name or path is in it, so it is
  safe to paste into a ticket ([docs/operations.md](docs/operations.md#what-to-send-support)).
- **`ordane init`** can scaffold a mesh on the stub runtime (`--runtime stub`) or from a shipped example (`--example name`,
  `--list`).
- **Documents.** The operations runbook ([docs/operations.md](docs/operations.md)), deployment, pricing (its tables generated
  from the plan table), licensing, security and a security questionnaire under [docs/commercial/](docs/commercial/README.md),
  [SECURITY.md](SECURITY.md), and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) generated from the lockfile.
- **A landing and pricing page** in [site/](site/README.md), with a plan-and-cost calculator whose numbers are generated.
- **`mesh_artifact_read` says where the artifact stands.** The result carries `status`, `version` and `owner` beside `canSettle`,
  on every page, so a seat reading a report to cite it learns that it is a draft, and whom to ask, from the read.

### Fixed

- A seat that submits an artifact for review is told that nobody has been asked. Moving an artifact to `READY_FOR_REVIEW` sends no
  request and wakes no one, and neither does announcing it; the briefing's "a DRAFT nobody transitions is never reviewed" read as "a
  transition gets it reviewed". The twelfth Haiku run's developer submitted two patches that way and the tech lead's first turn on
  each came 3 min 2 s and 2 min 39 s later, from the unread-mail sweep (an asked-for review of the architect's document took
  1 min 28 s). The briefing now says a submission asks nobody and names the ask as the seat has it (`mesh_request_review`, or
  `mesh_call review.artifact` under the contracts vocabulary), and the reply to the submission says so, naming the seats that can
  settle it, unless a review of that version was asked for or the owner is the only seat that could settle it.
- A verification report that names a commit its worktree does not hold is told so in the reply to its publish. The runtime already
  stamps a report with the tree it was written from, but only compared it with the patches the turn *read*, and a verifier is
  handed the commit by its briefing and reads nothing. The twelfth Haiku run's QA named the patch's commit (243 of 243 pass),
  ran the tests in a tree at the scaffold's (233 fail), blocked `quality` on it and had a good patch rejected: it had stood
  MERGEABLE at 16:56:34 and was merged at 16:59:40, after two more versions of the same tree. The commit under `metadata.commit`
  is now checked too, the reply says what the report describes and how to test the commit, and the run report flags a delivered
  one. Nothing is refused.
- A pass that names a report now lifts the blocker's own block on that subject. A verdict naming an artifact is filed under
  `artifact:<id>`, so a QA seat that had blocked `quality` and then passed it with its test report attached still had its block
  read as standing: the stall watchdog woke QA, who had passed and cannot accept, instead of the pm who could, in both rounds
  of the twelfth Haiku run (the pm accepted 3 min 11 s and 5 min 13 s after the wasted nudge, when its unread-mail timer
  fired). The approval record keeps the subject it was given, and the watchdog reads the pass as the sign-off the gates
  already counted it as.
- A merge refused because the patch is not `MERGEABLE` says where the patch stands and whose move is next. An approved patch
  has two rungs left (`VERIFIED`, `MERGEABLE`) and nothing climbs them by itself; the refusal named neither, and the twelfth
  run's tech-lead met it three times. It now says "You can" when the asking seat may climb them, and names the owner (or a
  seat that may verify) when it may not; a draft, a patch in review, a rejected one and a merged one each say what they wait for.
- `ordane --help` and `ordane -h` print the usage and exit 0. They answered "unknown command: --help" and exited 1, so a script that
  checked the command ran (the image's smoke test does) saw a failure; a command that does not exist still exits 1.
- A seat that passes the verification report it wrote now submits it with the pass. The report used to stay a draft, which is
  shown to nobody but its owner and is refused as evidence, so the seats that needed it spent minutes asking for a report that
  existed (the ninth Haiku run: six turns and four minutes). The pass is the owner's own transition under the same gates, taken
  only after every refusal a pass can meet; a pass on somebody else's draft submits nothing.
- A seat that may accept criteria is shown the submitted artifacts it could cite in its briefing, while a mandatory criterion
  that needs an acceptance is open. Until now only the stall watchdog's note named them, after three idle minutes.
- The closing report of `ordane run` is printed after the turns still running have settled, so its `SPEND` line matches the ledger
  and `ordane usage`. It was short by the final turn (2.2% to 2.6%) in every real run.
- An approval signed as `architecture` on another kind of artifact (a RequirementsDoc, in the tenth Haiku run) no longer closes
  `architecture-approved` or announces that the architecture is approved: the criterion and the derived event follow the artifact,
  and the reply names the architecture review the seat still owes.
- A mission that waits only on an acceptance, with a submitted verification report to cite and a seat that may accept it, is nudged
  after a twelfth of the stall idle window (15 s by default, not 180 s). It cost 3 min 22 s of a 13-minute round in the ninth and
  tenth runs.
- The acceptor's briefing and the pm's role prompt now say that an acceptance has to be backed by a read in the same turn; the pm
  had accepted without reading, been recorded `ASSERTED`, and needed a second wake.
- A pass that names the merged patch (or nothing) now also submits the verification report its giver wrote and left a draft. The
  eleventh Haiku run's QA wrote its test report, passed the patch five seconds later and left the report a draft that no other
  seat could see or cite; the pm spent 3 min 13 s of a 10 min 29 s round asking for it, being refused twice and waiting for QA's
  next turn. Only the giver's own newest report of the type that settles the pass's domain, this mission's, after every refusal;
  the reply says it was done.
- A verdict or an acceptance that names an artifact the mesh does not hold is refused with the route: the submitted artifacts an
  acceptance could cite (or why there are none), or the reviews the seat still owes. Seats typed ids from memory twelve times in
  runs 7 to 11, and the refusal said only that the artifact was unknown.
- A review request refused because no named seat can settle the artifact no longer says "no seat in this mesh can" when the artifact's
  owner is the only one that can (a test report only its author could settle, in the eleventh Haiku run). The refusal reads the
  same list as the briefing and names the owner, or says "you can" to it.
- A review request refused because the requesting seat is itself the only one that can settle the artifact says "you" and what to
  do (settle it with `mesh_approve`, and ask a seat to test it first with a `work.request`), instead of naming the seat back to
  itself and telling it to escalate; for an artifact no verdict can move (a draft, or one already past review) it says what state
  the artifact is in instead.
- A verdict that did not close its criterion now says so. A `pass` from a turn that checked nothing was recorded `ASSERTED` and
  answered `ok`, and an acceptance of the artifact the operator had rejected at a reopen was refused the same way; both now carry a
  note saying what happened and what to do. A pass names the artifact it was about (when that is submitted work), so a reopen can
  refuse the same artifact twice, and a seat is no longer told to "move it to review first" when the artifact has no such move.
- A replacement pod now takes over its predecessor's state lock at once (`MESH_INSTANCE_ID` is stable across restarts of one
  deployment); a different instance waits `MESH_LOCK_STALE_MS`. A host that loses the lock exits with status 70 instead of
  carrying on with two writers.
- The hosted demo project started with no scripted team and never moved; the host's demo mode now attaches it.
- Request bodies, live-stream subscribers and failed sign-ins are capped before authentication, so an unauthenticated client
  cannot exhaust memory.
- Paths served for previews are resolved through their real location, and object keys that could pollute prototypes are
  refused.
