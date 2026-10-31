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
   omitted: two briefs pushed the Designer's first seat out of the screen; on a
   phone that brief is ruled lines, not a card (2026-10-28).
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
page name is a signpost, the hero is the news. Below the mission's first cards,
on a wide screen, it carries `JumpRow`, its own four-door index, because the page
runs to 1,751 px at 1440 and past 3,000 at 621–768; each button scrolls to the
section **and focuses it**, and every `Panel` section is the anchor (`id` +
`tabIndex={-1}`), so a keyboard user continues inside the section rather than back
at the top. A phone draws no such row: below 621 the four sections are themselves
one 44 px closed row each, immediately under the hero, naming the same four
sections with their figures — so the row of buttons said the same four words
twice (2026-10-28).

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
- A row that does one thing is one press across its width. A closed evidence row
  is a door from its left edge, not a label with a 56 px handle at its end, and it
  lights as a whole band when pointed at or reached by the keyboard; the one
  control it carries keeps its own name, its 44 px box and its single tab stop
  (2026-10-29).
- An open event is the page on a phone. Below 900 the stream is hidden while an
  event is open, so the log's search bar and filter fold go with it — they narrow
  a list that is not on screen, and pressing Filters open there grew a 262 px panel
  and left the event 258 px of the 736 px view. The pane takes their height, and
  its title row — the kind, its mark and Close — sticks to the pane's top, bleeding
  by the pane's own gutter as a drawer's head does, so the way back is one press at
  any scroll (at 360 the close was 1,036.6 px above the pane at its end). A desk
  keeps the list beside the pane and keeps the tools (2026-10-30).
- A drawing is not a set of controls where a mark cannot be a target. The Steps
  timeline's 28 marks are 4–18 px wide: on the phone layout (620 and below) or a
  coarse pointer they are spans, and a 12 px line under the axis says the turn is
  a row below. A desk keeps the 28 buttons, their tooltips and their roving
  keyboard (2026-10-29).
- Filters that are not needed to read the page fold behind one 44 px button with
  a count, as Events and Steps do; the search stays out.
- A phone's page head is one line where its title, its status and its action
  fit, and the columns use the row's own 8 px, not the desk's 12. The Events head
  needed 333.1 px in 332 with the live chip at its widest, so the hold took a row
  of its own above the lede (147.1 px) and dropped back to 110 a second later
  when the chip read "Updated 1s ago": the whole log jumped 37.1 px as the clock
  ticked. It is 110 px in both states now (2026-10-30).
- The first-run guide is a brief, not a box: at 760 px and below it drops the
  card, each of its four steps is one 44 px ruled line, and the step to do now
  keeps its instruction and its field under its own line. At 360 it is 334.8 px
  and the roster's first 60 px seat is wholly above the pinned save bar, where a
  446.2 px card left 27.8 px of it (2026-10-28).
- The Designer's fixed chrome is two rows and one bar line on a phone: the
  verdict, Inspector and ⋯ share one 44 px row even at 320 (the phone's
  Inspector is its word, without the decorative glyph, and so are the draft chip
  and the verdict: a chip's dot and a status glyph are decoration and must not be
  the 5 px that wrap the head), and the save bar's path
  and draft state share one 17.4 px line. The header is 141.6 → 89.6 px and the
  bar 107.4 → 74.4 at 320; the two blocks together are 164 px at 320 and 360,
  and the roster's first 60 px seat is wholly above the bar at both (2026-10-28).
- A page's last row is a way on, not a full stop: `NextLinks` is 13 px link text
  on a rule, 44 px tall at 620 px and below, and wraps rather than scrolls. It is
  a signpost, not a second band of primary buttons.
- The Graph phone view is a list of seats (who they talk to, how many messages)
  and the ranked links, not a 900 px drawing that scrolls inside its frame.
- The frame is two rows at 360, not three: the menu, the state chip and the
  actions share row one, and the project switcher is row two. The goal and the
  telemetry leave the bar below 800 px (the Overview opens with both; the chip
  keeps the state); the bar's primary action moves to the first row of `⋯`
  rather than wrapping. Pinned by `tests/dashboard/frame-phone.test.ts`. Since
  2026-10-31 the frame also has a row at the thumb — the five places the work
  lives, on the bottom edge — and that is not the bar's third row: it belongs to
  the navigation, which is a drawer at this width.
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
- **Where the navigation is a drawer (800 px and below), the five places the
  work lives sit at the thumb** — Overview, Product, Files, Events, Needs you —
  as one 52 px row on the frame's bottom edge, the same five at 320 and at 768.
  It is drawn only on a project page while the server is known, it is inert
  under the navigation sheet, and it is not drawn in the Designer, whose save
  bar owns that edge. The page reserves 64 px for it, so a page is 36 px taller
  and no control is ever under it. Pinned by `tests/dashboard/dock-phone.test.ts`
  (2026-10-31).
- **A figure is a door.** The Overview's four figures each open what explains
  the number (checks: the goal's own section here; ran-for: Steps; tokens: Cost;
  agents: Agents), and the control covers the cell the way a closed section's
  does. Its label carries the figure and the destination, because a button's
  contents are flattened into its name. Pinned by
  `tests/dashboard/overview-figures.test.ts` (2026-10-31).
- **A page is named by the name you pressed.** One component behind two routes
  ("Needs you" and "Tool gates") titles itself by the tab in front, never by a
  fixed word (2026-10-31).
- **A finger is a finger at every width.** The 44 px floor is a coarse pointer's,
  not only a phone's: at 768 on a touch screen the end-of-page links were 32 px
  (2026-10-31).
- **A console with no host is not asked a host's routes.** A single-mesh server
  answers neither `/api/projects` (the shell must ask it once to learn what it
  is) nor `/api/host/config`; the second was a 404 on every visit to Cost
  (2026-10-31).

## Open problems (carried forward)

- The Overview is now **1,088 px** at 360 px with a delivered mission (1,223 on this pass's base build, 4,132 before the 2026-10-22 folding and
  shipped-card work, 8,582 before that): the four evidence sections are one ruled row each until opened, and since 2026-10-28 those rows are
  also the phone's index. The open question is the default, not the length: What shipped is closed like the other three, and a mission that
  has just delivered may deserve its six file rows open; measured, the closed row is 53 px and the open panel 847, so the whole difference is
  one press or two screens.
- A phone's first screen is the whole hero (**746 px** at 360), so the four evidence rows start 76 px below the fold even after the index
  went. Shortening the brief is a words-and-shape decision about the mission, not a layout one, and it is the next lever on this page.
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
- At **320** the Designer's save bar gives the file name the line it needs, so a blocked draft's sentence sits under the path on one line and the
  bar is **112 px** where it was 110.4 with three lines and 68 of its 70.5 px of name. The cost is one line, and only for a long name: the
  36-character fixture is 93.4 at 320 and 360, the 56-character one 108.4 (two lines of name), and a blocked draft of either 112. The header
  at 320 is two rows since 2026-10-31: a 79.59 px title row (the title and a 157.69 px dotless save-state chip) and the 44 px verdict,
  Inspector and menu, 168.59 with its lede; before that the chip and the menu each took a row of their own (250.59). The one place the shape costs is
  the **lag** state at 390: 146.8 against 127.8, because its four-line sentence now has the path's line above it.
- The Designer's Inspector is a word on every phone layout now (91.7 px wide, no glyph); at 390 and 620 the glyph had room beside the word,
  so whether the phone should keep it is a reading question rather than a measurement one.
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
- The thumb's row is 53 px of chrome and 36 px of page on every project page from 800 px down (2026-10-31). It buys one press
  instead of two for five places, and the pages opened once pay it too. Whether it should hide on scroll, or be shorter than 52,
  is a use question; the measurement is in this pass's entry.
- The Files bar is 44 px at 360 and 390 and 96 at 320: 220 + 103.52 + 12 = 335.5 in 296, so the button keeps the line under the
  search there. The search's hint now reads "Name, owner,..." at 360; the next words decision is whether the 320 edge should
  shorten the hint rather than give the button a row, or whether the button should be a 44 px glyph (which would keep the hint at
  360 and 390).

## What the next pass should take

1. The Overview's first screen is still the whole hero (737 px at 360, the four evidence rows at 903): the next lever is a
   words decision — the goal sentence, the three ghost links (files, cost, replay) and the note are 190 px between them,
   and two of the three links now have a figure and a dock tab that say the same thing.
2. Whether the thumb's row earns its 36 px of every page: it is the owner's daily five, but a page opened once (Graph, the
   Playground) pays too. Watch real use before shortening the list or hiding the row on scroll.
3. Whether the Designer's bottom stays its own: the save bar and the dock cannot both own that edge, and the workbench is
   the one screen that is not a brief.
4. The events page's "Live" chip says what the stream is doing while the mission is delivered; decide whether one word can
   say both, or whether the chip should read the mission's state here as it does in the bar.
5. The figures cover their own numbers: selecting "51.0k" to paste it is no longer possible on the hero. A copy control, or
   a door that covers only the label row, would give it back.
6. The Designer's 320 header is two rows now (168.59 px with its lede; 89.6 on the first-run guide, which has no lede). The save bar's
   blocked state is the next block there: its 44 px inline action inflates the line from 17.4 to 36, and that 18.6 px is the last thing
   the bar could give back — it needs either a glyph button (a name lost) or a target overlap (a target collision).
7. Decide whether the Steps filter fold belongs above 620: at 621–768 the chips take two rows and the switch a third (166 px),
   though the page's own reading is one button there. The tablet's `NextLinks` now take the 44 px floor on a coarse pointer, so the
   chips are the last of that family.
8. Decide whether What shipped opens by default on a fresh delivery, and whether the phone's fold remembers a section (the page
   resets to all closed on every visit).
9. Measure the project strip at 621–800 with enough projects, in the hosted console where a registry exists; `curule console` cannot show it.
10. Remember the YAML preview's wrap choice, or move the toggle into the pane's own head; either is a small addition to a layer that now fits.
11. Check the Events and inbox end-caps against real live content before adding any row (the decision above).
12. Read the console with a real thumb on a real phone: the measurements here are Chromium at 360 px with touch emulation only in CSS, not a hardware device.
13. Check the frame's safe-area claims on a notched device in both orientations; the insets are in the CSS but the stand-in browser reports them as zero.

## Pass log

### 2026-10-31 — the five places the work lives sit at the thumb, and the Overview's figures are its index

Surface: `shell.tsx` (the dock), `styles.css` (its rules and the page's clearance), `views/MissionHero.tsx`,
`views/Overview.tsx`, `views/overview.css` (the figures' doors), `views/Escalations.tsx` (its title),
`ui/next.css` (the coarse-pointer floor), `views/Cost.tsx` (a host-only read), and four new or extended tests.
Measured on the scripted demo at **Delivered** (9 files, 7 checks, 491 events, 51.0k tokens, 7 seats) in the production
build, Chromium at 320/360/390/768/1440 in light and at 360/1440 in dark, a touch pointer at 768 and below, reduced
motion, axe-core 4.14. Before is the same worktree at `d1979b5`, built and served from the same server in the same
session; both halves are the same delivered mission, and both 360 × 800 frames are `#/overview` at `#view.scrollTop` 0
and `#/designer` at 0.

- **The console's five daily places were two presses and a layer away, from a screen whose far corner is the menu.** At
  360 from Events, the product was the menu (one press), then the sheet's Product row at y = 532–576 (one press), under a
  288 px sheet and its scrim. The same five are now a 53 px row on the bottom edge — 360 × 53 at y = 747, five 72 × 52
  tabs (64 × 52 at 320, 154 × 52 at 768) — and the product is **one press from every project page**, including the four
  (Events, Steps, Needs you, the Designer) that had no product door in the page at all. The row is drawn only where the
  navigation is a drawer, only when the server is known, never on a host page, and never on the Designer.
- **A figure is a door.** The Overview's four figures were 148 and 151 px of inert cells: the pages that explain them
  (Cost, Steps, Agents) were behind that same menu. Each cell is now its own control, covering the cell (167 × 148 and
  166 × 151, the same boxes), with a chevron and a label that carries the figure: "7 of 7 mandatory checks evidenced.
  Open goal checks.", "Ran for 10m 55s. See every step.", "Tokens: 51.0k of 2.0M. Open Cost.", "Agents: 7 seats. Open
  Agents." Pressing the checks at 360 opens the closed Goal checks section and lands on it (`#view.scrollTop` 933, focus
  on `#ov-goal`); the other three leave for their page. Pointed at or reached by the keyboard, the whole figure takes the
  wash; in forced colours it takes a 2 px Highlight outline instead.
- **A page is named by the name you pressed.** The sidebar's "Tool gates" and the palette's "Go to Tool gates" opened a
  page headed "Needs you": the side says one name, the page said another, and the tab was the only thing that agreed with
  the link. The heading follows the tab now ("Tool gates" at `#/gates`, "Needs you" at `#/escalations`), and the document
  title already did.
- **The 44 px floor reaches a touch-class 768.** Every `NextLink` on Agents, Files, Cost, Graph and the Playground was
  **134.3 × 32** at 768 on a touch screen — the console's one control under its own floor there. A coarse pointer takes
  **132 × 44** now; a mouse at 768 keeps the quiet 32.
- **Cost stopped asking a route only a host has.** On every visit a single-mesh console asked `/api/host/config` and
  logged a 404 for a context that cannot exist; the read waits for a registry to answer now. The one console error left
  is `/api/projects`, which the shell must ask once to learn what kind of server this is.
- **What the row costs is 36 px of page.** `#view` reserves 64 px at the bottom (52 of tab, 12 of gutter) on the pages
  that draw it: Overview **1,171 → 1,207** at 320, **1,079 → 1,115** at 360 and 390, **3,129 → 3,165** at 768 and
  **1,934 → 1,934** at 1,440; Agents 1,191 → 1,227 (1,120 → 1,168 at 768, the extra 12 being the NextLinks' floor);
  Cost 1,614 → 1,650 (1,187 → 1,235); Files 1,083 → 1,119 (954 → 1,002); Steps 3,102 → 3,138 (2,626 → 2,674); Graph
  1,881 → 1,917 (1,540 → 1,588); Product 1,508 → 1,544 (1,236 → 1,284); Playground 1,057 → 1,093 (736 → 765). Events,
  Needs you, Tool gates and Host settings are exactly as they were (their content is a viewport-height pane), and the
  Designer is unchanged at every width (1,088 / 1,050 / 1,015 / 839 / 736) because it draws no dock and reserves none.
  At the end of every page no control is left under the row: the event list's own scroller ends 11 px above it.
- **Nothing else moves.** No document or `#view` sideways scroll at 320/360/390/768/1440 in light or 360/1440 in dark;
  axe-core **0** violations in 26 reads (13 views × 360 and 1,440 in light, 4 views at 360 and 1,440 in dark; 23–37 rules
  passed each); one console error in both halves (the one-mesh `/api/projects` 404, and before it was two on Cost); the
  smallest text stays 11 px (the avatar initials and the Designer's seat flags); the dock's tabs are 72 × 52 at 360, so
  they clear the floor by 8 px in the narrow direction.

Suite: typecheck and build clean; `node --test "dist/tests/**/*.test.js"` **6,431 tests, 6,429 pass, 0 fail, 2 skipped**;
`dist/tests/dashboard` **1,203 pass, 0 fail**, with three new files (`dock-phone`, `overview-figures`, `inbox-title`)
and one rule added to `page-exits` and to `failure-states`; eslint 0 errors (211 pre-existing cross-package warnings).

**Left.** The dock hands 36 px of every page to the frame: the trade is one press instead of two for five places, and it
is worth watching whether the row earns it on the pages opened once (Host settings is not one — it draws no dock). The
Overview's hero is still 737 px at 360, so the four closed evidence rows begin below the fold (903 after the row); the
figures now open what explains them, but the first screen is still the whole brief. The drawer's twelve rows still show
a 1–9 key hint on a surface that has no keyboard — it is a hover for a mouse, so a thumb never sees it. The figures cover
their own words, so the numbers can no longer be selected and copied (the fold accepted the same trade). The Designer
keeps its own bottom and therefore its own grammar at that edge; whether a workbench should have the row too is a reading
question. The events page's chip still says "Live" on a delivered mission because it describes the stream, not the
mission — a word to revisit with the mission chip beside it.

### 2026-10-31 — a phone's Designer head is two rows at 320, because its status is its words

Surface: `designer/designer.css` (the 760 block) and three rules in `tests/dashboard/designer-phone.test.ts`. Measured on the
scripted demo at **Delivered** (9 seats, 36 wires, the draft "No unsaved changes", the verdict "Valid, 2 notes") in the
production build, Chromium at 320/360/390/768/1440 in light and 360/1440 in dark, a touch pointer at 768 and below, reduced
motion, axe-core at 320/360/390/1440 light and 360/1440 dark. Before is the same worktree with only the stylesheet reverted,
built and served in the same session; both halves are `#/designer` at `#view.scrollTop` 0 on the same delivered mission.

- **The head was four rows at 320, and the menu had a row to itself.** The title row needed **296.57 px** in 292 (title 116.88 +
  8 + the draft chip 171.69) and the action row **301.5** (verdict 142.34 + 8 + Inspector 99.16 + 8 + the 44 px menu), so the
  chip took a row of its own and the menu a third: the head was **250.59 px**, the menu at y = 195.59 with **248 px of dead
  ground** beside it, and the roster's first seat at **425.17**.
- **The two marks were decoration around words, and they were the 5.3 and 9.5 px that did not fit.** The draft chip's dot
  (6 px and its 6 px gap) and the verdict's alert glyph (14 and 6) are not the state: "No unsaved changes" and "Valid, 2 notes"
  are. Without them the rows are **282.57** and **281.5**, the head is **two rows, 168.59 px**, the lede is **82 px** higher
  (165.59), the body is **256.59** (was 338.59) and the page **1,170 → 1,088**. The first seat is **343.17** (was 425.17) and
  the first screen holds **four whole seats** where it held three (4.9 px of the fifth shows above the 725.61 bar).
- **360 and 390 do not move a row.** The head is 168.59 at 360 and 147.59 at 390 in both builds; the chip is 12 px narrower
  (171.69 → 157.69), the verdict 20 (142.34 → 122.34), Inspector starts at 144.34 (was 164.34) and the menu at 251.5 (was
  271.5), so the menu now ends at 295.5 in a title row that ends at 346. 768 and 1,440 are outside the 760 block and keep the marks
  (chip 171.69, verdict 142.34 with its glyph). Dark reads the same geometry as light.
- **Nothing is lost, and the floors hold.** Every word, name and control stays: the chip is still `role="status"` with its
  `title`, the verdict is still a 122.34 × 44 button with `aria-expanded`, `aria-haspopup` and its checks panel, Inspector is a
  99.16 × 44 word and the menu a 44 × 44 glyph with the same five items; the same 16 targets and tab stops. No document or
  `#view` sideways scroll at 320/360/390/768/1440; no text under 12 px (the 11 px avatar glyphs aside); no control under 44 × 44
  at 320/360/390; **0** axe violations at 320/360/390/1440 light and 360/1440 dark (23/23/23/32/23/32 rules passed); the one
  console error is the one-mesh `/api/projects` 404.

Suite: typecheck and build clean; `dist/tests/dashboard` **1,192 pass, 0 fail** with three new rules in `designer-phone.test.ts`
(each mutation-checked: the dot rule removed, then the glyph rule, then the chip's inset, each failed its assertion and was
restored); `dist/tests/build` (`console-palette`, `icons`, `ui-kit-tokens`, `dist-coherence`, `no-mojibake`) **21 pass**.

**Left.** The two marks are gone on every phone layout, not only at 320 (a 360 screen has the room and loses them too, because
one phone shape is the rule). The 320 first screen now shows four seats and 4.9 px of the fifth; the head is 168.59 with its
three-line lede, and that lede is the next 63 px.

### 2026-10-30 — an open event is the page on a phone, and its close stays in reach

Surface: `views/events.css` (the 900 block and the pane's own gutter) and `evdetail.tsx` (the title row moved out of the head so
it can stick for the whole scroll), with one new rule in `tests/dashboard/events-phone.test.ts`. Measured on the scripted demo
at **Delivered** (491 events, 300 in the first bucket; event #98, "tech-lead approved the architecture in payment-architecture")
in the production build, Chromium over CDP at 320/360/390/620/768/900/1440 in light and at 360 in dark, a touch pointer at 768
and below, reduced motion, axe-core at 360 and 768 in both schemes. Before and after are the **same delivered mission**, served
from two builds in one session (the dashboard's `dist` swapped under a running server, `cache-control: no-cache`); both
360 × 800 frames are `#/events` with the same event open, the pane at `scrollTop` 480 and the mission-delivered notice
dismissed on both.

- **The log's search and filters sat above a log that was not on screen.** Below 900 an open event hides the stream
  (`display: none`), and the search row (44 px at 360, **96 at 320**) and the filter fold (112 px at 768, 114.5 at 900) stayed.
  They narrow a list nobody can see: driven at 360 on the base build, pressing **Filters** open grew a 262 px panel and left the
  event **258 px** of the 736 px view. With the split they step aside: the pane is **532 → 586** at 360, **442.9 → 548.9** at
  320, **429 → 607** at 768 and **434.5 → 607** at 900, and its content (1,583 px here) is read in a 530 → 584 px window.
- **The way back was at the top of that pane.** At 360 the pane held 1,583 px of content in 530, and the title row — the kind,
  its mark and Close — scrolled with it: at the pane's end (`scrollTop` 1,053) the close was **1,036.6 px above the pane's top**
  and 796.6 px above the top of the screen. The row sticks now, bleeding by the pane's own gutter as a drawer's head does: the
  close is at **y = 202.4** at `scrollTop` 480 and at the pane's end (999) as at 0. Its margins cancel its padding, so nothing
  moves at rest — at 360 the meta line is 255.8 with the pane at 186 as it was 309.8 with the pane at 240, and the thread's
  first row 650 (464 into the pane) as it was 704 (464 into the pane).
- **The desk does not move.** 1,440 keeps the list beside the pane: the pane **478.3** at y = 293.7, the title 310.7, the meta
  354.7, the thread 612.3 and the close at x = 1,355 — identical to the pixel in both builds, tools and facets still above both
  panes (a desk's pane still scrolls its title away; the list is beside it and Escape closes it). 620 and 390 gain the search
  row (553 → 607 and 532 → 586); 320 gains **106** px (its 96 px tool bar and the row's margin) and 768 **178** (44 + 112 plus
  the two margins).
- **Nothing is lost, and the floors hold.** The search, the Filters button, its count and the chips are still in the page and
  come back when the event closes; the close keeps its name ("Close event detail"), its 44 × 44 box and its one press. **0** axe
  violations on the open pane at 360/768 light and dark (23 rules passed each) and on the closed page at 360 (24); no document
  or `#view` sideways scroll at any width; the pane's smallest text is 12; one console error in both halves (the one-mesh
  `/api/projects` 404).

Suite: typecheck and build clean; `dist/tests/dashboard` **1,192 pass, 0 fail**, with the new `events-phone.test.ts` (each of
its three rules mutation-checked: the `:has` rule removed, then `sticky` put back to `relative`, each failed its rule and was
restored); `npm test` **6,416 tests, 6,414 pass, 0 fail, 2 skipped**; eslint on the changed `.tsx` and the new test 0 errors
(the stylesheet is not in eslint's config).

**Left.** A reader who wants to search the log while an event is open must close the event first — one press, now always in
reach. The sticky band keeps the pane's top 66 px at 360 (14 + the 46.8 px two-line kind + 8), which is the row that was
already there and is now painted with a hairline. A desk's pane still scrolls its title away, by choice; whether the desk
should keep its title too is a reading question the list beside it answers.

### 2026-10-30 — a phone's page head stays one line, and the Events log starts 37 px higher

Surface: `styles.css` (the thumb/pointer block) and one rule in `tests/dashboard/phone-head.test.ts`. Measured on the
scripted demo at **Delivered** (481 events, 300 in the first bucket) in the production build, Chromium over CDP at
320/360/390/768/1440 in light and 360/1440 in dark, a touch pointer at 768 and below, reduced motion, axe-core at 360 and
1440 in both schemes. Before is the same worktree with only the stylesheet reverted, built and served in the same session;
after is this branch, rebuilt; both halves were read on the same delivered mission within the minute, and both 360 × 800
frames are `#/events` at `#view.scrollTop` 0 with the live chip at its widest ("Updated just now").

- **The Events head was two rows whenever the live chip read "Updated just now".** At 360 the title row needed **333.1 px** in
  332 — 88 title + 12 + 177.1 chip + 12 + the 44 px hold — so the hold took a 44 px row of its own above the lede with
  **288 px of dead ground** beside it: the head was **147.1 px**, the lede at 165.1, the search at 223.1 and the first event
  at **357**. A second later the chip reads "Updated 1s ago" (166.6 px), the row fits, and the head is **110**: the head, the
  lede, the search and the whole log **jumped 37.1 px** as the clock ticked. 40 samples over 10 s at 360: **13 tall (147.1),
  27 short (110)**.
- **A phone's page head now uses the row's 8 px gap**, as the Designer's phone head already did, so the row is 325.1 px and the
  hold keeps the title row whatever the chip says: head **147.1 → 110**, title row **81.1 → 44**, the hold **y = 115.1 → 78**
  (still 44 × 44 at x = 302), the lede **165.1 → 128**, the search **223.1 → 186**, the bucket **278.1 → 241**, the first event
  **357 → 319.9**. The first screen now holds **42 px of the seventh event** where it held 5, and 40 samples over the next 10 s
  read **40 at 110** while the chip's words changed underneath.
- **320 keeps its row, and the desk does not move.** At 320 the row is 325.1 in 292, so the hold still takes its own 44 px row
  (head 147.1, first event 425.9, unchanged): on the narrowest phone the action row is the grammar's own. 390 is unchanged in
  height (110, the row already fitted) and 768 / 1,440 are unchanged to the pixel (81; the hold is the 168 × 36 word at
  y = 78 / 86.2, the first event at 368.9 / 367.6). Dark at 360 reads the same as light, and 1440 dark the same as 1440 light.
- **The cost is 4 px of the status chip.** The chip now sits 8 px from its title instead of 12: at 360 it is at x = 110 (was
  114), and the same 4 px applies on Agents, Steps and the Designer's already-8 px head. No control changed size or place at
  768 and 1,440; the hold is still 44 × 44; no control in Events is under 44 × 44 at 320/360 (the `h2` is a heading, not a
  target); no text is under 12 px; neither the document nor `#view` scrolls sideways at any width; axe-core finds **0**
  violations at 360 light/dark and 1,440 light/dark (24/24/28/28 rules passed). The one console error is the one-mesh
  `/api/projects` 404.

Suite: typecheck and build clean; `dist/tests/dashboard` **1,187 pass, 0 fail**, with one new rule in
`tests/dashboard/phone-head.test.ts` (mutation-checked: the gap put back to `--s3` fails it, then restored).

**Left.** A 4 px tighter status on every phone head is the trade for a head that cannot grow on a clock; whether the desk's 12
should stay the phone's too, on heads with no action, is a reading question the measurement does not answer. At 320 the action
row stays: a 325.1 px row in 292 is not a gap problem, and closing it would need the live chip's words or a narrower search.

### 2026-10-30 — a phone's step drawer is the whole screen, and its head meets its edges

Surface: `views/drawers.css` (the 620 phone block) and one new rule in `tests/dashboard/drawer-phone.test.ts`. Measured on the
scripted demo at **Delivered** (28 turns) in the production build, Chromium over CDP at 320/360/390/768/1440 in light and 360 in
dark, a touch pointer at 768 and below, reduced motion, axe-core at 360 light and dark. Both frames are the first turn's drawer
on the same delivered mission, read from the same server before and after the build; the turn's age reads 37m in the before frame
and 39m in the after, and it is the same turn (`turn-48275b`).

- **The step drawer is the one panel that kept a desk width on a phone.** Every other drawer's phone rule is `100vw`
  (`styles.css`); the step's `:has(.stepv)` rule (`min(760px, 96vw)`) outranks it, so at 360 the drawer was **345.6 px at
  x = 14.4** (320: **307.2 at 12.8**, 390: **374.4 at 15.6**) — 12.8–15.6 px of a page that cannot be read peeking beside it.
  It is **320 / 360 / 390 at x = 0** now, and the body's content is **288 / 328 / 358** (was 275.2 / 313.6 / 342.4).
- **Its sticky head was 12 px wider than the drawer, and the drawer scrolled 6 px sideways.** The head's bleed was written for
  the desk's 22 px padding (`margin: … -22px`), but the phone drawer pads by 16: at 360 the head was **357.6 px at x = 8.4**,
  **6 px past the drawer on each side**, its 1 px rule ran from 8.4 to 366 (a 6 px stub on the scrim), and the drawer's
  `scrollWidth` was **352 in a 346 px client**. The head bleeds by `--s4` on a phone and sticks from the notch as the shared head
  does: **320 / 360 / 390 at x = 0, 0 px of sideways scroll**, and the rule 0–320 / 0–360 / 0–390.
- **The head is 44 px shorter at 360, because the content is 14.4 px wider.** At 360 the head was **281.1 px** and is **237.1**;
  the first section moves up 44 px. At 320 it is **296.1 → 295.1** and at 390 **237.1 → 237.1**.
- **Nothing else moves.** 768 and 1440 are outside the 620 query and unchanged to the pixel (drawer 737.3 / 1,180, head 736.3 /
  1,179, the head inside the drawer's 1 px border); dark at 360 reads the same geometry; the close is still 44 × 44 at x = 300–344 at 360 and the walker's
  arrows 44 × 44, the same tab stops (focus lands on the close, Tab goes to the first jump chip), 0 axe violations at 360 light
  and dark (31 rules passed), no document or `#view` horizontal scroll, and the one console error is the one-mesh
  `/api/projects` 404.

Suite: typecheck and build clean; `dist/tests/dashboard` **1,186 pass, 0 fail**, with the new rule in `drawer-phone.test.ts`.

**Left.** At 768 the step drawer is still 96vw (737.3 in 768, a 30.7 px peek): that is the tablet's slide-over, and its head
already meets its edges because the tablet keeps the desk's 22 px padding. The phone's peek was the only visible sign that the
page was behind; the close (44 × 44) and Escape are the ways out, as in the agent and file drawers, which were already 100vw.

### 2026-10-30 — a phone's Files filters share the search's row, and the first file is 52 px higher

Surface: `views/files.css` (the 620 phone block) and one rule in `tests/dashboard/files-phone.test.ts`. Measured on the scripted
demo at **Delivered** (9 files: 3 approved or merged, 6 in review) in the production build, Chromium over CDP at
320/360/390/768/1440 in light and 360/1440 in dark, a touch pointer at 768 and below, reduced motion, axe-core at the same
widths. Before is the base build from this worktree; after is this branch, delivered again because the demo was restarted for the
new build: the file ages read 35m in the before frame and 1m in the after, and the same nine files are listed in both.

- **The Files bar is one 44 px row at 360 and 390.** The search and the counted Filters button were two rows: the search 336 px
  (366 at 390) on its own line, the **103.52 × 44** button alone at y = 221.59 with 232 px of dead ground beside it. The search now
  takes a 220 px basis (220.48 at 360, 250.48 at 390) and the button sits beside it at x = 244.48 (274.48): the bar is
  **96 → 44**, the first group, "Approved and merged 3", begins **281.59 → 229.59**, the first file is 52 px higher, and the page
  is **1,135 → 1,083**. The first screen keeps the same nine files but 52 px more of the sixth row.
- **At 320 the two do not fit, and the button keeps its row.** 220 + 103.52 + 12 = 335.5 px in 296: the search keeps its 296 px
  line, the button takes the 44 px line under it, the group begins at 281.59 and the page is **1,259**, as before. The rule is the
  search's own `max-width` over the base 220/200 basis; there is no 320 special case.
- **768 and 1,440 are outside the 620 query and do not move** (954 and 926 px; the bars 104 and 52). Dark at 360 reads the same
  geometry; the type stays on the ramp (the smallest word on the page is 12), no control is under 44 × 44 at 320/360/390, and
  neither the document nor `#view` scrolls sideways at any width.
- **The cost is the search's hint.** The field's text area is 130.48 px at 360, so "Name, owner, type or path" reads
  **"Name, owner,..."** (at 390, "Name, owner, type..."). The field's name is still "Search files", the page's lede still says
  "copy its path", and the search accepts all four; Events' 232 px search has already been read the same way ("Messages, ag...").
- **The controls are unchanged.** The button is still 103.52 × 44, with its word and count ("Filters (2)" with two on), its
  `aria-expanded`/`aria-controls` and its full-width panel; the search is the same 16 px field with its clear button. axe-core
  finds **0** violations at 320/360/390/768/1,440 light and 360/1,440 dark (25/25/25/27/30 rules passed).

Suite: typecheck and build clean; `dist/tests/dashboard` **1,185 pass, 0 fail**, with one rule rewritten in
`files-phone.test.ts` to the shape this entry describes.

### 2026-10-29 — a phone's Steps timeline is a drawing, and each turn is a row

Surface: `views/Steps.tsx` (the strip and `LaneRow`), `views/steps.css` (the mark rule and its caption) and one new rule in
`tests/dashboard/steps-phone.test.ts`. Measured on the scripted demo at **Delivered** (28 turns, 49.3k tokens, 7 lanes) in the
production build, Chromium over CDP at 320/360/390/620/768/1440 in light and 360/1440 in dark, reduced motion, a touch pointer at
360 and 768, axe-core at 360 light and 1440 light/dark. Before is the base build rebuilt from this worktree, after is this branch;
both were read on the same delivered mission within the hour, and the 360 × 800 captures are at **`#view.scrollTop` 500** on both
sides — the console scrolls `#view`, not the window, so the camera sets that property rather than `window.scrollY`.

- **The chart's 28 marks were buttons 4–18 px wide.** At 360 the timeline drew **28 buttons of 4.0–17.6 × 16** px (320: 4.0–15.2;
  390: 4.0–19.3; 620: 4.5–32.7), every one under 44 × 44, and they were the only marks in the console that took a press below the floor
  (the notify switch stays a 34 × 20 input inside its 44 px label; the timeline's window buttons are 44 px-tall text). At 621 and 768 a
  touch tablet opens the chart **by default**, so those 28 buttons were 4.0–22.8 and 4.0–28.3 × 16 without a press. On the phone layout
  (620 and below) or a coarse pointer the marks are spans: **28 → 0 of the chart's marks take a press** at 320/360/390/620 and at 768
  coarse (the four window buttons stay, 35–41 px wide and 44 tall); the same 28 marks keep each turn's position, outcome colour and
  duration.
- **The turn is a row a thumb can hit, and the chart says so.** The same turn is the ledger's whole-row button — 294 × 86 at 320,
  334 × 86 at 360, 594 × 86 at 620, 742 × 61 at 768, unchanged — and pressing a mark now opens nothing while the first row still opens
  the turn's drawer (a tap on a mark left only the closed navigation layer; a click on the row added the step drawer). A 12 px sentence
  under the axis, "Each turn is a row in the list below.", is the frame's visible change: the opened chart is **3,811 → 3,839** at 360,
  **3,914 → 3,942** at 320, **3,770 → 3,797** at 390 and **3,430 → 3,457** at 620, and a touch tablet's default page **2,648 → 2,676**
  at 768.
- **Nothing else moves.** A phone's closed page is 3,191 at 360 (3,294 at 320) in both halves; a mouse's chart is unchanged to the
  pixel at 768 (2,535) and 1,440 (2,438) and keeps its 28 buttons, tooltips and roving keyboard; every page is 0 px of horizontal
  scroll at 320/360/390/620/768/1,440 (light and 360/1,440 dark); the desktop's walk from the caption to the first row stays 12 Tabs and
  the phone's shortens **9 → 8**, because the chart no longer adds a roving stop. The marks still draw in Windows High Contrast
  (CanvasText and Canvas at 360), the `hot` mark still lights when its ledger row is pointed at (`1`), and axe-core finds **0**
  violations at 360 light and 1,440 light/dark (27 and 30 rules passed, as before); the console errors are the one-mesh
  `/api/projects` 404 in both halves.

Suite: typecheck and build clean; `dist/tests/dashboard` **1,185 pass, 0 fail**, with one new rule in
`tests/dashboard/steps-phone.test.ts`; `npm test` **6,403 tests, 6,401 pass, 0 fail, 2 skipped**; eslint on the changed files 0
errors (the stylesheet is not in eslint's config).

**Left.** A phone can no longer open a turn by pressing its mark; the mark was 4–18 px wide, and the row below is the same door at
thumb size. At 621–768 with a mouse the chart is open by default and its marks remain 4–28 px buttons — a mouse target, not a thumb's,
which is the same tablet question the 44 px `NextLinks` left open. The chart's caption is a sentence, not a control: it says where the
doors are but does not take the reader there.

### 2026-10-29 — a closed row is one press across its width, and it says so before the press

Surface: `views/overview.css` (the 620 phone block and the forced-colours block), the docstring in `views/Panel.tsx`, and two new rules in
`tests/dashboard/overview-fold.test.ts`. Measured on the scripted demo at **Delivered** (9 files, 7 checks, 508 events) in the production
build, Chromium over CDP at 320/360/390/768/1440 in light and at 360/1440 in dark, reduced motion, a touch pointer below 768, forced colours
at 360, axe-core at 360 and 1440 in both schemes. Before is the base build served from its own checkout on 7462, after is this branch on
7460; both were read on the same delivered mission within the hour, and every press below is a real pointer event at the coordinates named.

- **A closed row opens where it is pressed.** At 360 the row is **336 × 53** and its Show control **56 × 44** at the right edge, so the
  264 px of name and figure beside it were dead: a press 40 px into the row opened **0 of 4** sections at 320, 360 and 390, while a press at
  the control's centre opened 4 of 4. The control's own pseudo-element now covers the closed section — a pseudo-element of a button *is* the
  button — so the press the row takes is the press on Show: **4 of 4** at 320 (296 × 53 rows), 360 and 390 (366 × 53), with the control
  still 56 × 44 and still the one tab stop. The Graph's phone rows have always been whole-row buttons (294 × 88 of a 294 × 88 row); the
  Overview's four doors were the console's only handle-only row.
- **The row says it is a door before the press.** Pointed at, the whole band takes `--panel-2` (its background was `rgba(0,0,0,0)`), and
  reached by the keyboard the same band lights under the control's existing 2 px ring — 29 tab stops in both halves. In forced colours, where
  a background is not a signal the system keeps, the band becomes a **2 px Highlight outline** where there was none.
- **Nothing moves: 0 px at every width.** 320 **1,107** / 360 **1,088** / 390 **1,043** / 620 **915** / 621 **3,166** / 768 **3,103** / 1,440
  **1,751**, identical in both halves in light and dark; the row is still 53 px, the control 56 × 44, the four names and their figures
  unchanged, and no control was added or removed.
- **The press cannot move its own target.** The shared small button nudges itself 0.5 px on `:active`, and a transformed button becomes the
  containing block of its own pseudo-element: the first shape collapsed the overlay to 56 × 44 between pointerdown and pointerup — measured
  at 360, pointerdown landed on `BUTTON.small` and the click on `DIV.card-head`, and the row stayed closed. The closed row's control keeps
  `transform: none` on `:active`; the pressed fill and shadow stay.
- **The floor holds.** 140 view × width × theme reads with no document or `#view` horizontal scroll, the smallest text 11 px (the avatar
  glyph), no control under 44 × 44 below 768 beyond the recorded 34 × 20 checkbox inside its 44 px label, 0 console errors (the one-mesh
  `/api/projects` 404), and axe-core 0 violations on Overview and the other thirteen views at 360 and 1440.

Suite: typecheck and build clean; `dist/tests/dashboard` and `dist/tests/build` as reported in the pass record; eslint on the changed files
0 errors (the stylesheet is not in eslint's config).

**Left.** The words of a closed row can no longer be dragged to select, because the row is the control there; the heading and figure are read
in the body one press later, and the four `h3`s are still the page's outline. For a screen reader the row is still a heading and a figure with
one button beside them — a door for a thumb, a heading and a control for a reader — which is the shape that keeps one name per control and no
second tab stop. Whether the head should be a real button (and the `h3` move into it) is the markup question this pass answered with CSS, and
it is not measured on a hardware device.

### 2026-10-29 — the save bar shows the whole file name, and a state that holds a button takes the line under it

Surface: `designer/designer.css` (the 760 phone block) and one rule in `tests/dashboard/designer-phone.test.ts`. Measured on the
**first-run** project (the scaffold's placeholder goal, one seat, 4 events) in the production build, Chromium over CDP at
320/360/390/768/1440 in light, at 360 in dark, in forced colours and at a 32 px root, axe-core at 360 light and 1440 dark and on the
blocked bar at 320 — and on two copies of the same fixture whose file is called `a-much-longer-mesh-config-name.yaml` (36 characters,
273.9 px) and `an-even-longer-mesh-config-file-name-than-that-one.yaml` (56, 430.5 px), at 320 and 360. Before is the base build on 7986,
after is this branch on 7956 and 7966, all read on the same four-event state within the hour.

- **The file name is whole at every phone width.** The 88 px floor kept a nine-character name whole but not a name sharing the line with a
  state: at 320 the 36-character name showed **97.8 of its 273.9 px**, and in a blocked draft **68 of 273.9** with the whole path only in a
  `title` a phone cannot hover. The file row wraps now and the path takes the line its name needs
  (`min-width: max(88px, min(100%, max-content))`, with the folder `contain: size` so its own text cannot decide the break): **273.9 of
  273.9** in both states, the folder still 31.3 px of it. At 360 the same name reads 137.8 → **273.9**, and a 56-character name (430.5 px)
  wraps onto a second line and is whole there too, where it showed 97.8.
- **A blocked draft's sentence leaves its 200 px column.** With the goal emptied, "1 error blocks saving. Show the error" was three lines of
  53.4 px in the column beside an 88 px path; with the row wrapped it has the whole 296 px and is one line of **36**, and the bar is
  **110.4 → 112 px** at 320. At 360 nothing moves: the path and that state still fit one line (102.3 + 229.8 in 336), so the bar stays 93.
  The shape the last entry proposed — giving the state its own line whenever it holds a button — measures **112 at both widths**, i.e. a
  regression at 360; the wrap rule is what makes the move free there and affordable at 320.
- **The good bar does not move.** 74.4 at 320, 360 and 390 as before, because the path and the state still share the line; the path gains the
  row's 4 px gap (117.8 → 121.8 at 320, its folder 27.3 → 31.3; 157.8 → 161.8 and 67.3 → 71.3 at 360). The header (89.6), the guide (352.2 at
  320, 334.8 at 360), the guide's goal field (316.8 / 299.4), the roster's first seat (628.3 / 597.4) and the page (792 in a 780 px frame at
  320) are unchanged to the pixel, so the seat is still whole above the bar.
- **A long name costs one line, and only that project's bar.** The 36-character fixture is 74.4 → **93.4** at 320 and 360 (its name takes the
  line, the state goes under it), the 56-character one 74.4 → **108.4** at 320 for two lines of name, and a blocked draft of either 112. The
  lag state, read from its own markup because no save was driven, is 181.2 → **146.8** at 320 and 145.2 → 146.8 at 360, but 127.8 → 146.8 at
  390: the one width where the path's line above a four-line sentence costs 19 px.
- **Nothing else moved.** 768 and 1440 are unchanged to the pixel (bar 65 and 57, guide 428.8 and 394); dark, forced colours and a 32 px root
  read the same geometry in both states; no document or `#view` horizontal scroll at 320/360/390/768/1440; 0 text under 12 px (the bar's
  smallest is 12) and 0 controls under 44 × 44 at 320/360/390; 1 console error in both halves (the one-mesh `/api/projects` 404; a blocked
  read adds the 400 the emptied goal's own check makes, in both halves); axe-core **0** violations at 360 light and 1440 dark (24 and 32
  rules passed, as before) and on the blocked bar at 320 (25). No markup changed, so the keyboard is untouched: **8** Tabs to the guide's
  goal field, **13** to the roster's first seat, the same drawer order after Enter.

Suite: typecheck and build clean; `dist/tests/dashboard` **1,180 pass, 0 fail**, with one rule in `designer-phone.test.ts` rewritten to the
shape this entry describes (the `min-width` assertion reads the max-content claim, 88 px still its floor, and the row's `flex-wrap` is
pinned); the build and primitive tests (`console-*`, `icons`, `type-ramp`, `css-vars`, `forced-colors`, `primitives-a11y`) **35 pass**;
eslint on the changed test 0 errors (the stylesheet is not in eslint's config).

**Left.** A long name buys the bar one line (93.4 at 320/360, 108.4 for 56 characters), and the lag state pays 19 px at 390 for that trade.
The blocked state's action is still a 44 px inline link that inflates its line from 17.4 to 36: that 18.6 px is the last thing the bar could
give back, and it needs either a glyph button (a name lost) or a target that overlaps the save row (a target collision). The 320 header's
89.6 px and its 155.8 px chip are next.

### 2026-10-28 — the Designer's fixed chrome is two rows at every phone width

Surface: `designer/designer.css` (the 760 block) and one new rule in `tests/dashboard/designer-phone.test.ts`. Measured on the
**first-run** project (the scaffold's placeholder goal, one seat, 4 events) in the production build, Chromium over CDP at
320/360/390/768/1440 in light, at 360 in dark, in forced colours and at a 32 px root, axe-core at 360 light and 1440 dark — and on the
scripted demo's Designer at 360, where there is no guide, to show the bar gives back the same 33 px. Before is the base build from its own
checkout on 7736, after is this branch on 7756, both read on the same four-event state within the hour.

- **At 320 the header is two rows, not three: 141.6 → 89.6 px.** The three actions measured 128.5 + 119.7 + 44 = 308.2 px in a 292 px row,
  so the 44 px ⋯ menu alone took a third. The Inspector's sliders glyph was decoration around its name; without it the button is **91.7**
  and the row **280.2**. The word, the 44 × 44 target, `aria-pressed`/`aria-controls` and the keyboard are unchanged: Inspector is still the
  5th stop, 8 Tabs reach the guide's goal field and 13 the roster's first seat.
- **The save bar is a line and a row, not two: 107.4 → 74.4 px at 320 and 360.** The path and "The draft matches mesh.yaml." each had a
  34.4 px line; they share a **17.4** px line, and the bar's rhythm is 4 px (padding 10 → 4, gap 8 → 4). The path is **117.8** px at 320
  (the folder cuts, `mesh.yaml` is whole) and 157.8 at 360; the state is **170.2** on one line at both. On the demo's Designer the bar is
  the same 107.4 → 74.4 and the page 1,052 → 1,019, with the header (147.6) and seat row (308.6–405.9) untouched.
- **The roster's first 60 px seat is whole at 320.** It ended **3.7** px under the 736.6 bar (680.3–740.3); it is **628.3–688.3** above
  the 769.6 bar, 81.3 px clear. The fixed chrome is **249.0 → 164.0** at 320 and **197.0 → 164.0** at 360, so the first screen gives the
  work 85 px more at 320 and 33 at 360. The guide (352.2 at 320, 334.8 at 360), the page's top (76) and the seat's top at 360 (597.4) do
  not move.
- **A blocked draft still says so, and the bar grows rather than cutting the file name.** With the goal emptied and "1 error" the bar is
  **126 → 110.4** px at 320 (the base state was measured first); the state takes 200 px and wraps to three lines, and the path keeps its
  88 px (icon, gap and `mesh.yaml`). The state's buttons are still visible, 44 px and never hover-only.
- **Nothing else moved.** 390: header 89.6, bar 74.4, seat 597.4–657.4. 768 (above the phone layout) and 1440 are unchanged (guide
  428.8/394, bar 65/57, page 1,186/1,051). No document or `#view` horizontal scroll at 320/360/390/768/1440, **0** text under 12 px,
  **0** controls under 44 × 44 at 320/360/390/768, forced colours and a 32 px root the same geometry, 1 console error in both halves (the
  one-mesh `/api/projects` 404), and axe-core **0** violations at 360 light and 1440 dark (24 and 32 rules passed, as before).

Suite: typecheck and build clean; `dist/tests/dashboard` **1,180 pass, 0 fail**, with one new rule in `designer-phone.test.ts`; the build
and primitive tests (`console-*`, `icons`, `type-ramp`, `css-vars`, `forced-colors`, `primitives-a11y`) **35 pass**; eslint on the changed
test 0 errors (the stylesheet is not in eslint's config).

**Left.** A blocked state's 200 px column wraps to three lines (bar 110.4), and giving it the line under the path when it holds a button is
the next small shape; the 320 path shows the file name and a fragment of the folder, with the full path in the title. The Inspector is a
word on every phone layout now, which is a reading question at 390 and 620 where the glyph had room.

### 2026-10-28 — the first-run guide is a ruled path on a phone, and the roster opens on its seat

Surface: `designer/designer.css` (the guide's phone block) and one rule in `tests/dashboard/designer-phone.test.ts`. Measured on a
**first-run** project (the scaffold's placeholder goal, one seat, 4 events, `goal-M614ST980`) in the production build, Chromium over CDP
at 320/360/390/768/1440 in light, at 360 in dark, in forced colours and at a 32 px root, axe-core at 360 light and 1440 dark — and on the
scripted demo at **Delivered** at 360/390/1440 light and 360 dark, to show nothing moves where there is no guide. Reduced motion, a touch
pointer at 768 and below. Before is the base build from its own checkout on port 7716, after is this branch on 7726, both read on the same
four-event state within the hour.

- **The guide is a brief, not a box, on a phone.** At 360 it was a **446.2 px** card of the **736.6 px** a first-run phone has above its
  pinned save bar — 60% of the first screen — and the roster's first seat began at 708.8 with **27.8 of its 60 px** showing. Off the card
  and on the page's own rules (DESIGN.md keeps a card for a thing that is pressed as a whole) it is **334.8 px**, and that seat is
  **597.4–657.4**: whole above the bar, with the card's note under it. The view goes **888 → 780 px** in a 780 px frame, so nothing on the
  Designer's first page is below the fold any more.
- **Each step is one 44 px line.** The three closed steps were 69, 69 and 57 px of padded block; with the rule as their only separation
  they are **45 px each** (the 44 px disclosure and its 1 px rule), and the mark centres on the line it names, 9 px = (44 − 26) / 2. The
  path is **356.2 → 278.8 px**, and every step is still the same 44 px button with the same `aria-expanded`, opened in place: pressing
  "Decide who may message whom" grows that row 45 → **97.8 px** and the guide to 387.6, with the first seat still whole at 650.2–710.2.
- **The step to do now keeps its instruction and its field, and they get 42 px wider.** The guide's own 20 px inset was what narrowed them;
  on the page it takes the content width, so the goal's sentence is two lines at 360 instead of three and the now step is
  **161.2 → 143.8 px**. At 320 the same reflow leaves it at 161.2 and the guide there is **462.2 → 352.2**.
- **Nothing else moved.** 320: guide 462.2 → 352.2 and the first seat 790.3 → **680.3**, its last 3.7 px under the bar where none of it
  showed before; 390: 428.8 → 334.8 and 691.4 → **597.4**. 768 (above the phone layout) and 1440 are unchanged to the pixel — guide 428.8
  and 394, steps 143.8/69/69/57 and 149.8/57/57/45 — and a delivered mission's Designer is identical in 4 reads (360/390/1440 light, 360
  dark). No document or `#view` horizontal scroll at any width, **0** controls under 44 × 44 at 320/360/390/768, nothing under 12 px,
  forced colours and a 32 px root the same geometry, and 1 console error in both halves (the one-mesh `/api/projects` 404).
- **The keyboard is untouched.** From a cold load it is **8 Tabs** to the guide's goal field and **13** to the roster's first seat, and
  Enter on that seat opens its inspector with 7 more Tabs to the seat's first field — the same three numbers before and after, on the same
 2 px accent ring.
- **axe: 0 violations** at 360 light and 1440 dark, as before. At 360 the passing-rule count is 25 → 24 because
  `scrollable-region-focusable` no longer has a region to check — the page does not scroll. Fifteen nodes there now need a manual contrast
  read (was five), because the guide sits on the page's ground and the body's radial gradient stops axe computing a background; measured
  by hand, the smallest pair on it is `--muted` on `--bg`, **6.19:1** (`--text-dim` is 10.20:1).

Suite: typecheck and build clean; `dist/tests/dashboard` **1,179 pass, 0 fail**, with one new rule in `designer-phone.test.ts`; the build and
primitive tests (`console-*`, `icons`, `type-ramp`, `css-vars`, `forced-colors`, `primitives-a11y`) **35 pass**; eslint on the two changed
files 0 errors.

**Left.** At 320 the header still wraps to 141.6 px, which is the last 3.7 px of that seat. The save bar's **107.4 px** is now the largest
fixed block on the page: the file line takes a row and the two saves the next. Whether a guide someone wants in front of them while they
work is better as a sheet than as ruled lines is still a reading question — the ruled path costs nothing to leave open, which is what it
does on arrival.

### 2026-10-28 — a phone's Overview spends its words once, and every fold control says what it opens

Surface: `views/Overview.tsx`, `views/Panel.tsx`, `views/overview.css`, and the rules in `tests/dashboard/overview-fold.test.ts` and `page-exits.test.ts`. Measured on the scripted demo at **Delivered** (9 files, 7 checks, about 480 events) in the production build, Chromium over CDP at
320/360/390/620/621/768/1440 in light and at 360/1440 in dark, reduced motion, a touch pointer at 768 and below, axe-core on
Overview and Steps at 360 and 1440 in both schemes. Before is the base build served from its own checkout on port 7460, after is
this branch on 7461; both were read within the same minute, on the same delivered mission, twice, with identical numbers.

- **A phone's Overview stopped naming its four sections twice.** At 360 the page spent **107.6 px** on an "On this page" row of four
  44 px buttons starting at y = 827.8, and the same four names stood as headings 137 px below them (964.7 to 1,179.7). Below 621 the
  row is not drawn: the page is **1,223 → 1,088 px**, the first evidence row **947.4 → 811.8**, and each of the four names appears
  **2 → 1** times on the page. 320: 1,242 → 1,107. 390: 1,179 → 1,043. 620 (the fold's own break): 1,007 → 915, the index there
  having been 63.6 px.
- **The four rows are the index now, and every section is still reachable.** Each closed row names its section, gives its figure and
  opens it in place: at 360, Tab from the hero reaches **What shipped: Show, Latest work: Show, Goal checks: Show, Just happened:
  Show** — the first at y = 812, and **9 → 5 presses** from Replay to the last section's control, since the index's four buttons are
  no longer walked first. Goal checks pressed opens **53 → 975 px** with the page 1,088 → 2,010 (before: 1,223 → 2,145). The four
  `h3`s are still the page's heading outline; axe finds **0 violations** at 360 and 1440 in both schemes on Overview and Steps.
- **Four controls reading "Show" now say what they open.** The fold control was named by its own text, so a screen reader heard
  "Show, button, collapsed" four times in a row: **0 of 4** named. It now carries the section's name and the action — **4 of 4**
  read `What shipped: Show`, `Goal checks: Hide` — while still drawing the word for voice control (`aria-expanded` and
  `aria-controls` unchanged). The desk's Show/Hide is the same control and gains the same name.
- **A desk keeps its index, and it still lands.** It earns its place where the sections are open: at 1440 the row is **36 px** at
  y = 414.4, Just happened begins **1,307 px** down, and pressing Goal checks puts `#view` at scrollTop **913** with `#ov-goal` at
  **64 px**, focus on the section — before and after. 621 (88 px) and 768 (44 px) are untouched because the sections are open
  there, which is the same decision as the fold itself.
- **Nothing else moved.** The hero is 746 px at 360 in both builds and still owns the first screen, so the rows begin 76 px below
  the 736 px viewport — 135.6 px earlier than they did. 84 reads (14 views × 320/360/1440 × light and dark) have **no document or
  `#view` horizontal scroll**, **0 console errors** (the single-mesh `/api/projects` 404 aside), the smallest text at 11 px (the
  avatar glyph in the hero) and nothing off the ramp; no control is under 44 × 44 at 320/360 except the 34 × 20 checkbox inside its
  44 px label on the approvals inbox and Tool gates, as before. Contrast and the type census are unchanged.

Overview at a delivered mission, every width measured, `#view` content coordinates (`document` itself never scrolls):

| Width, light | Page, before → after | "On this page" index, before → after | First evidence row, before → after |
|---|---|---|---|
| 320 | 1,242 → **1,107** | 107.6 → **0** | 966.4 → **830.8** |
| 360 | 1,223 → **1,088** | 107.6 → **0** | 947.4 → **811.8** |
| 390 | 1,179 → **1,043** | 107.6 → **0** | 902.5 → **766.9** |
| 620 | 1,007 → **915** | 63.6 → **0** | 730.8 → **639.2** |
| 621 | 3,166 → 3,166 | 88 → 88 | 770 → 770 |
| 768 | 3,103 → 3,103 | 44 → 44 | 726 → 726 |
| 1440 | 1,751 → 1,751 | 36 → 36 | 462.4 → 462.4 |

360 and 1440 in dark read the same as their light columns. axe-core 4.14, tags `wcag2a wcag2aa wcag21a wcag21aa wcag22aa`:
Overview 0 violations at 360 and 1440 in both schemes (25 and 29 rules passed, against 24 and 29 before — the phone's 360 page has
one landmark fewer because the index landmark is gone), Steps 0 at the same four reads (27 and 30 passed, unchanged). Keyboard at
360: Replay → the last section's control was **9 presses** and is **5**.

Suite: typecheck, eslint on the two changed views (0 errors) and build clean; `dist/tests/dashboard` **1,178 pass, 0 fail** — two
rules in `overview-fold` and one in `page-exits` rewritten to the shape this entry describes, plus a new rule for the control's
name; the build and primitive tests (`console-*`, `icons`, `type-ramp`, `css-vars`, `forced-colors`, `primitives-a11y`) **35 pass**.

**Left.** The first screen at 360 is still the whole hero (746 px; the rows start 76 px below the fold), and shortening it is a
words-and-shape decision about the mission brief, not an index one. A closed row's title is not itself pressable — only its 56 × 44
Show control is, and a whole-row hit area needs a different row shape (a button that covers the head loses either the `h3` or the
pill's own hover and ring), so it was not taken here. At 621 the index is still two rows (88 px) because the caption and four
buttons do not fit 597 px: the same tablet question the last pass left. Whether a phone remembers which rows were open is still
open — the page resets closed on every visit.

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
- **A registry that never answers is a failed read, not a wait.** With `/api/projects` answering 503, the base build still
  said **"Loading this page…"** at 10 s with **0 alerts and 0 controls** — the 503 had put all twelve views there at 1.6 s —
  because `hasRegistry` never left null, so the shell held every view. `registryPhase` now distinguishes waiting from failed; at the same 10 s the page shows its own heading,
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
