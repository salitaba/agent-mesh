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
| `agents.ts` | The figures on a seat's card: the series of its recent turns for the sparkline (`turnSeries`), its own budget (`seatBudgets`), and `DENSE_FROM`, the number of seats from which the page offers rows. |
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
  person can read them as rows (the choice stays in this browser); a phone stacks them as small cards.
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
  ranked with bars.
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
- **The Graph on a phone** is a canvas that scrolls sideways; a list of seats with their links would serve a phone better.
- Sign-in is composed but still a small card on a mostly empty ground, and Host settings is a long form that leaves the right
  third of a wide screen empty.
