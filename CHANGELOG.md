# Changelog

What changed between versions, for whoever runs Curule. The format follows [Keep a Changelog](https://keepachangelog.com).
There is no supported downgrade: the event log is append-only and a newer build may append events an older one does
not know ([docs/operations.md](docs/operations.md#upgrade)). The fixes from the live Haiku runs (`NOTES-live-run-20260930-haiku.md`,
sections 1 to 24) are described there, run by run.

## Unreleased

### Changed: read this before upgrading a deployment

- **The product is called Curule** (it was Agent Mesh). The command is `curule`; `mesh` stays installed as the same
  command, so a script that says `mesh run` keeps working. `mesh.yaml`, the `MESH_*` variables, the `mesh_*` tools the
  agents use and the event log are unchanged. What a running deployment has to account for: the metrics are `curule_*`
  (they were `agent_mesh_*`); the default state directory is `~/.curule`, and an existing `~/.agent-mesh` is still used
  while there is no `~/.curule` (nothing is moved for you); the image is `ghcr.io/<owner>/curule`; the Helm chart is
  `curule`, and a release installed from the old chart needs `--set nameOverride=agent-mesh` on its first upgrade (a
  Deployment's selector cannot change); the Compose project is `curule`, and an existing deployment keeps its volume
  with `COMPOSE_PROJECT_NAME=agent-mesh`; the stamp the orphan reaper reads is `CURULE_HOST_PID`, and seats stamped
  with the old name are still found. The licence's *Licensed Work* line now reads "Curule (previously named Agent
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
  proxy that authenticates every request. `curule run|serve|console` take `--bind` (default loopback).
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

- **A runtime that is not tied to one model vendor.** `runtime: native` runs the agent loop in Curule itself, against any
  provider that speaks OpenAI-compatible chat completions or Anthropic Messages, with the seat's own tools (`Read`,
  `Write`, `Edit`, `Glob`, `Grep`, `Bash`, `WebFetch` and the `mesh_*` bus) behind the same permission, approval and
  landing gates the Claude adapter uses. A mesh names its providers under `mesh.runtime.providers` and a seat's model as
  `provider/model`; a key is read from the environment variable its provider names. `curule providers check [mesh.yaml]
  [--model provider/model]` proves a key, lists the models and makes one call that must use a tool. It is tested against
  servers that speak each format; how well other models do this product's work has not been measured. See
  [docs/runtime-native.md](docs/runtime-native.md).
- **The model gateway of Curule Cloud.** `packages/ai-gateway` and `npm run cloud -- gateway --config gateway.yaml`:
  virtual keys, a price table the operator owns, an append-only ledger of credit and spend in whole millionths of a
  currency unit, tiers with failover, OpenAI-compatible chat completions in and any provider out, and an admin API. It has
  not been run against a real provider. See [docs/ai-gateway.md](docs/ai-gateway.md) and [docs/cloud.md](docs/cloud.md).
- **The control plane of Curule Cloud.** `packages/cloud` and `npm run cloud -- control --config control.yaml`: accounts (email
  and password, a confirmation link, sessions in an `HttpOnly` cookie), a plan catalogue the operator owns, a billing port
  with a hosted-checkout adapter and a manual one, workspaces and their lifecycle (made, stopped for non-payment, deleted
  after a retention period) behind a provisioner port with a container implementation and a local-process one, an
  authenticating proxy that serves each workspace at an address of its own, and an operator's API on a separate listener
  behind a token. State is an append-only log. The configuration is checked before anything listens: a workspace domain
  under the app's own registrable domain, a licence key the build does not trust, the local provisioner in production, a
  mail server that would be sent a password in the clear, and account pages that still carry a place marked
  `TODO(owner)` are each refused, and every problem is reported at once. It has not been run against a real payment
  provider, container engine or mail service. See [docs/cloud-control-plane.md](docs/cloud-control-plane.md).
- **Account pages for Curule Cloud.** `apps/cloud-server/pages`: the front page, sign-up, sign-in, confirmation, password
  reset, the account (plan, credit, usage, workspaces) and the terms and privacy notice, as static files under a
  content policy that allows no inline script. The terms and the privacy notice are placeholders marked for the operator.
- **`curule-cloud trial`.** The whole service on one machine, with a stand-in model, a payment page of its own and mail that
  is printed, so that it can be tried and shown before anything is paid for. An end-to-end test walks a customer through
  it with a real host process for each workspace; `npm run qa:cloud` does the same in a browser at three widths and in both
  colour schemes, with an accessibility scan.
- **A workspace host that is given its models.** With `CURULE_GATEWAY_URL` and `CURULE_GATEWAY_KEY` set, a team made on
  the host runs on the service's gateway and the person brings no key.
- **Mail for Curule Cloud.** `mail.smtp` in `control.yaml` delivers to any provider that offers SMTP, with TLS or STARTTLS and
  a sign-in, using only Node's standard library; the certificate is verified and a password is never sent unencrypted.
  A message is written to a spool folder first and delivered with retry and a wait that doubles, so a provider that is down,
  a restart or a crash does not lose a confirmation link; `GET /owner/health` reports what is queued and goes not-ok when
  mail is stuck. `npm run cloud -- mail-check --config control.yaml --to <address>` sends one message and says what the
  server answered. See [docs/cloud-control-plane.md](docs/cloud-control-plane.md#mail).
- **`curule-cloud preflight`.** Looks at what a control plane's configuration points at and says what would fail a customer: whether
  the gateway answers, accepts the admin token and has the tiers the plans promise; whether the container engine runs, the image
  is there and the workspace network is internal; whether the folders can be written, the names resolve (the wildcard record), the
  listeners can be had and, given an address, a message goes through the mail server. Each answer is `ok`, `warning` or `problem`,
  and the exit status is 1 on a problem.
- **A way from the site into Curule Cloud.** With `CLOUD_URL` set in `site/assets/site.js` (`npm run site:domain -- <domain>
  --cloud-url https://app.example.com`), every page of the marketing site has "Sign in" and "Get started" in its header, which lead to
  the app's sign-in and sign-up pages; the home page leads with "Get started" and says Curule is also run for you; the pricing
  page sends a visitor to the app's plans and says its own plans are licences for the software you run; and the sentences that
  said Curule is not offered as a hosted service give way. It ships off, so until the app is live no page mentions it, and a
  visitor without a script sees the pages as they ship. Prices of the hosted plans are not copied into the site. See
  [site/README.md](site/README.md#the-way-into-curule-cloud).
- **A guide to going live.** [docs/cloud-go-live.md](docs/cloud-go-live.md) gives the order in which the service is made ready for
  a first customer (the licence key, the build, the models, the configuration, mail, the machine, payments in the provider's test
  mode, a rehearsal as a customer, opening, and what to keep), with what each step proves. The steps that meet a real provider are
  marked, because nothing here has been run against one.
- **Licensing.** Offline Ed25519 licence keys (`AML1.…`) verified on the customer's machine with no call out; the plan table
  (Community, Team, Business, Enterprise) with its limits and entitlements; `curule license status|install|verify|remove`;
  a licence card and an expiry banner in the dashboard; `tools/license/mesh-license.mjs` to generate and sign keys.
  See [docs/commercial/licensing.md](docs/commercial/licensing.md).
- **Usage and metrics.** `curule usage` reports what the meshes consumed by day, project, seat and model from their own event
  logs, as a table, JSON or CSV, with a dollar estimate at list prices; `/metrics/prometheus` exposes projects, spend, turns
  and the licence. Both are Team-plan features.
- **Deployment.** A container image (unprivileged, read-only root, tini) with a keyless `demo` mode; a Compose file; a Helm
  chart (one replica, `Recreate`, network policy, restricted pod, probes); a fleet provisioning script that creates a namespace,
  a credentials Secret and a release per tenant; a release workflow that builds for amd64 and arm64, attaches an SBOM and
  provenance and signs the digest; CI and security workflows; Dependabot. See
  [docs/commercial/deployment.md](docs/commercial/deployment.md).
- **On your own domain.** `docker-compose.caddy.yml` puts Caddy in front of the host, for HTTPS on a hostname you name: it gets
  and renews the certificate, redirects http to https, passes the live stream through unbuffered, and sets the four proxy
  settings (`MESH_ALLOWED_HOSTS`, `MESH_ALLOWED_ORIGINS`, `MESH_TRUST_PROXY`, `MESH_COOKIE_SECURE`) for you. `npm run site:domain`
  (`scripts/set-domain.mjs`) applies the domain you chose to the landing page, `SECURITY.md` and the files a host and a
  crawler read (`CNAME`, `robots.txt`, `sitemap.xml`, `security.txt`), and `npm run site:check` lists what is still to fill in.
  **Publish the site** is a workflow you start by hand: it checks first and publishes `site/` to GitHub Pages. See
  [docs/commercial/deployment.md](docs/commercial/deployment.md#tls-and-a-reverse-proxy) and [site/README.md](site/README.md).
- **`curule doctor`** prints what a support engineer needs and nothing that is yours: version, plan and licence state, the
  settings that are present (by name, never value), each project's configuration, lock and event-log size, disk space,
  and the host's probes with `--host`. No event content, prompt, credential, licensee name or path is in it, so it is
  safe to paste into a ticket ([docs/operations.md](docs/operations.md#what-to-send-support)).
- **`curule init`** can scaffold a mesh on the stub runtime (`--runtime stub`) or from a shipped example (`--example name`,
  `--list`).
- **Documents.** The operations runbook ([docs/operations.md](docs/operations.md)), deployment, pricing (its tables generated
  from the plan table), licensing, security and a security questionnaire under [docs/commercial/](docs/commercial/README.md),
  [SECURITY.md](SECURITY.md), and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) generated from the lockfile.
- **A public site** in [site/](site/README.md): a landing page, pricing (with a plan-and-cost calculator whose numbers are
  generated), a docs hub, security, contact, the legal pages and a 404. Static files with no build step, a strict
  content-security policy, light and dark, and thirteen pictures of the real console under stable names. Selling is by email
  and a hand-signed licence key; there is no sign-up or checkout, and nothing on the site pretends otherwise.
- **A redesigned console.** The shell is a sidebar of four groups (Mission, Results, Team, Host) with a top bar that carries the
  mission's one state and the one thing to do about it. The Overview, the bar and the browser tab title read the mission from
  one function (`mission.ts`: offline, down, loading, spend ceiling, needs you, failed, delivered, paused, parked, stalled,
  quiet, running), so they cannot disagree; a decision that holds one seat says so and does not claim the mission has stopped.
  Every view was rebuilt on shared primitives (page header, banner, empty and error states, copy buttons, one icon set) with a
  warm light and dark palette, and a type and spacing ramp the tests pin. There is a first-run welcome with three ways to start
  and a Projects page; a sign-in that says where the token is; a Designer with a seat list, a setup guide and a save bar that says
  what a restart does; a file reader with versions and comparisons. A view that crashes stays one view's failure (with a
  copyable report), and a tab left open across a host update is told to reload. The rules are in
  [docs/design-spec.md](docs/design-spec.md), and `npm run qa:console` runs the visual pass (every view, both themes, two widths,
  axe-core, console errors) and `npm run qa:walk` walks a person's session on the scripted demo.
- **`runtimes` in `GET /status`**: the runtimes the seats run on. The console words "Start the mission?" by it, so the shipped
  scripted demo no longer tells a visitor that agents "spend tokens".
- **`mesh_artifact_read` says where the artifact stands.** The result carries `status`, `version` and `owner` beside `canSettle`,
  on every page, so a seat reading a report to cite it learns that it is a draft, and whom to ask, from the read.

### Fixed

- A mission delivered in front of the person left **What shipped** saying "No files are recorded for this goal" until a reload: the
  Overview read the file list once, when it opened. It reads it again when an artifact event arrives, and the message count while
  the mission runs and once more when it stops.
- **`curule run`, `console` and `serve` (the README's quick start) had no live stream in the dashboard.** The page only opened an
  event stream for projects named by a registry, so on a server that runs one mesh it was a snapshot moved by the status poll. It
  now streams the mesh from the server's own `/events/stream`. Those servers also stopped showing the host's pages (Projects, Host
  settings) and asking for `/api/license`.
- The notices in the corner say what happened in a sentence. They were the event's own fields in lower case ("escalation opened:
  budget_exhausted (by explorer)", "budget exceeded: mission:goal-M44MV2BS003f3a104bda"); a decision now says what it holds (the mission,
  or one seat), a budget running out is announced once by its decision, and Start says who is starting and never claims success when no
  agent started.
- Creating the demo from the welcome page no longer leaves 404s and 409s in the console: a host's views wait for the project they would
  show while it starts.
- The Product page no longer requests a `package.json` that is not there (a 404 in the console on every visit); the Steps page no
  longer calls turns that wrote nothing "wasted"; the details panel's file reader no longer repeats versions and React keys; the top
  bar no longer says "No goal" beside a chip that says Starting; the quiet note no longer reads as if a running mission had not
  started.
- A seat that is about to end a turn without having called a single mesh tool is told, once and in the same turn, that the mesh is
  running and which tool reports what. After a `kill -9` and a restart the seventeenth run's QA and developer resumed sessions that
  carried the CLI's record that the mesh server had failed ("mesh bus unreachable: fetch failed"), did their work with their own
  tools and ended each turn on prose ("Awaiting mesh recovery", "Now I'll call the mesh operations:"); the mesh discarded four turns
  (QA's 41.5k tokens, the developer's three, 151k), nothing either found reached anyone, and the developer's first mesh call came
  10 min 52 s after the reopen, from the fresh session a rotation gave it. The reminder is a `Stop` hook, so the turn goes on in the
  same session and is billed once; it is given once per turn and never to a turn the mesh is interrupting or closing.
- The note to the owner of a patch that has just been approved names the call that moves it. It said "needs VERIFIED next, and only you
  can move it there", which was never so (any seat with `test.execute`, `security.review` or `implementation.approve` may take that
  rung) and which the seventeenth run's developer read as a verdict to wait for: two refused `mesh_approve` passes on its own patch, a
  review asked of a patch that was already approved, and 5 min 50 s to climb a rung that round 1's developer took in 30 s. The note now
  says `mesh_artifact_transition` with the artifact id and the rung, and that nothing else is needed, when the policy lets the owner make
  the move; otherwise it gives the policy's reason and, for a missing capability, the seats that may.
- A `package.json` created with no dependency in it is no longer announced as a dependency change. The first manifest of a project
  that has none (every cronlite run) woke the architect in most runs, 7.2k tokens in the seventeenth, and nothing came of it. A changed
  manifest, one that names a dependency (or workspaces) and the other manifest kinds are announced as before.

- A `mesh_done` in a turn that called `mesh_wait` and made nothing (no artifact, commit, merge, review request, verdict, task or
  decision) no longer completes the task its seat holds while a mandatory criterion is unmet. QA's verification task was completed on its
  first turn in each of the nine runs from the eighth (the sixteenth's: 21 s after the claim, "Standing by"), after a round of wording
  that did not hold. The reply says the task stays claimed; the seat's next `done` or `mesh_task_complete` completes it, and once every
  mandatory criterion is evidenced a `done` closes it as it always did.
- A completion the implementation gate refuses says who can lift it, and a seat that publishes a new version of an artifact is told which
  verdicts that dropped. The refusal named a token ("missing: qa.pass") and not who gives it or how; QA's pass had been dropped by its own
  new version of the report, nothing said so, and the sixteenth run's mission, with every criterion evidenced, sat 13 min 44 s: three
  refused completions, five nudges, an escalation that blamed "system state synchronization", until the operator named the call.
- The stall watchdog's cooldown no longer holds back the first nudge the acceptance needs. A nudge about a parked patch came 16 s before
  QA's report made the pm's acceptance possible, and the pm's nudge waited out the five minutes that nudge had started (4 min 37 s with
  nothing to wait for), as the thirteenth run's claimed task had already taught the cooldown for one other state.
- The verdict that brings a mission to the finish line says what still holds it open. The sixteenth run's pm accepted the last criterion
  with the developer's task still claimed, was told nothing, and broadcast MISSION_COMPLETE; the unread broadcast woke three seats for
  turns that did nothing (26.8k tokens).

- A turn the mesh cuts short is billed what the stream reported when the abort's own frame reads zero. A handover is ended by the mesh
  the moment its continuity record lands, the CLI answers that abort with a frame whose usage can read zero, and the ledger booked 0 tokens
  for six of the eleven handovers of the ninth to fifteenth Haiku runs (the fifteenth's developer: a call that wrote 14,826 and read 139,638
  tokens of cache). `curule usage`, the budgets and the cost estimate were short by that much; an interrupted or timed-out turn is read the
  same way.
- `mesh_done` says that it completes the task the seat holds, and QA's prompt says when to claim its verification task. QA claimed it and
  had it completed on its first turn in each of the eight runs from the eighth, with a summary that says it was waiting (23 of 46 task
  completions in those runs were made by `mesh_done`, which no description mentioned). The tool descriptions and `roles/qa.md` are wording;
  nothing refuses a `mesh_done`.
- QA is told what its verification has to cover: cases from the contract and not from the developer's tests, every member of an
  enumeration, forms in every place and combination, each rejection with its near-miss, and a report that lists what it ran (command and
  output) apart from what it did not (NOT TESTED). The fifteenth run's QA ran eleven CLI commands and eight library checks and listed every
  behaviour as verified; the library refused `JUL` and `WED` as Quartz syntax, as in six runs before it.
- A commit announces the manifest, login and permission changes it made, not the ones its branch already carried. The diff is cumulative,
  so a `package.json` created once woke the architect at every later commit (nine wakes in seven runs, for a project with no dependency).

- `curule status` on a mesh that is not running (what you get once `curule run` has exited) reads the event log through the same
  projections the server keeps. It used to print `[ACTIVE]` at 0% with no tokens line for a mission that was over, and about 2.4
  times the tokens each seat had spent (the fourteenth Haiku run: 825,740 spent, 2,019,225 shown). A line of the log it cannot
  apply is skipped and named on stderr.
- A merge of a patch that records no commit takes its owner's whole branch, and the reply now says so instead of calling the commits
  that came in "NOT part of this artifact". A second patch from a branch that merge already took is recorded as merged when its owner
  has nothing uncommitted and every file the patch lists is in the product as published; otherwise the refusal names what is wrong and
  does not send the owner to `mesh_commit` when `mesh_commit` would refuse. In the fourteenth run the developer's second patch sat
  `MERGEABLE` to the end with its file on `main`, after three refused merges and 7 turns of the tech lead.
- The stall watchdog, when only acceptances are unmet, wakes the seat that may accept before the merger of a patch parked on the merge
  ladder, and passes over a merger whose last nudge bought nothing. The acceptance came 5 min 22 s after the proof (13 s in the
  thirteenth run) because the first nudge went to the seat whose merge was being refused.
- An artifact id the mission does not hold is refused with the artifacts there are (newest first, five at most, with id, type, name,
  version and status), for every op that takes one. `approve` carried a hint that cost a call and a page; the other seven ops said
  only "unknown artifact".
- `curule budgets` aligns its columns to the longest key (a goal-and-seat key is 41 characters, a task's 60, and the table was a
  staircase), and `curule status` marks a goal line it cut at 60 characters with an ellipsis, at a word.
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
- `curule --help` and `curule -h` print the usage and exit 0. They answered "unknown command: --help" and exited 1, so a script that
  checked the command ran (the image's smoke test does) saw a failure; a command that does not exist still exits 1.
- A seat that passes the verification report it wrote now submits it with the pass. The report used to stay a draft, which is
  shown to nobody but its owner and is refused as evidence, so the seats that needed it spent minutes asking for a report that
  existed (the ninth Haiku run: six turns and four minutes). The pass is the owner's own transition under the same gates, taken
  only after every refusal a pass can meet; a pass on somebody else's draft submits nothing.
- A seat that may accept criteria is shown the submitted artifacts it could cite in its briefing, while a mandatory criterion
  that needs an acceptance is open. Until now only the stall watchdog's note named them, after three idle minutes.
- The closing report of `curule run` is printed after the turns still running have settled, so its `SPEND` line matches the ledger
  and `curule usage`. It was short by the final turn (2.2% to 2.6%) in every real run.
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
