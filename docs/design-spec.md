# Console design spec

The bar for "the UI is good". Every claim in a review should be checkable against
one of the numbered rules below. If a rule is wrong, change the rule — not the UI
in isolation, or the two drift apart again.

Status: **in force**. It was written from the code and then checked against
rendered screens: every view, in both themes, at 1440, 820 and 390 pixels wide, with
axe-core and a capture of console errors (§7, `npm run qa:console`). The numbers in
§2 to §4 are pinned by tests (`tests/build/console-palette.test.ts`,
`tests/build/icons.test.ts`, `tests/dashboard/type-ramp.test.ts`, `tests/dashboard/css-vars.test.ts`); the
primitives' promises to a keyboard and a screen reader by `tests/dashboard/primitives-a11y.test.ts`, and what Windows
High Contrast would lose by `tests/dashboard/forced-colors.test.ts` (§6b); the rest is convention and review.

The look itself (surfaces, depth, type, shape, motion, states) is the UI kit's, written once for the
site, the account pages and the console in [brand.md](brand.md#the-ui-kit). Every shared primitive
is drawn in every state, in both themes, on one page: `/kit.html` of the console build (`npm run dev:ui`
serves it without a sign-in; on a host it needs one). A primitive added to `components.tsx` that is not
drawn there fails `tests/dashboard/kit-gallery.test.ts`.

---

## 0. What this product is

A dense **operations console** for a running multi-agent organisation: one operator
watching 13 views of an event-sourced mission (overview, needs you, agents, steps,
events, files, product, cost, graph, designer, tool gates, and, on a host,
projects and host settings). Optimise for **scanability under load and trust**,
not for delight. Four consequences decide most arguments:

- **Density is a feature.** Do not "breathe" a working console into a marketing
  page. Whitespace must earn its place.
- **Two themes are a contract, not a skin.** Both are first-class and neither is a
  filter over the other. The console follows the system setting until the person
  chooses one.
- **One reading of the mission.** The top bar, the Overview and the browser tab
  say the same thing about the mission, because they read it from one function
  (`mission.ts`, §6a). A page that works out its own answer will, sooner or later,
  disagree with the bar.
- **The product speaks plainly.** Sentences say what is true and what to do next;
  the voice rules are in [brand.md](brand.md). A word that accuses ("wasted"),
  flatters or alarms without a fact behind it is a defect.

There are two kinds of server behind the same page. A **host** (`curule host`) holds
a registry of projects and has pages of its own (Projects, Host settings). A
**single-mesh server** (`curule run`, `console`, `serve`) runs one mesh, has no
registry and answers none of the host's routes, so it shows neither page, streams
its one mesh from its own `/events/stream`, and explains an address that names a
host page (`navmodel.ts`).

## 1. Definition of done (the checklist)

A view is "best" only when **all** hold, in both themes and at 390 / 768 / 1280:

1. **States** — it has, and shows correctly: `loading`, `empty`, `error`,
   `partial` (some data), and `dense` (long/large content). No naked spinners,
   no empty box with no explanation.
2. **Keyboard** — every interactive control is reachable in visual order, has a
   visible `:focus-visible` ring, and Escape/Enter/Tab do what a user expects.
3. **Contrast** — body text ≥ 4.5:1, control boundaries ≥ 3:1, on the surface the
   element actually sits on (not just on white).
4. **Motion** — every non-essential animation is suppressed under
   `prefers-reduced-motion: reduce`.
5. **No bypass** — the view uses tokens and shared classes; it introduces no raw
   hex colour and no off-ramp `px` for type or rhythm (see §3, §4).
6. **Overflow** — long names, long paths, and 10k-row lists are handled by
   truncation or virtualisation, never by a horizontal page scrollbar.
7. **Honesty** — a number that is stale, partial, or estimated is labelled as
   such. The console reports the system; it must not flatter it.
8. **Live** — what is on screen moves when the mission moves. A page that reads once
   when it opens is a snapshot: it said "No files are recorded" at the moment a
   mission was delivered. Each view names the signal that makes it read again.
9. **Failure stays local** — a view that throws loses that view, not the console:
   the shell, the other views and the mission carry on, and the error can be copied
   (`ViewBoundary`). A view whose file is gone after a host update says the console
   was updated and offers Reload.

---

## 2. Colour

Canonical tokens live in `:root` (`styles.css`) with a light override in
`[data-theme="light"]`. The neutrals (paper, panel, ink, muted, line) and the dark
accent are the brand's own (`brand/tokens.css`, [brand.md](brand.md)), so the site
and the product read as one family; the console adds the surfaces and the
semantic colours a dense tool needs. `tests/build/console-palette.test.ts`
recomputes every contrast pair in this section for both themes and pins the
shared neutrals, so a value nudged by eye fails there and not on a user's screen.

| Group | Tokens |
|---|---|
| Surfaces | `--bg`, `--bg-2`, `--panel`, `--panel-2`, `--drawer`, `--raised`, `--sunken` |
| Lines | `--line`, `--line-strong`, `--line-control` |
| Text | `--text`, `--text-dim`, `--muted` |
| Semantic | `--accent`, `--accent-2`, `--ok`, `--warn`, `--bad`, `--rej`, `--info` |
| Text-on-fill | `--text-on-accent`, `--text-on-hot` |
| Identity | `--role-*`, `--phase-prep`, `--phase-wait` |

Rules:

- **Text must never be a raw hex and never `--accent` on `--bg`** without a
  measured ratio. `--accent` is a *fill* colour; it fails as text on dark.
- **A chip tinted with its own hue** (`color-mix(in srgb, <token> N%, transparent)`
  — `.pill`, `.verdict`, `.bchip`, `.op-*`, `.avatar.tinted`) must clear 4.5:1 on
  the **darkest** surface it can land on. The light palette is derived to that
  target ("14% self-tint over `--sunken`"); re-derive the same way before editing
  any semantic value by eye.
- **`--line-control` is the >=3:1 boundary** for inputs. `--line` / `--line-strong`
  are decorative and must not be the only edge of a control.
- **`color-scheme`** must be set per theme (done) so native widgets follow.
- **Status is never colour alone.** A status colour comes with a dot, an icon or a word, so that it reads
  in Windows High Contrast and to a person who does not see the colour.
- **A colour is a name.** A seat has one colour (`agentColor(role)`, set as `--tint` on whatever draws the
  seat) and it is the same one on the avatar, the seat's bar in the Cost strip, its disc in the Graph and
  its rail in the Designer. A seat colour is not used for anything else, and a seat is not drawn in a colour
  that is not its own.

---

## 3. Typography

One ramp. **Every** `font-size` resolves to one of these ten steps, and a test
(`tests/dashboard/type-ramp.test.ts`, which names the file, the rule and the size) fails on one that
does not:

```
11  12  13  14  15  16  18  20  24  30
```

The floor is 11 px (a micro-label in capitals) and body text is 15 px; metadata is
12 px. The ramp used to start at 10 px, which was legible on a developer's monitor
and not on a laptop across a desk, so every size from 10 to 14 moved up one step.

Tier tokens (weight + size + line-height + family, so one rule = one tier):

| Token | Meaning |
|---|---|
| `--tx-page` | view title (`h2`), 24 px at weight 650 |
| `--tx-title` | the title of a card, a dialog or the sign-in page, 20 px |
| `--tx-section` | uppercase group header |
| `--tx-label` | uppercase micro-label (nav, chips) |
| `--tx-value` | primary value / body |
| `--tx-meta` | secondary / metadata |

Rules:

- No half-pixel sizes. No tenth size. Need a new step → add a token and a reason,
  or use the nearest existing tier.
- Colour is **not** part of a tier (pair with `.muted`).
- **Figures are tabular and set in the sans at weight 650** (`.kpi`, `.fig`, `.stat`, the top bar's
  readout, every big number a view draws). Monospace is for ids, paths, code and JSON only.
- Headings are balanced (`text-wrap: balance`) and tight (`--k-track-title`); a small label in capitals
  uses the kit's one tracking (`--k-track-caps`).
- **A card's title is a sentence**: `.card h3` is weight 600 at 15 px, tight, in the text colour, on every page and in
  every panel. The capital caption (`--tx-section`) names a group of rows inside a card or the head of a column,
  never the card. Two kinds of heading on one screen read as two products, and the console used to have both.
- **Heading order is semantic**: `h1`(app) → `h2`(view) → `h3`(section). Never
  skip a level for visual size.

---

## 4. Spacing, shape, elevation

```
--s0 2  --s1 4  --s1-5 6  --s2 8  --s2-5 10  --s3 12  --s3-5 14  --s4 16  --s5 20  --s6 28
--r-sm 6  --r 10  --r-lg 14  --r-xl 20    (the kit's: --k-r-sm, -md, -lg, -xl; and the pill, 999)
```

Rules:

- Rhythm (padding, margin, gap) uses `--s*`. Raw `px` is allowed **only** when
  optical-compensating a border or a glyph (e.g. `1.5px` ring, `padding: 0 0 6px`
  to centre a `3px`-bordered box) — and should say why in a comment.
- Radii are the four tokens and the pill only.
- **Depth is information, in five rungs** (the kit's `--k-shadow-1` to `5`). Rung 1 is a card at rest (in the
  dark scheme it also has a lit top edge, `--k-hl`, because a shadow on black shows nothing); rung 2 is a card
  that can be pressed, on hover; rung 3 is what floats (a menu, a toast, a tooltip); rung 4 is a dialog or a
  drawer (`--shadow`); rung 5 belongs to the site's product frame. Text that is only text stays flat.
- **The view sheets load before `styles.css`**, so at equal specificity the shared rule wins. A view that changes a
  shared rule names one more class than the rule does (`.my-view .card h3`, not `.card h3`); it does not reach for
  `!important`.
- Fixed/stuck layers use the `--z-*` ladder (a tooltip, `--z-tip`, is above whatever its control sits in); never a bare `z-index`. On a narrow screen the notices lie over the top of the view
  (`--z-notice`: above the page and its bars, under every menu, panel and dialog) instead of at the foot of the screen, where they
  sat on the button a person was about to press.

---

## 5. Breakpoints

Not tokens — CSS cannot read `var()` inside `@media`. The ladder is enforced by
convention (`styles.css` header):

```
1280  compact topbar        900  dense grids stack
1100  two-up grids collapse  800  sidebar → off-canvas drawer   (JS: NARROW)
760   step lanes compress    620  phone — topbar collapses      (JS: PHONE)
560   minimum supported      640  legacy stray → converge on 620
```

`801` is the deliberate complement of `800`. Any new media query must pick from
this list. `860` is the one remaining stray.

---

## 6. Components

Shared primitives in `components.tsx` (and `ui/*`, which it re-exports) are the **only** source of these shapes. A
view that re-implements one with inline styles is a bug against this spec (§1.5). Each is drawn in every state on the
gallery, `/kit.html`, and `tests/dashboard/kit-gallery.test.ts` fails for one that is not.

| Primitive | For |
|---|---|
| `Button`, `IconButton`, `Menu` | Every control. `Button` has the variants `primary`, `soft`, `small`, `ghost`, `linklike` and `banner-act`, a `danger` tone, `loading` (`aria-busy`, a spinner where the icon was, and a press does nothing until it ends) and `size="lg"`, the 44 px one for a form's one button; an `icon` is decoration and the label names the control. `IconButton` is 36 px square, needs a `label`, and says whether what it opened is open (`pressed`, `expanded`, `controls`, `haspopup`). A `Menu` item has an icon and a key hint, and can be `danger` or set apart by a rule. |
| `Tooltip`, `Kbd` | What an icon button is called and the key that does it: shown after 400 ms of hover and at once on keyboard focus, `role="tooltip"`, described-by, hoverable, closed by Escape, never on touch, drawn in a portal so nothing clips it (and warm for 400 ms after one closes). `Kbd` writes a chord for the platform: Cmd on a Mac, Ctrl elsewhere. Leave `title=` off an icon button: the tooltip is its name. |
| `Field`, `Input`, `Select`, `TextArea`, `SearchField`, `Checkbox`, `Radio`, `Switch` | A `Field` wraps one control and wires its label, hint and error (`aria-describedby`, `aria-invalid`); give the control no `id`. `SearchField` is the search box: a label, the key that focuses it, a clear button. `Checkbox`, `Radio` and `Switch` take a `label` and a `hint`. Each owns its focus ring, and a field is 16 px on a phone. |
| `Tabs`, `TabPanel`, `Segmented` | Tabs have a panel; `Segmented` is a choice or a filter with none, a trough with a raised thumb. |
| `Pill`, `Chip`, `StatusPill`, `LifecyclePill`, `OutcomePill` | A status in one recipe: a 14 % tint of its tone, a 24 % edge and a dot, so it is never colour alone (§2). The mission chip, the banner and the toast use the same recipe. |
| `Card`, `IconTile`, `Stat` | A card at rest is on elevation rung 1; `interactive` lifts it to rung 2 on hover. `IconTile` is the mark at the head of a card, a row or an empty state: 28, 40 or 48 px on the ground of a tone (`ok`, `warn`, `bad`, `info`, `neutral`, or the accent when none is given); `live` breathes a ring for something running now. `Stat` is a caption in capitals, a figure (tabular, 650), a unit and one line under it. |
| `Progress`, `Sparkline`, `Ring` | A quantity as a drawing, each named for a screen reader with its value in words: a bar (with a tone), a line of recent values, a ring of one or several slices. Their arithmetic is in `ui/chart-model.ts`, with its own test. |
| `PageHeader` | The row every view opens with: the title, a status chip, the page's actions, and one line saying what the page is for. |
| `Banner` | One notice in one shape: an icon, a sentence in bold, optional detail, the actions that answer it. `bad` is announced at once (`role="alert"`), the rest politely. On a phone its actions go under its words. |
| `EmptyState`, `ErrorState`, `Skeleton`, `SkeletonText` | What is missing and the next move; what could not be loaded and a retry; the shape of what is coming while it is read. Never an empty box, never an error that reads as an empty list, never a spinner alone. |
| `Dialog`, `DialogPanel`, `ConfirmDialog`, `DrawerHead`, `ToastCard` | The overlays. A dialog is a bottom sheet on a phone and `wide` is 640 px; a dialog body that scrolls is a tab stop, so a keyboard can reach what is below the fold. A drawer's title row stays put. A toast has a tone icon, a title, a detail and at most one button. |
| `CommandPalette` | Rows in groups until something is typed, each with an icon and the key that does it; the keyboard walks the rows in the order drawn (`palette.ts`, §6a). |
| `CopyButton`, `IdChip` | Copying says what happened ("Copied", or "Can't copy"), through a route that works on an http origin; a long id keeps both ends. |
| `ZoneNote` | "Times in CEST": the zone, said once beside the heading of a run of local times so no row repeats it. |
| `ViewBoundary`, `ViewLoading` | Around the view area: a crash stays in the view (`crash.ts` words it and builds the report); a lazy view shows the shape of a page with a `role="status"` line ("Loading this page…"), invisible for the first 150 ms so a fast load does not flash. The shell shows it too while the host's project list has not answered, so the view area is never blank. |
| `.sk` | The skeleton shimmer a view draws while its first read is in flight. |

Some shapes are classes and not components, because a view fills them with its own parts: `.stats`, `dl.kv`, `.rows` (with
`.dense`, `.clickable`), `details.disc`, `pre.code`, `.kpi` and `.fig`, `.card-head`, `.tbl`, `.chip-toggle` and `.fchip`. A
primitive takes `extra` for a view's own class, never `className`. The classes `.is-hover`, `.is-active` and `.is-focus` draw a
state without the pointer, for the gallery and for a photograph; product code never sets them.

Icons are one registry (`icons.tsx`): every icon is used, every one draws from
`currentColor` on a 20-unit grid, and nothing outside the registry names an icon
that is not in it (`tests/build/icons.test.ts`).

Every primitive documents its states (§1.1) and owns its focus ring (§1.2).
Inline `style={{}}` is reserved for one-off, non-repeatable geometry. Motion is one set: 120 ms for a route's fade and a press,
180 ms for a menu, tooltip or dialog, 240 ms for a panel, 300 ms for a bar filling, and one global rule cuts all of it under
`prefers-reduced-motion` (§1.4).

---

## 6a. Where the logic lives

Anything a view decides is in a `.ts` module with no DOM in it and a test in
`tests/dashboard/`, so the wording and the precedence are checked, not eyeballed.
A view is then drawing.

| Module | Decides |
|---|---|
| `mission.ts` | The mission's phase, tone, headline and the one thing to do (`describeMission`). Phases, strongest first: `offline`, `down`, `loading`, `ceiling`, `needs-you`, `failed`, `done`, `paused`, `parked`, `stalled`, `quiet`, `running`. A decision that holds only one seat says so and does not claim the mission has stopped. |
| `overview-model.ts`, `inbox-model.ts`, `escalation-card.ts` | What the Overview and the decision cards say, and which decisions hold the mission or a seat. |
| `spend.ts` | What a confirmation says about cost: a scripted (stub) team spends nothing and the dialog says so; an unknown runtime is read as spending. |
| `navmodel.ts` | Which pages a server has (host or single mesh). |
| `route.ts` | The hash router and the stream URLs, host (`/api/events/stream`) and single mesh (`/events/stream`). |
| `crash.ts` | What a crashed view says, whether the tab is stale, and the report that is copied. |
| `eventmodel.ts` (`eventLine`) | One event, one line: who did what, in the console's words, for every event type (a test fails when the catalog grows a type without one). The Overview's *Just happened*, the Events list, search and detail pane, and both drawers read it, so a row never says only its own label. A thin payload falls back to the label, never "undefined". |
| `palette.ts` | What the command palette lists for a query and in what order (label starts with it, a word does, the label holds it, keywords and id; each id once), and when a pointer may pick a row: only once it has moved, so a mouse resting over the list never takes the selection from the keyboard. |
| `toasttext.ts` | What a notice says, how long it stays (`toastLife`) and which page already shows it (`pageShowing`): a decision is not announced on the Needs you page. |
| `message-form.ts` | The Message panel's recipients (a seat toggled in the comma list, tidied, in the seat's own case) and the plain name of each kind of message. |
| `designer/load.ts` | What the answer to the Designer's first read means: only a 200 with no file is "no mesh.yaml"; a project that is not running is asked again; any other failure is a load error with a retry, never a blank template. |
| `goal.ts` | Whether a mission has a goal yet: a written one, or the scaffold's placeholder (`GOAL_PLACEHOLDER`). The welcome, the Designer, the top bar and the Start dialog read this one answer: a mission is not offered Start on the placeholder, it is offered the goal ("Write the goal first"). |
| `hostfacts.ts`, `firstrun.ts` | What the host says about itself (`GET /api/templates`): what a new project can be made from, whether it is a Curule Cloud workspace (`hosted.accountUrl`) and whether a team made there could reach a model. A hosted workspace is welcomed with a goal field, not folders; a hosted team with no model key is told where to add one. |
| `designer/guidemodel.ts`, `designer/arrival.ts`, `designer/assistant-text.ts` | The Designer's first minute: which step of the guide is *now* (done / now / next, exactly one now), why a person was just sent there and so where the cursor goes, and what the assistant says when it has nothing yet or cannot answer (a sentence saying what happened, that the draft is unchanged and what to do; never a raw error). |
| `attention.ts`, `favicon.ts`, `notify.ts` (+ `notifyclient.ts`, `notifycontrol.tsx`, `attentioneffects.tsx`) | Being told. Which mission states are news to someone who is not looking (a decision starts to wait, delivered, stopped on its own; never the person's own pause), what the tab's icon and title say about it (a disc with a bar, a disc with a tick, a square with a cross: shape, not only colour), when a desktop notification is raised (only while the page is hidden, once per event) and what the opt-in control promises: it works while the page is open in a browser tab, nothing is sent to anyone else, nothing reaches you once the tab is closed. There is no service worker, no push message, no e-mail and no request. |
| `rightnow.ts` | The Overview's "Right now" lines for a running mission: who is in a turn and for how long, what is next or waiting for mail, how many requests are open, which seats crashed or are blocked, why nothing happens, and whether anything needs the person. At most three lines, no ids, facts and not diagnoses. It cannot say who waits for whom: `/status` carries only a count of open requests. The status is read with every event and the list of steps every few seconds, so the two disagree for a moment about who is working; the lines and the count believe the status where it is newer, and `overview-model.ts` names the turns to read again (`staleRunning`, `unlistedRunning`). |
| `overview-model.ts` (the hero) | Which mark the hero wears for a phase (`heroLook`), the segments of the checks bar (`checkSegments`), the seats as a stack with the ones in a turn kept in view (`seatStack`), the wall clock against its limit (`missionClock`), and the headline split into a state and its sentence (`splitHeadline`). |
| `agents.ts` | The figures on a seat's card: the series of its recent turns for the sparkline (`turnSeries`), its own budget (`seatBudgets`), `DENSE_FROM`, the number of seats from which the page offers rows, and `rosterFinished` / `seatRecord`: a team with nothing left to run is drawn as rows, each saying what that seat did. |
| `steps.ts` | Which window the timeline opens on and where the bars and ticks fall. A mission that is working keeps the smallest preset that holds about nine turns in ten; one that is over, paused, failed or at its ceiling opens on **Fit**, first turn to last, with clock ticks in the reader's zone. The mission's *phase* decides (`autoPick`), not whether a turn is in flight this second: agents work in bursts, and a window that changed whenever the last live turn ended would never hold still. |
| `files.ts` | What kind of file a type is (patch, release plan, report or document; an unknown type is a document), the short names of the status buttons, and which lines of a patch are added, removed or context (a removed line that starts with dashes is still a removal). |
| `commands.ts`, `palette-groups.ts` | What the palette can run and in what order. The shell's own scope is listed first whichever scope registered first (the project strip registers before the shell, and "Go to Projects" used to come ahead of "Go to Overview"); the other scopes keep the order they first registered in, and a view that goes away takes its commands with it. Until something is typed the rows are in groups (Go to, Agents, Actions), and the arrow keys walk them in the order they are drawn. |
| `feed.ts`, `steps.ts`, `agents.ts`, `graph.ts`, `files.ts`, `product.ts`, `cost.ts`, `hostsettings.ts`, `license-facts.ts`, `firstrun.ts`, `signin.ts`, `projectsmodel.ts`, `designer/*` | The same, per view. |

Mutation-check a new rule the way these were: break the code, see the test fail,
put it back.

---

## 6b. How the pages are drawn

The primitives are the vocabulary; these are the sentences the pages say with them. A new page reuses them, and a new
recipe that a third page needs is written here.

**The front pages** (Overview, Needs you, Agents, Projects, Host settings, sign-in, the welcome):

- **One mark, one sentence, one button, four figures.** The Overview opens on a card whose mark is chosen by the phase
  (`heroLook`): a refresh while loading; an alert for offline, down, needs-you, failed and stalled; a cost mark at the
  spend ceiling; a tick when done; a pause for paused and parked; a dot for quiet and running. Only *running* moves, and only
  while an agent is in a turn. The state is set at 30 px with its sentence under it (`mission.ts`'s words), then the goal,
  then the one large button, the thing to do; the rest are quiet.
- **Figures are a ruled strip** (`.stat-strip` of `.stat-cell`, each a `Stat` and one small drawing): a segment for each
  mandatory check, the clock against its limit, tokens against the budget, the seats as a stack with the ones in a turn lit.
  The Projects page's host figures and the licence block are the same strip.
- **Last known state.** A project whose process stopped, or a server that stopped answering, marks the figures *Last known
  state*. A figure that may be stale says so (§1.7).
- **Lists are timelines or cards, not stacks of boxes.** What shipped is file cards (a type tile, a status, the path). The latest
  work and *Just happened* are rows on a rail, an icon for the kind of event, the time since with the exact time on hover
  (`views/Timeline.tsx`), and while they are read a skeleton of the same rows. "No events yet" is said only once the stream is open.
- **Needs you leads with the decision**: a stripe in the tone of the decision, the question first, who asks and since when, and what
  happens if nobody answers (a notice holds nothing, so it gets no such line). **Agents** leads with the seat and what it is
  doing: a seat in a turn is lit, one that needs you has a stripe, a finished one recedes, and from nine seats (`DENSE_FROM`) a
  person can read them as rows (the choice stays in this browser); a phone stacks them as small cards. A seat's role keeps its
  line only when it is not the seat's own name (`roleLabel`, `agents.ts`): six of the delivered demo's seven seats are named after
  their role, and `architect` over `architect` is one fact, on a card, in a row and in a phone's Graph row. When *no* seat has
  anything left to run (every one is finished, `rosterFinished`) the page opens as those rows: a card's two lines would say one
  sentence about the mission on every seat, while the facts that differ — the turns that seat ran, when its last one ended, what
  it spent — are a column each. The Cards/List choice is offered there too; a team with anything to run (a seat to wake, a
  decision, a live turn) stays cards.
- **On a phone** everything that is pressed is 44 px tall and a field is 16 px, so the page does not zoom.

**The working pages** (Steps, Events, Graph, Designer, Files, Product, Cost, Tool gates, the drawers):

- **A ledger** is one ruled card of rows, each with an inset 3 px rail in the colour of its state: Steps, Events,
  Tool gates and the drawers' ledgers. A state is a dot and a word in the state's colour, the quiet cousin of a pill.
  **Facts** are ruled cells: a small caption over a value at weight 650, tabular (Product, Cost, Steps, the drawers).
- **A seat is its colour** (`--tint`, from `agentColor(role)`): its avatar, its bar in the Cost strip, its disc in the Graph and
  its rail in the Designer (§2).
- **Steps draws its timeline**: rounded bars in the outcome's colour on a well with hairline ticks and a *now* line. Pointing at
  or focusing a bar says which turn it is (agent, outcome, time, how long, tokens, what it left, what woke it) and picks the
  same row, and the other way round; a filter dims the bars it hides. A mission that is over opens on **Fit** (§6a, `steps.ts`)
  and says "Times in <zone>". The turns are rows of a table: rail, avatar, what happened, duration, tokens, started.
- **Events is a ledger of lines**: when, who (the seat's avatar, or a tile for the kind of event), what, with the actor in
  bold, and the kind at the right. An alert is a red tile and rail; routine runs fold into one row (a switch turns that off).
  A row shows the clock time in the reader's zone, said once above the list ("Times are in CEST"), and not "2 minutes ago":
  a log is an audit trail, rows that change every second cannot be compared or quoted, and the group headings carry
  recency. The detail pane shows both.
- **Graph**: a seat is a disc in its role colour inside a ring for its state (solid working, amber waiting, red stopped, dashed
  paused); pointing at a seat draws only its lines, with counts on them; the key is chips, and the most active links are
  ranked with bars. On a phone the page is rows: the key is not the drawing's footer but sits above the ranked links it filters,
  and it lists only the kinds those rows carry — a dashed line and a state ring decode marks a phone never draws. A row's count is
  its own column, on the line of the seat's name; the sentence under it names who the messages were with and does not print the
  number again. The ranked card says once how many links of how many it lists; the note under it says why the list stops, in words,
  not in the same two numbers again.
- **Designer**: seat cards with the role colour down one edge; wires quiet until a seat or a wire is selected; one grouped
  toolbar of icon buttons that say whether what they opened is open; an inspector that reads as a form, its sections
  sentences on a turning chevron; kit dialogs; an assistant dock.
- **Files** shows what a file is before it is read (a tile for a patch, a release plan, a report or a document), its state as a
  word, and a patch by colour. **Product** is the checkout as ruled facts, a script as a button that says what it runs, and a
  failed run as a note with a rail. **Cost** leads with the figure (30 px); the meter turns amber and red by the host's own rule with
  a line in words under it, and the strip shows everyone's slice in the colours of the rows below. **Tool gates**: a seat that
  asked is a block with a rail, a row for each tool with its own *Unlock*, and *Unlock all N* at the foot.
- **Drawers** (step, agent, event, artifact) have their own sheet, `views/drawers.css`. A step reads as a ledger and an agent as
  a card of figures. A drawer's title row is a `div` and not a `header`, because the page has one banner landmark.

**Windows High Contrast** replaces every background with the system's, so a bar, a segment or a dot that is only a background
is gone, and nothing fails: the page still renders and every other check runs without it. A sheet that draws such a mark
draws it again inside `@media (forced-colors: active)` in system colours, and an outcome is told by how its mark is filled (solid
produced, hollow no output, hatched refused, blocked or crashed, the highlight colour running), because colour is what is lost.
`tests/dashboard/forced-colors.test.ts` fails for a mark that has no such rule. Real Windows has not been tried; the browser's
emulation has (§7).

---

## 7. Visual QA protocol

Run it before a change to the console ships, against a console whose demo has been
run to *Delivered* (every page then has real data):

```bash
npm install --no-save playwright-core axe-core        # not repo dependencies on purpose
npm run qa:console -- --base http://127.0.0.1:7420 --token <operator token> --widths 1440,820,390 --chrome /path/to/chrome
```

For every view, at each width, in both themes, it takes a screenshot, runs
axe-core, and records a horizontal page scroll, a failed request and a console
error; it exits 1 if it found any. The last pass of the redesign was 13 views by
3 widths by 2 themes: 78 screenshots, 78 axe runs, nothing found. The gallery, `/kit.html`,
is read the same way by hand (on a host it needs the sign-in; `npm run dev:ui` serves it without).

Some rules no screenshot keeps true, so they are read from the source in the unit run, before a browser:
the type ramp (`type-ramp.test.ts` reads every stylesheet of the console, so a sheet added later is read without anyone
listing it), a custom property read with no fallback and set nowhere (`css-vars.test.ts`: a radius of `var(--r-md)` is
no radius, and the page still renders), the drawers' sheet (`drawers-css.test.ts`), Windows High Contrast
(`forced-colors.test.ts`, §6b), what the primitives promise a keyboard (`primitives-a11y.test.ts`) and a primitive the
gallery does not draw (`kit-gallery.test.ts`).

What a script cannot see still needs a person, per theme:

1. Each view's `empty` and `error` state, and one **long-content** case (a deep
   event list, a large file, a long agent name).
2. A drawer open, the command palette open, a confirm.
3. A keyboard-only pass through the primary flow, with the focus ring in view.
4. A mission watched from Start to Delivered: every page that shows it must move
   with it (§1.8). This is how the stale "No files are recorded" was found, and no
   screenshot of a finished mission shows it. `npm run qa:walk` does this walk
   (start, pause and undo, resume, delivered, reopen with a reason, an agent, a step,
   an event search, a file, a message, Projects, the palette, help) against the
   scripted demo, and reports each step, every failing request and every page error.
5. Both kinds of server (§0): the host, and `curule console` serving the
   production build (`npm run build`), not the dev server.
6. Windows High Contrast, with the browser's emulation (`forced-colors: active`; in Playwright
   `page.emulateMedia({ forcedColors: "active" })`): Steps, Cost and a step's drawer. A bar that has become an empty well
   is the defect. Safari, Firefox, a real phone's touch and a screen reader are not covered by anything above.

---

## 8. Status

| Phase | Scope | State |
|---|---|---|
| **0 Foundation** | This spec, the visual baseline | Done: the spec is checked against rendered screens, and `npm run qa:console` is the baseline. |
| **1 Polish & harden** | States, focus, reduced motion, contrast, overflow; the raw `px` and inline-style debt; three widths | Done for the views and the shell. Contrast and the colour literals are pinned by tests. |
| **2 Redesign** | Shell, Overview, Needs you, and every view's flow | Done (mission-first Overview and bar, one reading of the mission, the Designer rebuilt, first-run and sign-in, the Projects page). |
| **3 Guardrails** | Stylelint banning raw hex and off-ramp `px`; screenshot diffs against a stored baseline | Open. The palette, icon, type-ramp, custom-property and forced-colours tests catch the worst drift (they read the stylesheets as text); a stylelint rule and image diffs are not in place. |
| **4 One kit** | The shell, the primitives and every page drawn from the kit's tokens (§2 to §4) and recipes (§6, §6b); the gallery; the pages' guard tests | Done, in Chromium: 13 views by 3 widths by 2 themes with no axe violation, no horizontal scroll and no console error, the walk passing, the gallery clean at three widths. Not tried: Safari, Firefox, a real phone, a screen reader, real Windows High Contrast. |

Known debt, so it is not rediscovered:

- **The startup stylesheet grew** from 164,583 to 207,979 bytes (minified, what `index.html` links; 29,810 to 39,283 gzipped),
  and all the chunks together from 200,866 to 258,287. About 65 classes in `styles.css` are named by no source (some are
  built at run time, such as `lw-*`, `op-*`, `sstat-*`); a sweep that keeps those would give some of it back.
- **The Designer on a dense mesh** is still a web of wires: a fully connected mesh of seven is 36 of them. Styling made them
  quiet until selected; the real fix changes what the page shows (one statement for a fully connected mesh and only the
  selected seat's wires), which is a decision about the page.
- **The Graph on a phone** was a canvas that scrolled sideways; it is a list of seats with their links now, and the desktop
  ring is unchanged.
- Sign-in is composed but still a small card on a mostly empty ground, and Host settings is a long form that leaves the right
  third of a wide screen empty.

---

## 9. Measured passes

The changes to the console that were measured against rendered screens, newest first. A pass is only in this list with the run
that produced it, the before and the after, and what it deliberately did not change.

### 2026-10-25 — the step drawer is pressed and read like the rest of the console

Run against `examples/demo-stub/mesh.yaml` at **Parked**, **Running** and **Delivered** (the scripted demo, no model calls) on the
production build from the worktree: a fresh state, the mission started from the console, every reading taken on the same build
and, for the before/after comparison, on the same delivered state (the build was reverted and rebuilt between the two readings,
so no event count differs). 320, 390, 768 and 1440 in light, 390 in dark; `prefers-reduced-motion: reduce`; Chromium 1248 with
axe-core 4.14 injected into the page, over the shared CDP browser.

**What changed.**

- **A phone's step drawer presses at 44 px.** The drawer is where every turn is read, and it was the console's only surface with
  a pressed thing under the floor (§6b): at 390 the turn walk's two arrows measured **30 × 28** and four of its rows — the
  Outcome row (40), a tool (31) and two events (36, 37) — were **31–40 px**, while all ten views at the same width measured
  **0**. Two mechanisms let them through: `.sv-walk > button` sets its 30 × 28 at a specificity above `styles.css`'s `:where()`
  floor, and the rows are `role="button"` divs, which no `button` selector names. `views/drawers.css` now says the floor in its
  own phone block (`.sv-walk > button:not(.linklike)` at 44 × 44, and `.sv-op, .sv-tool, .sv-ev[role]` at `min-height: 44px`,
  content centred), because the sheet owns those shapes and the shared floor cannot outrank them. A static event row (no
  `role`) is read, not pressed, and keeps its compact height.
- **The bodies the drawer scrolls take a tab stop when they scroll.** Every `pre` in the drawer is capped (`#drawer pre`,
  `max-height: 340px`), so the prompt the runtime assembled (5,826 px of text in a 418 px box on this run), the model's output
  and the turn record are read by scrolling a box *inside* the drawer's own scroll. A wheel reached them; a keyboard did not,
  because an `overflow: auto` element with no `tabIndex` is not a stop (§1.2, §6 — "a dialog body that scrolls is a tab stop",
  which the dialog's body and the file reader already honour). `ScrollPre` in `ui/scroll-stop.tsx` gives the stop exactly when
  the body holds more than it shows (the same `useScrolls` hook), and `#drawer pre:focus-visible` draws the ring every other
  control draws, inset by 2 px so the drawer's scroll does not clip it.

**Measured.** Same delivered state for every pair; the drawer is the first turn of the run, opened from Steps.

| | Before | After |
|---|---|---|
| Pressed things under 44 × 44 in the step drawer, 390 and 320 | 6 of 16 (arrows 30 × 28; rows 40 / 31 / 36 / 37) | 0 of 16 (all 44 × 44) |
| The turn walk's arrows, 390 / 320 | 30 × 28 | 44 × 44 |
| A pressed row's height, 390 (`sv-op` / `sv-tool` / `sv-ev`) | 40 / 31 / 36 | 44 / 44 / 44 |
| Scrolling bodies in the drawer with a tab stop, 390 | 0 of 2 (5,826 px in 418; 414 in 338) | 2 of 2 |
| Tab stops in the drawer, any width | 18 | 20 |
| The drawer's own scrollHeight, 390 / 320 | 1,768 / 1,873 px | 1,808 / 1,913 px (+40) |
| The drawer's scrollHeight, 768 / 1440 | 1,555 / 1,224 px | unchanged |
| The turn walk's arrows, 768 / 1440 (a mouse) | 30 × 28 | 30 × 28 |
| axe-core, the drawer at 390 light/dark, 320, 768, 1440 | 0 violations | 0 violations |
| The ten views, 320 / 390 / 768 / 1440 light and 390 / 1440 dark | Overview 4,023 / 1,750 · Steps 3,371 / 2,484 · Events 736 / 836 · Files 1,135 / 910 · Cost 1,545 / 1,179 · Graph 1,778 / 1,494 px | identical |
| Pressed things under 44 × 44 in those views, 320 and 390 | 0 (the Steps switch's 18 px checkbox sits in a 44 px label) | 0 |
| Horizontal page scroll, both themes | none | none |
| Smallest text | 11 px (a capital label) | 11 px |

`npm run typecheck`, `npx eslint` on the changed files and `npm run build` pass; `node --test "dist/tests/dashboard/*.test.js"
"dist/tests/build/console-palette.test.js" "dist/tests/build/icons.test.js"` passes **1,159 tests**, including the new
`drawer-phone.test.ts`. Each of its three rules was mutation-checked (the arrow width put back to 30, the tab stop made
unconditional, the focus ring removed — each seen to fail, then restored).

**Left.** The drawer's section jump row (`Outcome · Reasoning · Tools · Events · Brief · Raw`) still scrolls sideways on a phone
with its scrollbar hidden, as the console's tabs do; on this run `Brief` and `Raw` sat past the edge at 390, with the cut
`Events` pill as the only cue. Making all six visible means two rows (44 px) in a sticky head that is already 231 px of an
800 px screen — a layout decision this pass did not take. The dialog's title row is still a `<header>` and so a second `banner`
landmark while a dialog is open (`landmark-no-duplicate-banner`, one node, on every confirm); §6b asks for a `div`, as the
drawer's row already is, and that is a separate surface. The step drawer's sticky head still takes 204 px after scrolling
(25 % of a phone screen), because its identity and metrics are information about the turn being read. No real phone, screen
reader, Safari, Firefox or High Contrast run this pass.

### 2026-10-25 — the seats say each fact once, and a phone's Graph key goes with the list it filters

Run against `examples/demo-stub/mesh.yaml` at **Parked**, **Running** and **Delivered** (the scripted demo, no model calls), on the
production build from the worktree: a fresh state, the mission started from the console, every reading taken on the same build.
320, 360, 390 and 1440 in light, 390 and 1440 in dark, `prefers-reduced-motion: reduce`, Chromium 1248 with axe-core 4.14 in the
page. Before is the previous build (`e2aec42`), after is this pass's.

**What changed.**

- **A seat's role is not printed when it is the seat's own name.** Six of the delivered demo's seven seats are named after their
  role, so a card read `architect` over `architect`, a ledger row read the same two lines, and a phone's Graph row read
  `qa · qa · done`. `roleLabel` (`agents.ts`) leaves the line out when the role is the name, case and spacing aside, and keeps it
  when it is news (`pm` over `product-manager`); a role that merely starts with the name (`frontend` / `frontend-dev`) is a
  different fact and is kept whole. Agents' cards and rows and the Graph's phone rows all read it, so there is one answer.
- **A phone's Graph row says its count once.** The row read "5 messages with qa, security and 1 more." and then its figure column
  read "5 messages": the same number twice in 88 px, and the sentence spent a line on it. The count is the row's own column now,
  on the line of the name, so seven counts read down one edge; the sentence names only who the messages were with. The first
  line's count is no longer `aria-hidden` — nothing else says it — so a row is read "pm, 5 messages, product-manager · done, with
  qa, security and 1 more. Open details."
- **A phone's Graph key sits with the list it filters.** The key was a footer under the seat rows — at 390 px, 271 px above the
  ranked links its buttons hide — and it decoded a dashed line ("carried a message in the last 40 events") and a ring
  ("ready, idle or finished") that a phone's rows never draw: on a parked team those two entries were the *whole* key, under
  seven rows that said "No messages yet." It is now a row of the kind chips inside *Most active links*, above the rows it
  filters; the drawing keeps its fuller key under the wheel. The chips are 44 px tall as before, and the hairline under the key
  sets it apart from the rows.
- **The ranked card says how many links once.** The heading read `12 of 18` and the foot "Showing the 12 busiest of 18 links."
  The foot's figure was also a different denominator when a kind was hidden (`9 of 15` under a heading saying `9 of 18`). The
  heading keeps the count; the foot now says only why the list stops ("Only the busiest links are listed.").

**Measured.**

| | Before | After |
|---|---|---|
| Graph, 390, delivered | 1,848 px | 1,778 px |
| Graph, 360 / 320, delivered | 2,006 / 2,194 px | 1,881 / 2,033 px |
| Graph, 390 / 360 / 320, parked | 1,022 / 1,043 / 1,085 px | 909 / 930 / 972 px |
| Graph "Seats" card, 390 | 878 px | 689 px |
| Graph ranked card, 390 | y = 983 | y = 794 |
| Graph key, 390 | 221 px tall, y = 761, under the seats | 107 px tall, y = 843, above the first ranked row |
| A Graph row's count, 390 | in the sentence and in the column, 7 of 7 rows | once, 0 of 7 |
| A seat row's role, Graph + Agents | the name again, 6 of 7 | 0 of 7 |
| Graph seat rows, 390 | 93 / 93 / 93 / 74 / 93 / 74 / 74 px | 7 × 88 px |
| The ties sentence, 390 | two lines on 4 of 7 rows | one line on 7 of 7 |
| Agents ledger rows, 1440 | 51 px each | 44 px (51 for `pm`, the one with a role to say) |
| Agents, 390 / 320, delivered | 1,302 / 1,360 px | 1,198 / 1,256 px |
| Agents, 390, parked (cards) | 2,418 px | 2,314 px |
| Smallest text, both themes | 11 px | 11 px |
| Horizontal page scroll, 320/360/390/1440 both themes | none | none |
| Controls under 44 × 44 at 320 and 390 | 0 | 0 |
| axe-core, Graph and Agents, 6 plans × 3 states | 0 violations | 0 violations |
| Console errors | 0 | 0 |

`npm run typecheck`, `npm run lint` and `npm run build` pass; `node --test "dist/tests/dashboard/*.test.js"
"dist/tests/build/*.test.js"` passes 1,336 tests, including four new rules in `graph-phone.test.ts` and the `roleLabel` cases in
`agents.test.ts`; the full `npm test` passes 6,327 tests (6,325 pass, 0 fail, 2 skipped). Each new rule was mutation-checked (the
role check returning the role always, the count put back into the sentence, the key put back under the seats, and the count's
grid area removed from the stylesheet, all seen to fail).

**Left.** The Agents ledger's `pm` row is 7 px taller than the other six at 1440 (and 16 px at 390) because its role is the one
worth a line; equal rows would mean either printing the repeat or dropping the role everywhere. The ranked list is still capped
at 12 links with no way to see the rest in place — the Events page is where they are read, and the note now says the list is the
busiest only. The dialogs' `<header class="dlg-head">` is counted as a second banner landmark by axe while a dialog is open
(`landmark-no-duplicate-banner`, one node); §6b already asks for a drawer's title row to be a `div`, and the dialog's should be
one too. No real phone, screen reader, Safari, Firefox or High Contrast run this pass.

### 2026-10-24 — a finished team is a ledger, not seven identical cards

Run against `examples/demo-stub/mesh.yaml` at **Delivered** (the scripted demo, no model calls), on the production build from the
worktree: a fresh state, the mission started from the console, both readings taken within 10 s of the goal completing. 320, 390,
768, 900, 960, 1000, 1100 and 1440 in light and dark, with a coarse pointer below 500; Chromium over CDP. Before is the console
serving the previous build (`3a9b11a`), after is this pass's.

**What changed.**

- **A roster with nothing left to run is read as rows.** Every seat of the delivered demo finished, so every card of the Agents
  page measured 243 px at 390 and said the same two lines: "Finished" over "Done with the mission, so there is nothing for it to
  run." — seven times, 1,828 px of the page. A card is the shape for a seat with a *now*: what it is doing, for how long, and the
  buttons that act on it. When no seat has a turn, a decision or a control (`rosterFinished` in `agents.ts`), the page opens as
  its ledger: Agent, State, What it did, Tokens. The group's sentence stays, once, in its heading.
- **The row's middle column is the seat's own record.** `seatRecord` writes the turns the roster counted and when the last one
  ended ("4 turns · last 5m ago") instead of repeating the team's sentence; a seat whose turn the loaded history does not hold
  says only its count, and one with no counted turn says "Never ran". The same figure is now a column beside every other seat's, so
  14.4k and 650 can be compared by looking down rather than across seven cards.
- **The Cards/List choice is offered to this team, not only to nine seats.** A finished roster opens as List and can be turned
  back; the choice is the same one `DENSE_FROM` teams already had, kept in this browser. A parked team (every seat able to `Run one
  step`) and a running one still open as cards.
- **The record survives the width where the Now column used to be dropped.** From 1100 down, `.ag-t-now` is hidden because the
  240 px controls column needs its room; a finished roster has no controls column, so its record stays (901–1100) and the ≤900
  row card is three lines rather than four-and-a-blank.

**Measured.**

| | Before | After |
|---|---|---|
| Agents, 390 | 2,019 px; 7 cards of 243 | 1,302 px; 7 rows of 141 |
| Agents, 320 | 2,077 px | 1,360 px |
| Agents group, 390 | 1,828 px | 1,051 px |
| Agents, 1440 | 909 px (73 px of scroll); cards 3 + 3 + 1; group 722 | 836 px, fits the view; one 7-row ledger; group 425 |
| "Done with the mission, so there is nothing for it to run." | 7 times | 0 |
| "Finished", 390 | 7 times | 0 (the state is `done` in its own column) |
| Next links, 1440 | below the fold (y = 900) | on the screen (y = 611) |
| Per-seat tokens, 1440 | right end of each card, one per column | one right-aligned column |
| Tab stops, 390 | 10 | 12 (Cards, List) |
| Record line | — | 13 px, 11.31:1 light / 11.53:1 dark |
| Smallest text, both themes | 11 px (`Next`) | 11 px |
| Worst text pair, both themes | 5.90:1 | 5.90:1 |
| Horizontal page scroll, 320/390/768/900/960/1000/1100/1440, both themes | none | none |
| Controls under 44 × 44 at 320 and 390, coarse pointer | 0 | 0 |

`npm run typecheck` and `npm run build` pass; `node --test "dist/tests/dashboard/*.test.js" "dist/tests/build/console-palette.test.js"
"dist/tests/build/ui-kit-tokens.test.js"` passes 1,140 tests, including the two new rules in `agents.test.ts` (mutation-checked:
`rosterFinished` returning true for a `STARTING` seat, and `seatRecord` dating a turn the history does not hold, both seen to fail).

**Left.** The 768 row card leaves a wide gap between the state pill and the token figure (the shared dense-list grid, unchanged);
the Cards view of a finished team is 2,079 px, 60 px more than before, because the choice it now offers sits in the header; the
ledger has no sort or grouping, because the roster's order is the mesh's; and no axe-core run was made this pass (the palette,
type-ramp, tokens and primitives tests stand, and the page's contrast sweep is above).

### 2026-10-24 — the figures name the team, and the lists say a thing once

Run against `examples/demo-stub/mesh.yaml` at **Delivered** (the scripted demo, no model calls): `curule console --fresh`, the
mission started from the console, both readings taken within 10 s of the goal completing, on the production build. 390 and 1440 in
both themes, 360 in light; Chromium 156. Before is the build of `c240e3b`, after is this pass's.

**What changed.**

- **The Agents figure named three zeros.** In the two states a person parks on — a mission delivered, or one not started — nobody
  works, nothing waits and nothing is queued, so a quarter of the hero's strip read `0 working` over `0 waiting · 0 queued` while
  every other figure reported a result. `agentTally` (`overview-model.ts`) counts who is working while anyone is, and otherwise
  names the team: `7 seats` over `all finished` when every seat finished its work, `none working` when the roster has not run.
  The stack's screen-reader name follows ("The team: pm, architect, …", no longer the count the figure now says).
- **A phone's first figure column had 12 px less width than the second.** The two-up rule from 1100 (`padding-left: var(--s6)` on
  the first cell of each row, which lines it up with the hero's own edge) outweighs the phone's four-cells rule at (0, 2, 0), so
  the odd cells kept 28 px of left padding where the hero's content is 16. The phone rule now names the hero's cells with the same
  weight. Every cell is 16/16 on a phone: content 138 → 150 px at 390 and 123 → 135 at 360, where the Tokens figure was breaking
  inside its unit (`51.0k of` / `2.0M`) and now sits on one line.
- **"Latest work" said the outcome twice.** A quiet turn's pill reads "no output" and its second line read "… · wrote nothing":
  one fact, twice, in one row — four of the delivered demo's five rows at 390. `whatItLeft` keeps the line for what the pill does
  not carry (a count of messages or files, a refusal's count) and leaves it empty when the pill already worded it.
- **"Just happened" printed one sentence on every fold.** Every fold row carried "Folded. Open Events for each one." under a card
  whose own button says *All events*: the delivered demo showed three folds and read the same line three times. The first fold the
  panel draws carries it; its words already speak for each one. A fold row is 92 → 78 px at 390 and 58 → 44 at 1440.

**Bug found and fixed.** The Overview's index scrolled with `scrollIntoView({ behavior: "smooth" })`, which animates whatever the
person's motion setting is: the stylesheet's `scroll-behavior: auto !important` cannot reach an option passed to that call, so a
reduced-motion reader still got the sweep. The click now asks the same media query; `primitives-a11y.test.ts` holds it.

**Measured.**

| | Before | After |
|---|---|---|
| Agents figure, delivered, 390 | `0 working`, `0 waiting · 0 queued` | `7 seats`, `all finished` |
| Agents figure, parked, 390 | the same three zeros | `7 seats`, `none working` |
| Figure cells, 390 | odd columns pad 28/16, content 138 px | 16/16, content 150 px |
| Figure cells, 360 | content 123 px; `51.0k of` / `2.0M` | content 135 px; `51.0k of 2.0M` |
| Hero / figures strip, 360 | 761 / 325 px | 737 / 301 px |
| Latest work, one quiet row, 390 | `6s ago · wrote nothing` + pill `no output` | `6s ago` + pill `no output` |
| Just happened, 390 | 3 folds, 3 × "Folded. Open Events…", 817 px | 1 explained fold, 2 × 78 px, 789 px |
| Just happened, 1440 | 465 px | 437 px |
| Overview, 390 / 1440 | 4,462 / 1,778 px | 4,434 / 1,750 px |
| Horizontal page scroll, 360 / 390 / 1440, both themes | none | none |
| Controls under 44 × 44 at 360 and 390 | 0 | 0 |
| Smallest text pair, both themes | 5.61:1 | 5.61:1 |
| Type sizes on the Overview | 11 12 13 14 15 16 18 24 30 | unchanged |

`npm run typecheck` and `npm run build` pass; `node --test "dist/tests/dashboard/*.test.js" "dist/tests/build/console-palette.test.js"
"dist/tests/build/icons.test.js"` passes 1,133 tests, including the new `timeline-rows` file and the phone-cell rule. Each new rule was
mutation-checked (broken, seen to fail, restored).

**Left.** The two routine folds in the delivered buffer are still separate (a reading decision, as before). The Goal checks card's
100 % bar and the hero's seven segments draw the same figure twice on a finished goal. The Events and Latest work rows still put the
time on a third line at 390; joining it to the line above needs the row to give up width the message uses.

### 2026-10-23 — names a person can say, and a hero that ends in two rows

Run against `examples/demo-stub/mesh.yaml` at **Delivered** (the scripted demo, no model calls): 13 views × 390 / 768 / 1440 ×
light / dark, Chromium 156 through the shared CDP browser, axe-core injected into the signed-in page, reduced motion on, plus all
13 views at 320 in both themes. The console served the production build.

**What changed.**

- **Label in Name (WCAG 2.5.3).** A control named itself in an `aria-label` shorter than the words drawn inside it: the
  designer's dock button ("Ask the designer" over "Ask designer"), a Graph seat ("pm, done" over "PM pm done") and a Designer
  seat (`"pm, product-manager"` over the initial, name and role the card draws). axe called it
  `label-content-name-mismatch` on **166 nodes in 50 of the 78 view/width/theme pairs**. The three now take their name from
  their visible text (`aria-labelledby` for the two drawings) and the initial is part of the name because it is part of the
  picture. The phone Graph row and the ranked link's "See messages" do the same. No visible copy changed; the SVG and the two
  spans gained the space the text already read with. `tests/dashboard/label-in-name.test.ts` holds the rule, and
  `graph-phone.test.ts` no longer pins a name that overrides the row.
- **The Overview's actions.** At 1440 the action column (440 px) could not hold the primary and "Reopen with feedback" side by
  side, so the primary sat alone over a ragged row, beside a 93 px lead in a 140 px column. From 1280 the
  column is 520 px: the primary and the soft action share the first row, the three quiet actions share the second. On a phone
  the quiet actions lose the decorative icon and go one size down, so all three fit one row at 390; the goal is allowed three
  lines, which is the whole one-sentence goal the two-line clamp cut at 390 and 320.
- **Events folds.** A fold whose events all fell in one clock second printed "09:43:26 to 09:43:26" in the row's third column.
  The range is printed once when it is one time. The delivered demo has 18 folds; each range went from 127 px to 54 px, some
  1.3k px of repeated clock across the list.
- **The kit gallery.** It had no `h1` (axe `page-has-heading-one`) and the open-menu specimen gave the page 3 px of horizontal
  scroll at 390. An `sr-only` heading anchors the outline; the gallery's phone margin is 16 px, which leaves the 356 px menu
  1 px of room at 390, and below 380 it scrolls inside its own stage. The menu is complete at 390.

**Measured.**

| | Before | After |
|---|---|---|
| Overview hero, 1440 | 372 px; actions 3 rows, 140 px | 325 px; 2 rows, 88 px |
| Overview hero, 390 | 760 px; actions 4 rows, 200 px; goal cut after two lines | 727 px; 3 rows, 144 px; goal whole |
| Overview actions, 320 | 5 rows | 4 rows |
| axe `label-content-name-mismatch` | 166 nodes, 50 pairs | 0 nodes, 0 pairs |
| Gallery, 390 | no `h1`, 3 px page scroll | `h1`, no page scroll |
| Horizontal page scroll, 78 pairs | none | none (also all 13 views at 320) |

Tab order is unchanged in the views touched: no control was added, removed or reordered. Overview at 390 is 18 stops with a
visible ring on each; the Events stream keeps one roving row and the arrows walk the rest. The type ramp, the palette and the
brand tokens are untouched; the new quiet-action rule uses 13 px, an existing step.

**Left.**

- *Just happened* still shows seven identical "is done with the mission" rows on a delivered run. The Events page folds
  routine runs; the Overview's eight-row summary does not. Which of the eight to drop is a reading decision, not a style one.
- The 320 Overview still puts "Replay" on a fourth row. Squeezing a fourth label into the 264 px row would take the quiet
  actions below 13 px.
- The Designer's dense mesh still draws 36 wires (the known debt above), and Host settings still leaves a wide screen's right
  third empty. The graph phone debt is closed; its line above records that.
- `npm run qa:console` could not launch this machine's Chrome (no libatk); the same pairs were read through the shared Chrome
  over CDP with axe-core injected. That is the browser §7 names, but it is not the script's own launch path.

## 2026-10-23 — the summary says what happened, the thumb hits, and Clear clears

Run against `examples/demo-stub/mesh.yaml` at **Delivered** (the scripted demo, no model calls), served by
`curule console --resume` on the production build: 12 views at 1440, 1280, 768, 390 and 360, light and dark,
`prefers-reduced-motion: reduce`. The browser was the same Chromium 156 Playwright binary as the earlier pass (launched with
the local `LD_LIBRARY_PATH`; `qa:console`'s own launch path still lacks libatk here). **axe-core was not installed in this
worktree**, so this pass has no axe numbers: the checks below are the browser's own measurements plus the unit suite.

**What changed.**

- **The Overview's *Just happened* is a summary, not the newest eight rows.** On a delivered run it took the newest eight
  events whatever they were: measured at 1440, eight of eight were `recovery-manager released its hold …` repeats, and the
  mission's own completion was not on the panel. `eventmodel.ts` now has `miniFeed`: it keeps the newest rows but collapses
  runs of routine bookkeeping (as the Events page already did) and runs of a kind with a plain sentence (`agent.completed`,
  files, messages, reviews, checks). A fold is one row that says the count, that the rest is folded, and where to read each
  one; it is a button that opens Events. The same buffer now puts `mission complete` and the `pm could not be woken` alert on
  the panel. A fold is keyed by its oldest event, so new events at the top do not remount the row under a pointer.
- **Phone targets reach the floor.** `CopyButton`'s icon-only form was 24×24 on a phone (three in one event detail: types,
  event id, goal id) and the search box's clear control was 40×40. Both are 44×44 now: `.copy-btn.compact` and `.srch-clear`
  joined the shared 44 px floor in `styles.css`, and `live.css` no longer overrides the clear control to 40.
- **The Files filter button no longer claims a filter the page set itself.** "Latest of each name" is on when the page opens,
  but the count included it, so a phone opened on `Filters (1)` with a `Clear` that reset the filter to the value it already
  had. `activeFilterCount` and `filtersApplied` count only a change from the default; on arrival the button reads `Filters`
  and there is no Clear. Turning the switch off, choosing a type/status, or typing a search brings Clear back.
- **The Overview's quiet actions fit one row at 360.** The three quiet actions needed 302 px and had 8 px of side padding
  each; the third wrapped. On the phone break they now take 4 px of side padding with the existing 8 px gap, so the same
  words share one row without going below 13 px.

**Measured.**

| | Before | After |
|---|---|---|
| Overview *Just happened*, 1440 | 8 of 8 rows were routine budget releases; no completion row | 8 rows: 3 folds (28 routine, 7 seats finished, 5 reviews), the alert, `mission complete`, the check it met, the 6-of-7 progress line |
| Overview actions, 360 | 194 px; Replay on a fourth row (y = 451) | 148 px; all three quiet actions on one row (y = 405) |
| Event detail, 390 | 3 copy buttons 24×24; search clear 40×40 | every control ≥ 44×44; measured 0 under the floor |
| Files, 390, on arrival | `Filters (1)` + a no-op `Clear` | `Filters`; no `Clear`; Clear returns with a query |
| Horizontal page scroll, 12 views × 5 widths | none | none |
| Overview fold row, keyboard | — | a button with a 2 px ring; Enter opens Events; reduced motion leaves 0 running animations |

`npm run typecheck` and `npm run build` pass; `node --test "dist/tests/dashboard/*.test.js" "dist/tests/build/*.test.js"`
passes 1,313 tests. `phone-targets` and `primitives-a11y` now name the two controls that reached the floor, and
`files-phone` reads the count from the model that owns it.

**Left.**

- The Overview still shows two routine folds in the delivered buffer (28 and 6): runs are grouped by consecutiveness, not
  merged across the whole log. The panel says the count and sends the reader to Events, the audit trail. Merging them by kind
  is a reading decision, not a style one.
- The eighth row can still be an old `6 of 7 checks done` progress event. The feed is newest-first and stops at eight rows;
  preferring completion over progress would reorder the log, which the Events page is for.
- At 360 the token figure's unit wraps inside its cell (`51.0k` / `of 2.0M`). The text is complete and the cell is one of four;
  widening the cell would take the width from the checks and the clock. Left for a cell-layout decision.
- A single-mesh console still logs 404s for `/api/projects` and `/api/host/config` while it establishes that it has no host.
  They are read as "no host", not shown, and are not user-visible; the server routes are outside this console pass.
- No axe-core run (not installed here); `qa:console`'s own Chrome launch is still blocked by libatk on this machine. Safari,
  Firefox, a real phone's touch, a screen reader and real Windows High Contrast remain untested by this pass.


## 2026-10-24 — the views' targets, the answer at the action, and a phone's shipping list

Three passes, one per surface, run in parallel against `main` at `efd8855` and merged in this order: the marketing site
(`5f55edb`), the account pages (`1f08dbd`), the console (`b2b8925`). The console was rendered against
`examples/demo-stub/mesh.yaml` at **Delivered**; the account pages against a local trial with a seeded plan-less account;
the site from a static server. Screenshots at 360/390/768/1440, light (dark swept for contrast and scroll), reduced motion.

**What changed.**

- **Site: three of the six console-view chips went back to the hero.** The hero's tab radios reused the ids of the console
  cards (`view-overview`, `view-events`, `view-designer`), so each id named two elements and chips 01, 02 and 04 scrolled to
  `y=571` instead of the view row at `7,143` at 360. The radios are `hero-view-*`; all six land (`scrollLeft 0 / 322 / 965`).
  A test now fails on a repeated id or an in-page link that names more than one element.
- **Site: the documentation filter comes before the labels it filters by.** Five label rows sat above the filter; they are
  one closed *What each label means*, and the GitHub-titles note sits beside the cards it describes.
- **Site: the estimate follows the fields.** On a phone the form and result cannot share a screen, so editing a field left
  the figure 1,007 px down the viewport; a 48 px total now pins at `top 140` under the header and On-this-page bar while the
  fields are edited (hidden at 860+ and in print). The fee row names its period. The pricing page's first two headings take
  the page's rank (22 → 28 px at 360, 22 → 48 px at 1440), at the cost of height.
- **Account: an answer is said at the button that asked, with the cursor kept.** A plan action's refusal appeared at the top
  of the plan section (248 px above *Manage billing*, pushing the button out from under the pointer and dropping focus to the
  body); it is now in that plan's row, 112 px under the buttons, and `leaveFor` re-focuses a trigger the browser dropped. A
  refusal from the stage card is said in the card, not in the Plan section 1,050 px below.
- **Account: a plan is promised only when one was read.** With `/api/plans` down, a plan-less account was told to choose one
  below, above a section saying no price was shown. The card now says the plans could not be loaded, with a 133 × 48 *Try
  again* that draws the list in place. The allowance says "left of" in words, and the consent refusal is one line.
- **Console: what shipped is rows on a phone.** The panel was 1,150 px of stacked cards for nine files, six of them shown;
  each file is now a row in the Files page's shape, with the 40 px tile at 28. The delivery path is cut at the front
  (`direction: rtl` over a `<bdi>`), 98 → 39 px. A page change whose control was removed hands focus to the new page's `h2`
  instead of the body, and the tab title names the view.

**Measured.**

| Surface | Before | After |
|---|---|---|
| Console *What shipped*, 390 | panel 1,111 px; page 4,437 | panel 775; page 4,063 |
| Console page, 360 / 320 | 4,458 / 4,776 px | 4,120 / 4,480 |
| Console delivery path, 390 | wraps anywhere, 98 px | one line, tail visible, 39 px |
| Docs page, 360 | filter at 3,101; page 9,208 | filter at 2,523; page 8,805 |
| Docs page, 1440 | first card 1,930; page 4,696 | 1,671; 4,437 |
| Sign-up refusal, 360 × 800 | note 74 px; action 775–819 | note 50 px; action 751–795 (inside) |
| Pricing page, 360 / 1440 | 13,790 / 9,188 | 14,006 / 9,393 |
| Plan-action refusal, 360 | 248 px above *Manage billing*; focus on body | 112 px below; button y 1470 → 1470; focus kept |
| Sideways scroll, all surfaces, 320–1440, both themes | none | none |

`npm run typecheck`, `npm run lint` (0 errors), `npm run build` and the full `npm test` on the merged tree pass: **6,316
tests, 6,314 pass, 0 fail, 2 skipped**. New tests: the site's duplicate-id check; the account's refusal-in-the-card and
cursor assertions; the console's `views-phone`, `primitives-a11y` and the view-in-the-title.

**Left.**

- The landing page's height did not change (13,526 / 12,258 px): the pass fixed its path down, not its length. The demo
  steps and security sections are the product's own words and folding them would hide what the hero promises.
- The pricing page is 216 px taller at 360 for the two headings' rank; a phone reader pays that once, above the plans.
- The console's *Left* items from the 2026-10-23 pass stand: the goal card's bar repeats the hero's 7 of 7, the two routine
  folds, and the time on a third line in Latest work.
- No axe-core run and no real phone, screen reader, Safari, Firefox or High Contrast test; `qa:console`'s own Chrome launch
  is still blocked by libatk on this machine, so the shared CDP browser did the rendering.
