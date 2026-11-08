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
   The new page also starts at the top of `#view` — the frame's one scroller keeps its offset across the child swap — and a
   focused dock or sidebar tab that names a page **not** in front (Back/Forward leaves the tab that was pressed on the page you
   left) hands focus to the heading; the tab you pressed that still names the page keeps it (2026-11-04).
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
page name is a signpost, the hero is the news. On a phone the hero is a **delivery
receipt**: the verdict, the goal, one action and the four figures as the index, with
the first evidence row at the fold; every other action of the mission is behind the
hero's own `…` (2026-10-31). Below the mission's first cards,
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
- **A long list's tools ride with the list.** At 620 px and below the Files bar
  is the search row with the folded filter button (one 44 px row at 360, 96 px
  as two rows at 320) and it sticks flush under the top bar (top -12, the
  phone's gutter) as the files pass under it. On the delivered demo at 360 the
  end of the nine-file list left it at y=-213: filtering while reading meant
  scrolling the whole list back. With the fold open the bar is ~200 px of
  controls and stays in the flow, so it never becomes a ceiling over the files
  it filters (2026-11-04).
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
- **A number is data where a pointer can drag.** The figure's value sits above
  the door — selectable, with an I-beam — while the door still covers the cell;
  the wash is on the cell so the raised number still lights the whole figure. A
  coarse pointer puts the value back under the door: a thumb cannot select, and a
  28 px hole in a 148 px target is a press that does nothing. Pinned by
  `tests/dashboard/overview-receipt.test.ts` (2026-10-31).
- **A phone's hero is one action and a menu.** Where the navigation is a drawer
  (800 and below, the dock's own break) the row is `next[0]` — the one thing to
  do, whatever its look, so a running mission still shows its Pause — and every
  other action is a 44 px item behind a 44 × 44 `…`. At 360 the five actions were
  three rows and 148 px, and the three quiet ones opened Files and Cost, which the
  dock and the figures already name. A desk keeps the row of five. Pinned by
  `heroActions` in `overview-model.ts` (2026-10-31).
- **A delivered mission's why is read with its checks.** Its note is the gate's
  sentence, and the headline directly above already says the claim, so it is read
  at the head of Goal checks — under the progress it explains — not as a 45 px
  door in the receipt. At 360 the receipt is 543.14 → 498.14 and the second
  evidence row (692.73–745.73) is whole above the 747 px dock, where its head
  began 4.3 px above it; at 1,440 the 57 px note row leaves the first screen
  (hero 324.77 → 267.77). Every other phase keeps its note under its headline
  (2026-11-03).
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
- **The narrowest phone's hero is the page's width.** Below 341 the hero takes
  the page's own 12 px gutter and its four figures step one rung down the ramp
  (24 → 20; the step is the figures' strip since 2026-11-01, below), so the one
  action and its menu share one 44 px row; the goal's label runs into its
  sentence's first line rather than a column beside it, so the goal is two
  lines, and a closed evidence row's head takes the phone head's 8 px gap so
  its name and figure read on one line. At 320 the first evidence row's 44 px
  head is whole above the dock (677.7–721.7 in 747, 25.3 px clear since
  2026-11-02), where it began 55.6 px under it. Pinned by
  `tests/dashboard/overview-receipt.test.ts` (2026-11-01).
- **A figure steps by the strip it sits in, not by the viewport.** The four
  figures are 24 px while the strip is 361 px or wider and 20 px below that, one
  `@container` on the strip (2026-11-01). The step is not about the line — the
  demo's figure is 113.31 px at 24 in a 123 px cell, so nothing wrapped — it is
  about the receipt. Since 2026-11-02 it is no longer what lifts the first
  evidence row's head above the dock (the verdict's one line does that, at 543.14
  as at 552.33): it is 9.19 px of the first screen — at 360 the first row ends
  21.27 px above the 747 dock and the second row's head begins 4.27 px above it,
  where 24 px figures would put that head wholly under it. Its 361 px boundary is
  a density rule now, not the place the sentence wraps. Pinned by
  `tests/dashboard/overview-receipt.test.ts`.

- **A page read in the hand folds by the thumb, not by the viewport.** Where the navigation is a drawer (800 and below) the Overview's
  four evidence sections are one 53 px ruled row each and it draws no jump row; a 768 px tablet had the drawer and the dock and still
  opened all four (3,121 px), and is 841 now. The fold's predicate is `DOCK` (the dock's own 800), the same one the hero's compact action
  row uses, and the closed-row CSS lives in the 800 block. A desk (801+) keeps them open and keeps the index. Pinned by
  `tests/dashboard/overview-fold.test.ts` (2026-11-04).
- **A decision's answer is not behind its evidence.** The decision record and the involved seats follow the answer form; the consequence
  that decides the press still comes before it. On the host-spend card at 360 this moved "Raise the ceiling" from y=772 — wholly under
  the 747 px dock — to 688–732, whole above it. The DOM order is the visual order, so the tab order still walks the screen from top to
  bottom. Pinned by `tests/dashboard/decision-card.test.ts` (2026-11-04).
- **A control's name repeats the words it draws, in order.** The bar's inbox button and the dock's "Needs you" tab draw the label and
  then the badge; their names used to read "Needs you: 1 …", and the colon interrupted the drawn "Needs you 1" — a serious
  label-content-name-mismatch on every page with something waiting. The markup carries a real space between the label and the count, and
  the name is "Needs you 1 waiting on you". Pinned by `tests/dashboard/label-in-name.test.ts` (2026-11-04).
- **A delivered receipt dates its result.** Under "Ran for 2m 36s" the sub-line says "Delivered 14m ago" (the goal's own completion time),
  not how the figure was measured: the phone's first screen otherwise says nothing about how fresh the result is, and the date is one
  line where the measurement sentence took two at 320 and 360. Pinned by `tests/dashboard/overview-receipt.test.ts` (2026-11-04).
- **A waiting condition is read across the card, and its fix follows.** The attention row's 145 px action took more than half of a phone
  card: the sentence was 66 px wide at 320 (310 px tall) and 94 at 360, so one condition was a 400 px card and the evidence under it was
  a screen down. Below a 420 px card the sentence gets the row and the fix sits under it; one condition's head is the hero's own sentence
  and is read but not drawn. At 360 the card is 232 → 139 and the page 1,102 → 1,009, with the fix whole above the 747 px dock. Pinned by
  `tests/dashboard/attention-phone.test.ts` (2026-11-04).
- **A glyph that opens a menu is 44 × 44 on any finger.** The width floor lived in the 800 px block, so at 820–900 on a touch tablet the
  top bar's and the hero's `…` measured 36 × 44 while the sidebar was back. A coarse pointer takes a 44 px square at every width; at 820
  the two are 44 × 44 now and the page's only target under 44 is the 1 × 1 skip link. Pinned by `tests/dashboard/phone-targets.test.ts`
  (2026-11-04).

## Open problems (carried forward)

- The Overview is now **858 px** at 360 px with a delivered mission (876 before this pass, 921 before it, 943 on the pass before that,
  952 before the 2026-10-31 receipt, 1,124 before the 2026-10-22 folding and shipped-card work, 8,582 before that): the four evidence sections
  are one ruled row each until opened, and since 2026-10-28 those rows are also the page's index. Since 2026-11-04 the fold follows the
  thumb dock (800) rather than the phone's 620, so a 768 px tablet is 841 px instead of 3,121 and a desk (801+) is where the sections open.
  The open question is still the default, not the length: What shipped is closed like the other three, and a mission that has just delivered
  may deserve its six file rows open; measured, the closed row is 53 px and the open panel 847, so the whole difference is one press or two
  screens.
- A phone's first screen holds the receipt, the first evidence row and — at 360 — the second row **whole**: the receipt is **480 px**
  and What shipped begins at **609.5**, its 44 px head (**614.5–658.5**) 88.5 px clear of the 747 dock; Latest work is
  **674.5–727.5**, its head **679.5–723.5**, the row's end 19.5 px above the dock. At 390 the second head is **688.7–732.7**
  (14.3 px clear) and at 320 **701.9–745.9** (1.1 px clear, whole): 390's receipt is 489.1 and 320's 502.3 (2026-11-04, the
  delivered date in the clock's sub-line is one line where the measurement sentence took two). The 20 px figure step still holds
  9.19 px from 320 to 387 (2026-11-03).
- Events and the approvals inbox still close without `NextLinks`, and that is now a decision rather than a pending question: Events ends on
  its window status (the newest 300 of 491 events) and the inbox on its empty state's Back to the Overview; a row of doors would repeat
  the navigation each page already has (`Pause`/`Filters`, `Decisions`/`Tool gates`) rather than continue it. The inbox's *answer* is no
  longer at the bottom of its card: since 2026-11-04 the decision record and involved seats follow the answer, so on the host-spend card
  the action is 688–732 at 360, whole above the dock, where it began at 772.
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
- The Steps filter is one button at 620 and below and, since 2026-11-05, on a coarse pointer to 900: a 768 touch tablet's
  166 px of chips and switch is a 60 px toolbar. A fine pointer at 768 keeps 114 px of chips and switch; whether a fine-pointer
  tablet should also fold is the same open question as its `NextLinks`.
- The Playground now leads with its terminal and puts the product card after the output. That is a deliberate reversal of the
  2026-10-22 "product first" reading for this one page: the page's own action was at the foot of the first screen. If real use
  says the product should lead there too, the card costs 487 px above the command box and the measurement is in this entry.
- The thumb's row is 53 px of chrome and 36 px of page on every project page from 800 px down (2026-10-31). It buys one press
  instead of two for five places, and the pages opened once pay it too. Whether it should hide on scroll, or be shorter than 52,
  is a use question; the measurement is in this pass's entry.
- The Files bar is 44 px at 320, 360 and 390 since 2026-11-05: the search's **170 px** phone basis and Files' 200 px `min-width`
  giving way leave 287 in 296 at 320, so the button shares the row and the search grows to 179.1 (219.1 at 360, 249.1 at 390). The
  hint truncates at 320 ("Name, o…"); that is the deliberate trade, and the next question is whether the 320 edge should shorten the
  hint further or give the button a 44 px glyph. The 220 px basis this replaced was 0.94 px over at 360: a wrapped flex container
  breaks its line before it shrinks, so the bar took two rows (2026-11-04).

## What the next pass should take

1. Whether the thumb's row earns its 36 px of every page: it is the owner's daily five, but a page opened once (Graph, the
   Playground) pays too. Watch real use before shortening the list or hiding the row on scroll.
2. Whether the Designer's bottom stays its own: the save bar and the dock cannot both own that edge, and the workbench is
   the one screen that is not a brief.
3. The events page's "Live" chip says what the stream is doing while the mission is delivered; decide whether one word can
   say both, or whether the chip should read the mission's state here as it does in the bar. Measured 2026-11-08:
   "Following" grows the chip 63.7 → 86.8 px and wraps the Events head at 360 (89 → 126 px) and moves the meta line at 320,
   so the word is not free; shortening the meta or the title row is the first question.
4. Whether the hero's `…` and the frame's `…` should both offer `Reopen with feedback` on a phone, and whether a pointer's
   press on a figure's number doing nothing is the right price for being able to select it (2026-10-31).
5. The Designer's 320 header is two rows now (168.59 px with its lede; 89.6 on the first-run guide, which has no lede). The save bar's
   blocked state is the next block there: its 44 px inline action inflates the line from 17.4 to 36, and that 18.6 px is the last thing
   the bar could give back — it needs either a glyph button (a name lost) or a target overlap (a target collision).
6. Decide whether the Steps filter fold belongs above 620 on a **fine** pointer: a coarse pointer now folds to 900 (a 768 touch
   tablet's 166 px toolbar is 60), but a fine pointer at 768 still draws 114 px of chips and switch. The tablet's `NextLinks` take
   the 44 px floor on a coarse pointer, so the chips are the last of that family.
7. Decide whether What shipped opens by default on a fresh delivery, and whether the fold remembers a section (the page
   resets to all closed on every visit). It is now the second thing on the phone's first screen (609.5, its head 88.5 px above the dock);
   the tablet (768) shows the same four rows and has the same question.
8. Measure the project strip at 621–800 with enough projects, in the hosted console where a registry exists; `curule console` cannot show it.
9. Remember the YAML preview's wrap choice, or move the toggle into the pane's own head; either is a small addition to a layer that now fits.
10. Check the Events and inbox end-caps against real live content before adding any row (the decision above).
11. Read the console with a real thumb on a real phone: the measurements here are Chromium at 360 px with touch emulation only in CSS, not a hardware device.
12. Check the frame's safe-area claims on a notched device in both orientations; the insets are in the CSS but the stand-in browser reports them as zero.
13. Decide whether the fold should follow the dock past 800 to the 1,100 grid break: at 801 the desk returns (the Overview is ~3,100 px again)
    because the sidebar is back, and the four rows are 744 px wide with their figure at the far left and Show at the far right. Is a small
    laptop a desk or a hand's width with a keyboard? Measure it with a real pointer.
14. Decide whether the inbox's note field and "Clear this card" should also be on the first screen: the action is there now (688–732 at
    360), but the card is 1,242 px and the field is at 764. The card's answer can be one press while its note needs a scroll; the host-spend
    card's primary opens host settings, so the note is written on the way back, not on the way out.
15. Watch the compact "Your product" card (2026-11-08): a person who arrives to start its UI now presses once before the command box
    appears. If real use shows that press is the common path, the form can lead and the sentence can follow; the measurement is the
    card's 487 → 158 px and the checkout's 674 → 345 at 360.
16. Host settings still uses 1,080 px of a 1,440 page. The right margin is 104 px now, not a third; a two-column group grid would fit
    two cards but stack each row's label and control. Measure it with a real host before changing the row shape.
17. Decide whether "No status" is enough for a first failed read: every view already draws its own sentence and Try again, and the bar
    now says the console has not read the mission, but a person may still want the bar's chip to be a door to the page that says why.

## Pass log

### 2026-11-08 — the first screen belongs to the page, a failed read says it once, and host settings is not a project's

Surface: `src/views/YourProduct.tsx`, `src/views/Playground.tsx`, `src/views/Product.tsx` (call site), `src/playground.ts`,
`src/views/playground.css`, `src/views/product.css`, `src/views/agents.css`, `src/views/files.css`, `src/views/settings.css`,
`src/views/drawers.css`, `src/designer/topology.css`, `src/designer/assistant.css`, `src/styles.css`, `src/shell.tsx`,
`src/tabs.tsx`, `src/route.ts`, `src/store.tsx`, `src/mission.ts`, `src/useMission.ts`, with
`tests/dashboard/failure-states.test.ts`, `frame-phone.test.ts`, `mission.test.ts`, `route.test.ts`, `primitives-a11y.test.ts`,
`playground.test.ts`, `productlive.test.ts` and `phone-type.test.ts`.

Measured on the scripted demo at **Delivered** (507 events, 52.9k of 2.0M tokens, 7 checks, 9 files, 7 seats, 30 turns,
6 review files) in the production build served by `curule console`, Chromium 1248 at 320/360/1440 in light (and 360/1440 in
dark for axe). The before is the branch's base `48ac1c2` built in a second worktree and served beside it with the same
delivered log; the after is this branch's build. Each pair opens the same state (the toast dismissed), and every reading is
the same page at the same scroll position.

**What changed.**

- **The Product page's first screen is the checkout, not a start form for a UI the product does not have.** The no-page
  "Your product" card was **487 px** at 360 and "The checkout" began at **y = 674**; the page's own purpose (read the code,
  run a script, open it) was below the fold. With no page and no running UI the card is one sentence and **158 px**, and the
  full block is one press away ("Start its own UI", which focuses the command box it reveals). The checkout is at **345**
  (was 674) and "Run a script" at **621** (was 950); the page is **1,789 → 1,460**. At 1440 the card is **334 → 102**, the
  checkout **508 → 276**, the scripts **696 → 464**, and the page **1,236 → 1,004**. When a page or a UI does exist the
  full card is drawn, so the product path is unchanged.
- **The Playground's caveats are a disclosure, not a first screen of prose.** The paragraph under the command box was
  **183 px** at 360 (plus a 41 px empty-commands sentence), before the output or the product could begin. It is one line of
  the two facts a person acts on (**61 px**) and a 44 px "What it can see, and the time limit" disclosure; the block is
  **109 px**, the product card **487 → 158**, and the page **1,093 → 836**. The terminal still leads and the command box is
  still the page's first action.
- **A failed read is said once.** With `/status` answering 500, the bar said **"Connecting"** while the page said "Could
  not load the agent list — The server answered 500" and the corner added **"server error /status -> 500"**. The status read
  is quiet now (every page draws it), the first-read failure is the mission state **"No status"** (not a connection still
  coming), and the corner notice is **1 → 0**. `/playground/commands` 500 on Product and Playground did the same:
  **1 → 0** corner notices, with the page's own sentence and Try again kept.
- **A control's edge is visible.** The secondary and small buttons, the search field, the graph keys, the file filters,
  the quick-command and run buttons and the designer's starter chips drew a `--line-strong` hairline at **1.43:1** (on
  `--bg`) and **1.52:1** (on `--bg-2`), below the 3:1 boundary floor. They use `--line-control` now: **#837d72** on the
  light page, **3.68–4.08:1** on the three surfaces. The `kbd` keycap and the cards' decorative rules stay `--line-strong`
  on purpose: they are not the only edge of a control.
- **A project failure is not the host's page, and a host page's bar is the host's.** `route.ts`'s `HOST_VIEWS` had only
  `projects` while `navmodel.ts` had `projects` and `hostsettings`, so a bare `#/hostsettings` was read as a project page:
  the router rewrote it onto the project in front, the project strip laid a **296 px** locked-project banner over it
  (page title **y = 365** at 360, **220** at 1440), and the bar drew that project's **Locked** chip and Working/Tokens
  telemetry (its `p` key could pause a project the page never shows). Both host pages are host-level now: the banner is
  gone, the bar is bare, the title is **131** at 360 and **73** at 1440, and the first field at 1440 is **481 → 313**.
  Projects still draws the same lock on the project's own card, with its Restart.
- **The drawer's wordmark names the workspace.** The line under `Curule` printed the first 14 characters of the goal's
  opaque id (`goal-M6W5VH6Y00370…`), a 247 px caption a person could not use. It is the project's name on a host and the
  mesh's id (`demo-stub`) on a single-mesh server; the goal id moved to the title.
- **One section-head tier.** Overview, Cost, Graph, Product, Playground and the drawer already set a section at 15/600;
  Agents ("Idle or finished") and the Designer ("Team") drew **16/650**, Files' groups **14/600** and Host settings'
  cards **16/650**. All four are the shared 15/600 card-title recipe now (measured 16/650 → 15/600, height 21 → 20),
  so one screen no longer has three sizes for the same job.
- **The project switcher's name is the project and state it draws.** Axe reported label-content-name-mismatch (serious)
  on `.pj-switch` at 360 and 1440 on both host pages: its name was "Project in front: Demo Mesh (stub agents). Switch
  project" while the button drew the name over **Locked**, so the state word was outside the contiguous name. It is
  "`${name} ${state}. Switch project`" now (and "No project. Choose a project" with no project); the four failing reads
  are **0**, and the final axe sweep is **56 reads** (the 12 single-mesh views and the 2 host pages, at 360 and 1440, in
  both themes) with **0 violations**.

| | Before | After |
|---|---|---|
| Product, 360: Your product card / The checkout / Run a script | 487 / 674 / 950 | **158 / 345 / 621** |
| Product, 360: page height | 1,789 | **1,460** |
| Product, 1440: card / checkout / scripts / page | 334 / 508 / 696 / 1,236 | **102 / 276 / 464 / 1,004** |
| Playground, 360: caveat block / product card / page | 224 / 487 / 1,093 | **109 / 158 / 836** |
| Playground, 1440: product card y | 363 | **334** (the page fits at 836) |
| `/status` 500, 360: bar chip / corner notices / page error | Connecting / **1** / 1 | **No status / 0 / 1** |
| `/playground/commands` 500, 360: corner notices / page error | **1** / 1 | **0 / 1** |
| Soft button and search edge on `--bg` / `--bg-2` | 1.43:1 / 1.52:1 | **3.68:1 / 3.92:1** |
| Host settings with a locked project, 360: banner / title y | 296 px / 365 | **0 / 131** |
| Host settings, 1440: title y / first field y | 220 / 481 | **73 / 313** |
| Host settings bar: Locked chip and telemetry | drawn | **bare** |
| Section heads: Agents / Files / Designer / Host settings | 16/650 / 14/600 / 16/650 / 16/650 | **15/600 each** |
| Wordmark caption, 360 | `goal-M6W5VH6Y00370…` | **`demo-stub`** (name in the title) |
| Under-44 controls, 360, the changed views | 0 | **0** |
| Horizontal page scroll, 320/360/1440 | 0 | **0** |
| Axe, the eight changed views at 320/360/1440 light and 360/1440 dark; the other four at 360/1440 light | 0 | **0** |
| Axe, `.pj-switch` on both host pages, 360/1440 × both themes | 4 violations | **0** |
| Axe, 56 reads over the 12 single-mesh views and 2 host pages at 360/1440 × both themes | — | **0** |

Floors: `npm run typecheck` and `npm run build` clean; the full suite **6,621 tests, 6,619 pass, 2 skipped, 0 fail**
(dashboard **1,299**, build **253**); axe **0** in the 56 reads over the 12 single-mesh views and 2 host pages at 360/1440
in both themes (and in the changed views at 320/360/1440 light and 360/1440 dark); no page scrolls sideways at 320, 360
or 1440; no control under 44 × 44 at 360 beyond the 1 × 1 skip link
and the raw switch inside its 44 px label.

**Left.** The Playground's compact product card hides the start command until one press; the full block is the same card,
and the press puts the cursor in the command box. The Product page's checkout has an uncommitted-changes card in this
run (the demo's own workspace), so its page height is compared with the same log, not across a clean tree. The
`#/hostsettings` route on a single-mesh server already fell back to "This server runs one mesh" through `navmodel`; the
router's list now agrees with it, so a bare address is never rewritten onto a project. The "Live" chip still describes
the stream on a delivered mission: measured, "Following" grows the chip **63.7 → 86.8 px**, wraps the Events head from
**89 to 126 px** at 360 and moves the meta line at 320, so the word stays. Host settings still uses 1,080 px of a 1,440
page; the right margin is now 104 px and the form is not a third-empty page, but a two-column group grid would make each
row's label/control stack and is a question for real use.

### 2026-11-07 — a failed log read is said over the rows it kept, a clear keeps the field, and the delivered path can be copied

Surface: `src/views/Events.tsx` (`readLog`, the full-log banner), `src/store.tsx` (the quiet step and event reads),
`src/views/Agents.tsx` (the turn-history banners), `src/ui/search.tsx` and `src/views/Events.tsx` (`clearAll`),
`src/views/Shipped.tsx` and `src/views/overview.css` (the workspace path and its copy), `src/components.tsx`
(`focusAfterRetry`, `CopyButton`), with `tests/dashboard/failure-states.test.ts`, `events-log.test.ts`,
`overview-index.test.ts`, `primitives-a11y.test.ts` and the new `search-focus.test.ts`.

Measured on the scripted demo at **Delivered** (481 events, 49.3k of 2.0M tokens, 7 checks, 9 files, 7 seats, 28 turns)
in the production build served by `curule console`, Chromium 1248 at 320/360/768/1024/1440 in light and 360/1440 in
dark. The failure states were forced with `page.route` on `/events` and `/steps`; the before is this worktree at HEAD
before these edits (the Overview path pair's before is a base build on 8,361, whose shorter checkout explains its 420 px
path), and the after is this branch's build on 8,360.

- **A failed full-log read was invisible over the live stream's tail.** With `/events` answering 500 at 360 and 1,440,
  the page drew the 200 events the stream had delivered under **Live**, with the true window sentence "This page holds
  the newest 200 of 481; 281 older ones are not loaded" — and **0** banners, **0** Try again. The first-read
  `ErrorState` only existed while the buffer was empty, which the stream makes sure it is not. One `readLog` now serves
  the first read, the reconciler and the retry; a failure over a tail keeps the rows and says so: banner **336 × 166**
  at 360 (**296 × 199** at 320, **1,152 × 54** at 1,440), **Try again 107.7 × 44**. The list stays at 200; a successful
  retry is **300** events (the newest 300 of 400, 81 older not loaded) with the banner gone and focus on **H2 Events**.
  The page's own sentence is the answer: the generic **server error ×2** corner notice is **1 → 0**.
- **A failed or stale step history left Agents' last-turn facts missing under "Live".** With `/steps` answering 500 at
  360, the roster kept "4 turns" from `/status`, dropped every "last 27m ago" and recent-turn chart, and still said
  **Live · Updated 1s ago**; no banner, no retry. It now says **"The turn history did not load."** (banner **336 × 208**
  at 360, **296 × 241** at 320, **1,152 × 68** at 1,440, **Try again 44**) or, after a good read, "could not be read just
  now" with **Read again**; the successful retry brings the last-turn sentence back and puts focus on **H2 Agents**.
  The corner notice for the same read is **1 → 0**.
- **Clearing a search removed the control and left the cursor on `<body>`.** At 360 the field's own clear button, the
  toolbar's **Clear filters** and the empty state's **Clear filters** all left `activeElement` **BODY**; the next Tab was
  Filters, not the field the person was using. `SearchField` keeps a ref and returns to the field after its own clear,
  and `clearAll` focuses `#ev-search`; all three now land on **INPUT "Search events"** with its 2 px ring (the next Tab
  is still Filters). The same field serves Steps, Files and Product.
- **On a phone the delivered path was cut at its front with no whole value.** At 320 the `Delivered into` line was
  **254 × 19.5**, its content **420** (the base build's shorter checkout; **952** for this worktree), drawn from its end
  by `direction: rtl`, with **no title and no copy**. It now carries the whole path in `title` and a **44 × 44** copy
  control (the clipboard reads the exact 131-character path); the line is **102 px of path + 44 px copy**, the foot
  **39 → 44**, the card **964.4 → 969.4** and the page **1,769 → 1,774** at 320. At 360 the path is **142 + 44**; at
  768 and 1,440 the control is not drawn, the path wraps or fits whole, and the page does not move. A compact copy
  button also keeps its accessible name after the press (axe `button-name` on `.copy-btn` **1 → 0**).

| | Before | After |
|---|---|---|
| `/events` 500 over the stream tail, 360: banners / retry | 0 / 0 | **1 / 107.7 × 44** |
| The same at 1,440: banner / retry | 0 / 0 | **1,152 × 54 / 107.7 × 28** |
| A successful Events retry: events / banner / focus | 200 / — / BODY | **300 / 0 / H2 Events** |
| `/steps` 500 at 360: last-turn sentence / banner | absent / 0 | **returns after retry / 336 × 208** |
| Agents after the retry: banner / focus | — | **0 / H2 Agents** |
| Clearing a search (all three controls): active | **BODY** | **INPUT "Search events"** |
| The delivered path at 320: box / full value | 254 / no title, no copy | **102 + 44 × 44 / title + clipboard** |
| The Overview at 320: foot / card / page | 39 / 964.4 / 1,769 | **44 / 969.4 / 1,774** |
| The path at 768 / 1,440 | full, no control | full, **no copy control**, page unchanged |
| The copy button after its press: axe `button-name` | 1 | **0** |
| Normal page heights at 360, the ten views | 858 / 780 / 1,234 / 3,208 / 780 / 1,119 / 1,544 / 1,649 / 1,917 / 1,051 | **unchanged** |
| Axe, the changed states × 320/360/1,440 light and 360/1,440 dark | — | **0** |
| Horizontal page scroll, 320–1,440 | 0 | **0** |

Floors: `npm run typecheck` and `npm run build` clean; `npm test` **6,606 pass, 0 fail** (2 skipped); the dashboard
suite **1,290 pass** and the build suite **250 pass** (five new rules: the Events banner and read helper, the Agents
banners and quiet read, the search focus, the path and its copy, and the compact button's name); eslint **0** on the
touched TypeScript (the stylesheet is outside its configuration); axe **0** in the Events and Agents failures at
360/1,440 light and 360/1,440 dark, the Overview path at 320/1,440 light and 320 dark, the cleared search at 360 light
and dark, and the ten normal views at 360/1,440.

**Left.** The Events banner sits above the search, so the page still holds the 200-event stream tail while it asks for
the full log; the footer continues to say exactly what the buffer is. The path on a phone still shows only its last
~12 characters; the copy control, not the visible line, is where the whole value lives, and it is not drawn on a desk
because the path already fits or wraps there. The `server error` corner notice is quiet for these two reads because
their pages now carry the sentence; other reads keep their notices. Seen while measuring and untouched: the Events,
Steps and Agents chips still say **Live** on a delivered mission (the open question above).

### 2026-11-07 — a retry keeps the cursor on the page, a thread's count says events, and a recent window says recent

Surface: `src/components.tsx` (`focusAfterRetry`, the ErrorState's press), `src/evdetail.tsx` and
`src/views/events.css` (the thread's heading), `src/stepwalk.ts`, `src/drawers.tsx` and `src/views/Overview.tsx`
(the walker's scope), and `src/styles.css` (the drawer tab's count), with `tests/dashboard/failure-states.test.ts`,
`events-phone.test.ts`, `stepwalk.test.ts` and `phone-type.test.ts`.

Measured on the scripted demo at **Delivered** (481 events, 49.3k of 2.0M tokens, 7 checks, 9 files, 7 seats, 28 turns,
ran 16m 6s) in the production build served by `curule console`, Chromium 1248 at 320/360/390/768/1,024/1,440 in light,
360/1,440 in dark, a touch pointer at 800 and below, reduced motion, axe-core 4.14. The before is the base build at
`1184c19` under the same running console and the same delivered log.

- **A retry dropped the cursor on `<body>`.** Every error card that clears its failure for the re-read (Files, Cost,
  Graph, Product, Host settings) removed the pressed `Try again` from the document, drew a skeleton and, when the
  failure came back, a new card. At 360 with `/artifacts` answered 500, `document.activeElement` after the press was
  `<body>` in both the failing and the succeeding retry: no visible focus, and a screen reader had no place to read
  from. The card's page (or the drawer that holds it) outlives the card, so `ErrorState` now moves focus there before
  the read starts: **H2 "Files"** (and **H2 "Files"** when the retry succeeds), and `DIV#drawer` (`role="dialog"`) for
  a replay card inside the drawer; the failing answer's `role="alert"` still announces, and the next Tab is `Try
  again` (failing) or the Search field (loaded), as before.
- **The event's thread count was one word and one number with no unit.** The heading was `Thread<span>18</span>` with
  a CSS gap, so its textContent was **"Thread18"** and a reader could take 18 for a thread id. It is
  **"Thread, 18 events"** now, 80.8 → **142.4 px** at every width. The section head stays **70.2** at 360 and **64** at
  1,440; at 320 the longer heading plus the 118 px zone needed 268.4 in 266 with the head's 8 px column gap, so the
  phone block takes the row's 4 px there and the head stays **122.2** (its before height, with the two 44 px buttons
  already on rows of their own).
- **The same turn read "1 of 6" from the Overview and "1 of 28" from Steps.** The Overview holds its latest six steps
  and hands them to the drawer, so the walker counted six while the page the reader came from would have counted 28:
  one step, two positions, and the six looked like the run. The walker now names a recent window: Overview
  **"1 of 6 recent"** (title "step 1 of the 6 recent loaded, newest first"), Steps **"1 of 28"** unchanged; the
  drawer's 360 px walker is **174 → 180** wide at 320 and 360 and does not wrap. The six-step walk is still six:
  `All steps` remains the way to the rest.
- **A drawer's tab count was 11 px.** The agent and graph drawers' `Now 7` badge was **11 px** at 360 and at 1,440 —
  a mixed-case figure, not the capital micro-label or glyph the 11 px step belongs to. It is **12 px** (the ramp's
  next step): its box **22 × 19 → 22 × 20**, the tab row **93** at 320/360 and **37** at 1,440, with no wrap and
  nothing under 44 px.

| | Before | After |
|---|---|---|
| A failed retry at 360: activeElement | `<body>` | **H2 "Files"** |
| A succeeding retry at 360: activeElement | `<body>` | **H2 "Files"** |
| A retry inside the replay drawer: activeElement | `<body>` | **`DIV#drawer`** (dialog) |
| The thread heading's textContent | "Thread18" | **"Thread, 18 events"** |
| Its width (the same at 320, 360 and 1,440) | 80.8 | **142.4** |
| The thread section's head, 320 / 360 / 1,440 | 122.2 / 70.2 / 64 | **122.2 / 70.2 / 64** |
| The Overview's step walker | "1 of 6" | **"1 of 6 recent"** |
| The same turn from Steps | "1 of 28" | 1 of 28 (unchanged) |
| The walker's width at 320/360 | 174 | **180** |
| The drawer tab's count, 360 / 1,440 | 11 px, 22 × 19 | **12 px, 22 × 20** |
| The tab row at 360 / 1,440 | 93 / 37 | 93 / 37 |
| Axe, the changed states × 320/360/1,440 light and 360/1,440 dark | 0 | **0** |
| Horizontal page scroll, 320–1,440 | 0 | **0** |

Floors: `npm run typecheck` and `npm run build` clean; `dist/tests/dashboard` **1,284 pass, 0 fail** (five new
rules: the retry landing in `failure-states`, the thread's count in `events-phone`, the recent window and the Overview
scope in `stepwalk`, and the tab count in `phone-type`); `dist/tests/build` **248 pass, 0 fail**; eslint **0** on the
touched TypeScript (the two stylesheets are outside its configuration); axe **0** in the event detail at 320/360/1,440,
the agent drawer at 360/1,440, the step drawer at 320/360, the Files and Graph failures at 360, and 360/1,440 dark; no
page scrolls sideways; no control is under 44 × 44 at 320/360/390 beyond the raw switch inside its 44 px label; the
views' smallest text is the 11 px avatar initials.

**Left.** A recent window still walks six steps and stops; its counter says so, and `All steps` is still the door to the
other 22. The thread heading fits at 320 by 1.6 px with the phone's 4 px column gap, so a longer translation wraps the
zone to a second row, which the head already supports. A retry still draws the skeleton while the re-read is in flight
(it no longer takes the cursor with it); a failure that returns announces the same sentence on the new card. Seen while
measuring and untouched: the Events, Steps and Agents chips still say **Live** while the bar says **Delivered** (the
open question above), and a deep-linked old step still reads its position among the store's loaded list, not the
mission's whole history.

### 2026-11-07 — a phone's notice takes a row, a failed workspace is not a missing one, and a phone's link is a door

Surface: `src/styles.css` (the phone notice track), `src/views/Product.tsx` and `src/product.ts` (`workspacePill`, the quiet
workspace reads), `src/views/Graph.tsx` (the phone link's press, the empty roster's action), with
`tests/dashboard/notices-phone.test.ts`, `product.test.ts` and `graph-phone.test.ts`.

Measured on the scripted demo at **Delivered** (479 events, 49.3k of 2.0M tokens, 7 checks, 9 files, 7 seats, 28 turns,
ran 3m 25s) in the production build served by `curule console`, Chromium 1248 at 320/360/390/768/801/1,440 in light,
360/1,440 in dark, reduced motion, axe-core 4.14. The before is the base build at `5190cc5` under the same running console,
with the same delivered log; the delivery notice is reproduced with the page clock fixed 15s after `goal.completed`, which is
the state the console itself decides is news (`TOAST_FRESH_MS`).

- **The delivery notice covered the page, not the scrolled part of it.** At 360 its 336 × 85 box sat at y 72, exactly on the
  page's title: Files' h2 (14–73.4 × 78–105.6) hit the toast, and on Events its 44 px close button was exactly on Pause updates
  (both 302–346 × 78–122), so a press meant to pause dismissed the notice. The notice now has its own frame row between the bar
  and the view (`#app:has(#toasts .toast)`), the empty container keeps `main`, and the Designer and an open drawer keep their
  fixed foot (placing a fixed notice in the new row resolved its `bottom` against that row and put it at y = −123). The Files h2
  is at y 170.6 and hits itself; Events' pause at 171–215 hits its own button; the view starts at 157 instead of 64
  (its title at 171 instead of 78). At 768 the
  row is 66 px; 801+ keeps the corner. The page gains no row when no notice is up.
- **A failed workspace read said the workspace did not exist, and said it twice.** With `/workspace/info` answered 500, the
  header read **"No workspace"** (126 × 22, failed tone) over a body that read "Could not load the workspace", and a generic
  **"server error /workspace/info -> 500"** notice was raised in the corner as well: one failure, two answers, one of them a
  claim the console cannot make. `workspacePill` says **"Not loaded"** (106 × 22, the word Tool gates uses), and the info and
  folder reads pass `quiet: true` because their errors are already sentences on the page. The corner notice is **1 → 0**; the
  page error is unchanged.
- **A phone's ranked link was a pin with no drawing.** On the phone layout the Graph draws no ring, but the 268 × 60 link row
  was still a toggle: pressing it set `aria-pressed` and changed **0** edges — there was no drawing to light and the route did
  not move; the 44 px arrow was the only way on. The row is now the door on a phone (as the seat rows are): it opens its
  messages in Events and says so in hidden words. At 390 a press goes to `#/events` with the pair's 7 matching events, search
  "qa" and Filters (2); the desk keeps the pin that lights the line.
- **An empty Graph named the Designer but held no door to it.** With no seats the empty state was 296 × 195 at 320 with
  **0** buttons, 0 links and no Next row; the one action that changes it was behind the menu. It now carries the same
  **Open the Designer** button as Tool gates: 202 × 44, and the state is 296 × 255. A press lands on `#/designer`.

| | Before | After |
|---|---|---|
| Delivery notice at 360: box / y | 336 × 85 / 72 | **336 × 85 / 72** (its own row) |
| Files h2: y / what its centre hits | 78 / the toast | **170.6 / the h2** |
| Events Pause updates: box / what its centre hits | 302–346 × 78–122 / the toast's close | **302–346 × 171–215 / the button** |
| The view at 360: top / height with a notice | 64 / 780 | **157 / 687** |
| A notice at 768 / at 801 | row / corner | **66 px row / corner** |
| `/workspace/info` 500: header chip | No workspace, 126 × 22 | **Not loaded, 106 × 22** |
| The same read: corner notices | 1 (server error /workspace/info -> 500) | **0** |
| Graph link row at 390: box / press | 268 × 60 / aria-pressed, route unchanged, 0 edges lit | **268 × 60 / opens #/events, 7 events, search "qa"** |
| Empty Graph at 320: state / controls | 296 × 195 / 0 buttons, 0 links | **296 × 255 / 1 button, 202 × 44** |

Floors: `npm run typecheck` and `npm run build` clean; `dist/tests/dashboard` **1,279 pass, 0 fail** (the new
`notices-phone` and the changed `product` and `graph-phone` rules); eslint **0** on the touched TypeScript (the stylesheet is
outside its configuration); axe **0** in the notice at 360/768 light and 360 dark, the workspace failure at 360/1,440, the empty
Graph at 320/1,440 and the phone link at 360/390; no page scrolls sideways at 320–1,440 in light or 360/1,440 in dark; no
control under 44 × 44 at 320/360 beyond the recorded raw switch inside its 44 px label.

**Left.** The notice now moves the page down by its own height while it is up (85 px at 360, 66 at 390+), so a live mission's
notice arriving while someone is reading shifts the page once; the alternative was a control under a finger. The Product chip
says "Not loaded", not why; the error state under it carries the sentence and the retry. On a phone the Graph row and its 44 px
arrow now do the same thing (open Events); the arrow stays because it is the visible affordance on a row that also carries the
count. The empty roster's button repeats the Designer the navigation already has, which is the point of an empty state's one
action. Seen while measuring and untouched: the 320 Events head still puts Pause updates on a row of its own between the title
and the lede, and the delivery notice still stacks if several arrive at once.

### 2026-11-07 — an empty command is not a request, a failed read is a sentence, and a legend key says the press it makes

Surface: `src/views/Playground.tsx` and `src/playground.ts` (`canRun`, the empty-command refusal), `src/components.tsx`
and the new `src/errorwords.ts`, `src/views/Graph.tsx` and `src/graph.ts` (`kindKeyWords`), `src/styles.css` (the
inspector chip's width floor), with `tests/dashboard/playground.test.ts`, the new `error-words.test.ts`,
`graph.test.ts` and `phone-targets.test.ts`.

Measured on the scripted demo at **Delivered** (481 events, 49.3k of 2.0M tokens, 7 checks, 9 files, 7 seats, 28 turns,
ran 19s) in the production build served by `curule console`, Chromium 1248 at 320/360/390/768/1,024/1,440 in light and
360/1,440 in dark, a touch pointer at every width for the chip, reduced motion, axe-core 4.14. Both halves are the
**same delivered log**: the before is this worktree at `04ead2a` served on 8,363, the after this branch's build on the
same port without restarting the mission; the clock is the only difference.

- **Run posted an empty command.** On the Playground, with the box empty, Run was enabled (**336 × 44**, opacity 1) and
  pressing it sent `{command:""}`: the host answered 400 and the page drew its schema complaint, **"provide a \`command\`"**,
  at 360 y = 528.9 — **315.3 px below the field's bottom** — under a note that already said "Type one above". The press is
  guarded now (`canRun` in `playground.ts`): Run is **disabled, opacity .5** at 360 and 1,440, typing `node …` makes it
  enabled, and Enter in the empty box keeps focus in the field (**0 POSTs**, no refusal). If that contract error ever
  arrives it reads **"Type a command to run."** A 400 for any other reason still shows the server's sentence.
- **A failed read printed the browser's exception.** With the file list, the budgets and the graph refused at the
  transport, each `ErrorState` body was **"Failed to fetch"** — Chromium naming its machinery, 100 px wide at 360 and
  1,440. The same component already had the sentence for a missing detail; `errorwords.ts` maps the browser's five
  phrasings (and only those) to **"The mesh server did not answer. It may be restarting."** The Files card is
  **225.8 → 246.8** at 360 (the body **100 × 21 → 304 × 42**, two lines) and **209.8 → 209.8** at 1,440 (body
  **100 × 21 → 377 × 21**); the page is **780** at 360, **836** at 1,440. A server's own 503 sentence is kept.
- **A legend key's name said the opposite press.** All five Graph keys carried `aria-pressed="true"` and
  `aria-label="Show lines: approved"` while their title said "Hide the lines that approved"; a screen reader heard
  "Show lines: approved, pressed". `kindKeyWords` gives the key the press it will make: shown → **"Hide lines: …"**
  (title Hide), hidden → **"Show lines: …"**, and toggling one key reads Show / `aria-pressed="false"`. The five key
  boxes are unchanged (137/105/95/97/111 × 44 at 360) and the page is **1,917** at 360 and **1,498** at 1,440.
- **The inspector's shortest chip was 38 px on a finger.** The 44 px width floor for the Designer inspector's chips
  lived in the 760 phone block, so a touch laptop at 1,440 measured **"qa" 38 × 44** in both "May message" and "Also
  reachable by" — the only controls under 44 × 44 in the view (the 18 × 18 switch inside its 44 px label is the
  recorded exception). The floor is in the coarse block at every width now: **44 × 44**, its word centred, the row
  still fits (chips content 366 in 366) and the panel does not scroll sideways (398 / 398). 768 and 1,024 coarse take
  it too; a fine pointer keeps the 38 px density at 1,440.

| | Before | After |
|---|---|---|
| Playground Run, empty box, 360 / 1,440 | enabled, opacity 1 | **disabled, opacity .5** |
| Pressing it: POSTs / refusal | 1 / "provide a \`command\`" | **0 / none** |
| The refusal at 360: y, below the field | 528.9, 315.3 | **—** |
| The Playground page, 360 (with / without the refusal) | 1,151 / 1,093 | **1,093 / 1,093** |
| Typing `node …`: Run | enabled | **enabled** |
| Enter in the empty box: focus | the page | **the command field** |
| Files' error body, 360 / 1,440 | "Failed to fetch", 100 × 21 | **the sentence, 304 × 42 / 377 × 21** |
| The Files error card, 360 / 1,440 | 225.8 / 209.8 | **246.8 / 209.8** |
| Cost and Graph error bodies | "Failed to fetch" | **the sentence** |
| A 503's own sentence | kept | **kept** |
| Graph keys shown: name / pressed / title | Show / true / Hide | **Hide / true / Hide** |
| A key toggled off: name / pressed / title | Show / false / Show | Show / false / Show (unchanged) |
| "qa" chip, 1,440 touch | 38 × 44 | **44 × 44** |
| Under-44 controls in the view, 1,440 touch | 2 ("qa", twice) | **0** |
| The inspector panel, 768 / 1,024 / 1,440: scroll / client | — | **399/399, 399/399, 398/398** |
| Axe, the four states × 360/1,440 light and 360/1,440 dark | 0 | **0** |
| Horizontal page scroll, 320–1,440 × both themes | 0 | **0** |
| Controls under 44 × 44 at 320/360/390, the changed views | 0 | **0** |

Floors: `npm run typecheck` and `npm run build` clean; `dist/tests/dashboard` **1,272 pass, 0 fail** (the new
`error-words` and the changed `playground`, `graph` and `phone-targets` rules); eslint **0** on the touched TypeScript
(the stylesheet is outside its configuration); axe **0** in the changed states at 320/360/390/768/1,024/1,440 light and
360/1,440 dark; no page scrolls sideways; the smallest text in the changed views is 11 px (the avatar initials and
sidebar key glyphs).

**Left.** The Playground's Run is disabled with no inline reason; the placeholder and "Type one above." are the only
words, and a field-level hint would be a new line the page does not have. The empty-command map names the server's exact
phrase, so a reworded contract error would pass through as the server wrote it. The browser-failure map is exact
strings, so a proxy's or a translation's own wording is kept — the rule turns the known browser sentences into one
sentence, it does not classify every failure. The Designer's 44 px width is a finger's: a fine pointer at 1,440 keeps
38 px, and the 18 × 18 switch inside a 44 px label is still the recorded exception. Seen while measuring and untouched:
the agent and graph drawers' tab count is still 11 px at 360, the step drawer opened from Overview still reads "1 of 6"
where Steps reads "1 of 28", and the Events page's 81 oldest events are still outside its 400-event read.

### 2026-11-06 — a seat's own record lists all its steps, its budget reads like the rest, and one turn is a turn

Surface: `apps/mesh-server/src/index.ts` and `steps-view.ts` plus `packages/observability/src/steps.ts` (the agent
route's step filter), `src/drawers.tsx` (the Config budget), `src/views/ReplayDrawer.tsx` (one turn), with
`tests/server/steps-routes.test.ts`, `tests/dashboard/drawer-phone.test.ts` and `tests/dashboard/replay-phone.test.ts`.

Measured on the scripted demo at **Delivered** (before 481 events, after 480; 28 turns, 49.3k of 2.0M tokens, 7 seats,
9 files) in the production build served by `curule console`, Chromium 1248 at 360 and 1,440 in light, a touch pointer at
360, reduced motion, axe-core 4.14. The before build is the worktree at `6e03b97` served on 7424; the after is this
branch's build on the same port after a restart. Both halves are the scripted demo at Delivered; the runs differ by one
timing event and by the clock, not by the architect's five turns, the 28 activations or the 49.3k tokens.

- **A seat's drawer counted two of its five steps.** `/agents/:id` filled the step list with the newest 20 turns of
  *every* seat and only then filtered to the agent (`fillTurnSteps(..., stepLimit * 2)` → `buildAgentDetail`'s
  `filter`). Architect had run **5** turns; the route returned **2** recentSteps, so its drawer read **"Recent steps
  (2)"** under **"5 turns run"**, **"50% produced something"** (one of the two it could see) where the five turns are
  **60%** (three produced), and **"— typical turn"** because two steps are fewer than the four a median needs. The
  filter is part of the fill now (`buildTurnSteps(..., keep)` and `fillTurnSteps(..., keep)` apply it before the cut),
  and the route passes the agent's own live turns. `/agents/architect?limit=10` returns **5**; the drawer reads
  **"Recent steps (5)"**, **60%** and **80ms typical turn**, and the Work tab draws **5** cards (drawer 1,078 → 1,131
  at 360; 900 and scrolling at 1,440).
- **The Config tab printed the mission limit raw.** The budget row read **"200k tokens · mission 49.3k / 2000000"**
  while the Cost page and the same row's agent budget say **"2.0M"** and **"200k"**. Both sides of the mission figure
  go through `fmt` now: **"200k tokens · mission 49.3k / 2.0M"**. The row is 57 px at 360 before and after (the value
  column is 200 px, so it still wraps) and 38 px at 1,440; the fix is the figure, not the row height.
- **The Replay said "1 turns".** Explorer ran one turn and the phone's agent table drew the unit beside the figure
  (`rp-u` is shown only at 620 and below; a desk's column head says "Turns"): **"1 turns"** → **"1 turn"**. The drawer
  is 360/360 and 922 tall at 360; at 1,440 the cell is still "1" under "TURNS".

| | Before | After |
|---|---|---|
| `/agents/architect?limit=10`: recentSteps | 2 | **5** |
| The drawer's "produced something", 360 / 1,440 | 50% | **60%** |
| The drawer's "typical turn", 360 / 1,440 | — | **80ms** |
| The Work tab: heading / cards at 360 | Recent steps (2) / 2 | **Recent steps (5) / 5** |
| The agent drawer's scroll height at 360 | 1,078 | **1,131** |
| The Config budget row at 360 / 1,440 | mission 49.3k / 2000000, 57 / 38 px | **mission 49.3k / 2.0M, 57 / 38 px** |
| The Replay's explorer row at 360 | 1 turns | **1 turn** |
| The Replay drawer at 360: width / height | 360 / 922 | 360 / 922 |
| Axe, the agent drawer Now/Work/Config and the Replay, 360 / 1,440 | — | **0 violations** |
| Horizontal page scroll, those states | 0 | **0** |
| Controls under 44 at 360, those states | 0 | **0** |
| Off-ramp type, those states | 0 | **0** |
| Console errors, those states | 0 | **0** |

Floors: `npm run build` and `npm run typecheck` clean; `dist/tests/dashboard` **1,265 pass, 0 fail**;
`dist/tests/server/steps-view.test.js` + `steps-routes.test.js` **16 pass, 0 fail** (the new route test fails 1 when
the old route is put back); eslint **0 errors, 24 warnings**, all the pre-existing cross-package import warnings; axe
**0** in the changed states at 360 and 1,440; no state scrolls the page sideways; no control under 44 × 44 at 360.

**Left.** The drawer's vitals still read the last **10** turns (`?limit=10`), not the seat's whole history: a seat with
50 turns gets a 10-turn sample for "produced something" and "typical turn" while "turns run" is the full `activations`;
the route's cap is the next question, and "Recent steps" is honest about it. The Config budget row still wraps to two
lines at 360 (57 px) because the value column is 200 px; a label/value split would make it one line, but the table's
shape is unchanged. The Replay's "1 turn" is visible only at 360; at 1,440 the unit is hidden by design and the column
head names it. Seen while measuring and untouched: the step drawer opened from Overview's Latest work reads "1 of 6" and
walks only the six the Overview fetched, while the same turn from Steps reads "1 of 28"; the Graph key's aria-label still
says "Show lines: …" while its `aria-pressed` is true (its title says hide); the agent and graph drawers' tab badge is
11 px at 360; the Events page's 81 oldest events are still not loaded.

### 2026-11-06 — a fold switch says what its list is doing, a folder crumb is a thumb's target, and Latest work draws the six it counts

Surface: `src/views/Events.tsx` (the fold switch's state and its reason), `src/styles.css` (the crumb's phone width floor),
`src/views/Overview.tsx` (the work list), with one rule each in `tests/dashboard/events-log.test.ts`,
`phone-targets.test.ts` and `overview-index.test.ts`.

Measured on the scripted demo at **Delivered** (481 events, 49.3k of 2.0M tokens, 7 checks, 9 files, 7 seats, 28 turns,
ran 3m 41s) in the production build served by `curule console`, Chromium 1248 at 320/360/1,440 in light, a touch pointer
at 800 and below, reduced motion, axe-core 4.14. Both halves are the **same delivered log**: the before console is the
base build at `e6a0b2e` on 8841, the after this branch's build on 8881. Each pair opens the same state: Events filtered
to Routine, Product's Files card two folders down, and Overview's Latest work section.

- **The fold switch said on while nothing was folded.** Filtered to **Routine**, folding is turned off — one fold row
  would hide all 284 results — but the switch still read on. At 1,440 with Routine on: **26 fold bars and 110 rows** before
  the filter, **0 and 284** after, and the switch still `checked`; pressing it off and on again changed nothing (0 folds,
  284 rows both times). At 360 the same, with the switch **178 × 44** and its label claiming the fold. It now reads the
  list's own answer (`foldPref && !routineOn`): off, disabled, with the reason under it, **"Off while the Routine filter is
  on."**, 209 × 18.2. The routine state's facet row grows **70.5 → 81.8** at 1,440 and stays **308** at 360, where the 44 px
  label floor already covers the hint; the Events page does not move (**836** and **788**). The list is still 284 rows and
  no folds — that is what the filter asks for — and the control no longer says otherwise. Clearing Routine restores the
  preference and the checked switch.
- **A folder crumb was 27–34 px wide on a phone.** In the Product page's Files card, two folders down, **root** measured
  **34 × 44** and **src 27 × 44** at 320 and 360: both took the phone's height floor but kept their own text width, the two
  smallest targets on the screen, on the only way back up the tree. The touch block now gives `.crumb-btn` a **44 px**
  minimum width and 10 px of inline padding: both are **44 × 44** at 320 and 360, the crumb row stays one **44 px line**
  (**254 / 294** wide) and the Product page does not move (**1,648 / 1,529**). At 1,440 a pointer keeps **34 × 24** and
  **27 × 24**, because the floor is a finger's.
- **Latest work counted six and drew five.** The page asks for six steps and its door and closed row count them
  (**"Latest work 6"**, **"6 steps"**), but the section drew `steps.slice(0, 5)`: at 1,440 the sticky index read 6 over
  **five** rows and the page was **1,787**; at 360 the closed row said **6 steps** and opening it showed **five** rows
  (**1,352**). It draws every step it counted now: **six** rows at both widths, the sixth being **pm · release candidate ·
  29m ago · 2 messages · produced**; the opened phone section is **1,444** and the desk page **1,809**, while the closed
  360 page is unchanged at **858**. The figure, the closed row and the rows are one number.

| | Before | After |
|---|---|---|
| The fold switch with Routine filtered, 1,440: checked / folds / rows | on / 0 / 284 | **off + disabled / 0 / 284** |
| Pressing that switch off and on again, 1,440 / 360 | 0 folds, 284 rows both times | **cannot be pressed; its reason is on screen** |
| The switch's label at 360 | 178 × 44, no reason | **251 × 44, hint 209 × 18.2** |
| The facet row with Routine on, 1,440 / 360 | 70.5 / 308 | **81.8 / 308** |
| The Events page, 1,440 / 360 | 836 / 788 | 836 / 788 |
| The crumb "root" at 320 / 360 | 34 × 44 | **44 × 44** |
| The crumb "src" at 320 / 360 | 27 × 44 | **44 × 44** |
| The crumb row at 320 / 360: content / line | 254 / 44, 294 / 44 | 254 / 44, 294 / 44 (one line) |
| The same crumbs at 1,440 | 34 × 24, 27 × 24 | 34 × 24, 27 × 24 (unchanged) |
| The Product page at 320 / 360 / 1,440 | 1,648 / 1,529 / 1,059 | 1,648 / 1,529 / 1,059 |
| Latest work rows: 1,440 / 360 open | 5 / 5 | **6 / 6** |
| The door and the closed row | "Latest work 6", "6 steps" | "Latest work 6", "6 steps" (now true) |
| The Overview at 1,440 / 360 open / 360 closed | 1,787 / 1,352 / 858 | **1,809 / 1,444 / 858** |
| Axe, the three states × 320/360/1,440 light and 360 dark | — | **0 violations** |
| Horizontal page scroll, those states | 0 | **0** |

Floors: `npm run typecheck` and `npm run build` clean; `dist/tests/dashboard` + `dist/tests/build` **1,502 pass, 0 fail**
(one new rule in each of `events-log`, `phone-targets` and `overview-index`, each mutation-checked by putting the old
code back); eslint **0** on the touched TypeScript (the stylesheet is outside its configuration); axe **0** in nine reads
over the three states at 360 and 1,440 light and at 360 dark; no state scrolls the page sideways.

**Left.** The fold switch is disabled rather than able to fold 284 routine events into one row, and a reader must clear
the Routine filter to use it again; the hint says why, but a reader who does not connect the two will find a greyed
control. The crumb's new 44 px width costs 10 px a segment: a path of five or more folders will wrap to a second 44 px
line at 320 (it wraps rather than scrolls, and two segments still share one line). Latest work's sixth row is 92 px of
an opened phone section and 22 px of the desk page; it is the most recent step, not the whole 28, and All steps is still
the way to the rest. Seen while measuring and untouched: the agent and graph drawers' tab badge is 11 px on a phone, and
the Replay drawer's explorer row still reads "1 turns".

### 2026-11-06 — a timeline's window chips are thumb-wide, a payload's one door is 44 tall, and Start waits for a command

Surface: `src/styles.css` (the phone-target floor and the timeline's segmented choice), `src/views/steps.css` (the trough's
narrowest phone shape), `src/productlive.ts` (`canStart`), `src/views/YourProduct.tsx` (the button binding), with
`tests/dashboard/phone-targets.test.ts`, `steps-phone.test.ts` and `productlive.test.ts`.

Measured on the scripted demo at **Delivered** (481 events, 49.3k of 2.0M tokens, 7 checks, 9 files, 7 seats, 28 turns,
ran 2m 50s) in the production build served by `curule console`, Chromium 1248 at 320/360/700/1,440 in light, a touch
pointer at 800 and below, reduced motion. Both halves are the **same delivered log**, and each pair opens the same state:
the Steps timeline by its caption, the first Event and then its Payload, the Product page at *Its own UI* with an empty
command.

- **The Steps timeline's window choice was under 44 px wide.** Opened on the delivered run, its six chips measured
  **39, 41, 49, 36, 44 and 36 px wide × 44 tall** at 320 and at 360 (Fit / 5m / 30m / 2h / 12h / all): four under the floor,
  the smallest 36. The page head's own Cards/List choice had already been widened by `.page-head .seg button`, but the
  timeline's trough is drawn by a view sheet that rule never reached. The floor now names `.st-tl-head .seg button`: at 360
  the six are **44, 44, 49, 44, 44, 44** on one **285 in 285** row (the page stays 3,875), and at 700 the same 285 px row
  holds them. At 320, six 44 px chips need **280 px** in a **260 px** trough, so the head is a query container (`st-head`)
  and lays them **3 × 2** — each **83.3 × 44**, trough **260 / 260**, the page **3,968 → 4,014** — rather than leaving the
  last chip half out of a scroller. The desk at 1,440 keeps its **36–49 × 28** chips: the floor is the thumb's.
- **An event's payload had one door 24 px tall.** Opening the first Event and scrolling to *Payload* finds a single
  collapsed tree row, `messageid, protocolVersion, type, +11`, **304 × 24.14 px** at 360 — the only way into the tree, half
  a thumb's target. `.jt-row.can` now takes the phone floor and centres its line: the row is **304 × 44**, the payload block
  **111.1 → 131**, and the event pane keeps its **836 px** page and scrolls inside it. A leaf row is text, not a control, so
  it stays 24.14; at 1,440 the desk row is unchanged at **498.9 × 24.14**.
- **Start it was enabled with nothing to start.** On the Product page's *Its own UI*, with the command box empty, the
  **123.7 × 44** button was `disabled=false`; pressing it changed **0** lines of the view and left focus on the button, while
  the "Type how this product starts its own UI…" sentence already sat above the field. The model now says whether there is
  a command (`canStart`: empty and whitespace false), and the button follows it: with the box empty it is **disabled=true,
  opacity .5** at 360 and 1,440, and typing `node bin/ui.js` makes it **disabled=false, opacity 1**. An empty press no longer
  fires (a forced press focuses the page, not the button).

| | Before | After |
|---|---|---|
| The timeline chips at 360: Fit / 5m / 30m / 2h / 12h / all | 39 / 41 / 49 / 36 / 44 / 36 × 44 | **44 / 44 / 49 / 44 / 44 / 44 × 44** |
| The same at 700 | 39 / 41 / 49 / 36 / 44 / 36 × 44 | **44 / 44 / 49 / 44 / 44 / 44 × 44** |
| The trough at 360: content / box | 261 / 261 | **285 / 285** |
| The trough at 320: content / box | 261 / 260 (1 px scroll) | **260 / 260** (3 × 2) |
| A window chip at 320 | 39–49 × 44 | **83.3 × 44** |
| The Steps page at 320 / 360 | 3,968 / 3,875 | **4,014 / 3,875** |
| The desk chips at 1,440 | 36–49 × 28 | 36–49 × 28 (unchanged) |
| The Event payload door at 360 | 304 × 24.14 | **304 × 44** |
| The payload block at 360 | 111.1 | **131** |
| The Event page / pane at 360 | 836 / 997 | 836 / 997 |
| The desk payload door at 1,440 | 498.9 × 24.14 | 498.9 × 24.14 (unchanged) |
| The Product Start with an empty box, 360 / 1,440 | 123.7 × 44, enabled; press changes 0, focus stays | **123.7 × 44, disabled (.5); typing enables (.5 → 1)** |
| Axe / horizontal page scroll, the three states × 320/360/1,440 light | — | **0 / 0** |

Floors: `npm run typecheck` and `npm run build` clean; `dist/tests/dashboard` + `dist/tests/build` **1,496 pass, 0 fail**
(two new rules, one in `steps-phone` and one in `productlive`, and two selectors added to `phone-targets`; each was
mutation-checked by putting the old code back); eslint **0** on the touched TypeScript (the two stylesheets are outside its
configuration); axe **0** in nine reads over the three states at 320/360/1,440; no state scrolls the page sideways.
`npm run qa:console` at 1,440/390 in both themes: **52 screenshots, 52 axe runs, 0 violations, 0 px of page scroll**, and
the one console error in every read is the single-mesh `/api/projects` 404 the spec expects.

**Left.** At 320 the trough is two rows, **96 px** tall, and the Steps page grows **46 px**: six 44 px chips cannot share
260 px, and the 3 × 2 grid is the whole set rather than a scroll. At 360 the six exactly fill **285 px**, so a translation or
a wider font would need the trough's scroll back. The payload's leaf rows stay **24.14 px**: only `.can` rows expand, and a
tree with many expandable nested rows is taller on a phone. The Start button is prevented, but the sentence above it is
still the model's hint rather than a field error; Enter in the empty box still takes the model's empty path (it re-says the
same sentence). The Replay drawer's explorer row still reads "1 turns" — a wording bug seen while measuring, outside this
pass's three controls.

### 2026-11-06 — a phone's help is not behind its menu, its step chips are 44 px, and two labels leave the 11 px step

Surface: `src/shell.tsx` (`openHelp`), `src/views/drawers.css` (the phone jump row), `src/designer/topology.css`
(`.ms-flag`), `src/views/steps.css` (`.st-tick`), with one rule in each of `tests/dashboard/help.test.ts`,
`drawer-phone.test.ts` and `phone-type.test.ts`.

Measured on the scripted demo at **Delivered** (481 events, 49.3k of 2.0M tokens, 7 checks, 9 files, 7 seats, 28
turns, ran 3m 6s) in the production build served by `curule console`, Chromium 156 (headless Chrome over CDP) at
320/360/390/768/1,024/1,440 in light and 360/1,440 in dark, a touch pointer at 800 and below, reduced motion,
axe-core 4.14. The before bundle is the same worktree at `6d0bf23`, built and served in the same session.

- **The help button did nothing while the phone's menu was open.** The button lives at the foot of the sidebar; at
  360 opening the menu and pressing it drew the help panel at **360 × 900, z = 40** under the menu at **288 × 900,
  z = 50**. The only visible change was the button's own pressed background — the point at (180, 60) was still the
  sidebar — and Escape, which unwinds the menu first, was the only way to see the help that had been opened. At 320 the
  menu covered **275.2 of the panel's 320 px** (86%; 80% at 360). `openHelp` closes the menu first now: at 360 the
  sidebar is off-screen at **x = −302.4**, the help panel is **360 × 900** and the element at its title row is its own
  `drawer-head`; at 320 it is **320 × 900**. The `?` key goes through the same function, so it no longer opens the
  panel behind a menu either.
- **Three jump chips in a step's drawer were under 44 px wide.** With the first turn open, the jump row's Tools,
  Brief and Raw chips were **39.6, 37 and 33.6 px** at 320, 360 and 390 (Outcome, Reasoning and Events were 67.7, 72.2
  and 48.1). They were the only pressed things under 44 × 44 in the twelve views and the drawers. The phone block now
  gives every chip a **44 px** width and centres its word; the row's gap narrows from 4 to 2 px so the six chips still
  share one **334 px** row at 360 (329.98 px of content), and the 320 row wraps exactly as before (two rows, **88 px**).
  At 1,440 with a fine pointer the chips keep their 36 px height and 64.5/49/45.6 px widths.
- **Two labels were 11 px: a seat flag and a clock tick.** The Designer's seat list drew "Starts" and "Service" as
  **11 px** mixed-case chips, and the Steps timeline drew its clock ticks ("23:39:30") as **11 px** figures at 768 and
  1,440. The 11 px step belongs to a capital micro-label and to a glyph mark (the avatar initials), not to a word or a
  time. Both are **12 px** now: the flags measure 67.7 and 60.9 px wide, and a tick is 47.6 px wide with 202.1 px
  between major ticks at 768 and 187.7 px at 1,440, so nothing collides. The Designer page grows **4 px** (320:
  1,096, 360: 1,057, 390: 1,023); the Steps page does not move (2,576 at 768, 2,438 at 1,440). The only 11 px text left
  in a view is the avatar initials, a glyph in a 22 px disc.

| | Before | After |
|---|---|---|
| Help under the phone menu at 360: menu / panel | 288 × 900 (z 50) over 360 × 900 (z 40) | panel 360 × 900, menu closed (x −302.4) |
| Help under the phone menu at 320 | 275.2 × 900 over 320 × 900 | panel 320 × 900, menu closed |
| The step jump chips at 320/360/390: Tools / Brief / Raw | 39.6 / 37 / 33.6 | **44 / 44 / 44** |
| The jump row at 360: content / row | 318.2 / 334 (one row) | **329.98 / 334** (one row) |
| The jump row at 320 | 294 / 88 (two rows) | 294 / 88 (two rows) |
| The jump chips at 1,440 | 64.5 / 49 / 45.6, 36 tall | 64.5 / 49 / 45.6, 36 tall |
| A seat flag: font / "Starts" / "Service" | 11 / — / — | **12** / 67.7 / 60.9 |
| The Designer page at 320 / 360 / 390 | 1,092 / 1,053 / 1,019 | **1,096 / 1,057 / 1,023** |
| A timeline tick: font / width | 11 / — | **12** / 47.6 |
| Major-tick spacing at 768 / 1,440 | 202.1 / 187.7 | 202.1 / 187.7 |
| The Steps page at 768 / 1,440 | 2,576 / 2,438 | 2,576 / 2,438 |
| Axe, 12 views × 320/360/390/1,440 × both themes | — | **0 violations (96 reads)** |
| Horizontal page scroll, 320–1,440 × both themes | 0 | **0** |

Floors: `npm run typecheck` and `npm run build` clean; `dist/tests/dashboard` + `dist/tests/build` **1,491 pass, 0
fail** (three new rules, one in each of `help`, `drawer-phone` and `phone-type`; each was mutation-checked by putting
the old code back); eslint 0 on the touched TypeScript; axe 0 in 96 reads; no page scrolls sideways at
320/360/390/768/1,024/1,440 in light or 360/1,440 in dark; no pressed thing under 44 × 44 at 320/360/390 in the views
or the drawers beyond the 1 × 1 skip link and the raw switch inputs inside their 44 px labels; and every word or figure
in a view is 12 px or larger, the avatar initials (11 px glyphs) aside.

**Left.** The jump row still wraps at 320 (two 44 px rows), and the 2 px gap that keeps 360 on one row is the price of
six 44 px targets in a 334 px row; a translation or a wider font wraps it as at 320, which the row already supports.
The Events and Steps header still says **Live** while the list's own bar says **Updates paused** — two facts, and the
open question from the 2026-11-05 pass about that chip; this pass did not change it. The phone's drawer close is 44 px,
the desk's stays 32. The help fix is measured in Chromium with touch emulation in CSS, not on hardware, and the screen
reader path (`?` and Escape) is reasoned from the one handler, not read with a real screen reader.

### 2026-11-05 — a phone's drawer tabs wrap, and its open request names the seat

Surface: `src/styles.css` (the phone tab strip and the dock tab's inset), `src/views/steps.css` (the pulse row as a
container and its 320 caption), `src/inbox-model.ts` (`pendingLine`, `pendingRecipients`), `src/drawers.tsx` (the Signals
line), with one rule in each of `tests/dashboard/frame-phone.test.ts`, `phone-head.test.ts`, `drawer-phone.test.ts` and
`inbox-model.test.ts`.

Measured on the scripted demo at **Delivered** (481 events, 49.3k of 2.0M tokens, 7 checks, 9 files, 7 seats, 28 turns, ran
2m 14s) in the production build served by `curule console`, Chromium 1248 at 320/360/390/768/1,024/1,440 in light and
360/1,440 in dark, a touch pointer at 800 and below, reduced motion, axe-core 4.14. Both halves are the **same delivered
log**: the before bundle is the same worktree at `1db915e`, built and served in the same session. The phone pair is pm's
drawer at 360 (`#/p/demo-stub/agents`, then the first `.agent-open`) and the desk pair the same drawer at 1,440; the 320 pair
is `#/p/demo-stub/steps` and `#/p/demo-stub/overview` at `#view.scrollTop` 0.

- **The drawer's last tab was off the phone.** At 360 the tab strip was **328 px client and 388 px of tabs** (Now 82, Work 60,
  Comms 78, Memory 82, Config 70): Config began at **x = 334**, wholly past the 360 edge, behind `overflow-x: auto` with the
  scrollbar hidden. At 320 two tabs were off (Memory right **330**, Config **404**); at 390 Config alone (**404**). It wraps
  now: the strip is **328/328** at 360 (**93 px** tall, two rows), Config at **x = 16** on the second row; at 320 Now/Work/Comms
  then Memory/Config; at 390 four then Config. The desk's sliding ink gives way on a phone to the chosen tab's own 2 px
  underline, so a wrapped strip still says which one is open; 768 and 1,440 keep one row (**515/515**) and the ink. The
  drawer's own content grows **48 px** (1,178 → 1,226 at 360); the page behind does not move.
- **The pulse's three captions ran together at 320.** The card's content is **262 px**, so its three columns are **79.3**;
  "Turns done" needs **98** and its right edge was **127** against "Tokens" at **120.3** — **6.7 px of one caption over the
  next**, read as "TURNS DONETOKENS" — and "No output" was **88** in **79.3**, 8.7 px past the content edge. The pulse row is
  a container now: at **280 px or narrower** the captions wrap and reserve their second line. At 320 each label is **79.3 ×
  31.2** with scrollWidth **79** in clientWidth **79** (no overflow), the figures stay **28 / 49.3k / 44%** and their values
  align; the strip **57.6 → 73.2**, the page **3,305 → 3,320**. At 360 the strip stays **57.6** and the 5.3 px overflow sits in
  the **12 px** gap between columns (nothing touches); 390/768/1,024/1,440 do not move.
- **The fifth dock tab said "Needs …".** At 320 a tab is **64 px** and "Needs you" is **63**; the tab's **2 px inset each
  side** left the label **60**, so `text-overflow: ellipsis` drew "Needs …". The tab has no side padding now: the label's box
  is **63 in 64** and the name is whole, while the target stays **64 × 52**. At 360 ("63 in 63"), 390 and 768 nothing
  changes; the dock's height and every page's height are unchanged.
- **The drawer's open request did not name the seat it waited on.** On the delivered demo pm's drawer said "**1 open request
  waiting on an answer**" while the person's own inbox was correctly empty (`/escalations` `[]`, `/tool-approvals`
  `{"seats":[]}`); the request is pm → **security** for the release-plan review. The sentence is built from the request's
  `to` now — "**1 open request waiting on security**" — in the same **37.5 px** line at 360 and 1,440, so the drawer and Needs
  you no longer look like they disagree about who is waiting.

| | Before | After |
|---|---|---|
| The drawer tab strip at 360: client / scroll | 328 / 388 | **328 / 328** |
| Its last tab, x → right | 334 → 404 (off screen) | **16 → 86** (second row) |
| Tabs off screen: 320 / 360 / 390 | 2 / 1 / 1 | **0 / 0 / 0** |
| The strip's height at 360 | 44 | **93** (two rows) |
| The drawer's scroll height at 360 | 1,178 | **1,226** |
| The Steps strip at 320 / 360 | 57.6 / 57.6 | **73.2 / 57.6** |
| "Turns done" at 320: box / text | 79.3 / 98 (6.7 px into Tokens) | **79.3 / 79** (wrapped) |
| "No output" at 320: box / text | 79.3 / 88 | **79.3 / 79** |
| The Steps page at 320 | 3,305 | **3,320** |
| The dock label at 320: box / text | 60 / 63 ("Needs …") | **63 / 63** ("Needs you") |
| The dock tab at 320 | 64 × 52 | 64 × 52 (unchanged) |
| The Signals line | 1 open request waiting on an answer | **1 open request waiting on security** |
| Its line height at 360 / 1,440 | 37.5 / 37.5 | 37.5 / 37.5 |
| Axe, 13 views × 320/360/390/1,440 light and 360/1,440 dark | — | **0 violations (78 reads)** |
| Horizontal page scroll, 320–1,440 × both themes | 0 | **0** |

Floors: `npm run typecheck` and `npm run build` clean; `dist/tests/dashboard` **1,256 pass, 0 fail** (four new rules, one in each of
`inbox-model`, `frame-phone`, `phone-head` and `drawer-phone`); `dist/tests/build/console-palette.test.js` **7 pass**; eslint **0 errors** on the touched TypeScript
(the two CSS files are outside its configuration); axe **0** in 78 reads; no page scrolls sideways at 320/360/390/768/1,024/1,440
in light or 360/1,440 in dark; no control under 44 × 44 at 320/360/390 beyond the 1 × 1 skip link (the two raw switch inputs
still sit inside 44 px labels); the smallest text stays 11 (the avatar initials), and the 320 caption is 12, the ramp's phone
step.

**Left.** The tab strip is **93 px** at 320/360/390, one 44 px row more than the desk's; that is the price of a Config a thumb
can reach, and at 390 the second row holds Config alone. The 360 pulse caption still runs **5.3 px** into the **12 px** gap
between its column and Tokens; it does not touch the next word, so the container query stops at the card width that collides, and
a longer caption would need the same treatment. The `Live` chip on a delivered mission is still the open question from the last
pass (a word about the stream, beside "Delivered"). The open request names its seat but is not a door to the thread, and with
more than two recipients the third is counted rather than named. The 320 dock label fits by **1 px** (63 in 64); a translation
or a wider font ellipsizes it again. None of this is read on hardware; the 320/360/390 figures are Chromium with touch emulation
in CSS.

### 2026-11-05 — a phone row shares its width at 320, and a thumb's tablet folds its filters

Surface: `src/live.css` (the search's phone basis), `src/views/files.css` (the Files basis and the coarse fold),
`src/views/events.css` and `src/views/steps.css` (the coarse fold), `src/views/Artifacts.tsx` (`FOLD`), `src/views/Events.tsx`
(the lede) and `src/views/Steps.tsx` (the zone's words), with `tests/dashboard/files-phone.test.ts`,
`events-phone.test.ts` and `steps-phone.test.ts`.

Measured on the scripted demo at **Delivered** (481 events, 49.3k of 2.0M tokens, 7 checks, 9 files, 7 seats, 28 turns) in the
production build served by `curule console`, Chromium 1248 at 320/360/390/768/820/900/1,024/1,440 in light and 360/768/1,440 in
dark, a touch pointer at 900 and below, reduced motion, axe-core 4.14. Both halves are the **same delivered log**: the before
bundle was rebuilt from `git stash` and swapped under the running console for each pair.

**At 320 the search and the folded Filters button were two rows.** The search's 200 px basis plus the 105 px button and the
8–12 px gap is 313–317 in 296, so on Events and Files the button took a second 44 px row: the Files bar was **96 px**, its first
group at **281.6**, the page **1,295**; Events' tools were **96** and its log **448.9**. A 170 px basis at a phone width — the
search still grows to **219.1 at 360** and **249.1 at 390** — and Files' 200 px `min-width` giving way share the row: Files
**44 px**, first group **229.6**, page **1,243**, search **179.1**; Events tools **44**, log **500.9**, search **183.1**. The
placeholder clips at 320 (the Files screenshot reads "Name, o…"), which is the trade the previous pass named; 360/390/768/1,440
do not move.

**A touch tablet kept the filters in plain sight.** At 768 on a coarse pointer the Events facets took **112 px** and left the
log **491**; the Steps chips and switch took **166 px** of toolbar, the first turn at **934.8** and the page **2,686**; the Files
filters took **104 px**, the first file at **268.6** and the page **1,002**. The phone folds all three behind one 44 px button,
and now so does a thumb above the phone break: Events facets **0**, toggle **44**, log **615**; Steps toolbar **60**, first turn
**828.8**, page **2,580**; Files bar **44**, first file **208.6**, page **942**. A fine pointer at 768 keeps its chips (Events
80, Steps 114, Files 68) because the query is `(pointer: coarse)`.

**The Steps timeline caption wrapped at 320/360.** "Who was busy, when" (179.2) + 12 + "Times in GMT+3:30" (118) is **309.2**
in 302 at 360 and 262 at 320, so the 44 px caption row was **69.4 px**. The visible note is the zone's own words, **"GMT+3:30"**
(64), with "Times in " sr-only and the full phrase in its title: the row is **44** at 320/360/390, the page **3,253 → 3,227** at
360, and the screen reader still hears "Times in GMT+3:30".

**The Events lede claimed every event.** The page holds the newest 400 of 481 and says so at its end — "81 older ones are not
loaded" — while the lede said "Everything the mesh does". It says **"The newest events first."** now; the page is 836 either way,
and the end note is unchanged.

| | Before | After |
|---|---|---|
| The Files bar, 320 | 96 | **44** |
| The Files first group, 320 | 281.6 | **229.6** |
| The Files page, 320 | 1,295 | **1,243** |
| The Files search, 320 | 296 | **179.1** |
| The Events tools, 320 | 96 | **44** |
| The Events log, 320 | 448.9 | **500.9** |
| The Events search, 320 | 296 | **183.1** |
| The Events facets, 768 touch | 112 | **0** (toggle 44) |
| The Events log, 768 touch | 491 | **615** |
| The Steps toolbar, 768 touch | 166 | **60** |
| The Steps first turn, 768 touch | 934.8 | **828.8** |
| The Steps page, 768 touch | 2,686 | **2,580** |
| The Files bar, 768 touch | 104 | **44** |
| The Files first file, 768 touch | 268.6 | **208.6** |
| The Files page, 768 touch | 1,002 | **942** |
| The Steps caption row, 320 / 360 | 69.4 / 69.4 | **44 / 44** |
| Its zone note, 320 / 360 | 118 | **64** |
| The Steps page, 360 | 3,253 | **3,227** |
| The Events lede, 1,440 | "Everything the mesh does, newest first." | **"The newest events first."** |
| Fine pointer 768: Events facets / Steps toolbar / Files bar | 80 / 114 / 68 | 80 / 114 / 68 |
| Axe, the three views × 320/360/768/1,440 × both themes | — | **0 violations** |
| Horizontal page scroll, 320–1,440 × both themes | 0 | **0** |

Floors: `npm run typecheck`, `npm run build` clean; `dist/tests/dashboard` **1,252 pass, 0 fail** (three new tests, one
rewritten); `dist/tests/build/console-*.test.js` **7 pass**; eslint **0 errors** on the touched TypeScript (the four CSS files
are outside its configuration and report only the ignored-file warning); axe **0** in 20 reads; no page scrolls sideways at
320/360/390/768/1,024/1,440; the smallest text is still 11 (avatar initials and micro-labels).

**Left.** The 320 search is 179–183 px and its placeholder clips (the Files field reads "Name, o…"); that is the price of the shared row. The fold stops at 900, so a
1,024 coarse pointer keeps the Files bar's 104 px and the open facets — a touch laptop is the next measurement. The Files bar at
768 coarse folds but is not sticky (the sticky rule remains the phone's), so its tools still scroll away on a tablet. The Steps
caption's second note ("N older turns outside this window") can still wrap the row if both notes appear at 320; the delivered
state does not draw it. The Events "Live" chip on a delivered mission is still the open question it was.

### 2026-11-05 — a focused control is scrolled clear of the dock, and a closed file says so inside its reader

Surface: `src/styles.css` (the dock block's scroll padding), `src/files.ts` (`versionStateWords`, and `trailWords`' second
argument), `src/artifactreader.tsx` (the reader reads the mission's own fact), `src/views/ReplayDrawer.tsx` and
`src/views/overview.css` (the Replay table's phone shape), with one rule added to `tests/dashboard/dock-phone.test.ts` and
two new files, `tests/dashboard/reader-words.test.ts` and `tests/dashboard/replay-phone.test.ts`.

Measured on the scripted demo at **Delivered** (481 events, 49.3k of 2.0M tokens, 7 checks, 9 files: 3 delivered and 6 never
given a verdict, 7 seats, 17 messages, ran 17s) in the production build served by `curule console`, Chromium 1248 at
320/360/390/768/820/900/1,440 in light and 360/1,440 in dark, a touch pointer at 900 and below, reduced motion, axe-core 4.14
(`qa:console` on each side: 52 page reads at 1,440/390 × both themes, and 52 at 320/768/820/900 light). Both halves are the
**same delivered log**: the before bundle was rebuilt from `git stash` and swapped under the running console for each pair.

**Tab left the last evidence row behind the dock.** `#view` reserved 64 px at its foot for the 52 px row, so a page's last
row was clear of it at rest — but a box the browser scrolls into view is aligned to the scrollport's bottom edge, and the dock
is a layer over that edge. At 360, thirteen Tabs from the top landed on **Just happened: Show** at **800–844** with the dock
at 791–844: the whole 44 px control was behind it, `elementFromPoint` at its centre answered **`.dock-label` "Needs you"**,
and the one thing the keyboard had just selected was invisible. The third row was 2 px clear. The dock's block gives `#view`
the same 64 px as `scroll-padding-bottom` now: the fourth row lands at **732–776**, 15 px above the dock, `elementFromPoint`
answers the button itself, and the third is 736–780. A walk of Overview, Files and Steps at 320/390/768/820/900 finds no
focused control under the row. `scroll-padding-bottom` moves the bottom edge only, so the index's jumps to a section head and
the Files bar's sticky top are untouched.

**The reader called a closed file "ready for review".** The 2026-11-05 pass taught the Files list and the Overview's result
that a file a delivered mission never decided is closed without a verdict, but the reader those rows open still printed the
raw lifecycle word: on the demo's `release-test-report` the list said **closed without verdict**, and pressing the row showed
the same file as **ready for review**, with the trail reading "draft › ready for review". One state, two views, and the one a
person pressed said the work was still waiting after the mission had closed. The reader reads the mission's own fact now
(`facts.goalStatus === "COMPLETED"`, the predicate the Files page reads) and takes its words from `files.ts`
(`versionStateWords`): the pill is **closed without verdict**, the version picker says it for the latest version, and the
trail ends in it (**draft › closed without verdict**). Older versions keep their historical words — a v1 that was ready for
review when v2 landed is a step, not the state now — and a decided file is untouched (`merged`, `approved` …). The words are
the same in the Files pane at 1,440 and in the drawer at 320/360, where they cost no height: the reader head is **112.8** at
320 and **74.4** at 360/390 in both halves.

**The Replay drawer's table was 353 px in a 288 px phone.** The drawer is the page's own width at 620 and below, and the
Agents table's four columns need 353 px: at **320** the layer scrolled **49 px sideways** and the Tokens column sat off the
screen (the head read "TOK", and 14.4k was cut); at **360** it was **9 px**. It draws one ruled row per agent on a phone now,
as the Agents ledger does — the name and its tokens on the first line, the state and its turns under them, each figure saying
its unit (**7.2k tokens**, **4 turns**) because the head is not drawn — while the head stays in the accessibility tree through
the sr-only pattern (axe: 0 violations in the drawer at 320/360 in both themes). The drawer's overflow is **0 at 320, 360 and
390**; the table is 288 in 288 at 320; a desk keeps the four-column table and its head (768: 515 px, unchanged). The
drawer's own `#drawer table.tbl td` rule drew a 1 px line on every cell, which on a stacked row appeared as two short rules
inside the row; the row is the only rule there now.

| | Before | After |
|---|---|---|
| Tab 13, Overview 360: the focused control's box | 800–844, wholly under the 791 dock | **732–776, 15 px above it** |
| `elementFromPoint` at its centre | `.dock-label` "Needs you" | **the button ("Show")** |
| Tab 13's scroll (`#view.scrollTop`) | 10 | **78** |
| Tab 12: Goal checks: Show | 745–789 (2 px clear) | **736–780** |
| Focused controls under the dock, Overview/Files/Steps × 320/390/768/820/900 | 1 on Overview at 360 | **0** |
| The reader's pill, `release-test-report` (list said "closed without verdict") | ready for review | **closed without verdict** |
| Its trail | draft › ready for review | **draft › closed without verdict** |
| A merged file's trail (unchanged) | draft … merged | draft … merged |
| The reader head, 320 / 360 / 390 | 112.8 / 74.4 / 74.4 | 112.8 / 74.4 / 74.4 |
| The Replay drawer's sideways scroll, 320 / 360 / 390 | 49 / 9 / 0 px | **0 / 0 / 0** |
| Its table's width in the drawer, 320 | 353 in 288 | **288 in 288** |
| The last cell at 320 | "7.2k", right edge 369 (49 px off screen) | **"7.2k tokens", right edge 304** |
| The Replay table at 768 | 515, four columns | 515, four columns (unchanged) |
| Axe, the Replay drawer 320/360 × light/dark | — | **0 violations** |
| Horizontal page scroll, 320–1,440 × both themes | 0 | **0** |

Floors: `npm run typecheck`, `npm run build` clean; `dist/tests/dashboard` **1,249 pass, 0 fail** (ten new tests in two
files, one assertion added to `dock-phone`); eslint **0 errors** on the touched files; `npm run qa:console` at 1,440/390 in
both themes — **52 screenshots, 52 axe runs, 0 violations, 0 px of page scroll** — and again at 320/768/820/900 light (**52
screenshots, 26 axe runs, 0**); the only console error in every read is the one-mesh `/api/projects` 404. No colour moved, so
both themes read the same geometry; the 44 px floor is untouched (the stacked rows are text, not controls, and the reader's
pill is a label).

**Left.** The reader drawer still trips `heading-order` (one node, the document's `h4` after the drawer's `h2`) — pre-existing,
and the reader's own layer, not this pass's three fixes. The Events, Steps and Agents chip still says **"Live"** on a delivered
mission beside the bar's "Delivered": the open question from the last pass was measured here, and it is a question of words
rather than a missing fact — "Up to date" (108 px) grows the Events head **110 → 147.1** at 360 and re-breaks the one-line
head the 2026-10-30 pass won, while "Final" (69 px) fits but is false the moment a message adds an event. The reader rewrites
only the *latest* version of an undecided file: an older version's trail is history and keeps its word. The scroll padding
exists only where the dock is drawn (800 and below); above 800 the sidebar is in the flow and there is nothing over the page
foot. The Replay drawer's `Raw replay` block still scrolls inside itself, which is a `pre` of JSON and deliberate. And the
reader's closed words are read from the goal's own status, so a *failed* mission keeps saying "ready for review" as the Files
page does — one rule, one word, and the failure state is a separate decision.

### 2026-11-05 — a delivered receipt sets its verdict at the display step, and a closed file says so

Surface: `src/mission.ts` (the delivered headline), `src/files.ts` (`CLOSED_REVIEW`), `src/views/Shipped.tsx` (the result's
words), `src/views/Artifacts.tsx` (the shared words), `src/views/Agents.tsx` and `src/views/agents.css` (the token column on a
stacked row), `src/views/ToolAccess.tsx` (the empty gate's next move), and six tests (`mission`, `files`, `shipped`,
`failure-states`, and the new `agents-phone`).

Measured on the scripted demo at **Delivered** (481 events, 49.3k of 2.0M tokens, 7 checks, 9 files: 3 delivered and 6 never
given a verdict; 17 messages; 7 seats; ran 2m 0s) in the production build served by `curule console`, Chromium 1248 at
320/360/390/768/1,440 in light, a touch pointer at 768 and below, reduced motion, axe-core 4.14 at 360 and 1,440 in both
themes. Both halves are the **same delivered log**: the before is the base at `fc5cecf`, and the after bundle was swapped
under the same running console without restarting the mission. The 320 receipt before was read by putting the base build's
exact headline markup back into the same live DOM, because the first captures did not include 320.

**The delivered verdict was a paragraph, not a verdict.** The completion change of 4 Nov made a delivered mission with work
left say `Delivered, with work left on the table: 6 files were never given a verdict.` as one sentence. `splitHeadline` only
splits at a full stop, so the whole sentence took the `.long` step: **20 px at 320/360/390 and 24 px at 768/1,440**, with no
`Delivered.` at 30; at 360 it was four lines of **96 px** and the receipt was **516.6**, 36.6 px past the 480 the 4 Nov entry
records. It is two sentences now: **`Delivered.` at 30** and the facts at 16 on a phone / 18 on a desk. The receipt is **480 at
360 and 489.1 at 390** (the 4 Nov numbers) and **498.1 at 320**; the second evidence row's 44 px head is whole above the 747 px
dock at all three (5.3 / 23.5 / 14.3 px clear, where it was 50.3 / 13.2 px under and 1.7 above). At 768 and 1,440 the receipt
is **4.6 px taller** (463.4 / 267.8 against 458.8 / 263.2): the state at 30 and its sentence on its own line is one line more
than the long-sentence step, and that is the display step's price.

**What shipped called a closed file "awaiting review".** The same completion change taught the Files page that a file put
forward and never decided is "closed without a verdict" once the goal is COMPLETED, but the Overview's result kept its fixed
words: the group heading **Awaiting review**, its count **6 awaiting review**, and every row **ready for review**, one press
from Files' "Closed without a verdict". The result reads the same `CLOSED_REVIEW` words (`files.ts`) now: **Closed without a
verdict** (6), the meta **9 files · 3 delivered · 6 without a verdict**, and a row state **no verdict** — short in the desk's
two-column ledger, where the heading above already says the rest. The card is **497 → 495.1 px** at 1,440 (the shorter row
state pays for the longer heading); the language is one answer on both pages, and the warning tone the completion change gave
the hero stays.

**A finished agent row's token figure was bare on a phone.** At 900 and below the Agents table stacks a row into four bands and
hid the `<thead>` with `display: none`; the token cell drew **7.2k** with no label on screen and no header in the accessibility
tree. The cell says **7.2k tokens** now (the word is drawn only where the head is not; a desk keeps its head and its 54 px
rows), and the head is visually hidden with the sr-only pattern instead of `display: none`, so `getByRole("columnheader")`
reads **Agent, State, What it did, Tokens** (**0 → 4**). The cell is **114 × 21 → 169 × 21** at 360, the state cell **176 →
121**, the row **141.4** and the page **1,234** unchanged.

**An empty tool gate named the Designer and could not take you there.** `No gated seats` said to set `requires_approval` on a
seat in `mesh.yaml` and offered no control (**0** in the empty state; the card was **237 px**). It is one **202.4 × 44**
`Open the Designer` press now and the card is **296.8**; the page still fits its 736 px view at 360, so the next move costs no
reach. The button opens the Designer's roster, not a seat's Tools section (see Left).

| | Before | After |
|---|---|---|
| The Overview, 320 / 360 / 390 | 936 / 894 / 879 | **876 / 858 / 867** |
| The Overview, 768 / 1,440 | 836 / 1,784 | **841 / 1,787** |
| The receipt, 320 / 360 / 390 | 558.8 / 516.6 / 501.8 | **498.1 / 480 / 489.1** |
| The receipt, 768 / 1,440 | 458.8 / 263.2 | **463.4 / 267.8** |
| The verdict's step | the whole sentence at 20 (phone) / 24 (768, desk) | **`Delivered.` at 30; its sentence at 16 / 18** |
| The headline's box, 360 / 1,440 | 96 / 57.6 | **59.4 / 62.2** |
| Second evidence row's 44 px head, 320 / 360 / 390 | 753.3–797.3 / 716.2–760.2 / 701.3–745.3 | **697.7–741.7 / 679.5–723.5 / 688.7–732.7** |
| The head's bottom against the 747 px dock, 320 / 360 / 390 | 50.3 under / 13.2 under / 1.7 above | **5.3 / 23.5 / 14.3 above** |
| What shipped heading and meta, 1,440 | Awaiting review; 9 files · 3 delivered · 6 awaiting review | **Closed without a verdict; 9 files · 3 delivered · 6 without a verdict** |
| Its row state, 1,440 | ready for review | **no verdict** |
| The result card, 1,440 | 497 | **495.1** |
| The Agents token cell, 360 | 114 × 21, "7.2k" | **169 × 21, "7.2k tokens"** |
| The Agents state cell and row, 360 | 176 × 23; 141.4 | **121 × 23; 141.4** |
| Column headers exposed at 360 | 0 (`thead` was `display: none`) | **4** (`Agent, State, What it did, Tokens`) |
| The Tool gates empty state, 360 | 0 controls; card 237 | **1 control, 202.4 × 44; card 296.8** |
| Axe, the ten single-mesh views × 1,440/390 × both themes | 0 violations | **0** |
| Axe, the same views × 360/1,440 × both themes | 0 | **0** |
| Horizontal page scroll, 320–1,440 | 0 | **0** |

**Floors.** `npm run typecheck` and `npm run build` clean; `dist/tests/dashboard` plus `console-palette` and `ui-kit-tokens`
**1,252 pass, 0 fail** (the full suite is the coordinator's); eslint **0 errors** (211 pre-existing warnings); `npm run
qa:console` over the ten single-mesh views at 1,440 and 390 in both themes: **44 screenshots, 44 axe runs, 0 violations**, the
one-mesh `/api/projects` 404 in each, **0 px** of horizontal page scroll; a second 40-read pass (10 views × 360/1,440 × both
themes) also found 0. No token moved, so both themes read the same geometry; the 44 px floor is untouched (the new Designer
button is 202.4 × 44, and the Agents token cell is not a control).

**Left.** The third evidence row at 360 begins at 744.5 — 2.5 px above the dock and 41.5 px under it: this pass restored the
second row, not the third; the next 44 px is the goal's third line or the row gap. At 768 and 1,440 the receipt is 4.6 px
taller than the long-sentence step was, which is the display step's price rather than a wrap. The phrase "with work left on the
table" is not in the receipt now: the facts, the warning tone and "What shipped 3 of 9" say it, and the phrase was what took
the receipt past the first screen at 320/360/390. The Steps timeline's closed caption still wraps at 320/360 on a reader in
GMT+3:30: `Who was busy, when` (179 px) and `Times in GMT+3:30` (118) need 305 in 302, so the row is 69 px where the 44 px
caption row was designed; closing it needs the zone's words or a 3 px gap, and was not this pass. The empty tool-gate button
opens the Designer's roster, not the first seat's Tools section; a deep link would need the Designer's arrival mechanism. The
Files page's row state stays `closed without verdict` (the single-column list has the room) while the Overview's two-column
ledger says `no verdict`; both are the same `CLOSED_REVIEW` state. The Events page's "Live" chip still describes the stream on
a delivered mission, the known open question.

### 2026-11-04 — a waiting condition is read across the card, and a touch tablet's `…` is a full target

Surface: `views/AttentionList.tsx` (the `single` class), `views/overview.css` (the attention row's container query and the phone
padding), `styles.css` (the coarse-pointer width floor), `tests/dashboard/attention-phone.test.ts` (new) and one selector in
`tests/dashboard/phone-targets.test.ts`.

Measured on the scripted demo at **Delivered** (490 events, 51.0k of 2.0M tokens, 7 checks, 9 files: 3 delivered, 6 awaiting
review, 7 seats, ran 13s) in the production build served by `curule console`, Chromium 1248 at 320/360/390/560/620/820/1,440 in
light and at 360 in dark, a touch pointer at 820, reduced motion, axe-core 4.14. Both halves are the **same delivered log**: the
before bundle was rebuilt from `git stash` and swapped under the running console for each pair. The waiting state is one real
host-spend ceiling card raised through the console's own API (`POST /escalations/host-ceiling`), which also adds the
DisagreementRecord artifact the card points at; the delivered pairs were read before it was raised.

**The attention sentence was a 66 px column with a 145 px button beside it.** The row is a 3-column grid — a 28 px mark, the line,
the fix — and `.ov-fix` is `white-space: nowrap`, so "Review decisions" took 144.7 px of a 296 px card at 320 and left the
sentence **66 px** of it. The line was **310 px tall** (one or two words a line), the card was **400 px** for one condition, and
the evidence under it began a screen down; at 360 the line was 94 and 142, at 390 123 and 121. Below a **420 px card** the row is
two columns: the mark, the sentence across the card, and the fix under it at the row's end. The card was a `single` condition's
whole answer, and the hero directly above already says "1 decision is still waiting on you.", so its head ("Attention 1") is read
by a screen reader but not drawn; a list of two or more keeps its head. The card's block padding on a phone is 12 rather than 16
and the stacked row's gap 6 rather than 12, which is what keeps the fix whole above the 747 px dock at 390.

| One condition waiting | Before | After |
|---|---|---|
| The card, 320 / 360 / 390 | 400 / 232 / 211 | **139 / 139 / 139** |
| The line, 320 | 66 × 310 | **209 × 58** |
| The line, 360 | 94 × 142 | **231 × 58** |
| The line, 390 | 123 × 121 | **282 × 58** |
| The fix (y), 320 / 360 / 390 | 675.5–719.5 / 675.5–719.5 / 684.7–728.7 | 691.5–735.5 / 691.5–735.5 / 700.7–744.7 |
| The Overview, 320 / 360 / 390 | 1,270 / 1,102 / 1,090 | **1,009 / 1,009 / 1,018** |
| The card, 560 / 620 | 148 / 127 | 140 / 119 |
| The Overview, 560 / 620 | 982 / 961 | 974 / 953 |
| The card and page, 820 / 1,440 | 148 / 111; 929 / 1,998 | 148 / 111; 929 / 1,998 |
| The card and page, 360 dark | 232; 1,102 | **139; 1,009** |
| The delivered Overview, 360 / 1,440 | 858 / 1,789 | 858 / 1,789 |

**The touch tablet's `…` was 36 × 44.** The 44 px width floor for `.menu-btn` lived in the `max-width: 800px` block, and at 820
the sidebar is back while the floor is not: the top bar's "More actions" and the hero's "More actions on the mission" measured
**36 × 44** on a touch pointer at 820 (and the bar's at 900), the console's only controls under 44 there. A coarse pointer takes
`min-width: 44px` at every width now: both are **44 × 44**, and the page's only target under 44 at 820 is the 1 × 1 skip link, as
it is at 360. A fine pointer at 820 keeps the 36 px pointer-density control.

**Floors.** `npm run typecheck` and `npm run build` clean; `dist/tests/dashboard` plus the build tests **1,251 pass, 0 fail**;
`npm run qa:console` at 360 and 1,440 in both themes: **52 screenshots, 52 axe runs, 0 violations**, one page-wide console error in
each (the one-mesh `/api/projects` 404); every frame is 0 px of horizontal page scroll (`document.documentElement.scrollWidth` is
the viewport at 320–1,440), the 11 delivered frames and 8 waiting frames are axe-clean, and the smallest text stays on the ramp.
The attention head is visually hidden with the console's sr-only pattern, not removed: `aria-labelledby` still names the card.

**Left.** With two or more conditions waiting the head stays and each row stacks, which is a list rather than a band; the first
row's fix can sit under the fold there, and that case was not measured with real cards. The 420 px threshold is a **container**
width, like the figures' 361, not a new viewport break: 560 and 620 keep the side-by-side row (line 282 / 347 px) and only lose the
card's 8 px of block padding. The delivered page itself is untouched — this pass is the state where a decision waits and a touch
tablet's menu. The events page's "Live" chip on a delivered mission and the delivery notice over a phone's page head are still the
open items they were; a fine pointer at 820 keeps the sidebar's 36 px rows and the 36 px `…`, as pointer density.

### 2026-11-04 — the fold ends where the sidebar gives the page its width back, and a desk's index is pinned

Surface: `views/Overview.tsx` (the fold's predicate and the wide index's figures), `views/overview.css` (the fold's block moved from
800 to 900; the pinned index; the result's rows two-up), `views/Shipped.tsx` (`shippedFigure`, one fraction for the row and the
index) and four tests (`overview-fold`, `overview-receipt`, `page-exits`, and the new `overview-index`).

Measured on the scripted demo at **Delivered** (507 events, 7 checks, 9 files, 6 awaiting review, 7 seats) in the production build
served by `curule console` on its own port, Chromium 1248 at 320/360/390/768/801/820/900/901/1000/1100/1101/1200/1280/1440, light
and dark, a touch pointer at 900 and below, reduced motion, axe-core 4.14 (108 reads: 9 views × 6 widths × 2 themes). Both halves of
each pair are the same log: the before bundle was rebuilt from `git stash` and served over the same state.

**The fold stopped where the dock does, not where the page is narrow.** From 801 the sidebar is drawn in the flow and takes 232 px, so
the view is 569–668 px — narrower than a 768 phone — while the page drew the full desk shape: **801 px was 3,228 px tall, 820 was
3,365, 900 was 3,167**, against 841 at 768. `DOCK` and the closed-row CSS are the ladder's 900 now (its "dense grids stack" step), the
last width at which the sidebar has not given the page its width back: **820 is 836, 900 is 836**, with the hero's compact row (one
action and "…") at 801–900 as at a phone. 768 (841), 901 (2,989) and 1440 are unchanged; 320/360/390 do not move. Deliberately not
changed: the single column at 901–1100 is still ~2,900 px with a two-line index. It is a desk with its sections open, and folding it
would take the result away from a mouse.

**The index was four bare names, drawn once, and scrolled away.** At 1440 the row sat at 422–458 and the page is 1,913: 600 px in it
was gone (top −178), and at the event log it was 655 px above (−655). It carries each section's figure now — "What shipped 3 of 9 ·
Latest work 6 · Goal checks 7/7 · Just happened 507" — and is pinned at the board's 1280, where it is one line (985 px of doors in
992): top **84 at both 600 and 1,400** of scroll. Its figures are hidden below 1280, where the row would wrap to two lines (measured
at 1100: 36 → 72 px and 36 px of page). `#view` pins a sticky child at its content edge, so the bar paints the 20 px strip above it in
the page's ground (a pixel at y=72 read the shipped card before), and `.ov .card` carries `scroll-margin-top` for the bar: a jump put
the section at 124 in a bar of 84–137 (13 px under it) and lands it at 145, 8 px clear, with focus on the section.

**The result's six waiting files were six full-width rows.** One column in a 1,152 px card set a name, a type and a state at 44 px
each and left 600 px of every row empty between them: What shipped was **621 px** and Latest work began at **1,103** — past the 900 px
of a desk's first screen. Two columns from 1101 (the desk's own grid): the card is **497 px at 1440 (515 at 1280, 549 at 1200, 565 at
1101)**, Latest work is at **979**, and the page is **1,913 → 1,789** (1,974 → 1,869 at 1280, 2,042 → 1,969 at 1200). A row is
unchanged; the second column's first row drops its rule so the two read as one ledger under the group's caption.

Gates: `npm run typecheck` clean; `npm test` 6,496 tests, 6,494 pass, 2 skipped (the pre-existing pid-identity skip); axe 0
violations, no console error and no horizontal scroll in 108 reads; the only targets under 44 px at 360/390 are the skip link (1×1
until focused) and a checkbox whose label is 366 × 56.

### 2026-11-04 — the brief follows the thumb, and the page whose job is the answer leads with it

Surface: `views/Overview.tsx` (the fold's predicate), `views/overview.css` (the closed row's rules moved to a new 800 block),
`views/files.css` (the search's basis), `views/DecisionCard.tsx` (the evidence after the answer), `views/MissionHero.tsx` (the
delivered clock's sub-line), `shell.tsx` (the two inbox names), `views/inbox.css` (its header), and nine tests
(`overview-fold`, `overview-figures`, `page-exits`, `overview-receipt`, `files-phone`, `label-in-name`, `dock-phone`,
`frame-phone`, and the new `decision-card`).

Measured on the scripted demo at **Delivered** (507 events, 7 checks, 9 files, 17 messages, 7 seats, ran 9.2s) in the production
build served by `curule console`, Chromium at 320/360/390/620/621/768/801/1,440 in light and at 360/768/1,440 in dark (84 axe
reads), a touch pointer at 800 and below, reduced motion, axe-core 4.14. The inbox's waiting state is one real host-spend ceiling
card raised through the console's own API (`POST /escalations/host-ceiling`), which also adds the DisagreementRecord artifact the
card's decision record points at; the two halves of each inbox pair are that card.

**The tablet had the drawer and the dock, but the desk's scroll.** The Overview folded its four evidence sections only at the phone's
620, while a 768 px tablet has the navigation drawer, the compact hero and the five places at its thumb. It opened all four sections
at once and the What shipped panel drew 601 px of rows: the delivered page was **3,121 px**, 4.2 screens, and the first evidence
started 709 px down with the whole result below it. At 621 the page was 3,621. The fold now uses `DOCK` (the dock's own 800), the
same answer the hero's compact row already asked, and the closed-row CSS moved from the 620 block into a new 800 block so the JS and
CSS cannot disagree. At 768 the page is **841**: the hero, two whole evidence rows, and the third row's head on the first screen; the
tab stops in `#view` fall from 40 to 10. A desk (801+) keeps all four open and keeps the jump row; 1,440 is unchanged (1,913). The
figures are still doors: pressing Checks at 768 opens Goal checks, scrolls to it and focuses it (`#view.scrollTop` 1,255, focus
`#ov-goal`), and a press 40 px into a closed row opens it with focus on its own Show control.

**The Files bar was a row over by less than a pixel.** The search's 220 px basis plus the Filters button (104.94) and the 12 px gap
is **336.94 in a 336 px row at 360**. A wrapped flex container breaks its line before its items shrink, so 0.94 px was enough to put
the bar back on two rows: **96 px**, the first group at 281.59 instead of 229.59, the first file 52 px lower, the search full width.
The 2026-10-30 pass measured the button at 103.52 (336 in 336) — a half-pixel fit that a font's own edge could take away. The basis
is **200 px** now: 200 + 104.94 + 12 leaves 19 px of slack, the search grows to 219, and the hint truncates as that pass intended
("Name, owner,..."). Measured at 360: bar **96 → 44**, first group **281.6 → 229.6**, page **1,171 → 1,119**; at the end of the list
the bar is still stuck under the top bar (y=64), now 44 px rather than 96. 320 keeps its two rows (296 of content cannot hold 317);
390, 768 and 1,440 do not move.

**The inbox's answer was wholly under the dock.** On the host-spend card the decision record (72 px of `.dc-context`) sat between
the consequence and the form, so the card's primary control — **Raise the ceiling** — began at **y=772**, its whole 44 px box under
the 747 px dock. "Needs you" is the page whose one job is the answer, and its first screen showed no action. The record and the
involved seats now follow the answer in the **DOM** (not by a CSS `order`, which would have left the tab order walking a different
screen): the consequence that decides the press still comes first, the answer is **688–732** at 360 and 320 — whole above the dock —
and **583** at 768. The card is still 1,242 px, and its note field (764) and Clear this card (816) stay below the first screen, after
the action.

**The count broke the name.** With one decision waiting, axe reported `label-content-name-mismatch` (serious) on the bar's inbox
button and the dock's Needs you tab: the drawn text is **"Needs you 1"**, and the accessible name was "Needs you: 1 waiting on you",
whose colon interrupts the visible sequence (WCAG 2.5.3). It failed **22 of 22** reads with the badge — 11 views × 2 themes at 360 —
and 2 nodes at 621 and 768 (the bar's button and the dock tab; 1 at 1,440, where the dock is not drawn). The name now repeats the
drawn label and count in order, and the markup
carries a real space between them so the visible text is the same sequence. After: **0** in 84 reads (14 views × 360/768/1,440 ×
both themes). The dock's five tabs keep their 64/72/154 px boxes, and the bar's button its 67 × 44.

**The receipt did not date itself.** Under "Ran for 2m 36s" the sub-line explained the measurement ("From creation to delivery"),
which "Ran for" already says, and it wrapped to two lines at 320/360/390, while nothing on the phone's first screen said when the
result was from. It is **"Delivered 14m ago"** now, from the goal's own `completedAt`, one line at every phone width. The receipt
falls **18 px** at 320/360/390 (520.5/498.1/507.3 → 502.3/480/489.1), and at 320 the second evidence row's whole head is above the
dock (701.9–745.9) where it began 17.1 px under it.

| | Before | After |
|---|---|---|
| The Overview, 320 / 360 / 390 / 620 | 898 / 876 / 885 / 822 | 880 / 858 / 867 / 822 |
| The Overview, 768 | 3,121 | **841** |
| The Overview, 621 (one waiting card) | 3,621 | 980 |
| The Overview, 1,440 | 1,913 | 1,913 |
| The receipt (hero), 320 / 360 / 390 | 520.5 / 498.1 / 507.3 | 502.3 / 480 / 489.1 |
| What shipped row, 360 | 627.7–680.7 | 609.5–662.5 |
| Its 44 px head, 360 | 632.7–676.7 (70.3 clear of the 747 dock) | 614.5–658.5 (88.5 clear) |
| Latest work head, 360 / 390 / 320 | 697.7–741.7 / 706.9–750.9 / 720.1–764.1 | 679.5–723.5 / 688.7–732.7 / 701.9–745.9 |
| Latest work head clear of the dock, 320 | 17.1 under | 1.1 above (whole) |
| Tab stops in `#view`, 768 (delivered) | 40 | 10 |
| The Files bar, 360 | 96 | 44 |
| The Files first group, 360 | 281.6 | 229.6 |
| The Files search, 360 | 336 | 219 |
| The Files page, 360 | 1,171 | 1,119 |
| The Files bar at the list's end, 360 | y 64, 96 | y 64, 44 |
| The inbox answer, 320 / 360 | 772 | 688 (688–732) |
| axe `label-content-name-mismatch`, 360 with a badge | 22 of 22 reads, 1 serious each | 0 of 84 reads |
| Horizontal page scroll, 320–1,440, both themes | 0 | 0 |
| Controls under 44 × 44 in `#view`, 320/360/768 | 0 | 0 (the 34 × 20 notify switch inside its 44 px label is the recorded exception) |
| Type census at 360 | 11 12 13 14 15 16 20 24 30 | the same (11 is the avatar initials) |

**Floors.** `npm run typecheck` and `npm run build` clean; `dist/tests/dashboard` **1,223 pass, 0 fail**; the full suite
**6,487 tests, 6,485 pass, 0 fail, 2 skipped**; eslint **0 errors** (211 pre-existing cross-package warnings); `npm run qa:console`
at 360 and 1,440 in both themes: **52 screenshots, 52 axe runs, 0 violations, 0 page scroll**, and only the one-mesh
`/api/projects` 404 in the console. `tests/build/console-palette.test.ts` and `type-ramp.test.ts` pass.

**Left.** At **801** the sidebar returns and the fold does not, so the Overview jumps back to ~3,100 px (3,489 with a waiting card);
whether the brief should follow the dock to the 1,100 grid break is the next measurement, with a pointer. At 768 the four rows are
744 px wide with the figure at the far left and Show at the far right, which is a lot of air for a one-line rule; a tablet could put
the figure under the name, but the phone's one-line row is the pinned shape. The tablet's closed rows were read by a scripted pointer
and a keyboard, not a thumb. At 360 the third evidence row's head is still 7.5 px under the dock (739.5–783.5) and at 320 the third
begins at 761.9, 14.9 under; the receipt's 18 px bought the second row at 320 and 30.8 px of the first screen at 360, not the third.
The fold still forgets a section on every visit, and What shipped still opens closed (items 7), the delivery notice still sits over
the page head for its 4.8 s (the previous pass), and the events chip still says "Live" on a delivered mission (item 3). The
inbox's evidence is after its answer on a desk too, where the old order was not a reach problem; that is one card shape rather than
a phone-only rule, and it is the same DOM the reader's tab order follows.

### 2026-11-04 — a page starts at its head, and focus names the page in front

Surface: `shell.tsx` (the view-change effect: scroll reset + the stale-tab rule), `views/files.css` (one rule in the 620 block),
`DESIGN.md`. No server, schema or other surface moved.

Measured on the scripted demo at **Delivered** in the production build served by `curule console` at 360 (Chromium over CDP,
touch, reduced motion); the Files rule also at 320/620/621/768/1,440 and at 360 in dark.

**The problem.** The frame has one scroller (`#view`) and React only swaps its children, so a new page inherited the old page's
scroll offset, clamped to its own height. Read Cost to its end (913 of 913) and open Agents from the drawer: Agents opened at
**498 — its own maximum** — with its title **420 px above the screen** and the list beginning at its third seat. The page's own
name, status and first seats were below the reader, who had asked for the page from a menu two screens up. The same effect
turns Back/Forward into a keyboard trap: the dock survives the route change, so focus stayed on the tab that had been pressed
on the page being left. After Back from Needs you to Agents, focus was the **“Needs you” dock tab while the page was Agents**;
the dock is the last control in the document, so the **next Tab left the page** (activeElement came back `<body>`, then the skip
link) and the heading was never announced. A third, smaller reach problem: Files' search and folded Filters sat at the top of a
long list, so at its end (383 px of travel) the bar was at **y=-213** — filtering while reading meant scrolling the whole list
back.

**What changed.**

- **A route change resets `#view` to 0 before paint.** The reset is a layout effect (the browser would otherwise paint one frame
  at the old offset) and it forces `scroll-behavior: auto` for the assignment, because `#view` scrolls smoothly and a route
  change is not a movement to watch.
- **A tab for another page is not a landing place.** If the focused control is in `#dock` or `#sidebar` and its `data-view` is
  not the view in front, it is blurred; the existing rule then focuses the new page's `h2` (no ring, `preventScroll`). A tab
  whose `data-view` is the view in front keeps its focus, so pressing Files in the dock still leaves the keyboard on Files, and
  the off-canvas menu still hands focus back to ☰.
- **Files' tools ride with the list on a phone.** At 620 and below `.files-bar`, when the filter fold is closed, is `position:
  sticky; top: -12px` on the page's own `--bg` (the Steps toolbar's pattern, no shadow). With the fold open the bar is ~200 px
  and stays in the flow; above 620 nothing changes.

**Measured.**

| | Before | After |
|---|---|---|
| Cost read to end, then Agents from the drawer (`#view.scrollTop`) | 498 of 498 | 0 |
| Agents' `h2` y at that arrival | −420 | 78 |
| First thing on screen at that arrival | a mid-list seat (tech-lead) | the page title, status and Cards/List |
| Back from Needs you to Agents: focused control | `button.dock-tab` “Needs you” | `h2` “Agents” |
| First Tab after that Back | leaves the document (`<body>`) | “Cards”, the page's own control |
| Files bar at the end of the list, 360 | y −213…−169 | y 64…108, stuck |
| Files bar at the end of the list, 320 | off the screen (two rows, 96 px) | y 64…160, stuck |
| Files bar with the fold open, 360 | 170…378 | 170…378 (in flow) |
| Files bar, 621 / 768 / 1,440 | static, 104 / 68 / 36 | unchanged |
| Files, first group at 360 (at rest) | y 230 | y 230 (nothing moves until it sticks) |

**Floors.** `npm run typecheck` and `npm run build` clean; `dist/tests/dashboard` **1,218 pass, 0 fail**; eslint 0 on
`shell.tsx`; axe-core 4.14 **0 violations** on the nine views at 360; no document sideways scroll at 320/360 (360 = 360);
the Files bar's own Filters still reads 14.75:1 in dark; the dark 360 render adds no failure. The 44 px floor is untouched:
the bar's search and button were already 44 and the sticky rule changes only position.

**Left.** The delivery notice still sits over the page head for its 4.8 s life at 360 (visible in this pass's captures): it is
transient and dismissible, and moving it out of the scrollport's top is a layer decision, not this pass. The same offset problem
is not solved for the Steps search above the sticky filter (the filter rides, the search does not), nor for Files at 621–768,
where the bar is 104 px and the fold stays in plain sight: both are measured, neither is a phone. And neither new rule is pinned
by a test — `primitives-a11y.test.ts` reads the focus effect as text, so its two assertions were kept literal; the scroll and
Back behaviour were measured in the browser, not asserted. The 96 px two-row bar at 320 is the shape the search/button pair
already had; whether the reach is worth a third of the narrowest screen's top is a thumb question.

### 2026-11-03 — a delivered receipt says its claim once, so a second piece of evidence is above the dock

Surface: `views/overview-model.ts` (one function, `noteBelongs`), `views/Overview.tsx` (the note routed by it), `views/MissionHero.tsx`
(the delivered note's door and the `NOTE_FOLD` / `noteFold` fold removed), `views/GoalChecks.tsx` (the note's new home), `views/overview.css`
(`.ov-why`), `tests/dashboard/overview-receipt.test.ts` (two tests rewritten) and `tests/dashboard/overview-model.test.ts` (one added).
Measured on the scripted demo at **Delivered** on the production build: one delivered log (508 events, 49.3k of 2.0M tokens, 7 checks,
9 files, 17 messages, 7 seats, ran 6.5s) restored and served by a `--resume` console for **each** build, so both halves read the same
figures; Chromium over CDP at 320/360/390/620/768/900/1,440, light at every width and dark at 360 and 1,440, a touch pointer at 390
and below, reduced motion, axe-core 4.14 in the page at 360 and 1,440 in both schemes.

**The problem.** The delivered hero said its claim twice: the headline's second sentence ("Every mandatory check is evidenced.")
and, one block below the figures, a 45 px door named **"Why this is done"** whose body was the gate's own sentence ("Every
mandatory acceptance criterion was evidenced, with no open escalations and no work still claimed"). The question and its answer
cost the phone 45 px of the first screen, and the second evidence row's 44 px head began **4.3 px above** the thumb dock. The
checks that sentence names are the Goal checks section — the place an operator opens to ask why. It was the first item of the
previous pass's "What the next pass should take", and the answer is the checks, not the receipt.

**What changed.**

- **The finished note is read at the head of Goal checks.** `noteBelongs(phase)` sends `done`'s note to the checks section and every
  other phase's note to its hero: a stopped, held or half-finished mission still explains itself under its own headline. Goal checks
  draws the gate's sentence and the line behind it ("The project is parked. A finished mission does not need it running.") under the
  progress it explains, at 14 px in `--text-dim` and 90ch wide.
- **The receipt loses the door, not the claim.** The hero still says "Delivered. Every mandatory check is evidenced."; the exact gate
  wording and the parked line are with the checks. `NOTE_FOLD` and the `noteFold` prop existed only for `done`, so they are gone: no
  door in the console is named after a sentence the page above it already said.
- **The empty state and the note's other homes are untouched.** Needs you, failed, paused, parked, stalled and ceiling keep their note
  in the hero; the parked Overview still shows its "Nothing has been done yet…" door.

**Measured.**

| | Before | After |
|---|---|---|
| The receipt (hero), 320 | 565.53 px | 520.53 |
| The receipt, 360 / 390 / 620 | 543.14 / 552.33 / 489.64 | 498.14 / 507.33 / 444.64 |
| The receipt, 768 / 900 / 1,440 | 521.84 / 565.84 / 324.77 | 460.84 / 504.84 / 267.77 |
| What shipped row, 360 | 672.73–725.73 | 627.73–680.73 |
| Its 44 px head, 360 | 677.73–721.73 (25.27 px clear of the 747 px dock) | 632.73–676.73 (70.27 clear) |
| Latest work row, 360 | 737.73–790.73 (head 742.73–786.73, 4.3 px above the dock) | 692.73–745.73 (head 697.73–741.73, 1.27 px clear) |
| Latest work head, 390 | 751.92–795.92 (48.92 under the dock) | 706.92–750.92 (3.92 under) |
| Latest work head, 320 | 765.13–809.13 (62.13 under) | 720.13–764.13 (17.13 under) |
| What shipped row, 320 / 390 | 695.13 / 681.92 | 650.13 / 636.92 |
| The Overview (`#view` scrollHeight), 320 / 360 / 390 / 620 | 943 / 921 / 930 / 867 | 898 / 876 / 885 / 836 |
| The Overview, 768 / 900 / 1,440 | 2,939 / 2,965 / 1,934 | 2,959 / 2,985 / 1,913 |
| The note in the receipt | 45 px at 360, 57 at 1,440, 61 at 768 / 900 | 0 |
| Tab stops in `#view` at 320 / 360 / 390 | 39 / 39 / 39 | 38 / 38 / 38 (the door's summary was one) |
| Axe, 13 views × 360 and 1,440 × both themes | 0 violations | 0 |
| Horizontal page scroll, the same 52 frames | 0 | 0 |
| Controls under 44 × 44 in `#view`, 360 / 320 | 0 / 0 | 0 / 0 |
| Console errors | one, the one-mesh `/api/projects` 404 | the same one |

The page grows 20 px at 768 and 900 and shrinks 21 at 1,440: there the Goal checks panel is open, so the note moves from the receipt
into the right-hand column and the row of the grid takes its height. The first screen is 61 px (768/900) and 57 px (1,440) shorter
before the evidence begins — that is what the change buys; total length on an open desk page is not.

**Floors.** No document or `#view` sideways scroll at any width in either scheme; axe-core 0 violations at 360 and 1,440 in both
schemes (52 runs over the 13 views, the same 4 one-mesh 404s as the base); the smallest text stays 11 (the avatar initials); the
receipt's figures keep their 20 px step under a 361 px strip; dark at 360 and 1,440 reads the same geometry. The finished note is
text in both schemes and in Windows High Contrast, so it needs no `forced-colors` rule.

Suite: `npm run typecheck` and `npm run build` clean; `dist/tests/dashboard` **1,218 pass, 0 fail** with one new test and two
rewritten; `dist/tests/build` (console-palette and dist-coherence) **8 pass, 0 fail**; eslint 0 errors on the changed files;
`qa:console` at 360 and 1,440 in both themes: 52 screenshots, 52 axe runs, 0 violations, 0 page scroll, only the one-mesh
`/api/projects` 404. The two new rules were mutation-checked — `noteBelongs` returned `"hero"` for every phase (both tests failed,
then passed restored) — and the view's routing is pinned by the receipt test, not by the function alone.

**Left.** At 390 and 320 the second evidence row's head is still partly under the dock (3.9 and 17.1 px): both widths pay the
receipt's height there (507.33 / 520.53), and the next 40 px is the receipt's two 20 px block paddings, not the note. The delivered
note is now one press away on a phone (Goal checks is a closed row) rather than visible under the headline; the hero's own second
sentence still states the claim, and the parked line waits with the checks. What shipped's default remains open on the desk and
closed on a phone (the previous pass's open question), and the hero's `…` still shares `Reopen with feedback` with the frame's `…`.

### 2026-11-02 — a phone's verdict sentence is the receipt's width, so the first evidence row is whole above the dock

Surface: `views/overview.css` (the 620 block: the headline's block and the mark's tile) and one new test plus one changed rule in
`tests/dashboard/overview-receipt.test.ts`. Measured on the scripted demo at **Delivered** (9 files: 3 delivered, 6 awaiting review;
7 checks; 519 events; 51.0k of 2.0M tokens; 17 messages; 7 seats; ran 9.4s) in the production build, Chromium over CDP at
320/341/360/387/388/390/398/620/768/1,440 in light, at 360 in dark and in forced colours, a touch pointer at 360 and below, reduced
motion, axe-core 4.14 at 360 in both schemes. Both halves are the **same delivered mission**: its event log was restored and served by
a `--resume` console for each build, so every figure reads the same in both, and the 768 and 1,440 PNGs are byte-identical.

| at 360 | before | after |
|---|---|---|
| the verdict's sentence | a 242 px box, two lines (171.13 + 94.22) | a 302 px box, one line (269.33) |
| the receipt (the hero) | 565.53 | 543.14 |
| its top block | 226.78 | 204.39 |
| the first evidence row | 695.13, ending 748.13 | 672.73, ending 725.73 |
| its 44 px head | 700.13–744.13 | 677.73–721.73 |
| clear of the 747 dock | 2.87, the row's own end 1.13 under it | 25.27, the row's end 21.27 above it |
| the mark | 48 × 48, a 24 px glyph | 40 × 40, a 20 px glyph |
| the page | 943 | 921 |

- **No box on a phone could hold that sentence beside the mark.** It is **269.33 px** at 16, and the lead beside the mark has 242 at
  360 (302 of content − the mark and its 12 px gap), 223 at 341 and 210 at 320: two lines and 22.39 px of the first screen from 320 to
  387, one line only from 388, where the column finally meets 270. The one box that holds it is the receipt's own width — 302 at 360,
  270 at 320 — so the headline's block spans it: its word keeps the mark's column by a 52 px inset and its second sentence stretches
  across the block, one line at every width from 320 (270 against 269.33, two thirds of a pixel) to 620 (562).
- **The mark steps 48 → 40 because the sentence now starts at the receipt's edge.** The sentence's line box begins 37 px into the
  block and its cap at 180.79, where the tile's foot was 178.59: a 48 px tile stands 11 px into that line, and a 40 px one clears it by
  **2.2 px**. 40 is the kit's base tile (`.tile`, a 20 px glyph), so the drawing takes a size the kit already has rather than one
  written here. A lead long enough to step down to 20 px — a crash's reason can pass 44 characters and carry a second sentence,
  as `crashHint` does — takes the tile's height, so its sentence still starts under the mark.
- **The axis is what the line costs.** The sentence starts at the receipt's edge, under the tile, not under "Delivered."; the goal and
  the action row already start there, so the receipt's left edge is one axis now and only the verdict's word hangs at 81. Measured in
  the same browser, the whole width with the mark's row kept above the sentence (the sentence in a row of its own) returns **3.39 px**,
  not 22.39: a full-width line has to clear the tile, and giving it its own row spends the mark's 48 px and an 8 px gap.
- **Nothing else moves.** 388 (**552.33**), 390 (552.33), 398 (534.14) and 620 (489.64) keep every height to the pixel — there the
  sentence already had its line, so only the mark's size and the sentence's left edge differ; the page is 930 / 930 / 912 / 867 in both
  halves. 768 (527.84, its mark still 48) and 1,440 (324.77) do not move at all. Dark at 360 reads the same geometry as light, and
  forced colours reads 543.14 with the head at 677.73–721.73.
- **The floors hold.** No document or `#view` sideways scroll at any width in either scheme; axe-core **0** violations at 360 light and
  360 dark (19 rules passed in each read, the same in both halves); no control under 44 × 44 in `#view` from 320 to 620, the same 13
  pointer-density rows at 768 and 16 at 1,440 in both halves (the drawer's closed rows and the desk's ghost links); the smallest text
  stays 11 (the avatar initials); **11 Tabs** from the body to `What shipped: Show`, the same list in both halves; one console error in
  both (the one-mesh `/api/projects` 404).

Suite: typecheck and build clean; `dist/tests/dashboard` **1,217 pass, 0 fail**, with one new test and one changed rule (three of the
new test's assertions mutation-checked: the tile put back to 48 px, the headline put back into the mark's column, the long lead's box
removed — each failed its assertion and was restored); `dist/tests/build` **224 pass, 0 fail**; `npm run test:only` **6,450 tests,
6,448 pass, 0 fail, 2 skipped**.

**Left.** The first screen now ends on the whole first evidence row (21.27 px of air above the dock) and 4.3 px of the second row's
head; 24 px figures would make the receipt 552.33 and put that head wholly under the dock, which is all the 20 px step still buys. The
sentence is one line by two thirds of a pixel at 320 — a longer verdict wraps there, which is what more words should do, and a verdict
a word shorter changes nothing. The mark is 40 on every phone layout, 620 included, where nothing else moved; whether a receipt wants a
48 px mark and a two-line sentence instead is a reading question this pass answered by measurement, not by taste. The sentence's ink
clears the tile by 2.2 px, which is the tightest pair on the receipt now.

### 2026-11-01 — a phone's receipt is one height, and the figures step by the strip they are in

Surface: `views/overview.css` (one container query on the figures' strip; the 340 block's type rule removed) and one new test plus one
changed rule in `tests/dashboard/overview-receipt.test.ts`. Measured on the scripted demo at **Delivered** (9 files: 3 delivered, 6
awaiting review; 7 checks; 481 events; 49.3k of 2.0M tokens; 17 messages; 7 seats; ran 12s) in the production build, Chromium at every
2 px from 316 to 420 and at 320/344/360/390/560/620/768/900/1,100/1,440 in light, at 360 in dark and in forced colours, a touch pointer
at 768 and below, reduced motion, axe-core 4.14 at 360. Before is the same worktree at `bede609` (main), built and served from the same
server in the same session; both halves are the same delivered mission, and both 360 × 800 frames are `#/p/demo-stub/overview` at
`#view.scrollTop` 0. The 320, 390, 620, 768 and 1,440 frames are byte-identical PNGs between the halves.

- **The sliver the last pass left was measured against a number that is not on the page.** The 341–348 eight widths were said to wrap
  the Tokens unit because the cell has 127.5–131 px (this build reads 125.5–129) for a figure that "needs 129.4". The value is a 24 px
  number and a 14 px unit, and the line measures **113.31** ("49.3k" 60.26 + " of 2.0M" 53.05); 129.4 is the whole string set at 24
  (149.59 measured here). Every phone cell holds 123 px of content at 320 through 150 at 390, so the line keeps 9.69–36.69 px to spare
  and none of the 316–420 widths measured wraps it at 24; the 340 block's step down to 20 px was never a wrap it prevented.
- **What the step does buy is 9.19 px, and only the two narrowest widths were given it.** From 341 to 387 the verdict's second sentence
  takes two lines, the receipt is **574.72** and the first evidence row's 44 px head begins 37.7 px above the dock and ends **6.3 px
  under it** (709.31–753.31 in 747). At 320 the same receipt is **565.53** with its head whole (700.13–744.13) because its figures are
  20; crossing 341 handed the height back to the figures and took it from the first screen, so a phone one pixel wider was worse.
- **One container query makes the receipt one height from 320 to 387.** The figures step to 20 px while the **strip is 361 px or
  narrower** — a 180.5 px cell, 148.5 of content, the strip at 387 — and keep 24 from 388, where the verdict is one line and the receipt
  is 552.33. Measured at 360: the hero **574.72 → 565.53**, the strip **300.94 → 291.75** (two rows, 4.59 each), the first row
  **704.31 → 695.13**, its head **709.31–753.31 → 700.13–744.13** (whole, 2.9 px clear), the page **952 → 943**. 341, 344, 348, 349 and
  386 read the same; 320, 340, 388, 390 (930), 398 (912) and 620 (867) do not move.
- **The strip is the fact, so one number holds in three layouts.** 361 px of strip is a 2-up phone strip, a 620 tablet's 2-up (594: 24
  kept), a 900 desk's 2-up (610: 24) and a 1,440 desk's 4-up row (1,150: 24); a viewport break would have needed a different number for
  each. The 340 block keeps the 12 px gutter, the label as a prefix and the row head's 8 px gap, and no longer decides the figure's type.
- **Nothing else moves, and the floors hold.** No document or `#view` sideways scroll at any width in either scheme; axe-core **0**
  violations at 360 light (25 rules passed, both halves) and 360 dark; no control under 44 × 44 in `#view`; the smallest text stays 11
  (the avatar initials); **11 Tabs** from the body to `What shipped: Show`, the same 11 in both halves; one console error in both (the
  one-mesh `/api/projects` 404); forced colours at 360 read the same geometry (943, head 700–744); the no-script sentence and print at
  794 are untouched (a desk's strip keeps 24).

Suite: typecheck and build clean; `dist/tests/dashboard` **1,216 pass, 0 fail**, with one new test and one changed (the 340 block's type
rule dropped from it; both new assertions mutation-checked — the container query deleted, then `container-type` deleted, each failed
its assertion and was restored); `dist/tests/build` **224 pass, 0 fail**; eslint 0 errors (the stylesheet is not in eslint's config).

**Left.** From 388 the receipt is 552.33 because the verdict's sentence finally fits its column; from 320 to 387 the two lines cost
22.39 px and the figures give back 9.19 of it. The sentence needs 269.33 px and the lead has 242 at 360 beside the mark's 48, so taking
the receipt's whole width would give the other 13.2 — at the price of starting the sentence at the receipt's edge instead of under
"Delivered.", the axis the 2026-10-31 pass chose; that is a reading decision, not a measurement one. The 361 px boundary is still a
coincidence of where the sentence wraps, so a verdict a word shorter would step the figures one width early (harmless: 9.19 px shorter
than it needs). And 388–397 keeps the figures at 24 while the Tokens sub still wraps, so that 18.19 px of strip is the next thing a
phone pays there.

### 2026-11-01 — the 320 first screen is the same receipt, and its figures keep their units

Surface: `views/overview.css` (the 340 block) and two new tests in `tests/dashboard/overview-receipt.test.ts`. Measured on the
scripted demo at **Delivered** (9 files: 3 delivered, 6 awaiting review; 7 checks; 491 events; 51.0k of 2.0M tokens; 17 messages;
7 seats; ran 3.7s) in the production build, Chromium at 320/360/390/620/768/1440 in light and at 320 in dark, a touch pointer at
800 and below, reduced motion, axe-core 4.14 at 320 and 360. Before is the same worktree at `8bf566c`, built and served from the
same server in the same session; both halves are the same delivered mission, and the 320/360 × 800 frames are
`#/p/demo-stub/overview` at `#view.scrollTop` 0, and at 200 for the second frame. The 360/390/620/768/1,440 frames are
byte-identical between the halves.

- **The 320 screen was three line-costs short, not one.** The queued item put the row at 726.8 on a build where the one action
  shared its row and the Tokens figure kept its unit. On this base both had wrapped: the primary's **212.38 px** label had 210 px
  beside the 44 px menu, so the menu took a second 44 px row (**96**), and "51.0k of 2.0M" needed **129.4** in the cell's 115, so
  the second figure row grew **28.6**. The first evidence row began at **802.59**, 55.6 px under the 747 px dock, not 21 above it.
- **The narrowest phone takes the page's 12 px gutter.** 16 → 12 on the hero's three padded blocks and its figure cells: the one
  action and its menu share a 44 px row (primary **218**, menu 44 at y = 281.4), the Tokens cell has **123** px of content, and the
  hero's text lines up with the page's own edge. The hero **673 → 598.5** before the type step.
- **The four figures step one rung down the ramp.** 24 → 20 at 340 and below: "51.0k of 2.0M" is **116.8** px at 20 in the cell's
  123, where 24 needed 129.4 and broke "of 2.0M" onto a line of its own. The strip **324.72 → 291.75**, the second row **176.16 →
  147.78**, and the hero → **565.5**.
- **The goal's label is a prefix, not a column.** The hanging label left **213.16** px of a sentence that needs 225 for two lines;
  inline it gets **270** and takes two (**67.5 → 45**). The two spans carry a real space now — inline they were read and drawn as
  "GoalBuild", where the grid's 8 px gap had done that work — and the 4 px margin plus that space are the same 8. The clamp moves to
  the sentence's own box, so a long goal still stops at three lines (a 261-character goal measures 67.5 with its ellipsis, not 203).
- **The first evidence row's 44 px head is whole above the dock.** The row **802.59 → 695.13**, its head **700.13–744.13** in a
  747 px dock (2.9 px clear; the 360 head is 709.31–753.31, 6.3 px under it), and the page is **1,051 → 943**. The row's own 53 px
  end at 748.13, 1.1 px into the dock, where the 360 row ends 10.3 px into it.
- **The row's own head reads on one line.** At 320 it needed 6 px it did not have — 108 + 94 + 60.4 + 24 = 286 in 280 — so
  "What shipped" wrapped to "What / shipped" and its figure read "3 of 9 delive…". The head takes the phone head's 8 px gap and the
  Show control 4 px of side padding (**48.4 × 44**, over the floor): all four rows are one line with their whole figures
  ("3 of 9 delivered" 100 in 100, "7 of 7 evidenced" 117 in 117), and the rows stay 53.
- **Nothing else moves, and the floors hold.** 360/390 (**574.72 / 704.31 / 952**), 620 (**489.64 / 619.23 / 867**), 768
  (**536.44 / 3,132**) and 1,440 (**324.77 / 1,934**) are identical to the pixel and their PNGs are byte-identical. No document or
  `#view` sideways scroll at any width; axe-core **0** violations at 320 and 360 light; **11 Tabs** from the body to
  `What shipped: Show` at both (skip, navigation, the bar's `…`, `Open the product`, the hero's `…`, four figures, the note's door,
  the row); no control under 44 × 44 in the page (the 1 × 1 skip link aside); the smallest text stays 11 (the avatar initials); one console error in both halves
  (the one-mesh `/api/projects` 404). Dark at 320 reads the same geometry; the change touches no colour.

Suite: typecheck and build clean; `dist/tests/dashboard` **1,215 pass, 0 fail**, with two new tests in `overview-receipt.test.ts`
(each mutation-checked: the caps' margin, then the 20 px figure, then the head's gap, each failed its assertion and was restored);
`npm run test:only` **6,445 tests, 6,443 pass, 0 fail, 2 skipped**; eslint 0 errors (211 pre-existing warnings).

**Left.** The figure's break is the file's 340, so 341–348 — where the 16 px gutter is back and the cell has 127.5–131 px — still
wrap the Tokens unit and their row's head sits 14 px above the dock, exactly as before this pass; 349+ fits, and closing that sliver
needs the figure to answer its own cell (a container query) rather than the viewport. The 320 hero is 9.2 px shorter than the 360 one
because its figures are 20: the price of "51.0k of 2.0M" on one line at 123. The label is a prefix at 333–340 too, where the hanging
column would have fitted, and the figures are 20 there, where the 12 px gutter alone would have kept 24: one break for the narrowest
phone is the choice, and it costs the second line's indent and 4 px of figure in that 8 px range. The hero's skeleton was not re-read
at 320 (a cold boot shows "Checking the host…" until `/status` lands; the change is padding, type and a line box, not the skeleton's
shape).

### 2026-10-31 — the Overview opens as a delivery receipt, and its figures give their numbers back

Surface: `views/MissionHero.tsx`, `views/Overview.tsx`, `views/overview.css`, `overview-model.ts` (`heroActions`),
and `tests/dashboard/overview-receipt.test.ts` with the changed selectors in `overview-figures.test.ts`.
Measured on the scripted demo at **Delivered** (9 files, 7 checks, 481 events, 49.3k of 2.0M tokens, 7 seats, ran 18s) in
the production build, Chromium over CDP at 320/360/390/620/768/1440 in light and at 360/1440 in dark, a touch pointer at
360 and below, reduced motion, forced colours at 360, axe-core 4.14. Before is the same worktree at `fd913ac`, built and
served from the same server in the same session; both halves are the same delivered mission, and both 360 × 800 frames are
`#/overview` at `#view.scrollTop` 0.

- **A phone has 684 px of content above its dock, and the hero was 746.2.** The topbar ends at 64 and the dock's tabs start
  at 748; the first evidence row was at 811.8 px in the page — **875.8 on screen, 128 px below the dock** (76 px below the
  736 px `#view`). It is at **640.3 (704 on screen)** now: 44 of its 53 px, its name, figure and Show, are above the dock.
  The hero is **574.7**, the page **952** (was 1,124). 320: 765.2 → **597.2**, page 1,143 → **975**; 390: 701.3 → **552.3**,
  1,079 → **930**; 620: 573.6 → **489.6**, 951 → **867**; 768: 571.8 → **527.8**, 2,944 → **2,900**; 1,440 unchanged to the
  pixel (324.8 / 462.4 / 1,934).
- **One action in the row where the navigation is a drawer.** The five actions were three rows and **148 px** at 320/360/390
  (96 at 620, 88 at 768): `Open the product` and `Reopen with feedback` each took the width, then the three quiet links shared
  a row — and two of those opened Files and Cost, which the dock names and the tokens figure opens. The row is `next[0]` (the
  one thing to do, whatever its look, so a running mission still shows its Pause) and the rest is behind a **44 × 44 `…`** with
  four 44 px items; it is **44 px** at 320/360/390 and 620/768. The decision is `heroActions` in `overview-model.ts`: every
  step and every secondary action appears once, and a secondary that is already a step is not listed again. A desk keeps all
  five (the 1,440 row does not move).
- **The delivered note was 86 px of the headline's own claim.** "Every mandatory check is evidenced." is the headline's
  second sentence, and the note's summary was "Every mandatory acceptance criterion was evidenced, with no open escalations
  and no work still claimed." — the same claim, five words longer, at the foot of the hero. On a phone it is a **44 px door**
  ("Why this is done") whose body's first line is the gate's exact sentence and then the parked line (measured open: 188 px).
  Only `done` folds; every other phase's note says something the headline does not.
- **The goal took three lines in a 197 px column.** The lead was 242 px (302 of content − the mark's 48 − its 12 gap), and
  the hanging "Goal" label and its 8 px gap left 197 of that for the sentence, so it was 67.5 px at 360 and 320. Across the
  hero's width (302) it is **45**, and the mark and headline keep the first row (`display: contents` on the lead, the hero's
  own grid, the phone's 8 px row gap instead of the desk's 12).
  At 320 the goal keeps its third line: the hanging label leaves 224 px where the sentence needs about 230.
- **The figures covered their own numbers.** The door's `inset: 0` sat over `49.3k of 2.0M`, so a drag opened Cost instead of
  selecting the figure. The value sits above the door now — **dragging it selects "49.3k of 2.0M" and does not navigate**, and
  the I-beam says the line is text — while the door still covers the cell; the wash moved to the cell so the raised number
  still lights the whole figure, and forced colours still take the 2 px Highlight outline. Under a coarse pointer the value
  goes back under the door (`elementFromPoint` at 360 returns the 167 × 151 door): a thumb cannot select, and a hole in the
  target would be a press that does nothing.
- **Nothing else moves, and the floors hold.** No document or `#view` sideways scroll at any width in either scheme; axe-core
  **0** violations in 8 reads (320/360/390/620/768/1,440 light and 360/1,440 dark); no control under 44 × 44 on the page at
  320/360/390/620 beyond the 1 × 1 skip link (at 768 the closed drawer keeps its 36 px rows and 32 px close off-canvas; a
  desk's 36 px sidebar rows are pointer density, §5); the smallest text stays 11 (the avatar initials); one console error in
  both halves (the one-mesh `/api/projects` 404). Keyboard at 360: **11 Tabs** from the body to `What shipped: Show` (skip,
  navigation, the bar's `…`, `Open the product`, the hero's `…`, four figures, the note's door, the row) — three fewer than
  when the quiet links were on the row.

Suite: typecheck and build clean; `node --test "dist/tests/**/*.test.js"` **6,443 tests, 6,441 pass, 0 fail, 2 skipped**;
`dist/tests/dashboard` + `dist/tests/build` **1,436 pass, 0 fail**, with the new `overview-receipt.test.ts` (10 tests: `heroActions`' four cases, the note fold, the goal's grid and the value's layer) and two selectors updated in `overview-figures.test.ts`; eslint 0
errors (211 pre-existing cross-package warnings).

**Left.** At 320 the goal's third line holds the first evidence row 21 px above the dock, its words under it; that is the
next 40 px. The hero's `…` and the frame's `…` both offer `Reopen with feedback` on a phone — the hero's is the mission's
own secondary action and the hero is where the result lives, but two menus with one item in common is a reading question.
On a pointer, a press on a figure's number now does nothing (the value is the selectable layer): the trade is selection for
a 246 × 28 px hole in a 287 × 132 cell, and the I-beam is what says so. The delivered note's exact wording is one press
further away on a phone; the headline above it says the claim. The 320 goal, the note's fold for other phases, and the
`display: contents` grid on a notched device are not read on hardware.

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
  At the end of every page no control is left under the row: the event list's own scroller ends 12 px above it.
- **Nothing else moves.** No document or `#view` sideways scroll at 320/360/390/768/1440 in light or 360/1440 in dark;
  axe-core **0** violations in 34 reads (13 views × 360 and 1,440 in light, 4 views at 360 and 1,440 in dark; 19–32 rules
  passed each); one console error in both halves (the one-mesh `/api/projects` 404, and before it was two on Cost); the
  smallest text stays 11 px (the avatar initials and the Designer's seat flags); the dock's tabs are 72 × 52 at 360, so
  they clear the floor by 8 px in the narrow direction.

Suite: typecheck and build clean; `node --test "dist/tests/**/*.test.js"` **6,431 tests, 6,429 pass, 0 fail, 2 skipped**;
`dist/tests/dashboard` **1,203 pass, 0 fail**, with three new files (`dock-phone`, `overview-figures`, `inbox-title`)
and one rule added to `page-exits` and to `failure-states`; eslint 0 errors (211 pre-existing cross-package warnings).

**Left.** The dock hands 36 px of every page to the frame: the trade is one press instead of two for five places, and it
is worth watching whether the row earns it on the pages opened once (Host settings is not one — it draws no dock). The
Overview's hero is still 737 px at 360, so the four closed evidence rows begin at 867, below the 800 px fold; the
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
