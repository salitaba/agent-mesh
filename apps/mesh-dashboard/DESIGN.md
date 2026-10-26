# The console's design memory

One page. Read it before changing a console view; update it before the pass ends.
The exhaustive rules live in [`docs/design-spec.md`](../../docs/design-spec.md).
This file records the direction, the patterns this pass made binding, and the
work that is still wrong.

## Direction: the pocket brief

**Dense, plain, one-thumbed.**

The console is not a dashboard watched from a desk. Its owner has a phone and no
laptop, so every view is a **briefing read in the hand**: first where you are and
what is true, then the one thing to do, then the evidence as ruled rows. The same
order holds at 1440 px, where there is simply more room beside each row.

Those three adjectives decide arguments:

- **Dense** — information earns the screen. No hero whitespace on a working page,
  no card for a sentence that could be a row. A wide screen gets more columns and
  more facts, not larger padding.
- **Plain** — a state is a sentence and a next move, never a spinner or an empty
  box. A number that may be old says it is old. A control's name is the thing it
  does. The voice is [`brand.md`](../../docs/brand.md)'s: facts, no alarm, no
  flattery.
- **One-thumbed** — at 360 px every pressed thing is at least 44 × 44 px, fields
  are 16 px so iOS does not zoom, nothing scrolls sideways, nothing depends on
  hover, and long output keeps its controls in reach. The phone is the primary
  drawing, not the desktop one squeezed.

Why this is better than the previous "responsive console": the old layout met the
spec at 390 px by stacking desktop cards and by asking the reader to scroll the
Graph sideways. That is a screenshot that passes, not a console someone can use
with one hand. The pocket brief changes what a phone shows (a seat list, not a
ring), not only how wide it is.

## The page grammar every view follows

1. **The brief** — `PageHeader`: the view's name, its status if it has one, one
   sentence saying what the page is for, and the page's actions. On a phone the
   actions take their own row and controls may grow to fill it. When the page
   shows a first-run guide, the guide *is* the brief and the header's sentence is
   omitted: two briefs pushed the Designer's first seat out of the screen.
   A route change that lands focus on the page's heading announces the page; the heading wears no ring, because it is a place,
   not a control (the same for `#view`). A control's keyboard ring is untouched.
2. **The state, before the content** — a banner for stale or refused, an
   `ErrorState` with a retry, an `EmptyState` with the next move. Never an empty
   card, never zeros standing in for "not read".
3. **The content** — sections with an `h3`; rows ruled by `--line`; cards only
   for a thing that can be pressed or a group that genuinely belongs together.
4. **The end** — long lists say how many they left off; long output is scrollable
   and its controls stay outside the scrolling text; and a page that can be read
   to its end closes on a row of ways on (`NextLinks`), naming real destinations
   in a sentence each. The product is the first door wherever it applies, then
   the files, the cost, and the pages that continue the same question.

Overview is the one deliberate variation: its brief is short because the mission
hero directly under it is the page's real headline. The two are not peers: the
page name is a signpost, the hero is the news. Below the mission's first cards
and before the sections it indexes, it carries `JumpRow`, its own four-door
index, because the page runs past 8,500 px on a phone; each button scrolls to
the section **and focuses it**, and every `Panel`
section is the anchor (`id` + `tabIndex={-1}`), so a keyboard user continues
inside the section rather than back at the top.

The **path** the surface is organised around is "open the console" → "I am using
my product": a delivered mission's loudest action is **Open the product**, Product
opens on the **Your product** card, and reading the files is what you do about a
result, not the first thing you are offered. Pinned by
`tests/dashboard/product-path.test.ts` and `tests/dashboard/page-exits.test.ts`.

## Type and space in force

Type ramp: **11 12 13 14 15 16 18 20 24 30** (pinned by
`tests/dashboard/type-ramp.test.ts`). Body is 14–15; metadata 12. 11 is reserved
for uppercase micro-labels on a wide screen (`Stat` captions, `dt`, `.caps`);
on a coarse pointer or at 760 px and below those captions move to 12, the ramp's
next step, and 11 remains only for glyphs such as avatar initials. Pinned by
`tests/dashboard/phone-type.test.ts`. Page titles are 24 (`--tx-page`); the
mission headline is 30 and steps to 24 when it runs long.

Space: `--s0 2 · --s1 4 · --s1-5 6 · --s2 8 · --s2-5 10 · --s3 12 · --s3-5 14 ·
--s4 16 · --s5 20 · --s6 28`. Radii: `--r-sm`, `--r`, `--r-lg`, `--r-xl`, pill.
Rhythm uses the space tokens; raw px only for optical corrections with a comment.

Breakpoints: **1280 1100 900 800 760 620 560**. 800 is the sidebar drawer (JS
`NARROW`); 620 is the phone (JS `PHONE`). Any new query picks from this list.

## States every view must show

| State | What the page says | Recipe |
|---|---|---|
| Loading | The shape of the content and a `role="status"` sentence. | `Skeleton` / the view's skeleton, invisible for the first 150 ms. |
| Empty | What is missing and the next move. | `EmptyState` with an action. No zeros. |
| Failed | What failed, that it may be temporary, and a retry. | `ErrorState`. Never an empty list, and never a claim about the data. A failed status poll is a failed page, not an empty project: `statusError` says so when no status has landed. |
| Partial / stale | The figures stay and say when they were read. | `Banner tone="warn"` with a read-again action; `Updated …` in the header. |
| Refused | What was asked, why it was refused, what to change. | A sentence in the form or dialog, not a toast alone. |
| Dense | Long names, paths, logs and lists stay readable. | Truncation with the full value reachable; a stated cap; scrollable output. |
| Phone | Every state above, at 44 px and one column. | See the phone rules below. |

## Phone rules this pass makes binding

- Every button, link-row, summary and field is at least 44 px in both directions
  where it is a glyph, 44 px tall where it is a line of text. Pinned by
  `tests/dashboard/phone-targets.test.ts`.
- Fields are 16 px and 44 px tall at 760 px and below; the iOS zoom is a layout
  bug, not a browser quirk.
- No page scrolls horizontally. A drawing that cannot fit becomes a list; a wide
  table becomes rows; a long path truncates in the middle with the whole value
  available (tooltip or copy), never pushes the page wide.
- No affordance is hover-only. A control that exists on a phone is visible or
  reachable by one press; a tooltip repeats a name, it does not supply one.
- Filters that are not needed to read the page fold behind one 44 px button with
  a count, as Events and Steps do; the search stays out.
- A page's last row is a way on, not a full stop: `NextLinks` is 13 px link text
  on a rule, 44 px tall at 620 px and below, and wraps rather than scrolls. It is
  a signpost, not a second band of primary buttons.
- The Graph phone view is a list of seats (who they talk to, how many messages)
  and the ranked links, not a 900 px drawing that scrolls inside its frame.
- The frame is two rows at 360, not three: the menu, the state chip and the
  actions share row one, and the project switcher is row two. The goal and the
  telemetry leave the bar below 800 px (the Overview opens with both; the chip
  keeps the state); the bar's primary action moves to the first row of `⋯`
  rather than wrapping. Pinned by `tests/dashboard/frame-phone.test.ts`.
- A panel or sheet is a **layer**, not a floating copy of the page: a scrim, a
  heading that stays put, a 44 px close control, `role="dialog"` and
  `aria-modal`, the page behind `inert` and not scrolling, Tab cycling inside it,
  and focus returning to its opener. On a phone it takes the whole screen
  (`100dvh`) and its own safe-area insets. The same rules for the navigation
  drawer as for the Help panel, the command palette and the confirmation dialog —
  and for the Designer's inspector, YAML preview and assistant dock where they
  cover the page (pinned by `tests/dashboard/designer-layers.test.ts`).
- A notice can be dismissed by hand; an action that resolves it dismisses it
  too. Nothing waits out a timer to get out of the way.

## Open problems (carried forward)

- The Overview is now **1,214 px** at 360 px with a delivered mission (was 4,132 today, 8,582 before the 2026-10-22 folding and shipped-card
  work): the four evidence sections below the index are one ruled row each until opened. The open question is the default, not the length:
  What shipped is closed like the other three, and a mission that has just delivered may deserve its six file rows open; measured, the
  closed row is 53 px and the open panel 847, so the whole difference is one press or two screens.
- Events and the approvals inbox still close without `NextLinks`, and that is now a decision rather than a pending question: Events ends on
  its window status (the newest 300 of 491 events) and the inbox on its empty state's Back to the Overview; a row of doors would repeat
  the navigation each page already has (`Pause`/`Filters`, `Decisions`/`Tool gates`) rather than continue it.
- At 621–800 px the project strip is still a row of tabs that scrolls inside itself when projects overflow. The phone's switcher and sheet
  prove the pattern; it was not measured here because `curule console` serves one mesh and `/api/projects` answers 404, so this mode has no
  strip to overflow. The hosted console is where the measurement can be made.
- The top bar no longer shows the mission's goal below 800 px. That is the
  deliberate trade that made it one row; the goal leads Overview and is one tap
  away, but a reader on Events cannot see it without leaving the page. Watch
  whether that absence costs a visit in real use.
- The Designer's phone header is **90 px** with the first-run guide (was 150): undo/redo are in ⋯ and the other three actions share one row.
  The first seat row starts at **735** on an 844 screen (was 795), so one row is fully visible but still only one: the guide's 459 px is now
  the largest block before the roster, and a one-line or sheet shape for the guide is the next decision.
- The Designer's YAML preview wraps by default at 620 and below (295/295 at 360, was 462 in 295). The choice is component state, so it is not
  remembered between visits; a wrapped path breaks anywhere and the copy button is still the way to the exact text.
- 768 px is just above the Designer's 760 phone layout, but its guide disclosures and canvas wiring ports now take the 44 px floor on a
  coarse pointer (the port keeps its 26 px mark). The console's `NextLinks` there still measure 32 px on a coarse pointer, above the phone
  break; whether every touch-class tablet row takes 44 is the wider question this pass did not answer.
- Overview's avatar initials are 11 px glyphs in a 22 px disc. They are marks, not
  words, and stay at 11 on a phone. The goal id under the wordmark was the last 11 px word there and is now 12.
- The public site (`apps/cloud-server/pages`) has its own memory; this pass did
  not change it.
- The registry's failure state is honest but not a console: while `/api/projects` does not answer, no view can be drawn, because
  the shell cannot tell a host from a one-mesh server. The page says that and offers Try again; it does not guess.
- The Steps filter is one button at 620 and below and 166 px of chips and switch from 621 to 768. The phone's 44 px fold may be
  the right shape for a touch-class tablet, but that is the same open question as the tablet's 32 px `NextLinks`.
- The Playground now leads with its terminal and puts the product card after the output. That is a deliberate reversal of the
  2026-10-22 "product first" reading for this one page: the page's own action was at the foot of the first screen. If real use
  says the product should lead there too, the card costs 487 px above the command box and the measurement is in this entry.

## What the next pass should take

1. Give the first-run guide a phone shape — the path in one line, or a sheet — against the roster's first two rows being visible on arrival.
   The header is 90 and the guide 459; this was the last pass's first job and is now this one's.
2. Decide whether the Steps filter fold belongs above 620: at 621–768 the chips take two rows and the switch a third (166 px),
   though the page's own reading is one button there. The same decision covers the tablet's 32 px `NextLinks`.
3. Decide whether What shipped opens by default on a fresh delivery, and whether the phone's fold remembers a section (the page
   resets to all closed on every visit).
4. Measure the project strip at 621–800 with enough projects, in the hosted console where a registry exists; `curule console` cannot show it.
5. Remember the YAML preview's wrap choice, or move the toggle into the pane's own head; either is a small addition to a layer that now fits.
6. Check the Events and inbox end-caps against real live content before adding any row (the decision above).
7. Read the console with a real thumb on a real phone: the measurements here are Chromium at 360 px with touch emulation only in CSS, not a hardware device.
8. Check the frame's safe-area claims on a notched device in both orientations; the insets are in the CSS but the stand-in browser reports them as zero.

## Pass log

### 2026-10-26 — the Steps ledger gives the phone its screen, and a failed registry says so

Surface: `views/Steps.tsx`, `views/steps.css`, `views/Playground.tsx`, `shell.tsx`, `navmodel.ts`, `projects.tsx`, `styles.css`.
Measured on the scripted demo at **Delivered** (28 turns, one quiet fold) in the production build, Chromium 1248 at
320/360/390/768/900/1440 in light and dark, reduced motion, a touch pointer, axe-core 4.14 at 360 and 1440 in both schemes and
on the states this pass changed (Steps' filter open, the failed registry, forced colours). Before is the base build at
`a05ea58`, run beside this one on its own port for the registry case; after is this branch, on the same delivered mission.

- **The Steps filter is one button on a phone.** At 360 the ledger opened on **166 px** of filter — three outcome chips in two
  rows and the quiet-run switch on a third — before the first turn. It is one 44 px button that names the choice and its count
  (`Everything 28`), with the chips and the switch in its fold (opened: 218 px, only while choosing). Toolbar **166 → 60**, the
  first group **786 → 680**, the first turn **822 → 734**, so the ledger itself starts on the first screen. The page is
  3,372 → **3,377**: the filter gives 106 px back and the wrapped reasons below spend most of it. A desk is unchanged: the
  toggle is `display: none` above 620 and the panel takes no box (`display: contents`), so at 1440 the toolbar is **68 px**
  with the count and the switch where they were.
- **A wake reason reads on a phone.** The line under every turn was 264 px of `nowrap`; **5 of 25** reasons were cut with no
  end in reach — one held **1,728 px** of text — and a phone has no hover to reveal the `title`. It takes two lines and ends in
  an ellipsis: **0** are now cut without a visible end, and the 3 that do not fit two lines clamp at 35 px against content of
  139, 52 and 104 px. The step drawer still carries the whole note, as it did.
- **The quiet run's names are whole.** The fold row gave its names **113 of the 287 px** they needed and read
  `tech-lead, ar…`; the count and the cost now take the first line and the names the second, **306/306 at 360** (row 44 → 49)
  and **266/266 at 320** (64).
- **The Playground opens on its command.** The product card above the terminal put the command box at **y=657** and Run at
  **709**: the page's own action sat at the foot of the first screen, behind 487 px of a card Product already opens with. The
  terminal leads: command box **657 → 170**, Run **709 → 222**, and the product card follows the output (170 → 529). Page
  1,041 → 1,057. The product is still on the page, still the first door at its end, and still `Product`'s first card
  (`product-path.test.ts`); the Playground's own test now pins the terminal first and the product before the ways out.
- **A registry that never answers is a failed read, not a wait.** With `/api/projects` answering 503, at 10 s the console sat
  on **"Loading this page…"** in every view with **0 alerts and 0 controls**: `hasRegistry` never left null, so the shell held
  every view. `registryPhase` now distinguishes waiting from failed; at the same 10 s the page shows its own heading,
  `Could not load the projects list`, **one `role="alert"` and one 108 × 44 Try again**, and pressing it recovers the ledger
  (3,377 px). The generic `server error /api/projects -> 503` notice is suppressed (`quiet`) because the page now says it in
  place — it had been covering the page's own heading.
- **The page a route lands on is a place, not a control.** **7 of 12** pages arrived with a 2 px accent ring: four around the
  page title (Agents, Steps, Playground, Cost) and three around the whole **360 × 736** view (Files, Designer, Tool gates).
  The ring is gone (**0/12**) while the focus stays — `document.activeElement` is still the page's `h2` where the route change
  focuses it — and Tab through the bar still draws its 2 px ring on the skip link, ☰ and ⋯. The landing is announced, not
  selected.

The 120 view/width/theme reads are unchanged in the ways that matter: **no document or `#view` horizontal scroll** at
320/360/390/768/1440 in both schemes, **0 real controls under 44 × 44 at 320/360/390**, smallest text on the ramp (11 px is
the Designer's "Starts" flag and the Overview's avatar glyph), and **0 axe violations** at 360 and 1440, both schemes, on all
twelve views and on the filter-open and registry-failed states.

Suite: typecheck, eslint (0 errors, 211 pre-existing cross-package warnings) and build clean; `dist/tests/dashboard` **1,172
pass, 0 fail**, including the new `steps-phone.test.ts` and rules in `playground`, `navmodel`, `failure-states` and
`primitives-a11y`; `node --test "dist/tests/**/*.test.js"` **6,384 tests, 6,382 pass, 0 fail, 2 skipped**.

**Left.** The Designer's first-run guide is untouched (still 459 px, still one seat row on an 844 screen) and is the next
pass's first job. Above 620 the Steps chips still take two rows with the switch on a third (**166 px at 621–768**), because
the phone fold is at the phone break and a tablet is not a phone; whether the fold belongs up to 760 is the same question as
the tablet's 32 px `NextLinks`. The Playground note between the Run and the quick commands is eight lines on a phone and now
sits directly under the action; trimming it is a words decision, not a layout one. A registry that answers 5xx still cannot
draw a view: the console cannot know whether the server is a host or one mesh until it answers, so it says so and offers the
retry rather than guessing. The failure's own sentence is a full paragraph at 360 — it is the one place on the console that
explains a thing the person has never seen before, and the retry is directly under it.

### 2026-10-26 — the Overview becomes a briefing, and three rules reach the edges

Surface: `views/Overview.tsx`, `views/Panel.tsx`, `views/Shipped.tsx`, `views/GoalChecks.tsx`, `views/overview.css`, `designer/chrome.tsx`,
`designer/Designer.tsx`, `designer/designer.css`, `designer/topology.css`, `styles.css`. Measured on the scripted demo at **Delivered**
(491 events, 9 files, 7 checks), production build, Chromium over CDP at 320/360/390/620/621/768/1440 in light and dark, reduced motion,
a touch pointer at 800 and below, axe-core 4.14 at 360 and 1440. Before and after are the **same mission**: the pre-change build was
rebuilt from this pass's base and read at the same minute, then the fixed build was read again.

- **The Overview is a briefing, not a scroll.** At 360 a delivered mission was **4,132 px**: six file rows (847), five turns (547), seven
  checks (946) and the folded feed (789). The four sections below the index are now one ruled row each — title, one figure, Show —
  until opened in place (`Panel`'s `fold`, phone only). The page is **1,214 px**; the rows are **53 px** each, **212** for all four, and
  a closed row is a rule rather than a card with a heading and nothing under it (the card-shaped closed row measured 103). The index
  opens the section it names before it lands: pressing Goal checks at 360 put `#ov-goal` at the top of the now-2,157 px page with focus
  on it (a same-tick scroll clamps to 478, the folded page's end, and leaves the pressed section below the bar — the landing waits for the open). What it hides, one press each: the six file rows, the
  five turns, the seven checks and the feed. The hero's Open the product / files / cost / replay are untouched, and a closed row says
  its failure ("could not load", "paused while reconnecting") instead of reading forever. 1440 is unchanged at 1,750.
- **The YAML preview wraps.** At 360 a 462 px line lived in a 295 px pane — 167 px behind a sideways drag inside a layer that already
  fills the screen (2,043 in the larger draft the 2026-10-23 entry measured). It wraps by default below 620: **295/295, 0 hidden**,
  4,766 → 4,974 px of vertical text. A 44 px `Wrap lines` toggle (`aria-pressed`) returns the aligned `pre` text, and the desk still
  opens unwrapped. Tab still cycles inside the layer (close → Wrap → Copy → text) and Escape returns focus to `#ms-more`.
- **The 44 px floor reaches a touch-class 768.** 768 is above the Designer's 760 phone layout but a finger: the guide's three closed
  steps were **32 px** and each wiring port **26 × 26**. The disclosures are 44; the port's target is **44 × 44** with the 26 px mark
  drawn inside it, so the canvas does not grow a row of blobs. At 768 coarse the Designer has **0** controls under 44, against four
  (three steps and the port). The last 11 px word on a phone was the goal id under the wordmark (247 px wide at 360): it takes the
  caption's **12**. The Overview's smallest text is now a 22 px avatar's 11 px glyph; it was the goal-id word.
- **The Designer's phone header gives 60 px back.** At 360 with the first-run guide the header was 150 px and its actions two rows
  (52 for undo/redo and the verdict, 44 for Inspector and the menu). Undo/redo move into ⋯ on a phone (44 px rows; driven: one edit,
  then `Undo: Edited mission goal`, restores the placeholder). Header **150 → 90**, actions **104 → 44** in one row, the guide starts
  238 → 178, the roster body **709 → 649**, and the first seat row **795 → 735** — fully on an 844 screen, though still only one row:
  the guide is 459 and its own shape is the next decision.

The type and target census is otherwise unchanged: 120 page/width/theme reads have **no document or `#view` horizontal scroll**
(320/360/390/768/1440, light and dark), **0 axe WCAG/best-practice violations** at 360 and 1440 on all twelve views and with the YAML
layer open, and no control under 44 × 44 at 320/360/390 except the 20 px checkbox inside its 44 px label on Events/Steps/Gates. The
Designer's 11 px "Starts" flag is unchanged from its own 2026-10-23 census.

Suite: typecheck, eslint (0 errors, 211 pre-existing cross-package warnings) and build clean; `dist/tests/dashboard` **1,166 pass, 0
fail**, including the new `overview-fold.test.ts` and rules in `designer-layers`, `designer-phone`, `phone-type` and `page-exits`. The
fold's `hidden` body was mutation-checked: removing it fails the new test.

**Left.** What shipped is closed by default like the other three; a fresh delivery may deserve it open, and that is a reading decision,
not a layout one. The first-run guide still leaves one seat row on an 844 screen, 60 px better than it was. The project strip at
621–800 was not measured: `curule console` serves one mesh and `/api/projects` answers 404, so there is no strip here to overflow.
Events and the inbox still close without `NextLinks`: Events ends on its window status (the newest 300 of 491 events) and the inbox on
its empty state's Back to the Overview, and neither needed a second row of doors.

### 2026-10-25 — a read that fails or is slow still says what it is doing

Surface: `views/Steps.tsx`, `steps.ts`, `store.tsx`, `drawers.tsx`, `components.tsx` (the dialog's title row).
Measured on the scripted demo at **Delivered**, production build, Chromium 1248 at 320/360/390/768/1440 light and 390/1440 dark,
reduced motion, axe-core 4.14. Before and after are the same delivered state (491 events), read two minutes apart.

- **A failed first `/steps` read was an endless skeleton.** At 360, 768 and 1440 it said "Loading turns · Fetching the step
  history." over five skeleton rows after six seconds, with no error and no way to retry: the loader kept a stale list on purpose
  and had nowhere to report that it had never had one. `stepsError` now records only the first failure; the pulse reads **"Turns
  did not load · The step history could not be read."**, the count says `Not loaded`, and the list offers **Try again**. Five
  skeleton rows → 0; 0 retry → 1.
- **An agent drawer that is still reading becomes a panel, not the word "loading…".** With `/agents/pm` delayed 7 s the panel was
  8 characters in 360 × 800: no title row, no close, no status, focus on the drawer root. It now draws the same `DrawerHeader`
  as the record and the error, `Reading pm…` as `role="status"`, and the skeleton of its figures and lines. At 360: close
  **0 → 44 × 44**, status **0 → 1**, skeleton marks **0 → 11**, focus **#drawer → close**. The 1440 close stays 32 × 32.
- **The step drawer keeps focus when the turn arrives.** The skeleton's close is replaced by the record's head; removing the
  focused node dropped focus to `<body>`. At 360, 768 and 1440 the log was `row → close-x → BODY`; it is now
  `row → close-x → the close again`, restored once per turn and only when focus was lost.
- **A dialog's title row is no longer a second banner.** `<header class="dlg-head">` made axe report
  `landmark-no-duplicate-banner` and `landmark-unique` (one node each) on every confirm. It is a `<div>`: 2 → 0.

The 120 view/width/theme reads are otherwise unchanged: no horizontal page scroll, smallest text 11 px, 0 real controls under
44 × 44 at 320/360/390, and 0 WCAG axe violations. Steps at 320 moved 3,351 → 3,370 px in the sweep because its live `Started`
label had aged from `6m ago` to `18m ago`; rebuilding the pre-change UI and reading it at the same minute gave 3,370 too.

Suite: typecheck, eslint and build pass; the dashboard and build tests pass, including the new `drawer-loading.test.ts` and rules
in `failure-states`, `primitives-a11y` and `steps` (each mutation-checked).

**Left.** The agent drawer's close is 32 × 32 at 768/1440, pointer density as §5 defines it. Steps still gives no banner for a
refresh that fails *after* a good load: the list is kept and the row count stands, as before. The step drawer's sticky head and
its sideways section jump row are untouched.

### 2026-10-24 — the figures name the team, and the lists say a thing once

Surface: `views/MissionHero.tsx`, `views/Timeline.tsx`, `views/Overview.tsx`, `views/overview.css`, `overview-model.ts`.
Measured on `examples/demo-stub/mesh.yaml` at **Delivered** (the scripted demo, no model calls), production build, Chromium 156 at
1440, 390 and 360, both themes; before is the base build and after this one, both read within 10 s of delivery.

- **The Agents figure was three zeros** in the two states a person parks on. `agentTally` counts who is working while anyone is and
  otherwise names the team: **`0 working` / `0 waiting · 0 queued` → `7 seats` / `all finished`** (delivered) and **`7 seats` /
  `none working`** (not started). The stack's label is "The team: …" so the count is not said twice to a screen reader.
- **A phone's figure cells were 28 px on the left of the first column**, because the two-up rule from 1100 outranked the phone's
  rule: content **138 → 150 px at 390**, **123 → 135 at 360**, where the Tokens figure had been breaking at its unit
  (**`51.0k of` / `2.0M` → one line**). Hero **761 → 737 px** and strip **325 → 301** at 360.
- **The two lists said a fact twice.** "Latest work" printed `wrote nothing` beside a pill already reading `no output` (4 of 5 rows
  at 390); "Just happened" printed "Folded. Open Events for each one." on all three folds. The effect line now appears only when the
  pill does not carry it, and the fold sentence belongs to the first fold: panel **817 → 789 px at 390**, **465 → 437 at 1440**.
- **A script's smooth scroll ignored `prefers-reduced-motion`** (the `scrollIntoView` option is not reached by the stylesheet's
  `scroll-behavior` rule). The Overview's index now asks the media query.

Overview **4,462 → 4,434 px at 390** and **1,778 → 1,750 at 1440**; no horizontal page scroll at 360/390/1440 in either theme, 0
controls under 44 px at the phone widths, smallest text pair unchanged at **5.61:1**, type census on the ramp. Suite: 1,133
dashboard/build tests pass.

**Left.** The two routine folds are still separate (a reading decision). The Goal checks card's 100 % bar repeats the hero's
segments on a finished goal. A phone timeline row still spends a line on its time.

### 2026-10-23 — the parked Overview is a briefing, not the roster

Surface: `views/Overview.tsx`, `views/overview.css`, `eventmodel.ts` (the mini feed). Measured on `examples/demo-stub/mesh.yaml`
at **Parked** (the scripted demo, no model calls), production build, Chromium at 1440, 390, 360 and 320, both themes.

- **The first screen's log was the roster.** The newest eight events were the eight seats joining, so "Just happened" was eight
  identical rows and the goal the mission was created for was not on the panel. `miniFeed` now folds a run of `agent.created`
  as it already folded `agent.completed`: **8 rows → 3** (the fold, the thread, the goal), the panel **423 → 233 px at 1440**
  and **727 → 351 px at 390**. A later restart that re-adds three seats folds the same way; two joins still show as two rows.
- **"No work yet." was a dead end.** The empty Latest work card is a sentence naming what will appear and a **44 × 44 "Wake an
  agent"** route to the page the hero's note already tells you about. Card **108 → 129 px at 1440** (sentence and button share
  the row) and **124 → 197 px at 390**; the height is the route.
- **On a phone the state and the page's name were both 24 px**, so "Overview" competed with "Parked.". A state whose first
  sentence is short keeps the display step: **24 → 30 px** ("Parked."); a sentence-long state still steps to 20. Hero 608 → 615.
- **The page is shorter and still clean.** Overview **2,092 → 1,795 px at 390** (1,816 at 360) and **985 → 861 px at 1440**;
  no horizontal page scroll and 0 real controls under 44 px at 360/390; text contrast unchanged (the smallest pair on the page is
  still 5.61:1); `dist/tests/dashboard` + `dist/tests/build` 1,315 tests pass, including the new mini-feed case.

**Left.** The parked note still says "wake a single agent from Agents" in prose one screen above the button that now does it; a
link inside the note is the next move. The delivered Overview's length (open problem 1) is untouched, and 768 was not re-measured
for this pass.

### 2026-10-23 — the designer, drawn by one hand

Surface: `apps/mesh-dashboard/src/designer` (canvas, roster, inspector, assistant dock, setup guide, checks/YAML chrome).
Direction unchanged: dense, plain, one-thumbed. The work was to make the surface obey the rules this file already claimed,
and to give a seat's name the space it needs at every width. Measured in a driven Chromium at 360, 768 and 1440 against a
nine-seat copy (`/tmp/full-squad`) and an eight-seat project with a placeholder goal (`/tmp/designer-empty`).

**Bugs found, proved, fixed**

- **The roster cut seat names.** At 360 the name measured 88 px of width for 151 px of text; six of nine rows read
  `frontend-…`, `ux-desig…`. The flags shared the name's line. Now the name is its own wrapping line: measured 194/194 px,
  0 of 9 cut, and the row below it carries role + flags, then `May message N seats · M may message it`.
- **The phone inspector was not a layer.** It was a fixed 360 × 844 box with `role` and `aria-modal` both null, no scrim,
  the page scrollable behind it, and Shift+Tab from its close button landed on a seat row behind it. Now `role="dialog"`,
  `aria-modal="true"`, named by its heading (`Seat: pm`, `Mesh settings`, `Policy settings`), a scrim at z 39 under the
  drawer at z 40, `#view` and `body` locked, focus entering at the layer (not the seat-id field, which opened the phone
  keyboard), 16 of 16 Tabs staying inside, and Escape returning focus to the row that opened it.
- **The YAML slide said dialog but behaved as a panel.** `aria-modal` was absent, there was no ground behind it, and the
  22 px page gutter stayed live. Now modal, with a scrim, the page locked, a 44 px close; the 5,972 px YAML stays in its
  own 295 × 589 scroll box with the copy control outside it.
- **The assistant dock covered the phone without being a layer, and it opened the keyboard.** At ≤ 560 it was 360 × 844
  with no scrim, no modal state, Tab leaving it, and focus on the composer. Now it is a layer there only (desktop remains a
  non-modal 440 px slide-over): scrim, `aria-modal`, z 40, focus on the panel, 8 of 8 Tabs inside, Escape closes and focus
  returns to the `⋯` button. Desktop measured `aria-modal` null, no scrim, composer focused.
- **Canvas names were cut and cards repeated the name as the role.** At 1440 the name had 78 px for up to 140 px of text,
  six of nine cards were ellipsized, and six printed the id twice (`pm / pm`). Now names wrap to two lines (long ones
  measure 33 px tall), the role line appears only when it differs (2 of 9), and the starts/attention marks ride the avatar
  as dots. Cards are 168 × 56 up to nine seats, then 140 × 56: 0 of 9 cut.
- **The setup guide was a wall.** All four steps were open at once (553 px at 360) and the first seat began at y=881 on an
  844 px screen, so the instructions hid the thing they were about. Now only the `now` step is open, the header says
  `Step 1 of 4`, the other steps are 44 px disclosure buttons, and the guide is 459 px. The header's own sentence is
  suppressed while the guide shows (page header 229 → 150 px): the first roster row now begins at y=795, visible.
- **A dead end in the checks.** An error with no field said "Edit mesh.yaml directly", with no route. It now names the file
  and the route: More → Discard the draft and reload mesh.yaml.

**Measurements after (Chromium, no horizontal page scroll at any width)**

| Width | Page | Names | Targets | Other |
|---|---|---|---|---|
| 360 | doc 360/360 | 194/194 px, 0/9 cut | 0 controls under 44 in the page and 0 in the open drawer (its only 18 px box is a checkbox inside a 332 × 44 label) | guide 459 px, first row y=795; drawer/dock 360 × 844, close 44; YAML 338 × 844 |
| 768 | 768/768 | 106/106 px, 0/9 cut | canvas wire handles 26 px (pointer density); guide toggles 32 px because this is above the 760 phone layout | stage 718 px, 9 cards 168 × 56; guide 390 px |
| 1440 | 1440/1440 | 106 px box, long names 2 lines, 0/9 cut | desk density (30 px tool chips, 26 px handles) | stage 714 px, 9 cards 168 × 56; role line only on the 2 cards whose role differs |

Type census at both ends is on the ramp (11/12/13/14/15/16/24); text contrast measured a 5.61:1 minimum across 202 runs at
360 and 193 at 1440, with no WCAG AA failure. Pinned by `tests/dashboard/designer-layers.test.ts` plus the updated
`designer-topology.test.ts` and `designer-escape.test.ts`.

**Left for the next pass**

- The phone page header still spends 116 px on actions in three rows (undo/redo, verdict, inspector, more). Folding
  undo/redo into `⋯` would give the roster another 52 px; not done because undo is the one act a mis-tap needs.
- At 360 the guide plus header still use 709 px, so only the first roster row reaches the screen. Opening the guide as a
  sheet, or collapsing `next` steps behind one line, would show two or three; both hide the path, and the path is why the
  guide exists.
- The YAML preview scrolls sideways inside its own box (2,043 px of text). A wrap toggle is the obvious fix; the page
  itself does not scroll.
- 768 sits just above the 760 phone layout, so the guide's disclosures are 32 px and the canvas handles 26 px on a
  touch-class tablet. Decide whether the tablet should inherit the phone's 44 px.

### 2026-10-22 — the path is the product

Direction unchanged — dense, plain, one-thumbed — but this pass judged the
surface by one question: **from opening the console, how short is the way to
using the product?** Measured in a driven Chromium (Playwright in a container,
signed-in storage state, a rich copy of a live project at
`/tmp/full-squad`, never the project's own workspace) at 360, 768 and 1440.

**Bugs found, proved, fixed** (each commit carries its evidence):

- **The dev server hid the product's routes.** `/workspace/info` and `/ui` are
  root routes on the mesh server; Vite's `API_ROOTS` did not name them, so the
  proxy answered its SPA fallback with `index.html` and a 200. Product read that
  as "The mesh server did not answer" and showed "No workspace" beside a live
  workspace. Fixed in `vite.config.mts`; the page reads its product again.
- **A failed poll was taken as an idle product.** `productlive.ts refresh`
  guarded thrown requests but handed any JSON body to `absorb`. A 502
  `{error}` became "nothing has ever run", the live frame closed, the Start box
  returned for a command that was still running, and Start then said "already
  running" — the dead end the card exists to remove. A non-2xx answer now keeps
  the screen and asks again; `tests/dashboard/productlive.test.ts` drives live
  → 502 → recovery.
- **Steps scrolled sideways at 360.** The three-figure strip's `scrollWidth`
  was 378 in a 302 px card, and the view was 407 against 360. It is a
  two-column grid with the no-output share on its own full-width line: 302/302
  and 360/360 after.
- **Agents lost the name a thumb was aiming at.** A control row gave the name
  77 px ("dev…"). Rows are four lines on a phone (name; state and tokens; what
  it is doing; controls) and the name measures 302. At a desk the action cell
  was 190 px (166 content) for 213 px of controls; it is 240.
- **Files drew the same switch twice** at 768 and 1440: "Latest of each name"
  in the header and again among the filters. One copy, with the filters, and
  the test now pins that the header carries no actions.
- **Events' fold row never said what it does.** It spent its width on
  "16:50:47 to 16:51:03"; it now says the count, the range at desk widths and
  **Show/Hide**, a 44 px bar on a phone that drops the range (the bucket
  heading already gives it). The agent chooser moved into the phone's filter
  fold and a chosen agent is counted by the button.

**The path itself:**

- A **delivered mission's loudest action is the product**. The hero reads
  "Open the product" (primary), "Reopen with feedback" (soft), "Open the
  files", "What it cost", "Replay" (quiet). Measured at 360 in that order.
- **Product opens on the product**: `YourProduct` (the shipped page and its own
  UI, live) is the first card, before the checkout facts, the script runner,
  the changes list and the file list.
- The **Overview is indexed**. At 360 px a delivered mission made the page
  8,582 px tall with nothing at the top saying what followed. `JumpRow` under
  the hero offers What shipped / Latest work / Goal checks / Just happened;
  each scrolls and **focuses** the section. Driven: pressing Goal checks put
  `#view` at scrollTop 2,742 and focus on `#ov-goal`, its top at 64 px, below
  the sticky bar.
- **Every page that can be read to its end now ends on a way on.** Nine views
  close with `NextLinks`: quiet 13 px links on a rule, the product first where
  it applies. At 360 each link is 44 px tall; at 1440, 32. Files' "Open the
  product" driven to `#/product`, first card "Your product".

**Verified after the change:** every surface view (plus Steps) and both host
pages have **no horizontal overflow at 360, 768 and 1440**; no element with its
own text sits off the type ramp; no real control is under 44 px at 360. (The
only two raw `input`s that measure under 44 are the bare switch/checkbox inside
a 44–56 px `label.chk` on Steps and Gates — the label is the target.) Host
pages: NextLinks "Host settings" 106×44 and "Projects" 71×44 at 360.

**Suite:** `npm run typecheck` and `npm run build` clean; `node --test
"dist/tests/**/*.test.js"` 6,271 tests, 6,269 pass, 0 fail, 2 skipped (the
provider-key environment variables had to be unset for the pre-existing
cloud-trial assertion, not for anything this pass touched); lint 0 errors, 211
warnings, all pre-existing cross-package import warnings.

**Deliberately left alone:** Events and the approvals inbox have no end-cap
(live viewport / own navigation — see open problems); Gates changed nothing
because nothing on it failed a measurement; the Designer and the public site
are outside this surface; `packages/core` delivery gates untouched.

**Stopped at:** commits `fefb0df`, `ecbb5ed` and `ef7c0f9` on
`ux/auto-20261022-0139`. The next pass starts with the Overview's remaining
length and the two end-cap decisions below.

### 2026-10-21 — the frame is a layer

Changed (surface: `shell.tsx`, `tabs.tsx`, `commandpalette.tsx`, `components.tsx`,
`store.tsx`, `styles.css`, `live.css`, `index.html`; process measured in Chromium against a
copy of a live project, never the project's own workspace):

- **The phone bar lost two rows.** At 360×844 the top bar measured 154 px and the
  project strip 57 px: 211 px of 844 before the page. The 220 px goal basis forced
  the actions to wrap and the goal onto a third row. Now the goal and telemetry
  leave the bar below 800 px (Overview opens with both; the chip keeps the
  state), the actions' labels become accessible names, and the bar's primary
  action moves to the first row of `⋯`. Measured after: 64 + 53 = **117 px**.
  At 768 the same change took the bar from 116 px to 64 px (total chrome 173 →
  121).
- **The project strip is one row and a sheet on a phone.** The old row held 437 px
  of tabs in a 233 px window; the third project was off screen and the chrome
  itself scrolled. At ≤620 it is a 52 px switcher naming the project in front;
  its sheet lists every project as a 52 px row (measured 70–86 px tall rendered,
  current one checked), and choosing one switches the hash and project in one
  press. Scroll width 0. The sheet first measured 331 px flush left at 360: the
  `wide` dialog's 92vw desk width outranked the phone's docked `auto`. Now
  360×442 docked at the foot, with no slice of page beside it.
- **The navigation drawer became a modal layer.** It had no scrim, no close
  control, no `aria-modal`, eight focusable controls behind it in the tab order,
  and a tap outside did nothing. Now: a 360×844 scrim that closes on tap,
  `role="dialog"`/`aria-modal`, a 44×44 close in a sticky head, `inert` top bar,
  view, skip link, project strip and toasts, a Tab cycle that stays inside, and
  focus returned to `#btn-menu`. Verified: 0 tabbable elements behind it; 20
  Tabs never left the sheet.
- **Panels keep their way out in reach.** Help's floating close had scrolled to
  y = −136 after 400 px; it now uses the sticky `DrawerHead` (close 44×44 at
  x = 300, y = 12 after the same scroll). On a phone the drawer is the full
  360×100dvh with safe-area padding instead of 92vw. Its close X went from 32×32
  to 44×44.
- **The palette can be closed and its rows are thumbs.** It had no close control
  and 40 px rows; now a 44×44 `.palette-x` (Tab cycles input ↔ close), 44 px
  rows, 12 px captions, 344 px wide at 360, 80dvh tall.
- **The page behind a layer does not scroll.** `:has()` locks the view for the
  drawer, palette, confirmation and (below 800) the navigation; `overscroll-
  behavior: contain` inside each scroller.
- **Notices dismiss.** `dismissToast` in the store and a 44×44 `.toast-x` on the
  card; an action still dismisses its own notice.
- **Hover-only tab close is visible to a thumb** (`.ptab-x { opacity: 1 }` under
  coarse/760).
- **Off-ramp type fixed:** the skip link had no base font (13.333 px browser
  default) → 600 14; `.count` was 14 px/900 from `<b>` → 600 13; the sidebar's
  and palette's 11 px capital captions → 12 under coarse/760.
- **Phone edges:** `viewport-fit=cover`; safe-area insets on the bar, drawer,
  toasts and view foot.

Verified across every view at 360, 768 and 1440: no document horizontal scroll,
no off-ramp font sizes, and the 360 dark palette audit returned no contrast
failures. `tests/dashboard/frame-phone.test.ts` pins each structural promise;
`phone-targets` and `phone-type` extend their floor to the new controls.

Left alone deliberately: the desktop rail and 1440 bar (no measured defect);
view bodies; the project strip at 621–800 (above); `packages/core`.

### 2026-10-20 — pocket brief

Changed: the page brief and its phone action row; ledes cut to one sentence of
one shape and handed the detail to the controls; thumb-sized controls on every
console page with a coarse-pointer/narrow-window floor; Files' filters folded
behind a counted button on a phone (202 px of bar became 96 px); the phone Graph
replaced by a seat list with per-seat message counts (no sideways drawing); the
one-mesh server's Projects/Host settings fallback given a heading and a way
back; captions raised from 11 to 12 px on phones; and the failed states made
honest: a 502 status no longer becomes an empty roster, the event log says the
server answered with an error instead of printing "not iterable", Overview stops
saying "starting" when the status never arrived, and Playground no longer calls
a failed page probe "it ships no page". Measurements and the failing evidence
behind each are in the commit history.
