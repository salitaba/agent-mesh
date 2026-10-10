# Changelog

What changed between versions, for whoever runs Curule. The format follows [Keep a Changelog](https://keepachangelog.com).
There is no supported downgrade: the event log is append-only and a newer build may append events an older one does
not know ([docs/operations.md](docs/operations.md#upgrade)). The fixes from the live Haiku runs (`NOTES-live-run-20260930-haiku.md`,
sections 1 to 26) are described there, run by run.

## Unreleased

### Added: the desktop app, which is the hosted app in a window of its own

- **`apps/desktop`: a Tauri 2 shell.** The window shows `app.curule.dev`; the dashboard is still deployed, so a change to it
  reaches the desktop the moment it is deployed, and there is nothing in the shell to rebuild when it changes. The window
  opens on a page of its own, which holds the address, asks whether the app answers and goes there — and stays, with a
  Retry and a link to the system browser, when it does not. Tauri and wry report a load that failed to nobody on any of the
  three platforms, which is why the question is asked by the page that is still there to ask it.
- **One window, and the desktop's own manners.** A second launch focuses the window that is there; the tray offers Show,
  Reload and Quit; the size and position are remembered. Anything that is not the app's own origin — a `target="_blank"`
  link, a sign-in flow that leaves `app.curule.dev` — opens in the system browser rather than in the window, and the
  capability file grants the bundled page the baseline and nothing else, with no remote address listed.
- `CURULE_DESKTOP_URL` points the window at a self-hosted control plane or a local run. A value that is not an http(s)
  address falls back to the hosted app rather than refusing to start.
- **The installers come from CI, and they are unsigned.** `.github/workflows/desktop.yml` builds an AppImage and a deb, a
  dmg for each Mac architecture and the Windows NSIS and msi installers, and attaches them to a draft release cut from a
  `desktop-v*` tag. The crate has not been compiled on the machine it was written on — the first compile is CI's, and it
  failed the first time on one missing `?` — and no signing secret exists yet, so macOS and Windows will warn about the
  download until they are added. See [apps/desktop/README.md](apps/desktop/README.md), including what bundling the
  dashboard's own assets into the installer would take (not done here).
- Tests: `tests/desktop/desktop-shell.test.ts` — the window the Rust builds against the window the config declares, every
  icon on disk, the capability grant, the page's own elements, the workflow's four targets, and that nothing in the app
  carries a credential or a remote IPC grant.

### Added: Curule Cloud, hosting only

- **Hosting-only plans.** A plan with `byok: true` sells no model usage: no included usage, tiers or top-ups, and a payment grants no
  credit. When every plan is `byok` the control plane needs no `gateway:` section (a configured one that nothing uses is a warning).
- **The customer's own model key.** `POST /api/workspaces/:id/model-key` (and `/delete`) store, replace and remove it, with a form
  on the account page. It is write-only, sealed at rest (AES-256-GCM, derived from `CONTROL_SECRET`, bound to the workspace), not
  in the control log, any response or any seat's shell, and rate limited. A workspace host is given it as `CURULE_MODEL_PROVIDER`,
  `CURULE_MODEL_NAME`, `CURULE_MODEL_BASE_URL` and `CURULE_MODEL_KEY` ([docs/runtime-native.md](docs/runtime-native.md#hosted-workspaces)).

### Changed: what a person reads and presses

A pass over every page a person meets: the console, the account pages and the marketing site. Nothing here changes an API, an
event type or what a number means.

- **The console says what happened.** An event's line names who did what ("pm joined the team as product-manager", "developer
  saved a note: architecture", "criterion architecture-approved met") instead of repeating its own label. One function
  (`eventLine` in `eventmodel.ts`) decides it, so Overview's *Just happened*, the Events list and its detail, the agent
  drawer and the step drawer read the same. A drawer prints no kernel code (`THINKING → IDLE`) or bare id where a word or a name
  exists, a kernel notice carries one warning mark, and a count agrees with its noun at one ("1 approval").
- **A parked team says it is ready.** A seat that has not run reads "Ready" (or "Never ran" once the mission is over), not
  "Starting up", and the badge, the Graph and the card agree. What shipped shows a file's place in the product repository, not
  where the mesh stores it, and the Help panel names the button a parked console really shows (**Start mission**).
- **The scheduler's note is singular at one.** A wake for one waiting message says "1 message waiting in your mailbox."
  (it said "1 messages"). The two tests that pinned the old sentence were updated.
- **Controls do what a person expects.** In the command palette the top row is the best match (label starts with the
  words, then a word in the label, then the label, then keywords) and a mouse resting over the list no longer picks the row
  that Enter runs. Notices no longer cover the button the person is about to press (on a phone they sit under the top bar),
  and none repeats the page in front of them. The Message panel addresses seats with a tap and names each kind of message
  in words, and the feeds' hold button says **Pause updates** so it is not read as the mission's own Pause.
- **A failed read is not an empty answer.** The Designer used to open the Triad template, with "No mesh.yaml was found", on a
  project that was only starting or stopped, and never read again; saving would have written a new file over the person's mesh.
  A project that is not running is now a failed load with Retry, and the page reads the file when the project is up. While a
  project starts, the Overview shows dashes and "Loading this page…" instead of stating "no checks" and "Could not load recent
  work", and no view area is left blank.
- **The account pages.** Each page's heading says what it is now ("Check your email", "Password changed"); a password can be
  shown; the button says what it is doing while it works; the first field is focused on a device with a pointer (not on a phone,
  where the keyboard would cover the page); a person who did not get the sign-up email is told how to have it sent again. The
  top-up field names its currency. The front page says what the service sells: a hosting-only plan no longer promises
  model usage it does not sell. The terms and the privacy notice have a margin on a phone, and an address the service does
  not have shows a page (with a way back), not a line of JSON.
- **The marketing site.** The long pages (pricing, security, legal) keep an *On this page* bar under the header, one row at
  every width, and mark the section being read (not by colour alone). Every page has a *Back to top* button once the reader is
  two screens down; it rests above the footer, so it never covers a footer link. The documentation page says what a title
  opens (not how the page sets its links) and has a filter over its documents. On a phone a comparison table keeps its corner
  and shows that it scrolls, a long command shows that it goes on, a card that a link points at is marked, and the menu closes
  on a touch elsewhere and when Tab leaves it. Without JavaScript every page still reads and works as it did: the bar is a row
  of links, and the filter and the button are not there.

### Changed: the first ten minutes, being told, and the site's first screen

A second pass over the same pages, judged by what a person can get done: a visitor choosing a way in, a new customer reaching
their first mission, an operator who leaves a mission running. What each surface does now:

- **The marketing site says what Curule is in its first screen.** A statement, a subhead of about thirty words, three proof points
  the page argues further down, one action that leads (Get started while Curule Cloud is open, Try the demo while it is not) and the
  product's picture beside the text. The home and pricing pages open with the same choice: *Curule Cloud* (a flat monthly plan; you
  bring your own model key) or *the software you run* (the free Community plan, paid licences). The documentation page starts with
  four cards by goal; the security page with "At a glance"; the contact page says which address is for what, and one tap copies it;
  the cards that were text only have marks; the 404 page lists the pages people come for. The FAQ no longer says Curule Cloud
  supplies the models (on a hosting-only plan you bring your own key).
- **The site's pages are written in the state Curule Cloud is in.** The Cloud half of every page used to be switched on by the script
  after the first paint, so the pricing page jumped while it loaded (a layout shift of 0.34 on a phone, 0.14 on a desktop, measured in
  Chrome) and a visitor with no script, a search engine or a link preview read "Not today" about a service that is open. `npm run
  site:domain -- ... --cloud-url <url>|none` now writes the state into every page (`scripts/site-cloud-state.mjs`), `none` gives the
  pages back exactly, and `npm run site:check` fails on a page written for the other state. The shift is 0.000 in every load measured.
- **A page and its stylesheet can no longer be a stale pair.** A visitor whose browser had kept the previous stylesheet (a browser may
  keep a file for ten minutes without asking the host, and the page and the stylesheet are kept on their own clocks) was shown the
  cards' marks as black shapes as wide as the card, because the older stylesheet had no rule for them. A mark now carries its own size,
  fill and stroke, so it is right even then. Every page names the stylesheet and the scripts by a fingerprint of the file
  (`assets/site.css?v=9af9e701cf`), so a new page asks for the new files at once: `node scripts/site-chrome.mjs` writes it (run it after
  editing `assets/site.css`, `site.js` or `pricing.js`; its `--check`, and a test, fail until it has), and `site:domain` writes the
  script's. *Back to top* is shown when a reader two screens down scrolls up, or reaches the end, and no longer sits on the ends of
  the lines being read on a phone. Publish the site again to apply it; a browser that holds the old page needs one reload. The
  account pages had the same weakness in a smaller form (their script and stylesheet were kept for five minutes, so right after an
  upgrade a customer could be given the new page and the old script): they are now sent with an `ETag` and asked about each time,
  which costs a `304` and no body.
- **A customer's account knows where they are.** The account page opens with one next step (choose a plan; add your model key;
  make your first workspace; open it) and a stepper, and shows what is theirs at that stage: Balance and Usage only on a plan that
  sells usage, the plan once with "Change plan" behind a button, Delete behind "More" (still needing the typed name), the password
  under Settings. Each workspace is a card that says how it is in a sentence, holds its own model key (kept: provider, model, date,
  Replace, Remove; none: the form, open) and can open itself when it is ready ("Open it when it is ready", off by default). A workspace
  stopped for a missing payment says that a payment starts it instead of offering a Resume the service refuses; a late payment keeps
  Open beside "Update payment details".
- **"Check your email" helps.** After sign-up the page names the address and offers **Resend the email** (a visible 60-second wait)
  and **Use another address**; the page for a link that did not work asks for a new one. The plans page opens with how it works
  and each plan is a ticked list with one action. Every control on the account pages is 44 px on a phone.
- **A hosted workspace opens on "Welcome to your workspace".** A customer who pressed Open used to meet three folder cards in the
  self-hoster's words. The welcome now asks what the team should do (a goal field, three examples, "Create the team"), the scripted
  demo is a quiet second way, and folders and facts are under Details. The team is made with the goal, so the mission begins with it.
  A mission whose goal is still the placeholder is not offered Start: the top bar and the Overview say "Write the goal first" and take
  the person to the goal. On a hosting-only plan whose model key is missing the welcome, the Designer and the Start dialog say so and
  link to the account page, and the page notices the key by itself.
- **The Designer's first minute.** The guide says what is done, what is now and what is next; a team made from the welcome opens on its next
  step; the assistant opens on a question with two ways to begin, and when it cannot answer it says what happened, that the draft is
  unchanged and what to do, instead of a raw error. On a phone the buttons on the way to a first team and every confirm dialog are 44 px.
- **An operator who leaves a mission is told.** The tab's icon and title say when a decision waits (the mission is paused until it is
  answered), when the mission is delivered and when it stopped on its own, in shapes and not only colour. A desktop notification, if
  you ask for one ("Notify me when the mission needs me", on Needs you and in the "..." menu), says the same, only while the page is
  hidden. It works only while the console is open in a browser tab: there is no push, no e-mail and no service worker, and nothing is
  sent to anyone else.
- **Reading a running mission.** The Overview's *Right now* says who is in a turn and for how long, what is next, how many requests are
  open, which seats crashed or are blocked and whether anything needs you. A delivered mission offers **Open the files**, **Reopen with
  feedback**, what it cost and Replay. The Graph can be used: point at a seat to see only its lines, hide a kind of line, open a link's
  messages in Events; it is readable on a tablet and in a short window and scrolls, and says so, on a phone. The file reader leads with
  the file, and where the mesh stores it is under Details. Answering a decision on a phone has fingertip-sized controls, a 16 px
  field, a Send key and a way back to the mission.
- **The account e-mails** name the product in their subject, and the late-payment and ended-subscription mails say how many days
  (the service's own grace and retention periods) and link to the account page.
- **For the operator:** `curule-cloud trial --hosting-only` runs the service as it is sold (the customer's own model key, a stand-in
  that answers one sentence); `POST /api/verify/resend` (always answers the same, mails only an unconfirmed address, shares the sign-up's
  limits); `POST /api/projects` accepts a `goal` for the default team; `GET /api/templates` says when the host is a hosted workspace
  (`hosted.accountUrl`), and a workspace's host is given `CURULE_ACCOUNT_URL`.
- Known gaps: there is no "download everything" for a workspace (a file can be downloaded from its reader; a whole-workspace archive
  needs a host endpoint); the Overview cannot say who waits for whom (`/status` carries only a count of open requests); a plan's
  "Get" buttons on the site are a mail link, which opens nothing for a visitor who uses webmail (the contact page has the address
  with a Copy button).

### Changed: the look of every page, on one kit

A pass over how every page looks and feels to use, on the three surfaces: the marketing site, the Curule Cloud account pages
and the console. Nothing here changes an API, an event type, what a number means or what a page says; where a sentence moved,
a test pins it.

- **One set of values.** The colour roles, the five steps of elevation, the radii, the tracking that goes with each size of text
  and the motion are written once (`scripts/kit-tokens.mjs`), generated into the three stylesheets and `brand/kit.css`, and
  checked by `npm run brand:check` and a test, which also hold every text pair to its contrast in both themes
  ([docs/brand.md](docs/brand.md#the-ui-kit)).
- **The marketing site.** A card at rest, a card that can be pressed and what floats sit at different heights, and in the dark
  scheme the height shows as a lighter surface and a lit top edge where the shadow used to vanish. Figures are tabular, headings
  tight and balanced, a button has a pressed state, the product tabs and the billing switch are one control with a thumb that
  slides (radio inputs: it works without the script), and a code block has a header row with a Copy button. The first screen is
  composed: the product in a raised frame on the page's glow and ruled paper, the claims ruled under it. "Who runs it" is a
  decision between two cards, "Why it is not a group chat" four reasons each with a small drawing of its idea (a gate, a ledger
  with a playhead, budgets with a ceiling, a container), a mission is three steps on one rail, plans are cards whose rows line
  up, and the page closes on a dark band. The header becomes a layer with a line and a blur once the page has moved, and what is
  below the first screen rises once as it arrives, for a visitor who allows motion. Every page still reads and works without the
  script, and prints whole with its buttons as black text.
- **The account pages.** The sign-in family is a form beside a calm panel from 900 px (three statements, each already said on
  the front page or in the terms), with a drawn checkbox, a Show that has an eye, and a bar that says only that a new password
  has the ten characters asked for. The account opens on one card (what it waits for, with the steps while a workspace starts),
  then three tiles (workspaces, plan, balance) and a list of its sections that stays under the header and marks where you are.
  A workspace shows its state, its one action large, its address as a band with Copy, and a bar of three steps while it starts;
  the balance is a large figure with a meter for what is left of the plan's usage; usage is a table with a bar for each day, or
  a sentence that there is nothing yet; Settings are closed until opened. The first read shows a skeleton of the page's shape,
  so nothing jumps. Terms and privacy have a contents list beside them. Windows High Contrast keeps ticks, status dots and icons.
- **The console's shell and shared controls.** Page titles are larger and figures are set in the interface font (tabular; monospace
  is for ids, paths and code). Buttons, badges, menus, dialogs, toasts and the command palette share one set of shapes, shadows and
  motion. An icon button has a tooltip that says what it does and the key for it; the project tabs show each project's state; the
  palette groups its results, shows key hints and lists *Go to Overview* first; the top bar reads out the agents working and the
  token budget and is one row at every width (at a tablet's width it wrapped to two). Focus rings, reduced motion and Windows High
  Contrast are honoured throughout. Every component is drawn in every state on a gallery page, `/kit.html` (on a host it needs the
  sign-in; `npm run dev:ui` serves it without), and a test fails for one that is not.
- **The front pages.** Overview: one mark and one sentence for the state, one button, four figures ruled under it (checks, time,
  tokens, seats), *Right now* in at most three lines, what shipped as file cards, the latest work and the log as timelines.
  Needs you: the question first, what happens if nobody answers, then the answer; a notice holds nothing and says no more. Agents:
  cards that lead with the seat and what it is doing, seats in a turn lit, and nine seats or more can be read as rows. Projects,
  Host settings, sign-in, the welcome and the New project dialog follow. A project whose process stopped, or a server that stopped
  answering, marks its figures *Last known state*. The Overview's *Right now*, its pill and the count on Latest work follow the
  status where it is newer than the list of steps, so they no longer disagree about how many agents are working. On a phone
  everything pressed is 44 px tall and a field is 16 px, so the page does not zoom.
- **The working pages.** Steps draws its timeline: bars in the outcome's colour, pointing at a bar says which turn it is and picks
  its row (and the other way round), and a mission that is finished, paused or failed opens on a *Fit* window, first turn to last,
  where it used to open on a sliver at the edge of the last five minutes. Events reads as a ledger with one pane for each event:
  an alert is a red tile and rail, routine runs fold into one row, and a row keeps the clock time in your zone (said once above
  the list), not how long ago, so rows can be compared and quoted. The Graph draws a seat as a disc in its role colour inside a ring for its state. Files shows
  what a file is before it is read and colours a patch. Product, Cost, Tool gates, the Designer and the step and agent panels are
  redrawn from the same parts. A seat is one colour on every page.
- **Words that moved** (structure, not claims): the Steps captions read "Turns done", "Tokens" and "No output"; the Files *Any
  status* select is a row of buttons with a count each (All, Approved, Rework, Drafts), the full names in their tooltips; the Cost
  page's "240k left, 85 turns, 7 agents" is labelled cells, and a mission with no limit says "Limit: none"; on Tool gates *Unlock
  Bash* is *Unlock* on the Bash row (the control's name still says the tool); a card's title is a sentence on every page, where
  some were capitals.
- **Weight.** The console's startup stylesheet is 208 KB minified (39 KB gzipped); it was 165 KB (30 KB). The site's is 49.6 KB
  (11.7 KB gzipped, was 48.2 KB and 10.5 KB) and the account pages' 38 KB, written to be read (9.6 KB gzipped, was 21 KB and
  5.6 KB); their scripts went from 91 to 102 KB and from 19 to 23 KB. No font, image or remote request was added to any of them.
- **Pictures.** The product pictures on the home page and the demo recording in the README are taken again from the new console, and
  each picture's description says only what the picture shows.

Also:

- **Windows High Contrast.** A bar, a segment or a dot that is only a background disappears there, so the Steps timeline, the Cost
  strip and its bars, the step panel's phase bars, ticks, switch tracks and meter fills are drawn again in the system's colours,
  an outcome is told by how its mark is filled and not only by colour, and a test fails for a drawn mark that has no such rule.
  This was tried with the browser's emulation, not on Windows. On the account pages a ticked box, every icon and every status
  dot are drawn in it too.
- **Reachable by keyboard.** A wide table in a document is a named region a keyboard can focus and scroll, and a dialog whose body
  scrolls is a tab stop, so what is below its fold can be reached. A drawer's title row is not a second banner landmark, and a
  stylesheet that reads a custom property nothing sets (a radius that does not exist, which draws as no radius and fails no
  other check) now fails a test.
- **Print.** A printed page no longer shows a primary button as white text on white paper, nor the closing band's buttons: a button
  prints as black text in a black line.

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
- **`curule-cloud egress`, and a workspace at an address of its own.** The proxy a workspace's container is told to send what leaves
  its network through (`HTTPS_PROXY`) was not shipped: the operator was left to find one that does what the control plane assumes.
  `npm run cloud -- egress --config egress.yaml` carries HTTPS tunnels to the names the operator lists, on the ports listed, and to
  nothing else: no plain http, no address given as digits, no name that resolves to an address that is not public (the address
  that was checked is the one connected to), only from the networks named, with limits on tunnels, idle time and life. And
  `provisioner.subnet` in `control.yaml` makes the container provisioner run each workspace at a fixed address of the workspace
  network and reach it there, so that a control plane that runs on the machine, and not on the network, can find it (a container's
  name is resolved only on its own network). `preflight` compares the subnet with the network's own. Neither has met a real
  container engine. See [docs/cloud-control-plane.md](docs/cloud-control-plane.md#provisioners).
- **`workspaces.allow_same_site`, and a placeholder price id that stops a start.** A workspace domain under the app's registrable
  domain is still refused, and the refusal now names the way out: an operator with one domain can write `allow_same_site: true`, which
  makes it a warning that is printed every time and says what stands in the way and what does not. With hosted checkout, a plan whose
  `provider_price_id` still says `REPLACE` is refused in production, as a leftover `TODO(owner)` is.
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

- **A mission paused and resumed could stop with work owed, and the scripted demo did so every time four console walks ran at once.**
  A pause landed between the ops of a seat's turn (a lease left held, a patch never announced), or while a seat was thinking (its ops
  stopped, its mail marked delivered, nothing to wake it at resume), or while an event a seat was waiting for arrived (the event left
  nothing behind). Resume woke only seats that held mail, a task or a wait, so the seat was never woken again; the stall watchdog's
  manager would have noticed minutes later, and the demo's scripted manager only reports "turn done", so it stopped at 2 of 7 checks
  (found by the console's walk). A pause now waits for the op loops that have begun (milliseconds; 10 s at most); a turn whose model
  answers into a paused mission is cut whole, recorded as `turn.discarded` (`paused`, with its tokens), its mail stays owed and the
  seat is told; and resume wakes each seat the pause took a turn or an event from, once, with the reason it was first woken for and a
  note that says what did not run.
- **A turn the shutdown stopped, whose call had reported no usage, recorded no tokens.** The twentieth run's mission ended under a
  developer turn whose backend the shutdown tore down 24,497 tokens in, and the ledger, the end-of-run report and the console's
  cost view had none of them ("spend unmeasured"). The running count the turn's stream had reached is recorded as `tokens` on
  `turn.discarded` with `partial: true`, and the seat's note, the event line and the console say "at least N tokens". A stop that
  reports its own usage is unchanged, and a process killed outright still leaves nothing to record.
- **The wake for mail nothing else woke a seat for told it nothing, and the turn it bought was reported as idle work.** The note
  now lists what is waiting by kind and sender, says whether any of it asks something of the seat (an ask, work handed over, the
  operator's mail, anything classed `interrupt`) and, when none does, that `mesh_wait` is the ending that fits (`mesh_done` closes
  a task the seat holds). A turn woken that way that only waited or finished is recorded as "read the mail that had been waiting"
  and carries no warning, where the twentieth run's QA seat had its own summary replaced by "no work was produced … the watchdog
  will rotate to another driver" and carried that line through its next four turns.
- **QA's prompt asks for a list it writes itself, and the developer's for the rule behind a failure.** With no operator list, QA
  writes one from the contract before it runs anything (numbered commands, each with the output it must print: every rejection
  and its near-miss, every example, every enumeration member, every "every X must Y", the `RequirementsDoc`'s MUSTs, the
  architecture's constraints, and the wrong spellings of each kind of value) and reports each line as the operator's list is
  reported. A developer who is sent a failure extends it into the places the same rule applies before it asks for review. The
  twentieth run's QA ran the developer's 64 tests and six CLI commands again, and its reopen fix covered `JUL` and not `JUN-JUL`.
  Prompts, not enforcement: the next run is the check.
- **A reply that named the message under `replyTo` was refused as "unknown messageId".** `mesh_reply`, `mesh_respond`,
  `mesh_discharge` and `mesh_withdraw` take `messageId`, and a seat answering a message writes `replyTo` (what the message calls
  it, and what `mesh_send` names its own); the refusal named no key and quoted no value. They read `replyTo` as the id when
  `messageId` is absent, a call with neither is refused by name with the keys it carried, and an id that is no message is quoted
  back.
- **The owner of a ruled-on artifact is told when the ruling seat's turn ends, not at the verdict.** The seat with the power to rule
  usually has the power to take a patch on, and did, in the same turn; the owner was woken with "it needs VERIFIED next, and you
  can move it" for a step that was taken or about to be (two turns of 9.4k and 15.1k tokens in one run, and the chatter they
  started). A patch the turn took on is not announced; one it left where the verdict put it is, as before. A verdict given outside
  a turn (the operator's) still wakes the owner at once.
- **The run report printed an operator's whole reopen as one criterion** (49 of a run's 127 lines). A criterion longer than 240
  characters is one line, its start and a count of what was left out; the report's data keeps it whole.
- **The reopen dialog took one line.** It is a field of several lines now, and says that a list of checks (each a command and the
  output it must print) is what gets every one run: QA ran all nineteen of a list, and one example of each problem in a
  description. The QA, pm and developer prompts say what to do with such a list, and that a product's licence and author are not the
  developer's to choose (every one of the last six runs' products declared `"license": "MIT"`). QA's prompt also takes the
  architecture's testable constraints as its checklist, a command for each, run in the turn: the nineteenth run's architect wrote 35
  of them and QA never opened the document (it ran the developer's 51 tests and ten CLI commands, and the library refused `*` in a
  list, which the constraints list as a valid item).
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
