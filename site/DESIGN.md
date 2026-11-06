# The public site: the plain ledger, public

**Direction: exact, unhurried, warm.** The site is the first page of the same ledger the account
pages keep. A stranger should be able to check every claim, see what a licence costs, and know the
next press, one-thumbed, at 360px. Nothing is sold with a flourish; nothing is hidden behind a
hover. The account pages (`apps/cloud-server/pages/DESIGN.md`) are the other half of this record.

Why this direction: the owner reads the site on a phone, and the product's argument is that the
runtime keeps a record. A page that states prices, limits and refusals plainly is the argument.

## The surface

Seven plain pages under `site/`, no build step, no framework, no third-party request:

`index.html`, `pricing/`, `docs/`, `security/`, `contact/`, `legal/`, `404.html`.

`site/README.md` is the spec for claims. Prices are generated from `packages/licensing/src/plans.ts`
by `scripts/export-pricing.mjs`; do not hand-edit a generated block. Header and footer are written
by `scripts/site-chrome.mjs`; asset fingerprints are written by the same script. Run it after
editing CSS or JS.

## Rules that bind every page

1. **A card is for something you act on** (a plan, a place to start, an address, the 404's ways
   out). Explanatory prose is a ruled entry: a top rule, a mark, a title, words, no panel, no
   shadow. This is the change of this pass. It removes the "everything is a card" sameness and
   makes the pages read as one ledger.
2. **One job per screen.** On the home page the price follows the statement: after the hero and a
   numbered index, `#pricing` comes before the arguments. A visitor who came to pay does not scroll
   13,000px to find out what it costs.
3. **A control is 44px in its smallest dimension on a coarse pointer**, and never hover-only. Inline
   links in a sentence are the exception WCAG allows; a standalone link is not.
4. **Type stays on the ramp**: 11, 12, 13, 14, 15, 16, 18, 20, 24, 28, 30, 36, 48, 60, 76. Body
   16, captions 12 minimum, terminal 13. Code inside a block is not shrunk a second time.
5. **No horizontal page scroll at 360 or 320.** A table, a terminal, the console views and the
   plan cards may scroll inside their own box; the page may not. A box that scrolls sideways sets
   `position: relative`, so a screen-reader span inside an off-screen card cannot position itself
   against the page and widen it.
6. **Every state says what happened and what is next.** The site has no server-rendered failure
   states, but it does have: docs filter with no matches, copy refused, calculator with a quoted
   plan, menu open, no script, reduced motion, forced colours, print.
7. **Words are claims.** Every number is generated or measured; `tests/build/site-copy.test.ts` is
   the gate. Do not add a price, percentage or "open source" to prose.
8. **A control's edge is a boundary, not a decorative rule.** The outlined button, the Copy button, the
   menu button and the chosen segment of a switch take `--k-line-control` (≥3:1 on their ground, light
   and dark) **at rest**, not only on `:hover`. `--line` and `--line2` are for cards, frames, rules and
   tags. A chip whose words are the control (the On this page bar, the plan chooser) may keep the lighter
   rule: the row it sits in says where the target starts, and the words say what it does.

## Type and space

- Display: 76 / 60 / 48 (home h1 `clamp(2.5rem, 1.2rem + 5.4vw, 4.75rem)`); inner page h1
  60 / 45 / 36. Section title 48 / 28. Card title 19 (24 for the wide first reason).
- Body 16/1.6; lede 17–20/1.55; caption 12–14. Mono 13 in terminal and paths.
- Space: 4, 8, 12, 16, 20, 24, 32, 40, 48, 56, 64, 88. Section rhythm
  `clamp(48px, 7vw, 104px)`; heading to content `clamp(32px, 5vw, 56px)`.
- Measure: 40rem for a lede, 46rem for a section head, 68ch for prose.

## What every view must cover

| View | Empty | Loading | Failed | Refused / next |
|---|---|---|---|---|
| Home | n/a | first image `fetchpriority=high`, lazy below | alt text on every capture | both Cloud states, and the self-hosted state, are written into the page |
| Pricing | calculator always has a plan | inputs update on `input` | quoted plan says "Quoted, plus model usage", never an empty figure; a number out of range says the figure the estimate used | Cloud visitor is told the estimate is a licence, and where Cloud's price lives |
| Docs | filter with no match says what was typed and offers Clear | filter counts after a pause | n/a | every card names the one document to open |
| Security | n/a | n/a | n/a | what it does not do is a section, not a footnote |
| Contact | n/a | copy button says Copied | clipboard refused says where to look | three addresses, each with what it is for |
| 404 | n/a | n/a | n/a | six named ways back, home first |
| Legal | n/a | n/a | n/a | the owner's unwritten terms are marked, not invented |

## Measurements before this pass (2026-10-22, Chrome 156, CDP)

At 360px, reduced motion, touch:

- Home page **17,024px** tall; `#pricing` at **y=13,106**, first plan at **y=13,421**.
- Pricing 15,163px; docs 9,251; security 11,816; contact 5,033; legal 5,271; 404 2,327.
- Terminal code computed **11.38px** (13px × .875 from `code` inside `pre`).
- Brand hit area **29×44**; footer email **153×16**; security glance links **~42px**.
- Calculator on Enterprise: a bold **"Roughly"** row with an **empty value**.
- No page overflowed horizontally at 320, 360, 768 or 1440.

## What this pass changed

- Home order is now: hero, numbered index (`aria-label="Contents"`), `#pricing`, `#ways`, `#why`,
  `#how`, `#product`, `#try`, `#security`, `#faq`, closing band. The owner can see the price in
  the first quarter of the page instead of the last.
- The hero's reading order on a phone is statement, subhead, actions, picture, then the three
  claims: the way in is on the first screen, not under three proof points.
- Explanatory cards (`#why`, the home security answers, pricing's "paying", contact's guidance)
  are ruled entries. Surfaces remain only where there is an action: plans, start cards, document
  cards, addresses, 404 ways, calculator, frames.
- Console views on a phone are one horizontal snap row with a stated hint and a "Full size" link
  under each capture; the decorative drawings are hidden below 640px.
- The licence plans on `pricing/` are the same snap row on a phone, with a stated hint, and
  `position: relative` on the row. Before that, the `.sr` spans of the off-screen cards positioned
  against the page and made it 872px wide at 360.
- Every capture has a "Full size" link in the same window, so the text inside a 1440px shot is
  reachable on a phone.
- Terminal code is 13px and no longer shrunk by the inline-code rule; brand, footer address,
  security glance links and arrow links meet 44px.
- The calculator's quoted plan ends on "Total: Quoted, plus model usage", with no empty figure.
- Segmented-control labels take `clamp(8px, 3vw, 20px)` of side padding, so the Designer tab stays
  inside a 320px screen; the row used to reach 337px.
- Sections are closer together (48–104px, from 64–120), and the text-card padding is gone.

## Measurements after this pass (2026-10-22, Chrome 156, 360px, touch, reduced motion)

| Page | Before | After | Overflow, 320 / 360 / 768 / 1440 |
|---|---|---|---|
| Home | 17,024 | 13,780 | 0 / 0 / 0 / 0 |
| Pricing | 15,163 | 12,626 | 0 / 0 / 0 / 0 |
| Docs | 9,251 | 9,208 | 0 / 0 / 0 / 0 |
| Security | 11,816 | 11,844 | 0 / 0 / 0 / 0 |
| Contact | 5,033 | 4,815 | 0 / 0 / 0 / 0 |
| Legal | 5,271 | 5,292 | 0 / 0 / 0 / 0 |
| 404 | 2,327 | 2,348 | 0 / 0 / 0 / 0 |

- Home: `#pricing` at **y=1,720** (was 13,106), first plan at **y=2,059**, console at 7,397.
  Primary hero action **y=532**, inside the 740px first screen; it was y=792.
- Anchor `#pricing` lands at y=88 with a 69px pinned header (`scroll-padding-top: 88px`).
- Plans row at 360: 360 client / 1,306 scroll, hint visible, Enterprise ends wholly on screen
  (35–344), its action 44px; focus returns the row to the first card. Tiles row: 360 / 1,950.
- Text roles measured for contrast on home and pricing, light and dark: worst light **5.61:1**,
  worst dark **6.35:1** (AA normal text needs 4.5). Tiny text (<12px) census: empty on every page
  at 320/360.
- The only controls under 44px are the hidden 1×1 radios and the 24×24 checkbox whose label is
  44px.

## Still wrong / next pass

- The hero is 1,457px tall at 360. The action is now on the first screen, but the frame is not;
  a 720px phone capture would let a reader see the product without scrolling.
- The pricing page's plan table is 720px wide and scrolls under a sticky first column. The sticky
  column is measured, but a phone reader still has to swipe; a per-plan stacked table would be
  better than the snap row plus the wide table.
- The `#pricing` snap row on the home page and the plans row on `pricing/` show a sliver of the
  next card, which is intentional, but there is no visible page indicator. If the row is ever
  more than four cards, add one.
- The site cannot show Curule Cloud's prices: they live in the app. The home page says so; the next
  pass could add a generated "Cloud plans start at" line once the app exposes one stable price.
- The screenshots are 1440px wide and therefore small on a phone even at full size. A 720px capture
  set for the phone would read better than pinch-zooming.
- Every page was re-measured at 360/768/1440 after the changes; 200% zoom and a large-text profile
  were not run on this surface.
- `site/DESIGN.md` and `apps/cloud-server/pages/DESIGN.md` are two halves of one record; read them
  together.

## 2026-10-23: the first screen, the row's numbers, pricing's table

Measured with the same probe (Chrome 156 over CDP, reduced motion, touch, 360/768/1440, light and dark).
The before column is the previous pass's record, re-measured today and unchanged.

### What changed

- **The phone's first screen** now holds the product. At `max-width: 719px` the hero's spacing is one
  step tighter (top 24→16, eyebrow 20→12, lede 24→16, actions 28→20, picture 36→20), and the note
  that sat under the actions is laid out below the capture it describes (CSS `order`; the DOM order
  the test pins is untouched, and the note holds no control). The tabs and 125px of the capture are
  inside an 800px screen; the capture itself starts 153px higher.
- **The six console views are numbered 01–06** in the same 12px muted, tabular figure as the section
  eyebrows and the contents, with the same hairline between number and title. The row still scrolls
  as one snap row on a phone; the numbers give it an order a thumb can follow.
- **The two ways cards are smaller on a phone**: `padding-inline` 28→20, the answers' gap 20→14, and
  the one action is full width. The pricing page's plans start 76px higher.
- **The comparison table says it scrolls** (`Swipe the table sideways…`, where it really scrolls, at
  `max-width: 719px`), is 660px instead of 720, and its cells are 12/14 instead of 14/18. At 768 it
  no longer scrolls at all (705px box, 705px table; it was 720 in a 705 box), so the hint is not
  shown there: a reader is not told to swipe a table that fits.
- **The docs pages' empty state** no longer leaves the map's box behind: a filter that matches nothing
  collapses `.doc-grid` (measured 0×0; it used to keep a 56px top margin under the empty panel).
- **The graph in "How a mission goes"** gained the "Full size" link every other capture has; it was
  the only 1139px capture with no way to its text on a phone. `tests/build/site.test.ts` now counts
  ten such links, not nine.
- **Rows that scroll sideways contain the gesture** (`overscroll-behavior-x: contain` on the six
  views, the plans, the On-this-page row, the tables and terminal blocks), so a swipe at the end of a
  row no longer turns the page back.
- **Print** lays the rows out instead of scrolling them, fits the comparison table to the page, hides
  the swipe hints, and prints both the monthly and the annual price of a plan because the switch is
  not printed (`.price-monthly` was `display: none` under the checked Annual radio; measured block in
  print now).
- **High Contrast** keeps the dot that marks the On-this-page chip being read.

### Measurements after this pass

| Page | 360 before / after | 768 before / after | 1440 before / after |
|---|---|---|---|
| Home | 13,780 / **13,648** | 13,083 / 13,108 | 12,214 / 12,258 |
| Pricing | 12,626 / **12,632** | 10,732 / **10,613** | 9,125 / 9,125 |
| Docs | 9,208 / 9,208 | 6,171 / 6,171 | 4,696 / 4,696 |
| Security | 11,844 / 11,844 | 8,327 / 8,327 | 7,620 / 7,620 |
| Contact | 4,815 / 4,815 | 3,871 / 3,871 | 2,815 / 2,815 |
| Legal | 5,292 / 5,292 | 3,863 / 3,863 | 3,317 / 3,317 |
| 404 | 2,348 / 2,348 | 1,911 / 1,911 | 1,524 / 1,524 |

Home at 360: the primary action at **y=500** (was 532), the tab row at **568** (721), the product
frame at **634** (787), its first pixel at **675** (828), `#pricing` at **1,668** (1,720), the first
plan at **2,007** (2,059), the console at **6,936** (7,068), the views at **7,265** (7,397), the
steps at **5,719** (5,895), the questions at **11,189** (11,321), the closing band at **12,155**
(12,287). The page is 132px shorter at 360 and 25–44px taller at 768/1440, which is the graph's new
44px link.

Pricing at 360: the two ways are 1,257px (was 1,333), the plans start at **1,794** (1,870) and the
first card at **1,924** (2,000); the compare box is 660×674 inside a 326px window (was 720×682). At
768 the two comparison tables fill their box exactly, and the page is 10,613px (was 10,732). The two
hints appear at 719 and below, where the tables scroll, and print nowhere.

No page overflows horizontally at 360, 768 or 1440 in either theme, or at 320 in light; the probe
reports no console errors. At 320 the home page is 14,401px and pricing 13,523px, and the first screen
still shows the tabs and the top of the capture.

Type is unchanged: the smallest text is still 12px (the new numbers), body 16, terminal 13, and no new
colour, radius or size was added. At 360 with a coarse pointer, the only controls under 44px are the
hidden 1×1 billing radios, the 24×24 checkbox whose label is 44px, and inline links in sentences.

### What this pass deliberately left

- **The pricing page still opens with "Do you run it, or do we?"** before the licence plans. That order
  is the previous pass's documented choice (the page opens with the same two ways the home page
  offers); the cards are 76px shorter, and the first card is still below the first screen at 360. A
  later pass could move `#plans` above `#ways`, but that changes what the page opens with, not its
  craft.
- **The comparison table still scrolls at 360.** A per-plan stacked table needs per-row plan labels
  the pricing exporter does not write; it fits at 768 now and states what it does below 720.
- **The captures were not retaken** (the console is being redesigned in parallel). The alt texts and
  captions still describe the pictures that are there; they will need reading again with new shots.
- **Curule Cloud's prices** are still not on the site: they live in the app.
- 200% zoom and a large-text profile were not run; the surfaces were checked at 320/360/768/1440,
  print, no-JS, dark and forced colours.

## 2026-10-23, second pass: the phone's comparisons, the row's index, and large text

Measured with the same probe (Chrome 156 over CDP, reduced motion, touch, light and dark unless
said). The before column is today's site before this pass, re-measured; no earlier number is reused.

### What changed

- **The pricing page's two wide tables are one plan (or one model) at a time below 720px.** The plan
  table is 660px wide in a 326px window at 360 (334px hidden) and in a 288px window at 320 (372px
  hidden). The two comparisons are now generated twice from the same plan table: the existing
  `plan-table` and `run-costs` for the widths where they fit, and `plan-stack` / `run-stack`
  (`scripts/pricing-html.mjs`, fenced by `scripts/export-pricing.mjs`) for a phone. The stack is the
  table's own lines with each label beside its value; the table is hidden below 720 and kept for
  720, 768, 1440 and print. No number is typed by hand, and the page reads without a script.
- **The six console views have a page index on a phone.** Six 44px tabs (`01`–`06`, `aria-label`
  "Jump to a view") sit under the hint and jump to the card they name, so the sixth view is one press
  from the first instead of five swipes. The tabs are hidden at 720px and up, where the cards are a
  grid and every one is already on screen. Each tab is 44×44 and its target is the card's new
  `id`; the row's own snap scrolling and `position: relative` are unchanged.
- **Large text no longer widens the page.** At a 24px user default (150% of 16px) every page was
  **76px wider than a 360px viewport**; pricing was 132px wider at 320. The causes were the header's
  Menu label and pills (76px), the 60px `organization.` in the home `h1` (75px), the hero's tab
  labels (35px), the footer's "Documentation" (10px), and the calculator's total at 320 (27px). The
  header buttons, menu label, hero tabs, billing labels and footer now keep their 14–15px layout
  size instead of growing with the user's rem; headings break a word that cannot fit; the stacked
  labels keep a 160px column and break long words; the result total wraps. At 360 and 320 the page
  is now 0px over.
- The plan-card hint says "the comparison below lists every line" rather than naming a table that a
  phone no longer gets. The `table-hint` paragraphs and their CSS are gone: neither table is
  presented to a phone to swipe.

### Measurements after this pass

| Page | 360 before / after | 320 before / after | 768 / 1440 |
|---|---|---|---|
| Home | 13,648 / **13,700** | 14,400 / **14,452** | 13,108 / 12,282 (unchanged) |
| Pricing | 12,676 / **13,944** | 13,574 / **14,972** | 10,682 / 9,174 |
| Docs | 9,232 / 9,232 | 9,842 / 9,842 | 6,146 / 4,678 (unchanged) |
| Security | 11,916 / 11,916 | 12,823 / 12,823 | 8,327 / 7,668 (unchanged) |
| Contact | 4,815 / 4,815 | 5,110 / 5,110 | 3,871 / 2,815 (unchanged) |
| Legal | 5,267 / 5,267 | 5,741 / 5,741 | 3,863 / 3,317 (unchanged) |
| 404 | 2,348 / 2,348 | 2,443 / 2,443 | 1,911 / 1,524 (unchanged) |

- **Pricing at 360:** the plan table was 660×676 in a 326px window; the stack is four plans and
  1,558px tall, the run stack 803px. The page is 1,268px taller because all four plans are now read,
  not swiped. At 320 the stack is 1,666px and the page 1,398px taller. At 720 (the 200% stand-in) the
  table is 662×676 in a 662px box and the stack is hidden; the page is 11,152px, unchanged. At 768
  the table is 707×628, the stack is hidden, and one extra line in the mission's paragraph makes the
  page 10,682px (was 10,662).
- **The six-view index** is 328×44 at 360 and 288×44 at 320. Home is 52px taller at both (the index
  only); 768 and 1440 are unchanged. Pressing `06` put the Approvals card at **left 34, top 88**
  with the row at `scrollLeft 1,590`.
- **Large text (24px root), 360:** home 21,497→21,562, pricing 21,378→23,189; every page **0px
  over** (was 76). At 320: home 23,533→23,554 and pricing 25,255→25,417, both **0px over** (was 115
  and 132).
- **200% zoom (720px viewport):** 0px overflow on all seven pages, before and after. The smallest
  computed text is 12px and no page has text under 12px at any tested width.
- No page overflows at 320/360/768/1440 in light or dark, or at 720. The probe reports no console
  errors. Print at A4 width (794px) shows the tables, not the stacks, and is 0px over.

### What this pass deliberately left

- **The phone reads four full plans to compare them.** The stack is honest and needs no gesture, but
  it repeats both billing periods for every plan; the Annual/Monthly radios live in `#plans` and CSS
  cannot reach across sections, so the stack does not hide the period not chosen. Moving the switch
  into `#compare` (or a scoped `:has`) is the next step.
- **The index is a destination, not a position.** It tells a reader there are six views and takes
  them to one; it does not mark the view currently on screen. A live indicator would need the
  script, and the row already works without it.
- **The hero's three captures are still 1440px.** The console's six tiles are 720×450; the hero's
  three are the whole window. A 720 crop per hero view would read better on a phone, but the console
  is being redesigned in parallel and the pictures would be retaken twice.
- **Curule Cloud's prices** are still not on the site: they live in the app, and no stable Cloud
  price can be generated from `packages/licensing/src/plans.ts`.
- **The body's px ramp does not follow a user's default font size.** The 24px root test scales the
  rem-based headings and leaves 16px body text; a rem conversion of the whole ramp is a larger
  change than this pass, and the 200% zoom path (the WCAG reflow case) is clean.
- `npm run site:check` still fails on the owner's `TODO(owner)` for the terms in
  `site/legal/index.html:133`; that is the pre-existing publishing gate, not this pass.

## 2026-10-23, third pass: the pricing page's first screen, and the period a phone reads

Measured with the same probe (Chrome 156 over CDP, reduced motion, touch, light and dark unless
said). The before column is the site at the commit this pass started from, checked out again and
measured today; no number is copied from an earlier pass.

### What changed

- **The pricing page opens with the licence plans.** `#plans` now comes directly under the On this
  page bar and the Cloud-only choice between the two ways (`#ways`) follows it. The section the
  plans opened with was `sr`-only; it is now the visible "The licence plans.", so the four cards
  are named at the point where a reader meets them and are not read as Curule Cloud's. The licence
  card in `#ways` says "The plans above are licences…" because that is now where they are. The
  bar's first chip is the section the page opens with, so its mark is right from the first section:
  at 360 the first 1,257px, the whole of `#ways`, used to mark no chip at all.
- **The phone's plan comparison reads the billing period chosen above the cards.** The rows the
  exporter writes into the phone's stack carry `period-annual` and `period-monthly`; below 720 a
  `body:has()` rule hides the period that is not chosen, in `#compare` only. The surviving row still
  names its period, so the stack says which one it shows. The table keeps both rows at 720 and up
  and in print, where both are wanted. The `#calculator`'s model stack is untouched.
- **A capture's caption is no longer below the type floor.** The generic `code` rule made the
  `curule validate` in the Designer caption 11.375px (13 × .875); a `.frame figcaption code` rule
  keeps it at the caption's 13px.

### Measurements after this pass

| Pricing at | Before | After |
|---|---|---|
| 320 | 14,972 | **14,862** (monthly: 14,755) |
| 360 | 13,944 | **13,835** (monthly: 13,771) |
| 768 | 10,682 | **10,700** |
| 1440 | 9,174 | **9,212** |

- At 360 the first plan card is at **y=737** (was **1,924**, below the first screen by 1,124px);
  its amount is at **y=886** (was 2,074). The visible "The licence plans." heading is at y=569, the
  Annual/Monthly switch at 663.
- The phone's plan stack is **1,411px** (was 1,558) and shows **one** price row per plan instead of
  two (4 rows removed in total); the page is 109px shorter at 360. With Monthly chosen the stack is
  1,367px.
- At scroll y=560 the On this page bar marks **"The plans"**; before, its two chips were all past
  the reading line and it marked nothing.
- Home: the smallest computed text is **12px** (was **11.375px**); every page's census is empty
  below 12px at 320 and 360.
- No page overflows at 320/360/768/1440 in light or dark (pricing measured after switching to
  Monthly too). Print at A4 width keeps the table and hides the stack; the hidden rows are
  `display:none`, so nothing is read that is not shown. No new console errors.

### What this pass deliberately left

- **`#ways` still has no chip.** It is Cloud-only, and the bar's test forbids a chip whose section
  the Cloud switch can hide. Now that the bar starts with the plans, the unmarked section is below
  the first section rather than at the top of the page; while it is read the nearest chip above it
  ("The plans") stays marked.
- **The stack still repeats the limits and support for all four plans.** Only the price row was made
  to follow the switch. A per-plan summary that did not repeat the lines is a larger change to the
  generated stack.
- **The first plan's price is still 86px below an 800px first screen**, because the section's own
  heading, the phone hint and the switch take the first 200px. The card is on the screen; the
  figure needs one small scroll.
- **Curule Cloud's prices** are still in the app, not on the site.

## 2026-10-24: the price, one card on a phone; where Curule Cloud's prices are

Measured with the same probe (Chrome 156 over CDP, reduced motion, touch, light and dark unless
said). The before column is the site at the commit this pass started from, extracted again and
measured today; no number is copied from an earlier pass.

### What changed

- **The four plans are one rate card, read in rows, on a phone.** Below 600px each plan is a line of
  the card instead of a card: the name and its 36px amount on one line, the billing period under
  them, then the allowance under a hairline. The border, the 1px rules between cells and every
  word stay; the amount keeps its 36px, the name 15, the period and allowance 14. At 360 the teaser
  is **800.94 → 602.94px**: a screen that starts at the first plan (2,006) now holds all four
  figures, the note and the top of the buttons, where before it ended at the fourth plan's
  allowance with the buttons at 2,839 and the note at 2,955 below it. The page is 174px shorter at
  360.
- **How a paid plan starts is read before the two ways on.** The note that says a paid plan starts
  with an email and that the key is issued by hand (and, while Curule Cloud is open, that it has its
  own sign-up) now sits under the four plans and above the buttons: **2,955.19 → 2,625.19** at 360,
  while the buttons move **2,839.19 → 2,746.75**. The section reads plans, then the terms of buying,
  then "Compare the plans" and "How licences work"; it is **1,425.05 → 1,227.05px**.
- **Curule Cloud's card says where its own prices are.** "What you pay" in the way in now adds
  "Its plans and prices are on the sign-up page.", the sentence the pricing page's card already
  makes; the card's one action already goes to that page. The dead end a buyer met after the
  licence prices (a flat monthly plan with no figure and no place) is closed. The card is
  **522.56 → 546.56** at 360 and the ways section is 1,206.55 → 1,230.55px tall; at 768 the page is
  48px taller and at 1440 it is unchanged, because the sentence fits the lines the card already
  had.

### Measurements after this pass

| Home at | 320 | 360 | 390 | 768 | 1440 |
|---|---|---|---|---|---|
| Before | 14,476.89 | 13,699.39 | 13,171.77 | 13,106.70 | 12,256.70 |
| After | **14,283.80** | **13,525.39** | **12,997.77** | **13,154.66** | **12,256.70** |

- At 360 the pricing section is **1,667.70–2,894.75** (was 1,667.70–3,092.75); its first amount is
  at **2,021.25** (was 2,056.75), the note at **2,625.19**, the buttons at **2,746.75**, and the
  ways start at **2,894.75** (was 3,092.75). The four plans, the note and both buttons now span
  841px, where they spanned 1,039px.
- At 320 the teaser is **841.53 → 624.44px**: Team and Business used to wrap their period and
  allowance into 219.28px rows; they are 149.48 now. The quoted plan's amount takes its own line
  (row 170.98) rather than break "Enterprise" against a 36px "Let's talk" in a 250px line.
- At 390 the pricing section is **1,395.67 → 1,197.67**; the page 13,171.77 → 12,997.77.
- Type is unchanged: the smallest computed text is **12px**, the amount 36, and no new size,
  colour or radius was added. The worst text pair is **5.61:1** in light and **7.10:1** in dark at
  360 and 1440 (AA normal text needs 4.5). The only targets under 44×44 are the same inline links
  in sentences (3 at 360, 2 at 320); the four plans hold no control of their own.
- No page scrolls sideways at 320, 360, 390, 768 or 1440 in light, or at 360 and 1440 in dark. At
  a 24px user default the document is **0px over** at 320 and 360: the amount drops under the name
  rather than widening the row. Print is wider than the breakpoint and keeps the two-column rate
  card.
- The probe's failure list is identical before and after at 360 light and dark (28 and 26): the
  closed phone menu's links, the cards that sit off the snap row (which the probe cannot scroll),
  and the 1px hairlines under its 3:1 boundary floor. Nothing new was added to it.

### What this pass deliberately left

- **The first screen still carries the statement, the way in and the top of the capture, not a
  price.** A generated price line under the hero's actions was the other candidate and was left: it
  is a second line in the actions' column, which on a phone pushes the capture down and on a wide
  screen grows the hero's row, and it gives the first screen a second job. The price section is one
  flick below the contents, and its four figures now read in 603px.
- **The four plans are still four rows, not a snap row.** A price a buyer must swipe for is worse
  than one they can read; the pricing page's cards are a snap row because a card there carries a
  whole plan, and the teaser carries a line.
- **The teaser still shows the limits only.** What each plan includes, its support and the annual
  total are on the pricing page, one press from the buttons.
- **Curule Cloud's prices** are still in the app: the card now says so and its action goes there.
- The screenshots are unchanged; the captures were not retaken.


## 2026-10-24, second pass: the six views' targets, the map's filter, the estimate at the field

### What changed
- **Three of the six "Jump to a view" tabs pointed at the hero.** The hero's three tab radios
  reused the ids of the cards below (`view-overview`, `view-events`, `view-designer`), so at 360
  the 01, 02 and 04 chips scrolled back up to y=571, the hero, instead of the console row at
  7,143. The radios are now `hero-view-*`; all six chips land on their own card and the row
  scrolls to it (carousel scrollLeft 0 / 322 / 965). `site.test.ts` now fails on a repeated id or
  an in-page link that names more than one element.
- **The documentation map's filter comes before the label legend.** The four label explanations
  are a closed `details` ("What each label means") and the "Each title opens the document on
  GitHub" note follows the filter, next to the cards it describes. The filter moves from 3,101 to
  2,523 at 360 (1,722 to 1,361 at 1440) and the first document card from 3,306 to 2,903. Opened,
  the four rows are the same rows, and the filter moves down by their height, as before.
- **The estimate follows the fields on a phone.** The calculator's form and its result cannot be
  on a 360 × 800 screen together (558 + 666 px), so a change of a field left the figure 1,007 px
  down the viewport. The form now opens with a 48 px total (`#calc-total`, aria-hidden, the
  ledger's live region stays the result) that pins under the header and On this page bar while
  the form is edited: "Business / $637 / month (annual)". It is hidden at 860 and up, where the
  form and the result are side by side, and in print.
- **The calculator names its billing period.** For a listed plan the fee row now reads
  "$499 / month, billed annually" (or monthly), and the pinned total says "(annual)" or
  "(monthly)"; a quoted plan still says "Quoted, plus model usage", and the free plan "Free".
- **The pricing page's first two sections take the page's heading rank.** "The licence plans." and
  "Do you run it, or do we?" were 22 px `.legend-title`s, the same size as the plan names they
  carry, while the five sections after them were 28 px on a phone and 48 px on a desktop. Both are
  now section heads with an eyebrow ("Plans", "Two ways in") and a 28/48 px title.

### Measurements after this pass
| Page at 360 / 1440 | Before | After |
|---|---|---|
| Home | 13,526 / 12,258 | **13,526 / 12,258** |
| Documentation | 9,208 / 4,696 | **8,805 / 4,437** |
| Pricing | 13,790 / 9,188 | **14,006 / 9,393** |

- The home page is unchanged in height: the ids are the whole of its change. At 768 it is still
  13,156. The contents strip, the section order and the first screen are untouched.
- Documentation: the filter 3,101 → **2,523** at 360 and 1,722 → **1,361** at 1440; the first card
  3,306 → **2,903** and 1,930 → **1,671**; the page 9,208 → **8,805** at 360 and 4,696 → **4,437**
  at 1440 (6,171 → **5,839** at 768). The closed disclosure is one 48 px row; opened it is the
  same four rows (the columns block grows 226 → 684 at 360).
- Pricing: the plans section 1,636 → **1,700** at 360, the ways 1,225 → **1,309**, the calculator
  2,907 → **2,974** (the pinned total's 48 px and its 20 px margin), and the page +216 at 360 and
  +205 at 1440. The two H2s are **28 px at 360 and 48 px at 1440** (were 22 at both). The cost is
  the two eyebrows and the section-head's own gap, taken deliberately for the rank.
- The calculator, 360 and 768: with the first field in view (y=479), the figure is at
  **357–430** at 360, where the result used to start at 1,007 (below an 800 px screen); at 768 the
  result used to start at 939, and the pinned total is at the same place. The result itself is
  where it was. The pinned total holds at **top 140** under the 69 px header and 61 px bar, and is
  46 px tall (72 px when "Enterprise · Quoted, plus model usage" wraps at 320/360).
- No page scrolls sideways at 320, 360, 390, 768 or 1440 in light, or at 360 and 1440 in dark;
  0 console errors. The smallest text is **12 px** and the contrast probe finds **0** failing
  text pairs on the home, pricing and docs pages in either scheme.
- Tests: `node --test` over the eight site files (structure, copy, chrome, cloud, script,
  brand assets, pages workflow, pricing) is **130 pass, 0 fail**.

### What this pass deliberately left
- **The landing page is still 13,526 px at 360**, and its longest sections are the four demo steps
  (1,871) and security (1,531). Their words are the product's argument and the demo's commands are
  what the hero's second action promises; folding either behind a disclosure would hide the thing
  the visitor pressed. The pass fixed the path through the page (the six chips) rather than the
  page's length.
- **The home page's two ways in still carry one action each**, the demo for "You run it" and
  "Get started" for the Cloud card: `site-cloud.test.ts` states that as the design ("the one thing
  to press"), so a second "See the plans" link under the demo was not added. The plans sit one
  section above.
- **The pricing comparison still follows the Annual/Monthly switch above it** rather than
  repeating a switch under the table; its row label names the period, and a second segmented
  control would be two controls for one fact.
- The screenshots are unchanged; no capture was retaken.

## 2026-10-24, third pass: the bar that fits the phone, and the sections at 768

Measured with the same probe (Chrome 156 over CDP, reduced motion, touch, light and dark unless
said). The before column is the site at the commit this pass started from (`3a9b11a`), served on a
second port and measured today; no number is copied from an earlier pass.

### What changed

- **The wordmark is drawn at its own proportions on every phone.** The header's bar held more than
  it could: at 360 the wordmark's link is 102.61px wide and the bar's four items needed **401.6px
  of a 328px wrap**, so flex shrank the link to its 44px floor and the drawing inside it to
  **30 × 24** — 1.25:1 where the logo is drawn 221.54 × 60 (3.69:1) — and the actions ended at
  **345.0** against the wrap's right edge at **344**. The link and the drawing are now `flex: none`
  (a test pins both), and what gives way is the bar's copy, below.
- **Sign in is said once.** Below 600 the bar's Sign in is hidden and the menu's own row is the
  link (it was the same sentence twice on a 360 screen: in the bar at y=12 and four rows into the
  open panel); it stays in the bar from 600, and the panel's copy is hidden there, so exactly one
  "Sign in" is on screen at every width.
- **The menu is a 44 × 44 thumb's square below 600**, its word kept for a screen reader ("Menu"),
  and its icon is three bars instead of two (the two the bar had read as "=" once the word beside
  them was gone). At 600 and up there is room for the word: "Menu".
- **The four sections are a row from 768**, where they fit: at 768 the links take **301.1px**
  (Product 79.1, Pricing 72.9, Docs 59.6, Security 83.5) from x=158.7 to 459.8, and the actions
  start at 543.7 — **83.9px between them**. Before, a 768px window was a phone header: brand, Sign
  in, Get started, Menu, and the four sections behind a press. The menu is hidden there, and the
  current page's link keeps its mark (`aria-current`).
- No type, colour, radius or spacing step was added, and the header is still 69px: every page is the
  same height as before.

### Measurements after this pass

| The bar at | Logo before | Logo after | Brand link | What else |
|---|---|---|---|---|
| 320 | 46.39 × 24 (1.93:1) | **88.61 × 24 (3.69:1)** | 60.39 → **102.61** | menu 44 × 44; 13.25px to spare |
| 360 | 30 × 24 (1.25:1) | **88.61 × 24** | 44 (its floor) → **102.61** | 45.25px to spare; content 329/328 → **328/328** |
| 390 | 59.02 × 24 (2.46:1) | **88.61 × 24** | 73.02 → **102.61** | 45.25px to spare |
| 420 | 87.41 × 24 (3.64:1) | 88.61 × 24 | 101.41 → **102.61** | the last width where it was still off |
| 768 | 96 × 26 (3.69:1) | 96 × 26 | 110 | nav **hidden → shown** (301.1px), menu **shown → hidden** |
| 1440 | 96 × 26 | 96 × 26 | 110 | unchanged |

- Page heights are unchanged at 360 and 768 and 1440: home **13,526 / 13,172 / 12,258**, pricing
  **14,004 / 10,907 / 9,393**, docs **8,805 / 5,843 / 4,437**, security **11,844 / 8,331 / 7,620**,
  contact **4,815 / 3,871 / 2,815**, legal **5,267 / 3,863 / 3,317**, 404 **2,348 / 1,915 / 1,524**.
- No page scrolls sideways at 320, 360, 390, 768 or 1440 in light or dark (**0** on all 70
  page/width/theme pairs), and the probe reports **0** console errors on every one.
- At a 24px user default the document is **0px over** at 320, 360 and 720, and the bar does not
  overflow. With the script off the header is the same 69px and the menu still opens (a `details`).
  In High Contrast the menu keeps all three bars (two are the element's borders, the middle one
  `CanvasText`). Print does not print the header, as before.
- The smallest computed text is still **12px**. The only controls smaller than 44 × 44 are the same
  hidden 1 × 1 billing and hero radios and the 24 × 24 checkbox whose label is 44px; the menu is
  44 × 44, the brand 102.61 × 44.
- Tests: the eight site suites (**136** tests) pass, including a new one in `site.test.ts` that
  pins the bar's rules and the reason for each.

### What this pass deliberately left

- **The bar's Sign in is one press away on a phone, not in the bar.** At 360 the four items cannot
  all fit in 328px, so something had to go; the primary action and the wordmark stayed, and the
  returning visitor's link is the fifth row of the menu. The alternative — the wordmark at 74px, or
  "Get started" behind the menu — spends the first screen's most valuable 100px on a secondary link.
- **The 44px menu loses its word below 600.** The name stays for a screen reader, and the three
  bars carry it visually; at 600 the word returns, where the bar has 131px to spare.
- **The 768–859 band shows the nav but keeps its 36px links.** They are 44px on a coarse pointer,
  which is what that band is on a tablet; a mouse's 36px row in a 44px bar is the same as at 1440.
- **The home page's first screen was not touched.** Its action is still in the first 800px and the
  capture still starts at 634; this pass is the bar above it.
- **No capture was retaken**, and `site/ux/` was not edited.

## 2026-10-24, fourth pass: the address line, the rank of a section, the rules a forced-colour mode drops

Measured with the same probe (Chrome 156 over CDP, reduced motion, light unless said, touch at 320/360/390).
The before column is the site at the commit this pass started from (`651c5e5`), served on a second port and
measured today; no number is copied from an earlier pass.

### What changed

- **An address and its Copy are one line at every phone width.** At 360 the line wanted **280px in the row's
  278** (the address 205.97, the button 62.27, the gap 12), so the button dropped under the address and each of
  the contact page's three rows was **217.38px** where a row is **169.38**. The address now takes the shrink (it
  may break inside itself) and the button keeps its size; at 420 and below the line's gap is 8px, which gives the
  email its last 4px. Rows at 360: **217.38 → 169.38** (three rows **653.13 → 507.13**); at 320: **217.38 →
  179.75** (the email keeps two lines where 238px cannot hold it, so the saving is 37.63 a row, not 48).
- **A card's title no longer outranks its section's.** On the contact page the section heads were **22px** and the
  card titles **24px**, so "To sales" was the largest thing in its section. The card takes the design's card title
  (**24 → 19**, the same 19 every other card on the site uses) and the page's own section heads take the section
  rank the home and pricing pages use: **22 → 28 at 360, 22 → 48 at 1440** (`.section > .wrap > h2.legend-title`,
  which does not reach a title inside a column or a box). The docs page's "Start here" and "Something missing?"
  take it too: **22 → 28 at 360, 22 → 48 at 1440**; "How to read the labels" (a column's title) and the security
  page's "At a glance" (a box's title) stay 22.
- **A forced-colour mode keeps the rate card's and a plan's rules.** The home page's four plans and a plan's three
  figures are ruled by the 1px gap between cells, and a gap is a colour: with `forcedColors: active` at 360 the
  rate card measured **rgb(255,255,255) ground and rgb(255,255,255) cells** — one white block — and a plan's
  figures the same. The ground is now painted `CanvasText` (**measured rgb(0,0,0)**) and the cells keep their own
  forced colours (**rgb(255,255,255)**) over it, so the rules survive; the cells take `forced-color-adjust: auto`
  so their words stay the system's.

### Measurements after this pass

| Page | 320 before / after | 360 before / after | 390 | 768 | 1440 |
|---|---|---|---|---|---|
| Contact | 5,062 / **4,948** | 4,815 / **4,698** | 4,437 / 4,490 | 3,871 / 3,883 | 2,815 / 2,860 |
| Docs | 9,418 / 9,421 | 8,805 / 8,808 | 8,527 / 8,529 | 5,839 / 5,851 | 4,437 / 4,461 |
| Home, pricing, security, legal, 404 | unchanged | unchanged | unchanged | unchanged | unchanged |

- The contact page is **117px shorter at 360** and **114px shorter at 320**. It is 39–53px taller at 390 and above,
  which is the section rank (a 28px head at 390, a 48px one at 1440) where the address rows were already one line.
  The docs page is 3–24px taller for the same reason, on two heads.
- The contact page's first address is at **508 → 540** at 360 (the section head is 6px taller and the addresses
  start under it); the three addresses end **1,161 → 1,047**.
- The smallest computed text is still **12px** on every page at 320 and 360; no page has text under 12px.
- No page scrolls sideways at 320, 360, 390, 768 or 1440 in light or dark (**0** on all 70 page/width/theme
  pairs), and the probe reports no console errors. The type sizes added are on the design's ramp (19, 28, 48).

### What this pass deliberately left

- **The contact page still shows the same address three times**, once for each purpose: that is the owner's
  address, not the layout's, and the rows say which purpose each is for.
- **The On this page row still scrolls in silence where its chips do not fit** (the security page's six chips take
  1,232px in 768 and 1,203 in 360; the pricing page's 804 in 768). The script reveals the chip being read, so a
  reader is never left without the current section; a fade at the row's edge would be the next step, and it needs a
  class the script sets (CSS cannot see that a row overflows) — a larger change than this pass.
- **The two ways, the plans and the console row were not touched**; their snap rows and the 86px between the
  pricing page's first screen and its first figure are as the third pass left them.
- **No capture was retaken**, and `site/ux/` was not edited.

## 2026-10-25: the map of documents is a section, and the filter stands under its name

Measured with the same probe (Chrome 156 over CDP, reduced motion, light unless said, touch at 320/360/390). The before
column is the site at the commit this pass started from (`e2aec42`), served from a second copy on a second port and
measured today; no number is copied from an earlier pass.

### What changed

- **The map of documents is named, and named at the page's rank.** The band that holds every document was headed
  "How to read the labels" — a note about the label legend, 22px, beside its own legend — so the page's largest band
  (4,991px at 360, 57% of the page) had no name that said what it was, and its title was a footnote. It is now
  **"The documents, by area."** as the section's own head: **22 → 28px at 360** and **22 → 48px at 1440**, the rank the
  same page's "Start here" and the contact page's section heads already take. No new size was added.
- **The filter is the first line under that name.** It stood 258px below the section's top at 360, behind the legend's
  head, a three-line paragraph about labels and a closed legend row, so a reader who came to find one document scrolled
  past the explanation of the labels to reach the field. It is now **258 → 92px** below the section top at 360 (1440:
  152 → 84).
- **The label legend moved under the filter, into the disclosure it belongs to.** "What each label means" is a 48px
  closed row and the sentence that defends the labels ("a test checks it against the file…") now sits inside it, with
  the four rows it explains. Before, that sentence was a 102px paragraph above the filter at 360 (51px at 768, 77px at
  1440) and the legend sat beside it in a second column.
- **The eleven areas are card titles under the section, not headings beside it.** Each map card's title was an `h2`
  at 19px — the same rank as the section heads — so the outline read `h1 → h2 Start here → h2 Quickstart … h2 Brand`
  and the areas looked like eleven sections of the page. They are `h3` now (19px, unchanged: the stylesheet already
  sized `.doc-card h3`), and the outline reads `h1 → h2 The documents, by area → h3 Quickstart … h3 Brand`. The
  filter's group name is read from `h2, h3` (`assets/site.js`), so searching an area's name still finds its documents
  (measured: "configure" keeps the Configure card and its one document).

### Measurements after this pass

| The documentation page at | Before | After |
|---|---|---|
| 320 | 9,421 | **9,310** |
| 360 | 8,808 | **8,722** |
| 390 | 8,529 | **8,444** |
| 768 | 5,851 | **5,790** |
| 1440 | 4,461 | **4,473** |

- At 360 the map's preamble (its top to the first card's top) is **637.82 → 552.42px**; the filter is at
  **2,525.89 → 2,360.48** and the first document card at **2,905.84 → 2,820.44**. At 320 the same two are
  **687.43 → 576.43** and **3,115.16 → 3,004.16**; at 768 **505.03 → 443.69**; at 1440 **461.84 → 473.39**.
- The band is **85px shorter at 360**, 111 at 320, 85 at 390 and 61 at 768, and **12px taller at 1440**: the head is
  the page's rank there (+24px on a 28px line) and the legend is a row of its own under the filter, against the 77px
  column of explanation that moved into the disclosure. The legend row is 512px wide, in the filter's column.
- The outline is 1 `h1`, 3 `h2` and 15 `h3` on the page, with no `h2` inside `.doc-grid` (it was 11). The map's head
  is the section's own (28px at 320/360/390, 36.8 at 768, 48 at 1440); a title in a column — "Something missing?" in
  the closing band — and the security page's "At a glance" still keep their 22px, as the rule says. (The fourth
  pass's sentence said "Something missing?" had taken the section rank; it is a column's title and measures 22 at 360,
  unchanged by this pass.)
- The filter still works with every card as `h3`: "configure" → 1 of 16 documents and the Configure card; "Architecture"
  → 1 of 16 and Concepts; no match → "0 of 16 documents" with the panel and its Clear button. Without a script the field
  is hidden and the head, the legend, the notice and the eleven cards are all there.
- No page scrolls sideways at 320, 360, 390, 768 or 1440 in either theme (**0** on all 70 page/width/theme pairs), the
  probe reports **0** console errors, and the smallest computed text is **12px**. On the documentation page at 360 the
  only target under 44 × 44 is the inline "Sign up" link in the Cloud card's sentence (the field is 44px high and the
  legend's row 48px). The worst text pair on the page is **5.61:1** in light and **6.57:1** in dark, both above AA.
- Print at A4 width and forced colours at 360: no overflow; the legend row keeps its rule in High Contrast
  (`rgb(0, 0, 159)`). The filter is not printed — a printed map has no field to type in, as it has no billing switch
  or copy buttons — so the band's printed preamble loses the field's 151.56px and begins with its name.

### What this pass deliberately left

- **The eleven cards are still cards.** Each is a place to start reading, and the rule keeps a surface for that; only
  their rank changed.
- **"Something missing?" stays 22px.** It is a title in a column, beside two buttons, exactly as the contact page's
  closing band is; making it a section head is a change to that shared shape, not to the map.
- **The notice that a title opens the document on GitHub** is still a notice between the filter and the cards (150px at
  360). It is the only thing that explains the paths to a reader with no script, so it stays where the cards begin.
- **The filter still needs the script.** Without one it is hidden (`hidden` in the markup), as before; the map is
  complete without it.
- **No capture was retaken**, and `site/ux/` was not edited.

## 2026-10-25, second pass: the estimate's total, the bar on a tablet, and the chips on paper

Measured with the same probe (Chrome 156, reduced motion, light unless said, touch at 320/360/390, a coarse pointer at
768 and 1440, and print at 794 for A4). The before column is the site as it stood at `a25d02d`, measured today before
any edit (and, for the print heights, from a second copy on a second port); no number is copied from an earlier pass.

### What changed

- **The figure pinned over the estimate is the ledger's own total.** The phone's sticky total over the calculator was
  the plan's *licence* price, so on the Community plan it read **"Community · Free"** while the ledger a screen below
  read **"Roughly $138 / month"** — the two figures on one screen disagreed by the reader's whole model bill. The
  pinned figure is now the ledger's total, and when that total is only model usage it says so:
  **"Community · $138 / month (model usage)"** at the default fields (1 project, 7 agents, 25 missions, Haiku, annual).
  It tracks every field: $276, $390 and $773 on the three other models at 25 missions, "$637 / month (annual)" on
  Business, and "Quoted, plus model usage" on Enterprise, always the same number as the ledger's last row. The pinned
  line is 46 → **72px** at 320/360/390 (it wraps to two lines), and the pricing page is 26px taller there
  (14,049 → **14,075** at 360, 15,049 → **15,075** at 320, 13,407 → **13,433** at 390); at 768 and 1440, where the
  pinned total is not shown (from 860 up), the page is unchanged.
- **The four sections of the bar are a thumb's height on a coarse pointer.** At 768 and up the nav is a row of
  **82×36, 75×36, 61×36 and 86×36** links: a mouse's row in a 44px bar, which is what the third pass measured, but a
  tablet's finger got 36px of the bar's 68. With a coarse pointer they are 44 tall at every width
  (**82×44, 75×44, 61×44, 86×44** at 768 and 1440); the bar stays 68, the header 69, and the page 10,931 at 768 and
  9,481 at 1440. A fine pointer keeps its 36px row, so nothing moves for a mouse.
- **The On this page row is laid out in print, not scrolled.** A printed page has no swipe: on the security page at
  A4 width the six chips took **1,245px in 794**, so "What to do about it" was cut at the paper's edge and "Assurance"
  and "Reporting a problem" did not print at all (three chips past the edge, 451px hidden). The chips now wrap in
  print: **1,245 → 794px**, no chip cut, the row **60 → 112px** tall and the printed page 7,443 → **7,495**. The
  pricing page's row (811 in 794, no chip cut) wraps too, 60 → 112 and 10,248 → **10,300**; the legal page's three
  chips still fit one row and it is unchanged at 3,066. Nothing of this is on screen.

### Measurements after this pass

| Page at 360 / 1440 | Before | After |
|---|---|---|
| Home | 13,550 / 12,282 | **13,550 / 12,282** |
| Pricing | 14,049 / 9,417 | **14,075 / 9,417** |
| Documentation | 8,746 / 4,455 | **8,746 / 4,455** |
| Security | 11,916 / 7,668 | **11,916 / 7,668** |
| Contact | 4,698 / 2,860 | **4,698 / 2,860** |
| Legal | 5,267 / 3,317 | **5,267 / 3,317** |
| 404 | 2,348 / 1,524 | **2,348 / 1,524** |

- The pricing page at 320 and 390: **15,075** and **13,433** (was 15,049 and 13,407); at 768 it is **10,931**,
  unchanged.
- The pinned total is 72px at 320/360/390 and 46 at 768 and 859; from 860 it is hidden, where the form and the result
  are side by side.
- No page scrolls sideways at 320, 360, 390, 768 or 1440 in either theme (**0** on all 70 page/width/theme pairs) and
  the probe reports **0** console errors. The smallest computed text is **12px** on every page. On a coarse pointer at
  320–768 the only targets under 44 × 44 are the 1 × 1 radios and the 24 × 24 checkbox whose label is 44.
- The worst text pair is **5.61:1** in light and **6.57:1** in dark, as before (AA normal text needs 4.5). Forced
  colours at 360: no overflow, the rate card and a plan's figures keep their ground (`rgb(0, 0, 0)`) under the cells,
  and no text under 12px. Without a script at 360: no overflow, the calculator and the filter are hidden, and every
  page's text is what it was.
- Print at 794: no page overflows (0 on all seven), and no chip of an On this page row is cut on the three pages that
  have one.

### What this pass deliberately left

- **The address row's Copy still moves its line when its word grows.** At 360 the button goes 62 → 76px for "Copied"
  and 105 for "Not copied", so the email re-wraps (205 → 194px) and the row jumps **169.4 → 179.8px** for the 2.2
  seconds the word is shown. The line has 280px for a 205px address and a 62px button; the design says the button says
  "Copied", and any word wider than 67px breaks the address. A shorter state word or a line that does not reflow is a
  change to that shared shape, not to this pass.
- **The pricing page's first plan amount is at y=950 at 360**, 150px below an 800px first screen (the third pass's 86px
  was before the two sections took the page's heading rank). Reclaiming it means moving the billing switch out of
  `#plans` or dropping the hint that says the row swipes — both change what the page opens with.
- **The pricing page's hint still promises "every line"** in the comparison, which has the price, the three limits, the
  usage export and support, but not the two Business lines the cards carry (container and Helm support with runbooks,
  and security questionnaire support). It is a sentence about what a table contains, and the wording is the owner's.
- **The security page's "At a glance" box is 1,098px at 360**, 342 of which is the Curule Cloud notice inside it;
  moving the caveat out of the box is a decision about what the box is, not a defect of the box's rules.
- **The security and legal pages' section heads stay 24/34** (`.split > header h2`) while the documentation and contact
  pages take 28/48: the fourth pass scoped the section rank to `.section > .wrap > h2.legend-title`, and a `.split`'s
  header is its own shape. That is a shared rule to settle, not a page to change on its own.
- **No capture was retaken**, and `site/ux/` was not edited.

## 2026-10-25, third pass: the bar names every section of its page

Measured with the same probe (Chrome 156 over CDP, reduced motion, light unless said, touch at 320/360/390). The before column
is the site at the commit this pass started from (`f77dcd2`), served from a second copy on a second port and measured today;
no number is copied from an earlier pass. "Reading" below is the script's own rule: the last section whose top has passed the
line a third of the way down the window, over **every** section of the page; "the bar says" is that same rule over the
sections the bar has a chip for.

### What changed

- **The bar has a chip for every section of its page.** The page's promise is "a row of chips, one for each section", and the
  script marks the last chipped section whose top has passed the line. Two sections had been added to pages after their bar was
  written and never given a chip: the pricing page's **"Do you run it, or do we?"** (the two ways in, `12a3178`) and the
  security page's **"At a glance"** box (`3ec4379`). On the pricing page that is not a blank but a wrong answer: while the
  reader is in the band that asks who runs it, the bar marked **"The plans"** — for the whole band, which is
  **1,309px at 360** (1,381 at 320, 1,207 at 390, 796 at 768, 752 at 1440). The chips are **"Who runs it"**, the home page's
  own name for the same section, and **"At a glance"**, the box's own title. The bar is one row at every width and its height
  does not change, so nothing below it moves.
- **The pricing chip is hidden with the section it names.** `#ways` is `data-cloud-only`: while Curule Cloud is closed the
  pricing page starts at the plans, so a chip to that section would go nowhere. The chip is a `<li data-cloud-only>`, and the
  shared switch (`scripts/site-cloud-state.mjs`, and `assets/site.js` in the browser) hides the two together. The other pages'
  chips are unchanged.
- **A test holds the bar to the page.** The existing test pinned each chip to a section; it now also pins the pair's state
  (a chip to a section the Curule Cloud switch hides is hidden by the same switch), and a new one walks each page's `<main>`
  and fails unless **each section that carries an h2 has exactly one chip, in the page's order** — the assertion that would
  have caught both omissions. Breaking either (removing the chip, or removing its `data-cloud-only`) fails it.

### Measurements after this pass

| Page, scroll positions where the bar disagrees with the section being read | Before | After |
|---|---|---|
| Pricing at 320 | 1,380px of 14,275 (9.7%) | **0** |
| Pricing at 360 | 1,300px of 13,230 (9.8%) | **0** |
| Pricing at 390 | 1,210px of 12,608 (9.6%) | **0** |
| Pricing at 768 | 800px of 9,987 (8.0%) | **0** |
| Pricing at 1440 | 750px of 8,493 (8.8%) | **0** |
| Security at 320 | 1,270px of 11,999 (10.6%) | **0** |
| Security at 360 | 1,070px of 11,044 (9.7%) | **0** |
| Security at 390 | 980px of 10,305 (9.5%) | **0** |
| Security at 768 | 620px of 7,427 (8.3%) | **0** |
| Security at 1440 | 440px of 6,720 (6.5%) | **0** |
| Legal (3 sections, 3 chips — the control) | 0 | **0** |

- The band the bar lied about is the one it names now: the pricing page's "Do you run it, or do we?" is **1,309px at 360** and
  the security page's "At a glance" is **1,074px** (1,264 at 320, 978 at 390, 620 at 768, 434 at 1440); the pricing band was
  marked "The plans", the security one was marked by nothing at all.
- Every chip takes a reader to its section and marks itself: following each of the **7 + 7 + 3** chips at 320, 360 and 768
  lands the section's top at **150** (the 69 header and the 61 bar) and marks the chip. The pricing page's new chip lands at
  **y = 2,087** at 360 and 1,957 at 1440; the security one at **419** and 418.
- What the chips cost: the pricing row is **775 → 908px** wide at 320/360/390 and **804 → 938** at 768, and still fits at
  1440; the security row is **1,203 → 1,333**, **1,232 → 1,363** at 768 and **1,491 → 1,621** at 1440, where it scrolled
  a little before and scrolls a little more now. The bar stays **61px** and the row **60px** at every width, and no page
  changes height: pricing **15,075 / 14,030 / 13,408 / 10,887 / 9,393**, security **12,799 / 11,844 / 11,105 / 8,327 /
  7,620**, legal **5,793 / 5,267 / 4,943 / 3,863 / 3,317** at 320/360/390/768/1440.
- Print at 794 is unchanged: the pricing row is **806 → 940px** unwrapped and the security row **1,234 → 1,365**, both wrap
  to **2 lines**, the row is **112px**, and the printed pages stay **10,300** and **7,471**.
- Nothing else moved: no page scrolls sideways at 320/360/390/768/1440 in either theme (**0** on all 70 page/width/theme
  pairs), **0** console errors, **0** axe-core violations, the smallest text is **12px**, the chips are **44px** tall and no
  target under 44 × 44 is new. Without a script the bar is the same row of plain links with nothing marked; in forced colours
  the marked chip takes LinkText and its dot stays; with Curule Cloud closed the pricing chip is hidden (`[data-cloud-only]`),
  as the shared switch's test pins.

### What this pass deliberately left

- **The row still scrolls in silence where the chips do not fit** (the security page's seven are 1,365px in a 768px row and
  1,621 in 1,440). The script reveals the chip being read, so the reader is never without the current one; a fade at the
  row's edge still needs a class the script sets, as the last pass said.
- **The pricing page's first plan amount is still at y = 950 at 360**, and its hint still says "every line"; both are the
  pricing page's opening, left as the last pass left them.
- **The security page's At a glance box is still 1,074px at 360**; only its chip is new.
- **No capture was retaken**, and `site/ux/` was not edited.

## 2026-10-25, fourth pass: the chip the keyboard can read, and one sentence from the estimate

Measured with the same probe (Chrome 156 over CDP, reduced motion, light unless said, touch at 320/360/390, a coarse
pointer at 768 and 1440, print at 794 for A4). The before column is the site at `16afb3e`, extracted again and served on
a second port and measured today; no number is copied from an earlier pass.

### What changed

- **A chip that takes the keyboard's focus is brought wholly into the row.** The browser scrolls a focused element only
  until some part of it is visible, so at 360 the security page's third chip — "What leaves your environment", 280px wide
  in the DPR1 measurement (277.11px in the DPR2 capture) — stayed with **41 of its 280px** in the row, its name cut
  mid-word, and at 320 with **1 of 280px**. The row now listens for `focusin` and uses the same 24px reveal as the mark:
  at 360 the chip is **280 / 280** with the row at `scrollLeft 263` (in the DPR2 capture, 277.11 / 277.11 at 259); at 320
  **280 / 280** (303); at 390 **280 / 280** (233). On the security page at 768 the fourth chip is **192 / 192** (70, was
  146.28 of 192), the pricing page's "Licences" at 768 is **102 / 102** (46, was 80.28) and the legal page's "Terms" at
  320 is **82 / 82** (26, was 72). A chip already wholly in view moves nothing, and focusing the same chip again moves
  nothing.
- **The estimate is one sentence to a screen reader, not the ledger on every keystroke.** The result was a
  `aria-live="polite"` region of **504 characters** at the default fields, and every input cleared and rebuilt it
  (seven child-list mutations). The result is no longer a live region; a 46-character `#calc-said` (`role="status"`)
  is updated **400ms after the last change**: "Community: $138 a month, including model usage" at the default, "Team:
  $262 a month, billed annually" on Team, "Enterprise: quoted, plus model usage" on Enterprise. The ledger still
  updates at once for a sighted reader, and the pinned total is the same figure as before.
- **The two hints are the fields' descriptions.** The pricing calculator's "A project is one team's mesh…" and "A
  mission like the one we measured…" were visible only: the fields' descriptions in the accessibility tree were
  **null**. The inputs now name them with `aria-describedby`, and the descriptions are **95** and **73 characters**.
  The seats field has no visible hint and is unchanged.
- **A number out of range says what the estimate used.** With 0 in "Projects open at the same time" the field was
  invalid in the browser, but the estimate replaced it with 1 in silence: no message, no `aria-invalid`, and the ledger
  read **$138 / month** as if nothing had happened. The field now takes `aria-invalid="true"` and a 20px `role="alert"`
  line: **"Enter 1 or more. The estimate uses 1."** A fraction says "Enter a whole number. The estimate uses 2.", 1001
  says "Enter 1,000 or less. The estimate uses 1,000.", and 100,001 missions says "Enter 100,000 or less. The estimate
  uses 100,000." The line is 14px in the refusal colour, **6.35:1** in light and **6.66:1** in dark, and it adds 26px
  only while it is shown (pricing **14,075 → 14,101** at 360, 15,075 → 15,101 at 320, 10,931 → 10,958 at 768,
  9,417 → 9,443 at 1440). The default page is unchanged.

### Measurements after this pass

| Page at 320 / 360 / 390 / 768 / 1440 | Before | After |
|---|---|---|
| Home | 14,258 / 13,550 / 12,948 / 13,172 / 12,282 | **14,258 / 13,550 / 12,948 / 13,172 / 12,282** |
| Pricing | 15,075 / 14,075 / 13,433 / 10,931 / 9,417 | **15,075 / 14,075 / 13,433 / 10,931 / 9,417** |
| Documentation | 9,356 / 8,746 / 8,426 / 5,770 / 4,455 | **9,356 / 8,746 / 8,426 / 5,770 / 4,455** |
| Security | 12,823 / 11,916 / 11,178 / 8,331 / 7,668 | **12,823 / 11,916 / 11,178 / 8,331 / 7,668** |
| Contact | 4,996 / 4,698 / 4,490 / 3,883 / 2,860 | **4,996 / 4,698 / 4,490 / 3,883 / 2,860** |
| Legal | 5,741 / 5,267 / 4,941 / 3,863 / 3,317 | **5,741 / 5,267 / 4,941 / 3,863 / 3,317** |
| 404 | 2,443 / 2,348 / 2,301 / 1,915 / 1,524 | **2,443 / 2,348 / 2,301 / 1,915 / 1,524** |

- The On this page row is **1,344px** wide on the security page at 360 (984px hidden) and 913 on pricing (553 hidden);
  the focus reveal only changes where the row is while a chip has the keyboard, not its width or the page height.
- The estimate's error state adds one 20px line under the field; with all three fields invalid the pricing page is
  14,174 at 360 and 15,194 at 320, still with no horizontal overflow.
- No page scrolls sideways at 320, 360, 390, 768 or 1440 in either theme (**0** on all 70 page/width/theme pairs), the
  probe reports **0** console errors, **0** axe-core violations (also with the three error lines shown, at 320/360/768/
  1440 in both schemes), the smallest computed text is **12px**, and the target census is the same **116 entries** across
  320/360/390 and both schemes (the inline links in sentences and the 1×1 radios whose labels are 44).
- Print at A4 is **0** over on all seven pages, with the error shown it is 10,326 on pricing (10,300 without) and the
  message prints under its field. Without a script the form and the filter are hidden as before (pricing 12,836 at 360)
  and the errors are inside the hidden form. With `forcedColors: active` the error is CanvasText, the rate card keeps its
  ground, and the page is 0 over.

### What this pass deliberately left

- **The row still scrolls in silence where the chips do not fit.** The keyboard now brings its chip wholly into view,
  but a finger sees only the cut word at the row's edge; a fade needs a class the script sets when the row overflows, as
  the last pass said. This pass is the keyboard, not the touch.
- **The Annual/Monthly switch is 6,884px above the estimate at 360** (the switch ends at 777.27, the first field starts
  at 7,661.2). The estimate names its period in the fee row and the pinned total, and a second segmented control would be
  two controls for one fact; a period shortcut in the estimate is a product decision, not a repair.
- **The contact page's Copy still moves its line when the word grows** — 169.38 → 179.75px for "Copied" — as the
  previous pass recorded. The button's width is the word's, and the email re-wraps for 2.2 seconds.
- **The pricing comparison still stacks below 720**, the first plan amount is still at y=950 at 360, and the docs page
  still has no On this page bar. None of these changed.
- `site/ux/` was not edited.

## 2026-10-26: the copy button says what it did, and the filter's empty answer is spoken

Measured with the same probe (Chrome for Testing 156 over CDP, reduced motion, light unless said, touch at 320/360/390, a
mouse at 768 and 1440, print at 794 for A4, both schemes for the interactive states). The before column is the site at
`feb4968`, extracted to a second folder and served on a second port, and measured in the same run; no number is copied from
an earlier pass.

### What changed

- **A copy button's accessible name follows the word it shows.** The name was `Copy the sales address` (or `Copy these
  commands`) in every state, so when the button said "Copied" or "Not copied" the visible label was not inside the name:
  axe's `label-content-name-mismatch` (WCAG 2.5.3, Label in Name) reported **1 node** in each of the four states (the
  contact page and a code block, success and refusal). `copyName()` now derives the name from the state — `Copy the sales
  address`, `Copied: the sales address`, `Not copied: the sales address`, and `Copied: these commands` / `Not copied: these
  commands` — and the axe census of the six interactive states at 320/360/768/1440 in both schemes is **0 violations**.
- **The address line keeps its line while the button's word changes.** At 360 the address line was one line at rest (205 ×
  44) and the button 62; "Copied" made the button 76, the address **194 × 54.4** and its row **169.4 → 179.8** for the 2.2
  seconds the word was shown, pushing the Support row down 10.4px. The refusal did the same at 390 (169.4 → 179.8, the
  address 205 → 195 and onto a second line). The button now keeps one width (**76px**, the width of its success word
  "Copied"), and "Not copied" wraps inside it; at 420 and below the row gives it the room (padding-inline 16, gap 4). At
  360 the row is **169.4 → 169.4** and the address **205 × 44 → 205 × 44**; at 390 the same; at 320 the row is 179.8 in
  both states and the address 174 wide in both (it was 168 at rest and 154 when copied). The content of a 360px row starts
  8px further left (41 → 33), in line with its own padding.
- **A refusal says where to look on the page.** The only visible answer to a refused copy was the button's "Not copied";
  the 63-character instruction was in the 1 × 1 clipped live region, so a sighted reader was told that it failed and not
  what to do. The script now makes a visible `p.copy-note` — under the address (294 × 40.6 at 360, 369 × 40.6 at 768, in the
  address column) and at the end of a code block — with the same sentence the live region says: "The browser did not allow
  copying. Select the text and copy it." It appears only on a refusal, stays until the next attempt, and goes on a success.
  The row is 222 at 360 while it is shown (the answer is a line, not a jump to hide); a code block is 121.6 → 206.8 at 360
  (three lines of note at its end).
- **The filter's empty answer is spoken.** With nothing matching, the only live region said "0 of 16 documents" (17
  characters); the empty box's 125 characters — the words typed, and `Clear the filter` — were outside every live region, so
  a screen reader never heard them. `#doc-filter-count` is now the visible count only, and a `.sr` `#doc-filter-announce`
  (`role="status"`) says the whole answer, 102 characters: `No document matches “kubernetes operator”. 0 of 16 documents.
  Clear the filter, below, shows them all.` A normal filter announces "7 of 16 documents", and clearing "All 16 documents",
  exactly once (the count is not a second live region).
- **The tests hold each rule.** `copyName` is a pure export and the test checks the visible word is inside the name for
  every state; the click test checks the `aria-label` after a success and a refusal; a new test checks the note is a sibling
  after the address (and inside the code block), hidden until a refusal, shown then, and that its text is the live region's;
  the docs test checks the no-match sentence names the query and the Clear, that the count has no `role`, and that there is
  one live region. Breaking each rule fails it: removing the `aria-label` update fails 2 tests, the width 62 fails the copy
  and address-line tests, dropping the query fails the empty-state test, and always hiding the note fails the refusal test.

### Measurements after this pass

| Page, height at 320 / 360 / 390 / 768 / 1440 | Before | After |
|---|---|---|
| Home | 14,258 / 13,550 / 12,948 / 13,156 / 12,282 | **14,258 / 13,550 / 12,948 / 13,156 / 12,282** |
| Pricing | 15,075 / 14,075 / 13,433 / 10,911 / 9,417 | **15,075 / 14,075 / 13,433 / 10,911 / 9,417** |
| Documentation | 9,356 / 8,746 / 8,426 / 5,766 / 4,455 | **9,356 / 8,746 / 8,426 / 5,766 / 4,455** |
| Security | 12,823 / 11,916 / 11,178 / 8,327 / 7,668 | **12,823 / 11,916 / 11,178 / 8,327 / 7,668** |
| Contact | 4,996 / 4,698 / 4,490 / 3,883 / 2,860 | **4,996 / 4,698 / 4,490 / 3,883 / 2,860** |
| Legal | 5,741 / 5,267 / 4,941 / 3,863 / 3,317 | **5,741 / 5,267 / 4,941 / 3,863 / 3,317** |
| 404 | 2,443 / 2,348 / 2,301 / 1,911 / 1,524 | **2,443 / 2,348 / 2,301 / 1,911 / 1,524** |

| The contact page's first address row at 360 | Before | After |
|---|---|---|
| Address, at rest → after Copy | 205 × 44 → **194 × 54.4** (two lines) | 205 × 44 → **205 × 44** |
| Row, at rest → after Copy | **169.4 → 179.8** (+10.4) | **169.4 → 169.4** |
| Address and row, after a refusal | 165 × 54.4, row **179.8** | 205 × 44, row **222** with a 294 × 40.6 note |
| Button, at rest → Copied → Not copied | 62 → 76 → 105 | **76 → 76 → 76** (the refusal wraps: 26 + 48px lines) |
| axe, `label-content-name-mismatch`, Copied / refusal | **1 / 1** | **0 / 0** |

- At 390 the Copy is unchanged (the row was already 169.4); the refusal was **169.4 → 179.8** and is now **169.4 → 222**
  with the note. At 320 the Copy row is 179.8 → 179.8; the refusal is 179.8 → 232.3 with a 254 × 40.6 note. At 768 the
  button is 76 (was 62) and the row stays 119.4; the note sits in the address column (369 × 40.6).
- The six interactive states (contact Copied, contact refused, a code block Copied, a code block refused, docs no match,
  docs with results) at 320/360/768/1440 in light and dark: **0 axe violations, 0 horizontal overflow** (48 contexts).
- The 70 default page/width/theme pairs are unchanged: **0** horizontal page scroll, **0** axe WCAG 2.1 AA violations,
  **0** console errors, smallest text **12px**.
- Without a script: every page renders as before (home 13,549 at 360, contact 4,697, docs 8,681, pricing 12,836 with its
  calculator notice), no page overflows. With `forcedColors: active` at 360: no overflow, smallest text 12px. Print at 794:
  home 12,346; pricing 10,300; docs 4,690; security 7,495; contact 3,084; legal 3,066; 404 1,123 — unchanged, and a
  refusal note is not printed, like the copy buttons it belongs to.
- The default copy button is a 44px target on a coarse pointer, as before; the note is text, not a control.

### What this pass deliberately left

- **A refusal's note adds height while it is shown.** 40.6px at 360 and 390 (the row 169.4 → 222), 52.5px at 320, and
  85.2px in a code block (121.6 → 206.8), because the answer takes two or three lines at a phone's width. That is the answer
  being read, not a jump to hide; putting it in the code block's 48px header would cover the "Terminal" label and the button.
- **"Not copied" is two lines inside the 76px button** (26px and 48px at 13px/1.15). One line is 105px, which is what the
  address had to give up before; the word is whole, and the accessible name is still "Not copied: the sales address".
- **At 350 and below the address is two lines in every state** (205px of address and a 76px button do not fit 284px). It
  already was at 320; the row is now stable there instead of changing shape with the button's word.
- **The filter's live sentence still waits 400ms after the last keystroke**, as the count did, so a fast typist hears one
  answer and not one per character.
- **The On this page row still scrolls in silence where the chips do not fit**, the pricing page's first plan amount is
  still at y=950 at 360, and the docs page still has no On this page bar; none of these changed.
- `site/ux/` and the captures were not touched.

## 2026-10-26, second pass: the map's own index, the row's edge, and the page you are on

Measured with the same probe (Chrome for Testing 156 over CDP; reduced motion; light unless said; touch at 320/360/390; a
mouse at 768 and 1,440; print at 794; forced colours at 360). The before column is the site at `6102779`, served from this
worktree before the edits and measured today; no number is copied from an earlier pass.

### What changed

- **The documentation page has the On this page row the other long pages have.** The page is **8,722px at 360** and the map
  of documents alone is **4,991px** of it (57%); its closing band, "Something missing?", began at **7,258** with no way to it
  but the scroll. The heading now carries `has-toc` and a 61px row with three chips — **Start here**, **The documents**,
  **Something missing** — and the closing band has the `id="missing"` its chip points at. At 360 the row is at **423–484**;
  `#start` moves **432 → 484**, the filter **2,360 → 2,412**, the first document card **2,820 → 2,872**, and the closing band
  **7,258 → 7,311**. Each chip lands its section at **150**, the header and the row and the 20px under them. The page is
  **52px** taller at 320/360/390, 49 at 768 and 40 at 1,440.
- **The On this page row shadows the edge that has more.** At 360 the pricing row's seven chips are **908px in 360** (548
  hidden), the security row's **1,333px** (973 hidden), and at 1,440 the security row still has **1,621px in 1,440** (181
  hidden). Before, the third chip was cut mid-word and nothing said the row went on. The script reads the row's own
  `scrollWidth`, `clientWidth` and `scrollLeft` (`tocEdges`) and sets `is-more` and `is-back` on the bar; a 28px shadow in the
  site's own `--edge` is drawn at the edge that has more, both edges in the middle, and only the left at the end. Measured at
  360: pricing `is-more` at `scrollLeft` 0, both at 274, `is-back` at 548; security 0 / 487 / 973; the documentation row
  0 / 71 / 142; at 1,440 security 0 / 91 / 181, and the documentation row fits with neither class. The bar stays **61px** and
  the shadow takes no room. A forced-colour mode draws a 2px `CanvasText` line instead (a 28px gradient of the system's ink
  was a black band over the last chip), and print draws no edge at all.
- **At a 150% user text size the pricing page was 29px wider than a 360px viewport.** The figure pinned over the estimate was
  `white-space: nowrap`: at a 24px root it was one **358.4px** line in a 300px line, so the pricing page was **389px wide on
  a 360 screen** (29 over) and **389 on a 320 one** (69 over). The figure now wraps (`white-space: normal; text-align:
  right`): it is **298px** at 360 and **258** at 320, the page is **360** and **320** with **0px over** on all seven pages,
  and the pinned total is **96 → 132px** at 360 (two lines), the page **22,986 → 23,022** (320: **25,276 → 25,312**).
- **The page you are on is marked by a line as well as a tint.** With `forcedColors: active` at 768 the header's current link
  measured `background rgb(255, 255, 255)` (Canvas) and `color rgb(0, 0, 159)` (LinkText) on the white page, the same as the
  three links beside it, and `text-decoration: none`: the current page was not visibly marked. The current link — in the
  header nav, the phone menu (which holds the same link at 360) and the footer — now takes an underline (1.5px,
  `text-underline-offset: .22em`); measured at 768 the current pill is **72.88 × 36** with the line, and in forced colours
  `text-decoration-line` is `underline`. No page changes height.

### Measurements after this pass

| Page, height at 320 / 360 / 390 / 768 / 1440 | Before | After |
|---|---|---|
| Home | 14,285 / 13,526 / 12,999 / 13,156 / 12,258 | **14,285 / 13,526 / 12,999 / 13,156 / 12,258** |
| Pricing | 15,075 / 14,030 / 13,408 / 10,887 / 9,393 | **15,075 / 14,030 / 13,408 / 10,887 / 9,393** |
| Documentation | 9,310 / 8,722 / 8,444 / 5,790 / 4,473 | **9,362 / 8,774 / 8,496 / 5,839 / 4,513** |
| Security | 12,799 / 11,844 / 11,105 / 8,327 / 7,620 | **12,799 / 11,844 / 11,105 / 8,327 / 7,620** |
| Contact | 4,948 / 4,698 / 4,490 / 3,883 / 2,860 | **4,948 / 4,698 / 4,490 / 3,883 / 2,860** |
| Legal | 5,793 / 5,267 / 4,943 / 3,863 / 3,317 | **5,793 / 5,267 / 4,943 / 3,863 / 3,317** |
| 404 | 2,443 / 2,348 / 2,301 / 1,911 / 1,524 | **2,443 / 2,348 / 2,301 / 1,911 / 1,524** |

| The documentation page at 360 | Before | After |
|---|---|---|
| The page | 8,722 | **8,774** |
| Its heading | 69–432 | **69–423** |
| On this page row | none | **423–484** (61px, 3 chips) |
| `#start` | 432 | **484** |
| The filter | 2,360 | **2,412** |
| The first document card | 2,820 | **2,872** |
| The closing band | 7,258 | **7,311** |
| The row's width | — | **502px in 360**; the third chip 184.95px with 59px visible |

| The On this page row at 360 | Before | After |
|---|---|---|
| Pricing | 908 in 360, no cue | **`is-more` at 0, both at 274, `is-back` at 548** |
| Security | 1,333 in 360, no cue | **`is-more` at 0, both at 487, `is-back` at 973** |
| Documentation | — (no row) | **`is-more` at 0, both at 71, `is-back` at 142** |
| Security at 1,440 | 1,621 in 1,440, no cue | **`is-more` at 0, both at 91, `is-back` at 181** |
| Documentation at 1,440 | — | **502px of chips in 1,440; no class** |

| Pricing at a 24px root | Before | After |
|---|---|---|
| The page at 360 | **389px wide** (29 over) | **360** |
| The page at 320 | **389px wide** (69 over) | **320** |
| The pinned figure at 360 / 320 | **358.4 / 358.4** | **298 / 258** |
| The pinned total | **96px** | **132px** |
| The page at 360 / 320 | **22,986 / 25,276** | **23,022 / 25,312** |

| The current page | Before | After |
|---|---|---|
| Forced colours, 768: the nav's current link | Canvas fill, LinkText, no line | **1.5px underline** |
| Forced colours, 768: the other three links | LinkText, no line | unchanged |
| Normal, 768: the current pill | tint only | **72.88 × 36, tint and line** |

- No page scrolls sideways at 320, 360, 390, 768 or 1,440 in light or dark (**0** on all 70 page/width/theme pairs), and the
  probe reports **0** console errors. **0 axe-core violations** on the seven default views and on the eight interactive
  states (docs empty and matching filter, legend open, phone menu open, calculator error, Monthly, the row at its end, a
  copied address). The smallest computed text is **12px** on every page; the new chips are 44px tall.
- At a 24px user default every page is **0px over** at 320 and 360 (before, pricing was 389 at both). At 720 (the 200% zoom
  stand-in) every page is **0px over**. Print at 794: every page **0px over**; the documentation page is **4,761px** with
  its row (the row's three chips fit one line; the edge shadow is not printed).
- Without a script the documentation page is **8,685px** at 360 with its three chips as plain links and its filter hidden,
  and no page overflows; the current page's underline is CSS, and the row has no shadow (that is the script's).
- With `forcedColors: active` at 360 every page is 0px over and the smallest text is 12px; the current page is underlined,
  and the row's edge is a 2px line while it has more.

### What this pass deliberately left

- **The documentation row cuts its third chip at 360** (502px in 360; 142 hidden) and the shadow is the only cue that it
  goes on. A shorter chip or a chevron would name the closing band in full; the row is the same one-line shape as the other
  pages' and stays 61px.
- **The documentation page is 52px taller at a phone for its row.** The row names the map and the closing band; the
  alternative is the 7,000px of scroll the page had before.
- **The cue is the script's.** Without one, the row is plain links in one scrolled row: the chips and the cut third chip are
  there, but the edge shadow, like the pinned bar itself, is progressive.
- **The pricing page's opening is unchanged**: its first plan amount is still at y=950 at 360, and the comparison still
  stacks below 720. The billing switch and the section head are where the last pass left them.
- **The pinned figure wraps only where it must.** At normal text the total is 72px as it was; at a 24px root it is two lines
  and 132px, 36px more, which is the cost of not widening the page.
- **The current-page line is in the footer too.** The footer's current page was a weight and a colour; it is now underlined
  as well, and no page height moves.

## 2026-10-26, third pass: the way home is on the first screen, and a section head is the page's rank

Measured with the same probe (Chrome 156 in the pass container, where `system-ui` resolves to Noto Sans; the absolute page
heights are therefore 3–4% below the record's, which were taken where it resolves to a wider system font. The before and after
below are the same browser, the same run, so the differences stand: reduced motion, light unless said, touch at 320/360/390, a
mouse at 768 and 1,440, print at 794, forced colours at 360). The before column is the worktree at `a05ea58` before any edit,
measured in the same run; no number is copied from an earlier pass.

### What changed

- **A page that is not here offers the way home on the first screen.** The 404 page's one obvious action sat after the six ways:
  at 360 the button was at **y=1,194.8**, 395px below an 800px screen, and the screen ended in the third way with no way home on
  it (the header's wordmark is a link, but it does not say so). It is now under "That page is not here." at **y=341.6** (320:
  341.6, 1,440: 385.4, was 1,244.6 and 880.2), and the six ways begin at **521.2** (were 445.2; 320: 471 → 547, 1,440: 471.4 →
  543.4). The first screen at 360 holds the button and two of the six ways; before it held three ways, the third cut by the
  screen, and the button was 395px below it. The page is 2,300px at 360 in both. The sentence that introduces the ways is still
  the sentence immediately before them; the button stands between it and the h1, which is the design's "six named ways back,
  home first". `site-copy.test.ts` now fails if the button is after the list.

- **A section head takes the page's rank in a split too.** The security page's six sections and the legal page's three were
  `h2` at **24px** at 360 and **34px** at 1,440, while the documentation page's and the contact page's section heads were
  **28 and 48**: the same kind of head was two steps down on two pages, and at 360 only 5px above a card's title. The split's
  head now takes the page's rank: **24 → 28px at 360** (a one-line head 25.9 → 30.2px, the two-line "What leaves your
  environment" 51.8 → 60.5) and **34 → 48px at 1,440** (the legal page's "The licence, in plain words" 36.7 → 103.7, two
  lines). Every `h2` in a section is now 28 at 360 and 48 at 1,440; the only smaller ones are the three titles inside a
  column or a box — "Something missing?" (22), "At a glance" (22) and "What we can help with" (22). The security page is
  **11,100 → 11,082px** at 360 (the summary's −48 below more than pays for the larger heads) and the legal page **4,965 →
  5,008**; at 768 they are 8,162 → 8,206 and 3,865 → 3,887, and at 1,440 neither page changes height: a split's header is a
  column beside the content, whose height sets the section, so the bigger head is room the column already had.

- **The summary's answers use the box's width.** The three answers in the security page's At a glance box were a 40px mark
  plus a 222px column of words at 360 (182px at 320), so two of the three ran a line longer than the words needed and all
  three did at 320. The mark and its title now share the first row and the paragraph runs under both: **222 → 278px** at 360
  and **182 → 238px** at 320 (at 1,440, 282/253/253 → 338/309/309). The answers' heights at 360 are **96/144/120 → 96/120/96**
  (two lines fewer in all; the first was already four), at 320 **120/192/144 → 96/144/120** (four lines fewer, two of them
  in the second); the list is 566 → 518 at 360 (662 → 566 at 320), the box **977.9 → 929.9** (1,169.9 → 1,073.9), and the
  first section below it 1,520.4 → 1,472.4 (1,737.6 → 1,641.6). At 768 the box is 572 in both and at 1,440 388 in both,
  because the tallest answer sets those rows; what changes there is the measure, not the height.

- **The map's explanation is a ruled note, not a notice panel.** The paragraph saying that each title opens the document on
  GitHub and the path under it is its place in the repository was a `.notice` box with an icon: **150px** between the filter
  and the first card at 360 (174px at 320), five lines of 15px in a panel. It is now a ruled line of 14px muted words with the
  bold lead (**78.1px** at 360, 99.8 at 320); its words are unchanged. The first document card is **2,734.4 → 2,662.5** at
  360 (2,995.4 → 2,921.2 at 320), and the page **8,474 → 8,402** (9,109 → 9,035; at 768 −21 and at 1,440 −19). The no-script
  notice below it stays a notice: that one is a warning, and this one was an explanation in a warning's clothes.

- **A footer link is a thumb's square across.** "Terms" was **43.2 × 44** at 320 and 360: its own word at 15px in the system
  font, a pixel under the rule, and the last standalone target under 44 on the seven pages at those widths. The footer's links
  now keep a **44px** minimum width ("Terms" is 44 × 44; every other link is already wider); the only control under 44 at
  320/360 is the 24 × 24 usage-reports checkbox, whose label is the 44px target. At 1,440 the links are 44 × 36, a mouse's
  row, as before.

### Measurements after this pass

| Page, height at 320 / 360 / 390 / 768 / 1440 | Before | After |
|---|---|---|
| Home | 13,791 / 12,991 / 12,517 / 12,905 / 12,016 | unchanged |
| Pricing | 14,444 / 13,485 / 12,927 / 10,766 / 9,142 | unchanged |
| Documentation | 9,109 / 8,474 / 8,250 / 5,667 / 4,465 | **9,035 / 8,402 / 8,202 / 5,646 / 4,446** |
| Security | 12,298 / 11,100 / 10,569 / 8,162 / 7,450 | **12,233 / 11,082 / 10,577 / 8,206 / 7,450** |
| Contact | 4,749 / 4,459 / 4,334 / 3,883 / 2,836 | unchanged |
| Legal | 5,542 / 4,965 / 4,764 / 3,865 / 3,266 | **5,559 / 5,008 / 4,777 / 3,887 / 3,266** |
| 404 | 2,419 / 2,300 / 2,277 / 1,915 / 1,524 | unchanged |

| The 404 at 360 | Before | After |
|---|---|---|
| The way home | **y = 1,194.8**, after the six ways | **y = 341.6** |
| The first way | y = 445.2 | **y = 521.2** |
| The first screen (800) | three ways, the third cut; no way home | **the way home and two ways** |
| The page | 2,300 | 2,300 |

| The section heads at 360 / 1,440 | Before | After |
|---|---|---|
| Six on the security page | 24 / 34 | **28 / 48** |
| Three on the legal page | 24 / 34 | **28 / 48** |
| Every `h2` in a section | 28 / 48 on four pages, 24 / 34 on two | **28 / 48 on all six** |
| A title in a column or a box | 22 | 22 (three: the docs band, the glance, the contact band) |
| Security page height, 360 / 768 | 11,100 / 8,162 | **11,082 / 8,206** |
| Legal page height, 360 / 768 | 4,965 / 3,865 | **5,008 / 3,887** |

| The At a glance box | 320 | 360 | 1,440 |
|---|---|---|---|
| An answer's words, before → after | 182 → **238** | 222 → **278** | 282/253/253 → **338/309/309** |
| The three answers' heights | 120/192/144 → **96/144/120** | 96/144/120 → **96/120/96** | 96/120/120 → **72/120/96** |
| The list | 662 → **566** | 566 → **518** | 168 both |
| The box | 1,169.9 → **1,073.9** | 977.9 → **929.9** | 388 both |
| The first section | 1,737.6 → **1,641.6** | 1,520.4 → **1,472.4** | 955.2 both |

| The map's note | 320 | 360 | 1,440 |
|---|---|---|---|
| The note | 174 → **99.8** | 150 → **78.1** | 54 → **34.7** |
| The first document card | 2,995.4 → **2,921.2** | 2,734.4 → **2,662.5** | 1,698.5 → **1,679.2** |
| The page | 9,109 → **9,035** | 8,474 → **8,402** | 4,465 → **4,446** |

- The 404's way home at 1,440 is **385.4** (was 880.2), and the six ways **543.4** (were 471.4); at 768 the button is 335.7
  (was 826.6) and the ways begin at 493.8 (were 417.8). The button is 180 × 44 at 320/360 and 180 × 40 at 1,440, a mouse's row.
- The footer's "Terms" is **43.2 × 44 → 44 × 44** at 320 and 360, and 43.2 × 36 → 44 × 36 at 1,440 (where a fine pointer
  keeps its 36px rows). The only remaining target under 44 at 320/360 is the pricing page's 24 × 24 checkbox, whose label is
  44 (unchanged).
- No page scrolls sideways at 320, 360, 390, 768 or 1,440 in either theme (**0** on all 70 page/width/theme pairs), the probe
  reports **0** console errors, and **0** axe-core violations on the seven pages at 320 dark, 360 light, 768 light and 1,440
  dark. The smallest computed text is **12px** on every page, and the worst text pair is **5.61:1** in light and **6.57:1** in
  dark (AA normal text needs 4.5).
- Print at 794: every page **0px over** (home 12,060; pricing 10,062; docs 4,660; security 7,420; contact 3,084; legal 3,090;
  404 1,103); the note prints and the 404's button prints where it now stands. With `forcedColors: active` at 360 every page
  is 0px over; without a script every page is 0px over and the filter and calculator are hidden; at a 24px root every page is
  **0px over** at 320, 360 and 720.
- `tests/build/site.test.ts` holds the rank (the split's rule and the section rank state the same clamp), the glance's
  full-width answer, the map's note, and the footer's 44px; `site-copy.test.ts` holds the 404's way home before the ways. The
  site's own suites — the `site*` files with docs-links, product-name and no-mojibake — are **147** tests, all passing.

### What this pass deliberately left

- **The pricing page's first plan amount is still at y=950 at 360**, 150px below an 800px first screen. The page head's lede
  (five lines), the plans section's own head, its swipe hint and the billing switch own that 150px; the only ways to take it
  back are to shorten the lede or move the switch below the cards, and both change what the page opens with. It is the next
  pass's first job, as it was the last four passes'.
- **The legal page's `TODO(owner)` is still published**, so `npm run site:check` still exits 1 at `site/legal/index.html:133`.
  The terms are the owner's and counsel's, not a sentence to invent.
- **The security page's Cloud caveat stays in the At a glance box.** Moving it under the box would save about 44px of the
  section and let the box be the three answers alone, but `site-copy.test.ts` says the box says it, and the caveat is about
  the answers it qualifies; that is a change to what the box is, and the owner's.
- **The documentation row still cuts its third chip at 360** (502px of chips in 360); its labels are the sections' own names,
  and the row's edge shadow is the cue that it goes on. A shorter chip would name "Something missing" less exactly.
- **The 404's six ways still stand after the button.** They are the page's main content for a reader who knows what they
  wanted; the button is the fallback and now comes first. The page is the same height.
- **The captures were not retaken.** The console is being redesigned in parallel and the hero's 1,440 shots would be retaken
  twice; the docs page's note and the glance are type, not pictures.
- **At 1,440 a split's head is now 48px in a 443px column**, so the legal page's "The licence, in plain words" wraps onto two
  lines (36.7 → 103.7px). The section's height is its content's and the page does not move; a narrower column would be a
  change to the split, not to the rank.
- **Curule Cloud's prices** are still in the app; the pages say so, and no stable Cloud price can be generated from
  `packages/licensing/src/plans.ts`.
- `site/ux/` was not edited, and the passes' captures were not retaken.

The next pass's first job is the pricing page's first amount at 950 at 360; after it, the plan stack's repetition of the
limits and support (the exporter's), and the documentation row's third chip.

## 2026-10-26, fourth pass: the price on the first screen, and the demo's commands where a phone can read them

Measured with the same probe (Chrome over CDP, touch, reduced motion, light) at 320, 360 and 1,440. The before column is
the record of the third pass, re-measured from that commit's site.

### What changed

- **The price stands with the promise.** The hero was 1,296.4px at 360, the contents row 194 and the pricing head 323, so
  the first amount on the home page was at **y = 1,882.7** — 1,083px below an 800px screen, with the contents row and a
  pricing head between the action and the figure. A ruled line of figures now stands between the actions and the picture,
  **written from the plan table** by `scripts/export-pricing.mjs` (the `hero-price` block, like the teaser), so it cannot
  drift from `packages/licensing/src/plans.ts`: *Community is free; Team is $149 a month; Business is $599 a month;
  Enterprise is quoted.* with the way to the plans. The first price is **1,882.7 → 522.8** at 360 (320: 2,070.2 → 638.4;
  1,440: 2,142.7 → 496), and the action at 458.8 is still in the first screen with it.
- **The demo's commands read whole.** The three blocks of `#try` were 270px wide at 360 with 404, 498 and 498px of text, so
  **134, 228 and 228px** of the token, clone and run commands lay behind a sideways drag — 46% of the last two — and the run
  command's last **32px** were cut even at 1,440, where the two-column layout leaves the block 466px. They wrap now
  (`#try .code pre { white-space: pre-wrap; overflow-wrap: anywhere }`): **0px hidden at 320, 360 and 1,440**, block heights
  72/92/92 → **113/134/176** at 360 and 72/92/92 → **72/113/113** at 1,440. The Copy button still copies the exact text; the
  blocks are taller by the lines they no longer hide (`#try` 1,847.3 → 2,033.5 at 360).
- **The caveat sits with the step it explains.** "There is no published container image yet, so the second step builds it
  from the source" stood in the preamble, above the first command, and said "the second step" from outside it. It is now
  inside step 2, the one that builds the image, and reads "so this step builds it". A phone reaches the first command
  **83.2px** sooner: step 1 stands **640.8 → 557.6** from the section's top at 360 (320: 640.0 → 556.8). At 1,440 the steps
  are the right column and nothing moved.

The three together cost **297px** at 360 (12,991 → 13,288), 318 at 320 and 193 at 1,440, and they buy the price 1,360px
higher and every command whole. The cost of the price line is the picture: its first **166.2px** were inside the first 800px
at 360 and its first **55.2px** are now, because 81px of ruled figures stand above the frame. The frame bar, the three tabs
and the top of the capture are still on the first screen, and the capture is 326 × 204 at that width — 0.23 of the 1,440px
art it is cut from — so the figures are the thing a thumb can use and the picture is one scroll away.

### Measurements after this pass

| Page, height at 320 / 360 / 1,440 | Before | After |
|---|---|---|
| Home | 13,791 / 12,991 / 12,080 | **14,109 / 13,288 / 12,273** |
| Pricing (content untouched) | 13,485 / 9,206 (360/1,440) | unchanged |

| The first screen at 360 | Before | After |
|---|---|---|
| The hero | 1,296.4 | **1,407.4** |
| The primary action | y = 458.8 | y = 458.8 |
| The first price on the page | **y = 1,882.7** | **y = 522.8** |
| The picture's first line | y = 633.8 (166.2px in an 800px screen) | y = 744.8 (**55.2px**) |
| The contents row | y = 1,365.4 | y = 1,476.4 |

| The demo's three commands | 320 | 360 | 1,440 |
|---|---|---|---|
| Hidden behind a sideways drag, token / clone / run | 174 / 268 / 268 → **0 / 0 / 0** | 134 / 228 / 228 → **0 / 0 / 0** | 0 / 32 / 32 → **0 / 0 / 0** |
| Block heights | — | 72 / 92 / 92 → **113 / 134 / 176** | 72 / 92 / 92 → **72 / 113 / 113** |
| From the section's top to step 1 | 640.0 → **556.8** | 640.8 → **557.6** | 100.8 → 100.8 |
| The section | 1,919.2 → **2,126.2** | 1,847.3 → **2,033.5** | 1,166.7 → **1,263.3** |

- No page scrolls sideways at 320, 360 or 1,440 (**0** on each), axe-core reports **0** violations on the home page at 360
  and 1,440 and on pricing at both (WCAG 2.0/2.1 A and AA), and no text computes under **12px**.
- Four controls are under 44px at 360 and all four are inline links in a sentence (WCAG's exception): the new "Compare the
  plans" (132 × 19) joins the security caveat's link and the answer's two. No standalone control is under 44.
- `tests/build/site-copy.test.ts` holds the price between the actions and the picture, names all four plans with the plan
  table's figures, and holds the image caveat to step 2 and the wrap rule in the stylesheet.

### What this pass deliberately left

- **The contents row already lands where it says.** Every one of the eight entries puts its section at y = 88 under the 69px
  header, and no section's first line is below the fold after landing (the heads land at 88–137); at 1,440 the row is two
  columns of four, 98px. It was measured and not changed.
- **The pricing page's first amount is still at 950 at 360.** The calculator was read-only for this pass and is sound: 0
  console errors, every field 44px, the total and the quoted plan intact at 360 and 1,440. The page's own head (432px at
  320) and its plans head own the 150px; that is still the next pass's first job.
- **The FAQ was measured and left.** Its ten summaries are 64–86px, its answers 16px/25.6 at 328px wide, and the first three
  questions are the model account, your code, and the free plan. Nothing there was wrong enough to change.
- **A 720px capture of the hero would still read better than 326 × 204.** The console is being redesigned in parallel, so
  the captures were not retaken, and no CSS crop makes 1,440px of art legible in 326.
- `site/ux/` was not edited.

## 2026-10-28: the price at the head of the page that sells it

Measured with the same probe (Chrome over CDP, reduced motion, light unless said, touch at 320/360/390, a mouse at 768 and
1,440, print at 794, forced colours at 360, a 24px root at 320/360 and 720 for the 200% stand-in). The before column is the
site at the commit this pass started from, served on a second port and measured in the same run; no number is copied from
an earlier pass.

### What changed

- **The pricing page's four figures stand at its head.** The page's first `$` was at **943.4** at 360, **990.9** at 320, 881.9
  at 390, 810.8 at 768 and 941.2 at 1,440: below the first screen at every width, on the one page whose whole job is to state
  a price. The head now carries the hero's ruled line of figures (`head-price`, written by `scripts/export-pricing.mjs` from
  `packages/licensing/src/plans.ts`, like the home page's `hero-price`): *The licence plans, billed annually: Community is
  free; Team is $124 a month; Business is $499 a month; Enterprise is quoted.* It is **476.1–557.1** at 360, under the lede
  and above the On this page row, and the first `$` is at **512.7**.
- **The line names the period the switch below chooses, and the stylesheet is what chooses it.** Two sentences are in the
  markup and `body:has(#billing-monthly:checked)` shows the one the checked radio names — the same plain-CSS pattern as the
  plan cards and the phone's comparison stack. With Monthly chosen the head says *billed monthly: Team is $149 a month;
  Business is $599 a month* and the card beside it says $149: the two cannot disagree, and neither needs the script. Print
  has no switch, so both sentences print as two labelled lines.
- **The six other pages already kept the rule, and were measured rather than changed.** At 360 the answer each page exists
  for is at **522.8** on the home page (the price line), **600.7** on the documentation page (its first start card), **611.0**
  on the security page (its first answer), **578.9** on the contact page (its first address), **524.0** on the legal page (the
  licence's own head) and **341.6** on the 404 (the way home). The pricing page was the one page whose answer a reader had to
  scroll for; it now reads with them. This is the job the last four passes left: "the pricing page's first amount is still at
  y=950 at 360", recorded as the next pass's first job.

### Measurements after this pass

| Page, height at 320 / 360 / 390 / 768 / 1440 | Before | After |
|---|---|---|
| Home | 14,109 / 13,288 / 12,770 / 12,992 / 12,209 | unchanged |
| Pricing | 14,444 / 13,485 / 12,927 / 10,766 / 9,142 | **14,568 / 13,586 / 13,028 / 10,844 / 9,220** |
| Documentation | 9,035 / 8,402 / 8,202 / 5,646 / 4,446 | unchanged |
| Security | 12,233 / 11,082 / 10,577 / 8,206 / 7,450 | unchanged |
| Contact | 4,749 / 4,459 / 4,334 / 3,883 / 2,836 | unchanged |
| Legal | 5,559 / 5,008 / 4,777 / 3,887 / 3,266 | unchanged |
| 404 | 2,419 / 2,300 / 2,277 / 1,915 / 1,524 | unchanged |

| The first `$` on the pricing page at | Before | After |
|---|---|---|
| 320 | 990.9 (103.7px under the screen) | **537.8** |
| 360 | 943.4 (143.4 under) | **512.7** |
| 390 | 881.9 (81.9 under) | **451.2** |
| 768 | 810.8 (10.8 under) | **424.9** |
| 1,440 | 941.2 (41.2 under an 800px screen) | **472.6** |

| Pricing at 360 | Before | After |
|---|---|---|
| The page | 13,485 | **13,586** |
| The On this page row | 476.1 | **577.1** |
| The plans' own head | 604.3 | **705.3** |
| The Annual/Monthly switch | 727.3 | **828.3** |
| The first plan card | 801.3 | **902.3** |
| The first plan amount | 950.4 | **1,051.4** |

- The line costs the pricing page **101px at 360 and 390, 124 at 320 and 78 at 768 and 1,440**; with Monthly chosen the page
  is **13,523** at 360, 63px shorter than annual, because the monthly per-line is a line shorter. The switch and the cards
  move down by exactly the line's height; nothing else on the page moves, and no other page changes height.
- No page scrolls sideways at 320, 360, 390, 768 or 1,440 in light or dark (**0** on all 70 page/width/theme pairs), the
  probe reports **0** console errors, **0** axe-core WCAG 2.1 AA violations on the pricing page at 360 light and 1,440 dark,
  and the smallest computed text is **12px** on every page. The line is **.875rem/1.62** in `--ink2`, the hero's own rule,
  and the head is 81px tall at 360 (64.3 of words), 58.3 at 1,440 (41.7), 103.7 at 320.
- Without a script the line is the annual one and the page is **12,446** at 360 (**8,760** at 1,440), 0px over. With
  `forcedColors: active` at 360 it is 13,586, 0px over, and the smallest text is 12px. At a 24px root the head is 183.1px
  and the pricing page **21,823** at 360 and **24,104** at 320, 0px over; at 720 (the 200% stand-in) it is 11,008, 0px over.
  Print at 794 is **10,062 → 10,186** with both periods printed, 0px over.
- The only target under 44 × 44 at 320–768 is the same 24 × 24 checkbox whose label is 44; the line holds no control, so it
  adds none.
- `tests/build/site-copy.test.ts` pins the block: fenced by the exporter, before the On this page row and under the lede,
  every plan named with both its monthly and its annual figure, the two period sentences, the two `:has` rules that swap
  them, and the print rule that shows both. `site.test.ts` is unchanged. `tests/licensing/pricing-export.test.ts`'s write
  test now fences the two blocks the exporter requires — `hero-price` was already required by the last pass and missing
  from that fixture, so the test was failing on `main` before this pass — and it asserts the head block is written.

### What this pass deliberately left

- **The first plan card is 102px lower at 360** (801.3 → 902.3), because the line stands above the section rather than
  replacing any of it. The answer is on the first screen; the card's detail is one scroll below, where it was.
- **The line repeats the four figures the cards state 400px below.** That is the price of a first screen that answers: the
  home page's hero does the same with its teaser, and the two are written from the same table.
- **The home page's line is still the monthly list price** ($149/$599, unlabelled) while the pricing page opens on the
  annual one ($124/$499, labelled), because the pricing page's switch opens on Annual. Both are true offers and each is
  labelled where the period matters; making the home's line say "billed monthly" would add a phrase to the busiest line on
  the page without changing a figure.
- **The pricing page's cards still repeat the host scope sentence four times and the roadmap sentence twice**, and the
  comparison still stacks below 720. Neither is the opening, and both are the exporter's.
- **The documentation row still cuts its third chip at 360**, the security page's At a glance box is still 930px, and the
  footer is still 1,012px at 360 on every page. None of these changed.
- **No capture was retaken**, and `site/ux/` was not edited.

## 2026-10-28, second pass: the footer is an index, and it fits a phone

Measured with the same probe (Chrome over CDP; reduced motion; light unless said; touch at 320, 360 and 390, a mouse at 768
and 1,440; print at 794; forced colours at 360; a 24px root at 320, 360 and 720 for the 200% stand-in). The before column is
the site at `c607912`, served on a second port and measured in the same run; no number is copied from an earlier pass.

### What changed

- **The footer's three groups stand as three columns, and none of them dangles.** Below a tablet the index was a grid of two
  columns: Product (5 links) and Resources (6) side by side, and Company (5) alone under them in the left half, with the right
  half empty for 245px. The grid is `var(--c3)` now, so the three groups are one row at **96px each at 360** (83 at 320, 106
  at 390) and the footer's index is **747.9 → 445px at 360** (776 → 469 at 320; 748 → 445 at 390).
- **A tablet reads the footer it has the room for.** The four-column grid (brand as a column, three groups beside it) began at
  860, so at 768 — 706px of wrap — every page still read the two-column phone footer for **982.1px**. It begins at 640: at 768
  the brand is a **201.9px** column and the three groups are **144.2px** each (**341.3 → 144.2**), and the footer is
  **982.1 → 505.5** — the largest change on this surface, and the one the last pass's own record did not see, because the
  footer was measured at 360 only.
- **The brand stops being a banner wherever it can be a column.** It spanned the grid at every width below 860, and its 134px
  row stood above three columns that did not need it. From 640 it is the first column, so at 640 the footer is
  **991.1 → 514.1px** and the tagline wraps in the column it is given rather than across 352px.
- **A label that wraps still fits a thumb's row.** At 360 a 96px column wraps two of the sixteen labels ("What it shows",
  "Report a vulnerability") and at 320 three; the rows are **44px** with `line-height: 1.3` (the one that wrapped was 48), so
  the three columns' rows line up at 44 and no target changes size. The group's name sits **12 → 6px** above its links, and the
  legal block's rule keeps 20px under it instead of 24 and, at a phone, 32px above it instead of 40 — which is why the footer
  at 1,440 falls by the 6 and the 4 rather than more: **498.5 → 488.5**.
- **Nothing above the footer moved, and no sentence did.** The header and footer are written by `scripts/site-chrome.mjs`; this
  pass changed no markup in them, so all sixteen links, the three group names, the logo, the tagline ("A team of AI agents, run
  like an organization."), the contact line, the trademark line and the price line are exactly where they were — the footer's
  own top is **12,275.3 on the home page at 360, before and after**. The one thing that changed is its shape and its height.

### Measurements after this pass

| Page, height at 320 / 360 / 390 / 768 / 1440 | Before | After |
|---|---|---|
| Home | 14,109 / 13,288 / 12,770 / 12,992 / 12,209 | **13,790 / 12,973 / 12,455 / 12,515 / 12,199** |
| Pricing | 14,568 / 13,586 / 13,028 / 10,844 / 9,220 | **14,249 / 13,271 / 12,713 / 10,367 / 9,210** |
| Documentation | 9,035 / 8,402 / 8,202 / 5,646 / 4,446 | **8,716 / 8,087 / 7,887 / 5,169 / 4,436** |
| Security | 12,233 / 11,082 / 10,577 / 8,206 / 7,450 | **11,914 / 10,767 / 10,262 / 7,730 / 7,440** |
| Contact | 4,749 / 4,459 / 4,334 / 3,883 / 2,836 | **4,430 / 4,144 / 4,019 / 3,407 / 2,826** |
| Legal | 5,559 / 5,008 / 4,777 / 3,887 / 3,266 | **5,240 / 4,693 / 4,462 / 3,410 / 3,256** |
| 404 | 2,419 / 2,300 / 2,277 / 1,915 / 1,524 | **2,100 / 1,985 / 1,962 / 1,438 / 1,514** |

| The footer | 320 | 360 | 390 | 768 | 1,440 |
|---|---|---|---|---|---|
| Its height, before → after | 1,081.5 → **762.5** | 1,011.9 → **696.9** | 1,011.9 → **696.9** | 982.1 → **505.5** | 498.5 → **488.5** |
| Its index, before → after | 775.9 → **469** | 747.9 → **445** | 747.9 → **445** | 747.9 → **283** | 241 → **235** |
| Its columns, before | 132×289, 132×289, 132×249 | 152×289, 152×289, 152×245 | 167×289, 167×289, 167×245 | 341×289, 341×289, 341×245 | 238×241 ×3 |
| Its columns, after | **83×283 ×3** | **96×283 ×3** | **106×283 ×3** | **144×283 ×3** | 238×235 ×3 |
| The third column's row | its own row, left half | its own row, left half | its own row, left half | its own row, left half | same row |
| Its legal block | 176.6 → **172.6** | 135 → **131** | 135 → **131** | 93.4 → **89.4** | 72.6 → **68.6** |

| The seven footers together | Before | After |
|---|---|---|
| At 360 | 7,083.3 | **4,878.3** |
| At 768 | 6,874.7 | **3,538.5** |
| At 1,440 | 3,489.5 | **3,419.5** |

- The footer costs every page **315px at 360 and 390** (319 at 320, 477 at 768, 10 at 1,440). The 404 page, whose footer was
  44% of it, goes **2,300 → 1,985** at 360 (13.7% shorter) and its footer from **44% to 35%** of the page; the documentation page at
  768 goes **5,646 → 5,169** (8.5%). The home page is **13,288 → 12,973**, 16.6 screens of 800 to 16.2.
- At the home page's last scroll (12,173) the footer in the 800px screen runs from **102 to 1,114px** before — 314px under the
  bottom edge — and **102 to 799** after: the whole index, brand and legal lines fit one screen, with the closing band above it.
- No page scrolls sideways at 320, 360, 390, 768 or 1,440 in light or dark (**0** on all 70 page/width/theme pairs), the probe
  reports **0** console errors, and **0 axe-core WCAG 2.0/2.1/2.2 A and AA violations** on all seven pages at 360 light and
  1,440 dark. The smallest computed text is **12px** on every page. In dark at 360 and 1,440 every page is the height it is in
  light (home 12,973 / 12,199, the 404 1,985 / 1,514) and **0px** over.
- The only target under 44 × 44 at 320–768 is the pricing page's 24 × 24 usage-reports checkbox, whose label is the 44px target
  (unchanged); at 1,440 the rows are 36px for a mouse, as before (29 controls under 44 on the home page in both runs, the
  bar's and the footer's links).
- Without a script the home page is **12,972** at 360 and its footer 696.9, 0px over. With `forcedColors: active` at 360 it is
  12,973, 0px over, the columns keep their rules and the page you are on keeps its line. Print at 794 is **12,147 → 12,135**
  (the index is not printed, as before; the 12px is the legal block's air), 0px over. At a 24px root the footer is
  **1,204 → 902** at 360 and the page **20,621 → 20,319**, 0px over at 320, 360 and 720.
- `tests/build/site.test.ts` now holds the new shape: the index is `var(--c3)`, the brand spans it while the columns are narrow
  and takes a column of its own from 640, a footer link's `line-height: 1.3` keeps a wrapped label inside 44, and the group's
  name is 6px above its links. The site's own suites — the `site*` files with docs-links, product-name, brand-assets,
  set-domain and no-mojibake — are **177** tests, all passing.

### What this pass deliberately left

- **The home page is still sixteen screens (12,973 at 360).** The seed for this pass put its length down to "the arguments and
  the six-view product tour": measured, the tour is **878px** at 360 (its six views are one sideways snap row, one tile tall),
  and the length is nine argument sections — `#ways` 1,206.5, `#why` 1,395.6, `#how` 1,150, `#try` 2,033.5, `#security` 1,428.7,
  the price teaser 1,196.8 and the FAQ 943.8. That is not furniture to be recomposed but copy to be edited: which of the nine a
  phone reader needs, and in what order, is the next pass's first job.
- **At 360 two of the sixteen labels take two lines** in a 96px column ("What it shows", "Report a vulnerability"), and three
  at 320. The alternative is the two-column grid at 1,012px, or a 3-column grid at 13px type — the labels are whole, the rows
  are 44, and the words are the group's own.
- **Sixteen links at 44px is 704px of rows however they are arranged.** Three columns of six is the floor without hiding a group
  behind a disclosure control, which would take the links out of the page a phone reads by scrolling.
- **The footer at 1,440 loses 10px, not more.** The desktop grid was already four columns with the brand in the first; the only
  change there is the legal block's rule and the group's name.
- **The 404 page still carries the footer's full index** even though it is the page a reader least needs it on; the page's own
  six ways stand above it, and the way home is on the first screen.
- **The pricing page's cards still repeat the host scope sentence four times and the roadmap twice**, the comparison still
  stacks below 720, the documentation row still cuts its third chip at 360, and the security page's At a glance box is 930px.
  None of these changed.
- **No capture was retaken**, and `site/ux/` was not edited.

The next pass's first job is the home page's nine argument sections: at 360 they are 10,604.8px of the 12,973 (81.7%), and the only
honest way down is an editorial one — which arguments a phone reads, in what order, and what each one can say in fewer lines.

## 2026-10-28, third pass: the proof and the demo before the argument

Measured with the same probe (Chrome 156 over CDP, reduced motion, light unless said, touch at 320/360/390, a mouse at 768 and
1,440, print at 794, forced colours at 360, a 24px root at 320/360 and 720 for the 200% stand-in, and both schemes for the axe runs
and for the grounds). The before column is the site at `6c1123a`, served on a second port and measured in the same run; no number
is copied from an earlier pass.

### What changed

- **The console tour and the demo come before the two argument sections, and nothing else moves.** The order was the tagline, the
  price, the two ways in, **why it is not a group chat** (4,073.8), **how a mission goes** (5,469.4), the console (6,619.4), the demo
  (7,497.6), security, the questions. It is the tagline, the price, the two ways in, **the console** (4,073.8), **the demo** (4,952),
  why it is not a group chat (6,985.5), how a mission goes (8,381), security, the questions. The two argument sections were the page's
  two pieces of prose that ask to be read in order; the six captures and the four commands are what a phone can decide on. At 360 a
  reader now meets the console **6,619.4 → 4,073.8** (8.3 → 5.1 screens of 800) and the demo **7,497.6 → 4,952.0** (9.4 → 6.2),
  with the demo's first command block **8,172.9 → 5,627.3**. The price line (522.8) and the two ways' one action (3,422.2) do not
  move, so what it costs, that it is real and the way to try it all stand inside the first **6.2** screens, where the third of them
  was at **9.4**.
- **The order is a chain of questions now, and each section answers the one above it.** *What is it, and what does it cost?* The
  price. *Who runs it?* The two ways. *What does it look like?* The console, in six views. *Can I run it?* The four commands.
  *Isn't this just a group chat?* — the objection the six captures raise — is the next section's own heading, "Why it is not a group
  chat", so the answer arrives when the question does. *How does a mission go?* Then security, the questions, and the closing band.
  Until this pass the page answered an objection a reader had not yet formed, and showed the product 2,546px later than it asked the
  question.
- **The contents strip names the page it is on.** The eight entries are the same eight sections, in the same row of eight 48px
  links (194px at 360, unchanged), renumbered to the order a thumb now walks: **03 The console, 04 Try it, 05 Why rules, 06 How it
  works** (01 plans, 02 who runs it, 07 security, 08 questions are where they were). Every one of the eight lands its section at
  **88**, under the 69px bar, at 320, 360, 768 and 1,440, and the hero's "Try the demo" and the header's Product land at 88 too.
- **The bands travelled with the sections, so no stylesheet byte changed.** The console keeps its banded ground and the demo its
  plain one, so the sequence of grounds is still one plain block of buying (the price and the ways), a band (the console), a plain
  section (the demo), a band (why), a plain (how), the tinted security section, a banded FAQ and the closing band: measured
  `#product` `rgb(247, 245, 241)` → `#try` transparent → `#why` `rgb(247, 245, 241)` → `#how` transparent in light, and
  `rgb(14, 13, 12)` / transparent / `rgb(14, 13, 12)` / transparent in dark. No class, colour, size or spacing step was added, and
  `assets/site.css` and `assets/site.js` are untouched (their fingerprints and the pages' header and footer are what they were).

### Measurements after this pass

| The home page at 360, light | Before | After |
|---|---|---|
| The page | 12,973 (16.2 screens) | **12,973 (16.2)** |
| The price line in the hero | 522.8 | 522.8 |
| "Get started" in the two ways | 3,422.2 | 3,422.2 |
| The console (`#product`) | 6,619.4 | **4,073.8** |
| Its six-view row | 7,000.5 | **4,454.8** |
| The demo (`#try`) | 7,497.6 | **4,952.0** |
| The demo's first command | 8,172.9 | **5,627.3** |
| Why rules (`#why`) | 4,073.8 | **6,985.5** |
| How it works (`#how`) | 5,469.4 | **8,381.0** |
| Security / questions / closing band / footer | 9,531.1 / 10,959.8 / 11,903.6 / 12,275.3 | **unchanged** |
| Screens to the price, the console, the demo | 0.65 / 8.27 / 9.37 | **0.65 / 5.09 / 6.19** |

| The console, and the demo, at | 320 | 390 | 768 | 1,440 |
|---|---|---|---|---|
| The console, before → after | 7,068.7 → **4,379.7** | 6,431.4 → **3,992.2** | 6,573.5 → **3,309.8** | 6,024.2 → **3,297.1** |
| The demo, before → after | 7,948.9 → **5,259.8** | 7,296.0 → **4,856.8** | 8,262.4 → **4,998.7** | 8,132.3 → **5,405.2** |
| The page | 13,790 | 12,455 | 12,515 | 12,199 (all unchanged) |

- **Nothing was lost, measured.** 1,547 words, 36 links (29 unique), 52 controls, twelve figures (`$124`, `$149`, `$499`, `$599`,
  the four plans' limits), 11 sections, 11 `h2`, 26 `h3`, 12 questions and 10 captures: identical before and after at 360. The
  page height is identical at 320, 360, 390, 768 and 1,440.
- **The keyboard walks the same controls in a different order.** 73 stops at 360 both before and after, and 52 controls in `main`.
  The console's first control is the **28th** stop (was 29) and the demo's Copy buttons the **34th** (was 35), because the only
  control between them before was the Graph capture's "Full size" link; the price's first control is the 18th stop and the
  footer's the 56th in both halves.
- **The floors are untouched.** 70 page/width/theme pairs (7 pages × 320/360/390/768/1,440 × light/dark): **0** horizontal page
  scroll, **0** text under 12px, **0** console errors, and the same census of targets under 44 (the pricing page's 24 × 24
  checkbox whose label is 44, and the mouse's 36px rows at 1,440). axe-core WCAG 2.0/2.1/2.2 A and AA: **0** violations on the home
  page at 360 light, 360 dark and 1,440 dark. Without a script 12,972px; print at 794 12,135; `forcedColors: active` 12,973; a
  24px root 20,319 at 360 and 21,933 at 320; a 720px viewport 12,644 — every one identical before and after, and 0px over.
- **One test changed with the pinned shape.** `tests/build/site.test.ts` held the old order and the old numbering; it now holds the
  new one, and its name says what the order is for. Nothing else in the suite read the page's order.

### What this pass deliberately left

- **The page is still 12,973px at 360, 16.2 screens, and the nine argument sections are still 10,604.8px of it.** This pass moved
  what a phone meets and when it meets it; it did not shorten the words, because every claim on the page is pinned by a test and
  the surface's rule is that a section is either a claim or an action. The only honest way down from here is copy: the demo
  (**2,033.5px**) and the two ways in (**1,206.5**) are the two largest answers, and both are the owner's words.
- **The argument now comes after the demo.** A reader who wants the reasons before the pictures reads them at 6,985.5 ("why rules")
  and 8,381 ("how it works") instead of 4,073.8 and 5,469.4. That is the trade this pass makes: the objection "why is this not a
  group chat" is now the answer to a section the reader has just seen, and the reasons are for the reader who scrolls past the
  demo. The other order — arguments first, proof at 8.3 screens — is what the page had.
- **The demo is a commitment before the argument.** Its four steps ask for Docker and git, and they now stand at 6.2 screens rather
  than 9.4. A reader can skip them (the two ways in and the questions are one press each above and below), but the page does not
  ask whether they want them first; a disclosure that folded the four commands was refused by the 24 Oct pass, because those
  commands are what the hero's second action promises.
- **At a 32px root (200% of a 16px default) the home page is 6px wider than a 360px window and 26px wider than a 320px one**, identically
  before and after this pass: the closed phone menu's five links are 323..471 in a 360 window and the six-view row is a snap row that
  scrolls inside its own box. The body's `px` ramp does not follow a user's default size, which the 24 Oct pass recorded as debt; the
  200% case the record does test (a 720px viewport) is 0px over.
- **The captures were not retaken**, and `site/ux/` was not edited.
- **`npm run site:check` still exits 1** on the owner's `TODO(owner)` for the terms at `site/legal/index.html:133`; that is the
  publishing gate the last four passes have recorded, and it is not this pass's.

The next pass's first job is still the page's length: 12,973px at 360 is 16.2 screens, and the reorder changed the order a phone
meets them in, not how many words it reads. The demo (2,033.5px of four steps and three command blocks) and the two ways in
(1,206.5px of two cards) are the two places where fewer lines would take the most pixels off, and both are copy.

## 2026-10-28, fourth pass: the demo says its instructions in fewer lines

Measured with the same probe (Chrome 156 over CDP, reduced motion, light unless said, touch at 320/360/390, a mouse at 768 and
1,440, print at 794, forced colours at 360, a 24px root at 320 and 360, a 32px root at 320 and 360). The before column is the
site at `5b2205e`, served on a second port and measured in the same run; no number is copied from an earlier pass.

### What changed

- **The demo's preamble says the same in three lines fewer.** At 360 the heading is two lines instead of three (90.7 → 60.5):
  "Run the demo on your machine. No API key." keeps both claims and loses a connective. The lede is three lines (106.1 → 79.6)
  and the Docker/openssl line is three (102.4 → 76.8), still naming Docker, git, `openssl` and "32 or more characters". The
  preamble is **477.6 → 395.2** and the first command stands **106.4px higher** (5,627.3 → 5,520.9).
- **Two step headings name their step in one line.** "Build the image from the source" → "Build the image" (**49.4 → 24.7**) and
  "Open it and press Start mission" → "Open the console" (**49.4 → 24.7**). What the short heading drops, the step keeps: the
  caveat still says "this step builds it from the source", the command is still `git clone` and `docker build`, and step 4's
  sentence still says "Open the **demo-stub** project and press **Start mission**".
- **The fourth step's second paragraph is one line shorter.** "With your own credentials the same seats are real: …" is now
  "Your own credentials make the same seats real: …", with the same four providers and the same `curule init`
  (**120 → 96**). The step is **382.4 → 333.7** at 360 and 430.4 → 381.7 at 320.
- **The section is 203.8px shorter at 360 and the page 203px** (12,973 → 12,770, 16.2 → 15.96 screens of 800). At 320 the page
  is 74px shorter (13,790 → 13,716), at 390 27 (12,455 → 12,428), at 1,440 24 (12,199 → 12,175), and at 768 unchanged (12,515),
  where the steps column already set the height. The words are **219 → 200** in the demo and **1,547 → 1,528** on the page.
- **Nothing above or below moves except by that 203px.** The price line (522.8), the two ways (2,867.3), the console (4,073.8) and
  the demo's own top (4,952) are where they were; `#why` is 6,985.5 → 6,781.7, and the footer 12,275.3 → 12,071.6. The three
  command blocks keep their heights and hide 0px at 320/360/1,440, and the demo still has 1 link, 3 Copy buttons and 4 steps.

### Measurements after this pass

| The home page at 360, light | Before | After |
|---|---|---|
| The page | 12,973 (16.2 screens) | **12,770 (15.96)** |
| The demo (`#try`) | 2,033.5 | **1,829.7** |
| Its preamble | 477.6 | **395.2** |
| Its heading / lede / need line | 90.7 / 106.1 / 102.4 | **60.5 / 79.6 / 76.8** |
| Step 1 / step 2 | 330.9 / 400.4 | **306.9 / 351.7** |
| Step 3 / step 4 | 314.3 / 382.4 | **314.3 / 333.7** |
| The first command | 5,627.3 | **5,520.9** |
| The demo's words | 219 | **200** |
| The footer | 12,275.3 | **12,071.6** |

| The page at 320 / 390 / 768 / 1,440 | Before | After |
|---|---|---|
| Home | 13,790 / 12,455 / 12,515 / 12,199 | **13,716 / 12,428 / 12,515 / 12,175** |
| The demo | 2,126.2 / 1,812.1 / 1,418 / 1,263.3 | **2,052.8 / 1,785.4 / 1,418 / 1,239.3** |

- No page scrolls sideways at 320, 360, 390, 768 and 1,440 in either theme (**0** on all 70 page/width/theme pairs), the probe
  reports **0** console errors and **0** axe-core WCAG 2.0/2.1/2.2 A and AA violations on the home page at 320 dark, 360 light and
  1,440 dark, and the smallest computed text is **12px**. The target census is unchanged: no standalone control under 44×44 at
  320–768 on the home page (the four inline links in sentences are the exception the probe allows), and the same 29 mouse-sized
  36–40px rows at 1,440 as before.
- Without a script the home page is **12,769**, 0px over (was 12,972); with `forcedColors: active` at 360 it is **12,770**, 0px
  over; print at 794 is **12,135**, unchanged; at a 24px root **20,072** at 360 and **21,820** at 320, 0px over (was 20,319 and
  21,933); at a 32px root **30,076** and **33,313**, 6px and 26px over, exactly as before.
- The keyboard is **74** stops at 360 before and after; the demo's first control is the **34th** (the Deploying link) and the
  footer's the **57th**. The demo's four controls are the link and the three Copy buttons.
- Every pin in `tests/build/site-copy.test.ts` holds without an edit: four steps, the three exact command blocks, the caveat
  inside step 2, and "Open the demo-stub project and press Start mission". The site's own suites are **177** tests, all passing.

### What this pass deliberately left

- **The fourth step's first paragraph is still eight lines** (192px at 360). It carries the URL, the token, the project, the
  button, the seven agents, the mission, the chain from requirements to merged, reviewed and verified, and the one block;
  a line off means one of those off.
- **At 320 the page loses 74px, not 204.** Only step 2's and step 4's headings and step 4's second paragraph change line at
  232px of text; the heading, the lede and the Docker line keep their lines.
- **At 768 nothing changes.** The steps column set the section's height before and its lines did not move.
- **The demo is still a commitment before the argument** (6.2 screens), and each command block still carries its 48px Terminal
  row. That component is shared with the documentation page and was not this pass's.
- **The captures were not retaken**, and `site/ux/` was not edited.
- `npm run site:check` still exits 1 on the owner's `TODO(owner)` at `site/legal/index.html:133`, as the last four passes recorded.

The next pass's first job is the two ways in (`#ways`, 1,206.5px at 360): two 522.6px cards whose four answers repeat the pricing
page's. A card is kept for something you act on, so the saving there is the words inside the two cards, not their surface; after it,
the demo's fourth step's first paragraph is the only prose left in `#try` that is longer than its instruction.

## 2026-10-29: the two ways in carry one head each, and 206px of fewer words

Measured with the same probe (Chrome 156 over CDP, reduced motion, light unless said, touch at 320, 360 and 390, a mouse at
768 and 1,440, print at 794, forced colours at 360, a 24px root at 320 and 360, a 32px root at 320 and 360). The before
column is the site at `36b4e25`, served on a second port and measured in the same run; no number is copied from an earlier
pass.

### What changed

- **A card's head is one tinted block, not a band and a title 116.2px deep.** The head was a 65px tinted band with the way's
  mark and name, then, outside it, a 24px title 20px under the band: **116.2px at 360** (65 + 20 + 31.2) before either answer
  began. It is now a single `<header class="way-head">` whose grid holds the 40px mark, the name in the kind's 12px capitals
  and the title under it: **73.4px**, **42.8px off each card** and 85.6 of the section's saving. Every word stayed: "Curule
  Cloud" and "Self-hosted" are the name line, "We run it for you" and "You run it" the title, and the cloud card's head keeps
  its tint and its accent rule. At 1,440 the head is 73.4px where the band and its title stood 128.2px deep.
- **The four answers say the same in five lines fewer.** Four paragraphs of five lines each (145.2px) are now 3, 4, 4 and 4
  lines (**97.2, 121.2, 121.2, 121.2**): the cloud card's "who it is for" drops two of its five lines (36 → 22 words), its
  "what you pay" and the self card's "who it is for" one each (35 → 22 and 28 → 20). Every claim is still there — the
  sign-up, plan and browser steps and "Same console and agents, on our servers"; the flat monthly plan priced on the sign-up
  page, your own model key billed by your provider, "we do not resell model usage"; your own infrastructure and model
  credentials, one container per team, "Nothing phones home: no telemetry, no update check, no licence server"; the Community
  plan's one project and ten agents and no key, the paid licence that lifts the limits, and the Business Source License 1.1 —
  and no figure is written by hand. The section's words are **171 → 134**, its cards **84/70 → 58/59**.
- **The pricing page's own two ways in changed by the same rule.** Its Cloud "what you pay" was nine lines (216px) carrying
  five claims; it is six (144), with the account's workspace count and each workspace's own plan still stated. Its four
  answers are **21 lines → 15** and its section **1,230.5 → 1,000.9** at 360. The licence card keeps the sentence
  `site-cloud.test.ts` holds ("The plans above are licences for the software you run yourself.").
- **Nothing above the section moves, and everything below moves up by exactly its saving.** The price line is at 522.8 and
  `#pricing` at 1,670.4 in both halves; at 360 the console is **4,073.8 → 3,868.2**, its six-view row 4,454.8 → 4,249.2, the
  demo 4,952 → 4,746.4, its first command 5,520.9 → 5,315.3 and the footer 12,071.6 → 11,865.9. The cards still hold one
  action each, the two dts ("Who it is for", "What you pay"), the same 42 links and 46 controls in `main`, and the same 73
  keyboard stops, with the ways' action still the 20th.

### Measurements after this pass

| The home page at 320 / 360 / 390 / 768 / 1,440 | Before | After |
|---|---|---|
| The page | 13,716 / 12,770 / 12,428 / 12,515 / 12,175 | **13,487 / 12,564 / 12,199 / 12,388 / 12,120** |
| `#ways` | 1,302.5 / 1,206.5 / 1,206.5 / 751.6 / 704.4 | **1,072.9 / 1,000.9 / 976.9 / 624.8 / 649.6** |
| Its two cards at 360 | 522.6 / 522.6 | **407.8 / 431.8** |
| A card's head at 360 | 116.2 | **73.4** |
| The four answers at 360, lines | 5 / 5 / 5 / 5 | **3 / 4 / 4 / 4** |
| `#ways`, words | 171 | **134** |

| The pricing page at 320 / 360 / 390 / 768 / 1,440 | Before | After |
|---|---|---|
| The page | 14,249 / 13,271 / 12,713 / 10,367 / 9,210 | **14,043 / 13,042 / 12,507 / 10,241 / 9,107** |
| `#ways` | 1,332.8 / 1,230.5 / 1,182.5 / 775.6 / 728.4 | **1,127.2 / 1,000.9 / 976.9 / 648.8 / 625.6** |
| Its four answers at 360, lines | 3 / 9 / 4 / 5 | **2 / 6 / 3 / 4** |

- The section loses **205.6px at 360**, 229.6 at 320 and 390, 126.8 at 768 and 54.8 at 1,440; the page loses the same. The
  pricing page loses 229.6 at 360 (its longer Cloud answer), 206 at 320 and 390, 126 at 768 and 103 at 1,440.
- No page scrolls sideways at 320, 360, 390, 768 and 1,440 in either theme (**0** on all 70 page/width/theme pairs), **0**
  computed text under 12px and **0** console errors. The only controls under 44 × 44 are the pricing page's 24 × 24 checkbox,
  whose label is 44, and the 29 mouse-sized 36–40px rows at 1,440 on the home page, as before.
- axe-core WCAG 2.0/2.1/2.2 A and AA: **0** violations on the home page and on the pricing page at 320 dark, 360 light and
  1,440 dark. Without a script the home page is **12,563** (was 12,769), 0px over; print at 794 is **12,032** (12,135);
  `forcedColors: active` at 360 is 12,564, 0px over; at a 24px root **19,681** at 360 and **21,465** at 320 (were 20,072 and
  21,820); at a 32px root 29,548 and 32,720 with 6px and 26px over, exactly as before (the recorded debt); a 720px viewport
  is 12,486 (12,644), 0px over.
- The site's own suites are **177** tests, all passing. Three of them changed with the head's markup, and none of their claims
  did: `site-copy.test.ts` reads the mark from the new `<header class="way-head">`, `site.test.ts` names `.way-head .mark` as
  the 40px tile, and `site-cloud.test.ts`'s four home and pricing copy pins hold the new sentences. `site-chrome --check` and
  `export-pricing --check` pass; `site:check` still exits 1 on the owner's `TODO(owner)` at `site/legal/index.html:133`.

### What this pass deliberately left

- **The self card's "What you pay" ends "Source: Business Source License 1.1."** A label, not the full sentence the footer and
  the FAQ print. Keeping "The source is available under the Business Source License 1.1." would have made the answer five
  lines again and cost 24px; the licence's name is intact and the owner's sentence is a scroll away.
- **The pricing page's Cloud "what you pay" is still six lines** (144px, was 216). It carries five claims — flat monthly
  hosting, prices kept on the sign-up page, the account's workspace count, each workspace a host on its own plan, your own key
  and no resale — and dropping one would be a claim, not a line.
- **The answers still carry a label row and its 16px mark each** (25.2px per answer, 101px a card). Putting the label in the
  sentence saves the row and costs the line it pushes, so it was measured and left.
- **The pricing page's section is not the same height as the home page's** (both 1,000.9 at 360 now) because its Cloud answer
  is one line longer than the home page's; the two pages' cards say different things on purpose.
- **The captures were not retaken**, and `site/ux/` was not edited.

The next pass's first job is the demo's fourth step: its first paragraph is still eight lines (192px at 360) and carries the
URL, the token, the project, the button, the seven agents, the mission and the one block. After that, the pricing page's Cloud
answer (six lines, and the card that sets its row) and the three command blocks' 48px Terminal row, which is shared with the
documentation page.

## 2026-10-29, second pass: the footer's index fits its columns

Measured with the same probe (Chrome 156 over CDP; reduced motion; touch at 320, 360 and 390; a mouse at 768 and 1,440;
print at 794; forced colours at 360; a 24px root at 320, 360 and 720; a 32px root at 320 and 360). The before column is
the site at `c10a48c`, served before any edit and measured in the same run; no number is copied from an earlier pass.

### What changed

- **On a narrow phone the footer's index is three stacked groups whose links wrap, not three columns.** At 320 the three
  columns are **82.66px**; the site's own "Documentation" is **117px**, so it painted **14.33px into Contact's row** (and
  12.95px into Licence's, 31.05px of the rows intersecting); "RESOURCES" broke to a lone "S" (its head **25.91px** where
  the other two are **12.95**), and "Report a vulnerability" ran **11.33px past the wrap's right edge**. At 360
  "Documentation" is 117px in a 96px column and its right edge sits **1px** inside Contact's 248px column: the words
  touch. The index is now one full-width group per row, each group's links a flex row that wraps with a 20px column gap,
  so every label is whole and every row is 44px. The 16 links and the three group names are unchanged.
- **At 421 and up the three columns return; from 640 the four-column index is unchanged.** The breakpoint is measured:
  at 420 the three columns would leave **19px** between "Documentation" and Contact, and at 421 the label has that 19px
  to the next group. The 320/360/390 phone is the width where they do not, so it is the width the rule covers.
- No markup, content, address or script changed. `site:domain` was run as this pass's fingerprint step says; its
  unrelated rewrites of the contact address, `sitemap.xml` and the `security.txt` dates were reverted, so the owner's
  address is exactly what it was. `scripts/site-chrome.mjs` wrote the new stylesheet fingerprint (`--check` passes).

### Measurements after this pass

| Page, height at 320 / 360 / 390 / 768 / 1,440 | Before | After |
|---|---|---|
| Home | 14,002 / 13,226 / 12,529 / 12,655 / 12,344 | **14,127 / 13,320 / 12,623 / 12,655 / 12,344** |
| Pricing | 14,694 / 13,627 / 13,014 / 10,382 / 9,382 | **14,819 / 13,721 / 13,107 / 10,382 / 9,382** |
| Documentation | 9,028 / 8,429 / 8,113 / 5,321 / 4,442 | **9,153 / 8,523 / 8,207 / 5,321 / 4,442** |
| Security | 12,518 / 11,531 / 10,846 / 7,875 / 7,634 | **12,643 / 11,625 / 10,940 / 7,875 / 7,634** |
| Contact | 4,690 / 4,379 / 4,176 / 3,407 / 2,850 | **4,815 / 4,473 / 4,269 / 3,407 / 2,850** |
| Legal | 5,453 / 4,965 / 4,670 / 3,409 / 3,307 | **5,578 / 5,059 / 4,764 / 3,409 / 3,307** |
| 404 | 2,137 / 2,030 / 1,986 / 1,438 / 1,514 | **2,262 / 2,123 / 2,080 / 1,438 / 1,514** |

| The footer's index | 320 | 360 | 390 | 768 | 1,440 |
|---|---|---|---|---|---|
| The footer | 775.48 → **900.44** | 741.73 → **835.64** | 696.94 → **790.84** | 505.48 | 488.55 |
| Its index | 481.91 → **606.86** | 468.95 → **562.86** | 444.95 → **538.86** | 282.95 | 234.95 |
| The groups | 3 × 295.91 → **106.95 / 150.95 / 106.95** | 3 × 282.95 → **3 × 106.95** | 3 × 282.95 → **3 × 106.95** | 3 × 282.95 | 3 × 234.95 |
| The Resources head | 25.91 (two lines) → **12.95** | 12.95 | 12.95 | 12.95 | 12.95 |
| A link's row | 44 | 44 | 44 | 44 | 36 (a mouse) |
| Overlapping link boxes | 2 → **0** | 1px touch → **0** | 0 | 0 | 0 |
| Links outside the wrap | 1 (11.33px) → **0** | 0 | 0 | 0 | 0 |

- **The footer's own top does not move on any page** (home: 13,225.66 / 12,482.92 / 11,830.86 at 320/360/390, before
  and after), so only the footer grows; the page grows by the same 125px at 320 and 94px at 360 and 390. At 640, 768 and
  1,440 the page is the same height as before, to the pixel.
- At 320 the labels now read whole in their groups: Product is 2 + 3 (Overview, What it shows; Try the demo, Pricing,
  Security), Resources 2 + 3 + 1 (Documentation, Quickstart; Deploying, Operating, Changelog; Source code) and Company
  4 + 1; at 360 every group is two rows (Product 3 + 2, Resources 3 + 3, Company 4 + 1). Every link is 44px tall, the
  narrowest is "Terms" at 44 × 44, and no link's right edge passes the wrap: at 360 the widest ends are 333 of 344
  (Product), 328 of 344 (Resources) and 288 of 344 (Company), and at 320 they are 269, 290 and 288 of 304.
- No page scrolls sideways at 320, 360, 390, 768 or 1,440 in either theme (**0** on all 70 page/width/theme pairs), the
  probe reports **0** console errors, **0** axe-core WCAG 2.0/2.1/2.2 A and AA violations on all seven pages at 320,
  360 and 1,440 in both schemes, and the smallest computed text is **12px**.
- Without a script the home page is **14,126 / 13,319** at 320/360 (was 14,001 / 13,225) and pricing **13,471 / 12,482**
  (was 13,346 / 12,388), 0px over; at 768 and 1,440 they are unchanged. With `forcedColors: active` at 360 every page is
  the normal height, 0px over. Print at 794 is **12,326** (home) and **10,273** (pricing), unchanged: the footer is not
  printed, as before. At a 24px root every page is 0px over at 320, 360 and 720, and the footer is **1,119.8 / 1,044.6**
  at 320/360. At a 32px root the page's recorded debt is unchanged (home 40px over at 320, 20 at 360) and the footer has
  **0** overlapping boxes; this pass adds no overflow.
- The 16 links, three group names, three `nav` landmarks, the owner's contact line, the tagline and the legal block are
  exactly what they were; the current page's underline, the 44px rows, the no-script page, forced colours and print are
  untouched. `site.test.ts` holds the new rule and its reason; the site's own suites (150 tests over the `site*` files,
  pages workflow and UI-kit tokens) pass.

### What this pass deliberately left

- **The index is 125px taller at 320 and 94px at 360/390.** That is the price of every label being whole where a third of
  the phone cannot hold it; at 421 and up the three columns return and the footer is 94px shorter again. No link is hidden
  behind a disclosure, and the footer is still far shorter than the two-column one the previous pass replaced.
- **At 421–639 the index is still three columns.** At 421 "Documentation" is 117px in a 116.3px column but still 19px
  from Contact; from 422 the column is wide enough, and the 20px gap holds to 639. A wider system font would eat that gap
  before it collided with the next group; the phone widths the owner reads are the wrapped ones.
- **The contact email is still 18px outside the wrap at a 32px root.** That is the recorded large-text debt of the
  footer's address line, not the index; it is unchanged by this pass and the page's overflow there is the same 40/20px as
  before.
- **No capture was retaken**: the footer is type and rules, not a picture.
- **`site/ux/` was not edited**, and `npm run site:check` still exits 1 on the owner's `TODO(owner)` for the terms at
  `site/legal/index.html:133`, as the last five passes recorded. The pass's pair is
  `site/ux/shots/20261029-0925-before.png` and `20261029-0925-after.png`.

## 2026-10-31: the first screen is a spread, and the record is set in a serif

Measured with the same probe (Chrome 156, reduced motion, light unless said, touch at 320/360/390, a mouse at 768 and
1,440, dark at 320/360/390/768/1,440, print at 794, a 24px and a 32px root at 320/360/720). The before column is the site at
`dbb4b58`, exported from `git archive` and served on a second port, measured in the same run; no number is copied from an
earlier pass.

### What changed

- **The statement and the section heads take a display serif.** The site is the public half of a ledger, and a printed record
  is set in one: `--display` is a stack of system serifs (Georgia, Iowan Old Style, Palatino, Book Antiqua, Liberation Serif,
  DejaVu Serif, Noto Serif) and only `h1`/`h2` take it. The ramp's sizes do not move (40/60.7/76 for the home `h1`, 28/36.8/48
  for an `h2`); the serif gets the leading and tracking it needs (1.05/1.12, −.028em/−.02em). A card's title (`h3`), the
  body, the labels and every figure that is compared stay in the text face, as the README's "Figures" rule says; a footer
  group's name is a label and stays sans. 42 of the seven pages' 63 `h1`/`h2` take the serif (the other 21 are the footer's
  three group names on each page). No face is downloaded and no request is made.
- **On a desk the first screen is a spread, not a banner.** The hero's grid is 7/5 at 1,040 and up: the statement, the lede,
  the actions and the price line in the left column, and the console in the right one, level with the statement. Before, the
  picture was a full-width 1,440px window below everything, 1,118 × 699 at a 0.78 scale, beginning at y=682, so an 800px
  screen held 173px of it. It is a 453 × 553 plate now, beginning at y=177 and wholly inside a 900px screen, and the price
  section follows one screen lower.
- **The plate is a 1:1 crop of the same capture, at every width.** The whole 1,440 × 900 window shrunk to a phone's 326px
  made the console's own 13px text about 3px. The `img` is `object-fit: none` with an `object-position` that starts past
  the sidebar, at the goal, so the mission's own answer (Delivered, 7 of 7 checks, 9.2s) is read at 13px: 326 × 260 at 360,
  704 × 440 at 768, 451 × 420 at 1,440. The frame's Full size link still opens the whole capture. One caption height holds
  the three views (3 lines at 1,440, 4 at 360, 5 at 320), so switching a tab moves nothing below the plate.
- **The plate's control is the plate's width.** The three view labels were a 351px trough over a 1,118px plate; they are
  now a grid of the plate's own width at every breakpoint, so the control and the picture share both edges, as the phone's
  already did.

### Measurements after this pass

| The home page at | 320 | 360 | 390 | 768 | 1440 |
|---|---|---|---|---|---|
| Before | 14,082 | 13,255 | 12,577 | 12,534 | 12,259 |
| After | **13,994** | **13,140** | **12,575** | **12,331** | **11,435** |

| The home page at 1,440 | Before | After |
|---|---|---|
| The hero | 1,660.67 | **918.47** |
| The statement | 155.03 (2 lines, 1,120 wide) | **239.39** (3 lines, 643 wide) |
| The actions | y=340.83, right column | **y=570.19, left column** |
| The price line | y=496 | **y=702.97** |
| The plate's tabs / frame / image | 624.34 / 682.34 / 727.34 | **119 / 177 / 222** |
| The image | 1,118 × 698.75, 0.78 scale | **450.67 × 420, 1:1** |
| The image inside an 800px screen | 173 of 699px (25%) | **420 of 420 (100%)** |
| The proof | y=1,573.48 | **y=831.28** |
| The contents row / `#pricing` | 1,729.67 / 1,827.67 | **987.47 / 1,085.47** |

| The home page at 360 | Before | After |
|---|---|---|
| The statement | 163.19 (4 lines) | **126 (3 lines)** |
| The actions | y=499.55 | **y=462.36** |
| The price line | y=563.55 | **y=526.36** |
| The image | 326 × 203.75, 0.23 scale | **326 × 260, 1:1** |
| The image's top / inside an 800px screen | 789.56 / 10px | **752.38 / 48px** |
| The contents row / `#pricing` | 1,564.22 / 1,758.22 | **1,583.28 / 1,777.28** |
| The page | 13,255 | **13,140** |

| At 768 | Before | After |
|---|---|---|
| The statement | 185.63 (3 lines) | **127.41 (2 lines)** |
| The image | 704.55 × 440.33, 0.49 scale | **704.55 × 440, 1:1** |
| The image's top | 836.2 (not in an 800px screen) | **777.98** (22px in it) |
| `#pricing` / the page | 1,711.78 / 12,534 | **1,653.23 / 12,331** |

| Page, height at 360 before / after | Pricing | Docs | Security | Contact | Legal | 404 |
|---|---|---|---|---|---|---|
| 360 | 13,721 / **13,612** | 8,443 / **8,382** | 11,625 / **11,600** | 4,473 / **4,381** | 5,059 / **5,037** | 2,123 / **2,089** |
| 1,440 | 9,382 / **9,354** | 4,422 / **4,429** | 7,634 / **7,638** | 2,850 / **2,857** | 3,307 / **3,313** | 1,514 / **1,516** |

- The serif is narrower than the text face, so it costs a phone nothing and saves it lines: the home statement is one line
  shorter at 360 and one at 768, and the six inner pages are 22–109px shorter at 360. At 1,440 the extra leading on a one-
  line `h2` costs 2–7px on five pages, which is the price of the serif's 1.12 line-height.
- No page scrolls sideways at 320, 360, 390, 768 or 1,440 in light or dark (**0** on all 70 page/width/theme pairs), the
  probe reports **0** console errors, the smallest computed text is **12px** on every page, and the worst text pair is
  **5.61:1** in light and **6.57:1** in dark, as before (AA normal text needs 4.5). The only targets under 44 × 44 at
  320/360 are the same inline links in sentences, the 1 × 1 radios and the 24 × 24 checkbox whose label is 44; the plate's
  tabs are 44 on a coarse pointer and its Full size chip is 44.
- Switching the plate's three tabs leaves the frame at **553.5px at 1,440, 554 at 768 and 413 at 360** for Overview, Events
  and Designer; the page height does not move. The three crops are the goal's answer, the Events log and the Designer canvas.
- Print at 794 is **0px over** on all seven pages (home 12,006; pricing 10,198; docs 4,668; security 7,509; contact 3,076;
  legal 3,082; 404 1,123), and the plate prints the whole capture, not the crop (`height: auto; object-fit: fill`). At a
  24px root and at a 32px root every page is **0px over** at 320, 360 and 720.
- `site-chrome --check` passes; the site's own suites are **159** tests, all passing. `npm run site:check` still exits 1 on
  the owner's `TODO(owner)` for the terms at `site/legal/index.html:133`, as the last six passes recorded.

### What this pass deliberately left

- **The statement is three lines in the desk's 643px column** where it was two across 1,120. That is the spread: a statement
  beside a product is narrower than a banner over one, and the plate's 553px sets the first screen's height with it. The
  price line is still on the first screen (y=703), and the section that sells the plans is 742px higher.
- **The crop cuts a line at its right edge.** The plate is a window on a 1,440px console; the goal's title, the Events
  filters and the Designer's inspector continue past it, as they would in a narrow window, and the Full size link opens the
  whole capture. A fade would have taken the RAN FOR figure with it; a narrower plate would have shown less.
- **The phone still reaches the product one flick down.** At 360 the statement, the lede, the actions and the price take
  the first 641px; the plate's tabs begin there and its image at 752, so the first screen holds 48px of the crop. Taking more
  would mean cutting the price line or the lede, which the last four passes measured and left.
- **The four plans, the comparisons, the console's six views and the footer are unchanged**, and no capture was retaken: the
  plate crops the pictures that were already there.
- **The serif is a system face**, so a Linux pass container draws it with Liberation Serif and a Mac or Windows reader gets
  Georgia; the sizes, the ramp and the contrast are the same. No webfont is added, and the site still makes no request.
- `site/ux/` was not edited: that record page is owned by another pass.

## 2026-10-31, second pass: each of the plate's three views is cropped to the thing it is about

Measured with the same probe (Chrome over CDP, reduced motion, light unless said, touch at 320/360/390/719, a mouse at
768/1,040/1,440, print at 794 and at 360, forced colours at 360, a 24px root at 320/360). The before column is the site at
`5d9c20d`, exported with `git archive` and served on the same port before any edit, measured in the same run; no number is
copied from an earlier pass. The landmarks below (a row's rule, a seat's card) were read from the captures' own pixels
with a scan of each image, not from an earlier record.

### What changed

- **Each of the plate's three views has its own crop on a phone.** The three panes shared one `object-position`
  (`20% 9%`), so the 326 × 260 window at 360 began at **y = 57.6** of the 1,440 × 900 art. That is the Overview's goal,
  and it is only the Overview's: the Events log's first bucket is at **y = 306** of its capture and its first row at
  **345**, and the Designer's canvas starts at **304** with its first row of seats at **410**, so the Events tab ended
  on the filter row and the Designer tab on its Add seat toolbar. The window is stated in the capture's own pixels now,
  one aim per view: **−223 / −58** (the goal, where it already was), **−231 / −300** (the page's content column and the
  log's first bucket) and **−219 / −340** (above the seats, with the window's right edge on the seat beside explorer at
  360). At 360 the Events crop holds the bucket, the red "pm could not be woken" row and two more rows; the Designer
  crop holds the explorer and security seats and the wires leaving them.
- **The window is the same at every phone width.** A percentage is relative to the window, so the same `20%` began the
  crop at **222.8** at 360 and at **156.1** at 719 — 75px of the console's sidebar at the widest phone. The four phone
  widths now show the same pixels of the art (223 / 231 / 219 at 320, 360, 390 and 719), and no sidebar at any of them.
- **Nothing above 719 moved.** 720–1,039 keeps its 440px window and `30% 14%`, and 1,040 and up its 420px and `23% 14%`,
  where each crop already reaches its view's content: at 768 the bucket and **2 of the log's 8 rows** and the canvas's
  first **3 seats**; at 1,440 the same 2 rows. Only `max-width: 719px` changed, and no type, colour, radius or spacing
  step was added.

### Measurements after this pass

| The plate at 360 | Before | After |
|---|---|---|
| The window, in the art's pixels | x 222.8–548.8, y 57.6–317.6, one for the three panes | **223–549 / 58–318** (Overview), **231–557 / 300–560** (Events), **219–545 / 340–600** (Designer) |
| The Events tab | **0 of the log's 8 rows**, 0 of its 2 red lines (the crop ended 6px into the bucket's top rule at 306–311) | **3 of 8 rows, the first of them red** ("pm could not be woken: miss…"), the bucket and 3 folds |
| The Designer tab | **0 of the 7 seats** (the crop ended at 317.6, the canvas's first 13px) | **2 of 7 seats** (explorer 355–450, security 310–475) and their wires; 5 of the 7 are in the window's band |
| The art's box / the frame / the caption | 326 × 260 / 413 / 107 | **326 × 260 / 413 / 107**, all three tabs |
| At 719, the window | x 156.1–815.6 (75px of the sidebar) | **223 / 231 / 219** (no sidebar) |
| At 719, the two tabs | the page head | the three whole log sentences ("pm could not be woken: mission is completed", …); pm, explorer, architect, security and tech-lead |

| Page height at 320 / 360 / 390 / 719 / 768 / 1,040 / 1,440 | Before | After |
|---|---|---|
| Home | 14,041 / 13,116 / 12,623 / 11,591 / 12,347 / 10,739 / 11,476 | **unchanged, to the pixel** |

- `object-position` is paint, not layout: the art's box is the same at every width (286 × 260 at 320, 326 × 260 at 360,
  356 × 260 at 390, 659.5 × 260 at 719) and every height is the same — at a 24px root **20,500** at 360 and **22,821** at
  320 (0px over), measured with the old aim and the new one in the same run.
- No page scrolls sideways at 320, 360, 390, 719, 768, 1,040 and 1,440 in light, or at 360 and 1,440 in dark; **0**
  console errors; the smallest computed text is **12px**; no target changes size (the tabs are 44 on a coarse pointer and
  the plate's chip 44, as before).
- axe-core WCAG 2.0–2.2 A and AA: **0** violations on the home page at 320 with the Designer tab chosen, at 360 light,
  360 dark and 1,440 light. `ux-render` at 360 × 844 reports the **same 18** rows before and after (the closed phone
  menu's links, the cards that sit off the snap row, the 1px hairlines under the 3:1 boundary floor).
- Print prints the whole capture, not the window: at 360 the picture is **326 × 203.8** and at 794 **728.5 × 455.3**
  (`object-fit: fill`), so the aim has no effect on paper; the printed page is 12,080 at 794 and 13,642 at 360, 0px over.
  Without a script the page is 13,115 at 360; with `forcedColors: active` it is 13,116.

### What this pass deliberately left

- **At 390 the Designer crop shows 30px of the seat beside explorer** (219 + 356 = 575), as a narrow window on a canvas
  does; at 360 the window's right edge falls exactly on that seat's border, and at 320 the seat is outside it.
- **A 326px window holds one column of the canvas**, so the Designer tab shows 2 of the 7 seats however it is aimed: the
  seats are about 165px wide with 95px between them, and three of them span 425px. The other five, with who may contact
  whom, are one press away in the Full size capture.
- **The Events crop cuts its rows' sentences** at 360 ("pm could not be woken: miss…", whole at 719): a 326px window of
  a 1,440px log holds the time, the mark and 130px of the message; the reason column is only in the full size.
- **At 1,040 the Events caption is one line longer than the other two** (107 against the 87.5px min-height the three
  share), so pressing Events at that width moves everything below the plate by 7px (the frame 553.5 → 573). It is a band
  of widths below 1,100 — at 1,100 all three captions are 87.5 — and a caption's measure, not a crop; it was measured and left,
  and it is this plate's next job.
- **The pictures were not retaken**: the crop is a window on the captures that were already there, and `site/ux/` was not
  edited. The pass's pair is `site/ux/shots/20261031-0910-before.png` and `20261031-0910-after.png`, and the standing
  picture `site/ux/shots/landing-now.png` was taken again (the one it replaces was mostly blank below the hero: the lazy
  pictures and the sections below them had not painted when it was captured).
- `npm run site:check` still exits 1 on the owner's `TODO(owner)` for the terms at `site/legal/index.html:133`, as the
  last seven passes recorded.

## 2026-10-31, third pass: the plan you choose, and a price that agrees with itself

Measured with the same probe (Chrome 156 over CDP; reduced motion; light unless said; touch at 320/360/390, a mouse at 768
and 1,440; dark at all five; print at 794; forced colours at 360; a 24px root at 360; no script at 360 and 768). The before
column is the site at `d1979b5`, exported with `git archive` and served on a second port, measured in the same run; no number
is copied from an earlier pass.

### What changed

- **On a phone a plan is read one at a time, chosen by its name and its figure.** A card at 360 is **978px** tall — a screen
  and a quarter, once the tagline, both prices, three limits, four features, support and (on two plans) the roadmap are in it —
  and the four stood in one sideways snap row. Comparing two figures meant swiping at four different heights, and the row
  showed one card's figure at a time. The four names and their figures are one **2 × 2 chooser** now (each chip **160 × 62**
  at 360, the block **328 × 131** at **869**), so all four prices are on one screen, one press each; the card below is the plan
  chosen (**328 × 739** at 360, at **1,016**), and the comparison further down still lists every line of all four. The plans are
  **1,006 → 739px** at 360 and the row scrolls no more (**1,306 → 328** of scroll width). It is radios and CSS, so it works with
  no script; a chip's figure is the period the Annual/Monthly switch names; the chosen chip is a dot and a rule as well as a
  tint (and an outline in High Contrast), so it is not colour alone. From 720 four cards fit and the chooser is not shown.
- **The first figure is the same figure on the home page and on the page that sells it.** The hero line and the home rate card
  said **$149 / $599** (monthly) while the pricing page opened on **$124 / $499** (annual, which is the switch's first choice):
  the same plan had two prices, one page apart. The hero's line is now the pricing page's head line, in the period that page
  opens on — *Billed annually: Community is free; Team is $124 a month; Business is $499 a month; Enterprise is quoted.* — and
  the rate card's amount is the annual figure with the monthly one named beside it (*per month, billed annually; $149 billed
  monthly*). Nothing was invented: both figures come from the plan table, and the monthly one is still on the page, labelled.
- **The figures rank above the sentence they sit in.** The amounts in the hero line and the pricing page's head are bold and
  tabular (`<b>`, `font-variant-numeric: tabular-nums`), the site's rule for every figure that is compared; they read as four
  facts, not as a sentence to parse.
- **A card no longer says what the section already says.** "One host, one plan: a licence installs on a single host, and the
  three figures above are that host's." stood in **all four** plan cards and again in the paragraph under the table, where it
  belongs. The cards lost it: the card is **1,043 → 946px** at 1,440 and the page **150px shorter** at 768. What a card keeps
  is what only it says: its tagline, its figures, its limits, its includes, its support, its roadmap and its action.
- **Contact is in the phone's menu.** It was in the footer and in a plan button's `mailto:` and nowhere a thumb reaches in one
  press: a reader on the home page who wanted to ask a question had to scroll 12,000px or know the footer. The menu is six
  48px rows (**302px** tall) and marks the page you are on; the bar's four links are unchanged, because at 768 a fifth would
  sit within 20px of the actions.
- **The six views' index says where the row is, not only where it goes.** The 01–06 chips above the console row were
  destinations: a reader who had swiped to the fourth view still saw "01" as the only chip, so the index could not tell them
  where they were in a row of six. The chip of the card nearest the row's left edge is marked (`aria-current`, the same
  attribute the On this page bar uses) with a tint, a border and a line under the number, so it is not colour alone; the mark
  is placed from the row's own scroll, once a frame, and the row's `scrollLeft` 0 / 322 / 1,590 marks **01 / 02 / 06**. It is
  not shown from 720, where the six are a grid and every one is on screen.

### Measurements after this pass

| Page, height at 320 / 360 / 390 / 768 / 1,440 | Before | After |
|---|---|---|
| Home | 14,082 / 13,140 / 12,575 / 12,347 / 11,435 | **14,035 / 13,180 / 12,616 / 12,388 / 11,435** |
| Pricing | 15,075 / 13,612 / 12,967 / 10,321 / 9,354 | **14,522 / 13,491 / 12,869 / 10,171 / 9,256** |
| The other five pages | unchanged | **unchanged** |

| Pricing at 360 | Before | After |
|---|---|---|
| The plans section | 1,724 | **1,603** |
| Its content (the row / the chooser + card) | 869, **1,006** tall | **869, 131** then **1,016, 739** |
| The first plan's figure | **1,018**, one at a time | **869–1,000**, all four |
| The page | 13,612 | **13,491** |

| The home page at 360 | Before | After |
|---|---|---|
| The hero | 1,514 | **1,514** (the price line is 81px in both) |
| The plate's first pixel | 752 | **752** |
| The rate card | 1,199 | **1,240** (three paid rows are one line longer) |
| The page | 13,140 | **13,180** |

- The pricing page is **553px shorter at 320**, 121 at 360, 98 at 390, 150 at 768 and 98 at 1,440; the cards are **946** at
  1,440 (were 1,043) and **739** at 360 (a full-width card wraps less, and the scope line is gone). The home page is 41px
  taller at 360–768 because each paid row now names both periods, and unchanged at 1,440 where the four columns had the line.
- No page scrolls sideways at 320, 360, 390, 768 or 1,440 in light or dark (**0** on all 70 page/width/theme pairs), **0**
  console errors, **0** axe-core WCAG 2.0–2.2 A and AA violations in **20** runs (home and pricing at five widths in both
  schemes), and the smallest computed text is **12px**. The targets under 44 × 44 are the same 1 × 1 radios (the four new
  choice inputs are 1 × 1, as the billing ones are) and the 24 × 24 checkbox whose label is 44.
- Without a script the pricing page is **12,252** at 360, 0px over, and the chooser works: the first card shows, the radios
  are real. With `forcedColors: active` at 360 it is 13,585 (with Business chosen) and the chosen chip keeps a 2px outline;
  at a 24px root **22,207** (22,422 with Business chosen), 0px over. Print at 794 is **0px over** on all seven pages and prints
  the **four** cards, not the chooser.
- `tests/build/site.test.ts` now holds the chooser (four chips, one card, the switch's period in the chip, the chooser hidden
  from 720) in place of the snap row it held before, `site-copy.test.ts` holds the hero line to the annual figures, and
  `site-script.test.ts` holds `nearestStart` (the row's position to a chip) and the line that marks it. All three are changes
  of a pinned shape the pass made on purpose, not of a claim.

### What this pass deliberately left

- **The home page is still 13,180px at 360 — 16.5 screens.** The length is nine argument sections of the owner's copy; this
  pass changed what the price says and how a phone chooses a plan, not how many words the arguments take.
- **Three of the four cards are not in the page at a phone width** (`display:none` until chosen). What the comparison below
  does not repeat is each plan's *includes* list, so a reader must choose a plan to read what it adds. A chooser that kept
  four includes lists would be the 1,006px row again.
- **The cards still repeat the roadmap on Business and Enterprise** ("Planned, not included: …"), and the comparison still
  repeats the limits. Both are the exporter's blocks, and the notice under the plans says the same for the section.
- **The bar's navigation still has four links.** Contact is in the menu and the footer; a fifth link at 768 would sit within
  20px of the actions. A bar that drops the wordmark to make room is a larger change than this pass.
- **Curule Cloud's prices are still in the app**, as the last seven passes recorded, and **no capture was retaken** (the
  console is being redesigned in parallel).
- `npm run site:check` still exits 1 on the owner's `TODO(owner)` for the terms at `site/legal/index.html:133`, and
  `site/ux/` was not edited. The pass's before and after frames — the landing page at its top, and the pricing page's plans —
  were handed to the /ux page with the report; they are not in `site/ux/`, which belongs to that page's own pass.

## 2026-10-31, fourth pass: the demo is one sequence, and its commands are the step's

Measured with the same probe (Chrome over CDP, reduced motion, light unless said, touch at 320/360/390, a mouse at 768 and
1,440, dark at all five, print at 794, forced colours at 360, a 24px and a 32px root at 320/360, no script at 360/768). The
before column is the site at `fd913ac`, exported with `git archive` and served on a second port (8110), measured in the same
run; no number is copied from an earlier pass.

### What changed

- **The demo's cost is four facts, not a sentence.** "You need Docker and git; the first command uses `openssl`, and any random
  string of 32 or more characters is a token." was three lines (77px at 360, 51 at 1,440). It is a `ul.try-facts` of four
  one-line facts now — Docker and git, No API key, 32+ character token, Mission: seconds — **77 → 48px at 360** (two rows)
  and **51 → 22px at 1,440** (one row). Every fact is already in the deployment guide ("Try it in a minute, with no API key",
  the 32-character token, the mission "in a few seconds"); no number is new.
- **The step is the number, the heading and the Copy button on one line, and the command takes the column.** At 719px and
  below the step is a `28px / 1fr / auto` grid: the number is static instead of a 36px absolute circle, the vertical rail is
  gone, and the code block spans the column — **272 → 328px at 360 (+20.6%)** and **232 → 288px at 320**. The 48px Terminal
  band is gone from the demo's three blocks; the Copy button belongs to the step, stands on its heading line, and is 44px on
  a coarse pointer (36px on a mouse). The heading keeps 48px clear of it only while the script has put the button there
  (`.try > li:has(.code-bar) h3`), so a page with no script has a full-width heading and no empty gutter.
- **The three commands are broken where a shell breaks them.** The token is `export MESH_API_TOKEN=\` + `"$(openssl rand
  -hex 32)"`; the run command is one flag per line, with `-e MESH_API_TOKEN=\` + `"$MESH_API_TOKEN"`; at a phone the build
  URL fills its line (`word-break: break-all`) instead of leaving `git clone` alone while the URL moves whole to the next
  line. The copied text is the same command, and `site-copy.test.ts` pins the new line breaks.
- **The fourth step is an instruction and two notes.** Its first paragraph was eight lines (192px at 360) carrying the URL,
  the token, the project, the button, the seven agents, the mission and the block. It is now the instruction (3 lines, 72px),
  "what you'll see" (4 lines, 84px at 14px) and "your own credentials" (3 lines, 64px at 14px); the step is **334 → 297px**.
  The 14px note is a new rule (`p.small` inside `.try`), so a note reads as a note and an instruction as an instruction.
- **The pricing page's Cloud answer is five lines.** "Flat monthly hosting, priced at sign-up and kept there. Your plan sets
  your workspaces; each is a host on its own plan. Your key, your provider's bill: we do not resell model usage." is **218 →
  181 characters**, **6 → 5 lines (144 → 120px)**; the Cloud card is **432 → 408px**, the licence card's height, and `#ways`
  is **1,002 → 978px**. Every claim is kept: the flat monthly hosting, where its prices live, the account's workspaces, each
  workspace on its own plan, your own key and provider bill, and no resale.

**The patterns that now bind.** A step in a recipe is its number, its heading and its Copy button on one line; the command
spans the column and carries no chrome of its own. A command is broken at a shell's own boundaries, never inside a token. A
note beside an instruction is 14px and muted; the instruction stays 15px. A demo's cost is a row of facts, not a sentence.

### Measurements after this pass

| The home page at 320 / 360 / 390 / 768 / 1,440 | Before | After |
|---|---|---|
| The page | 13,592 / 12,669 / 12,275 / 12,247 / 11,283 | **13,234 / 12,436 / 12,044 / 12,191 / 11,226** |
| `#try` | 2,025 / 1,832 / 1,788 / 1,380 / 1,239 | **1,667 / 1,599 / 1,557 / 1,324 / 1,182** |

| The demo at 360 | Before | After |
|---|---|---|
| The cost line / facts | 77 (3 lines) | **48 (2 rows)** |
| Step 1 / 2 / 3 / 4 | 307 / 352 / 314 / 334 | **285 / 277 / 243 / 297** |
| The three command blocks | 163 / 184 / 226 | **86 / 107 / 149** |
| Step 4's first paragraph | 192 (8 lines) | **72 (3 lines) + 84 + 64 at 14px** |
| The demo's words | 200 | **193** |

| The pricing page at 360 | Before | After |
|---|---|---|
| `#ways` | 1,002 | **978** |
| The Cloud card | 432 | **408** |
| Its "What you pay" | 144 (6 lines) | **120 (5 lines)** |

- No page scrolls sideways at 320, 360, 390, 768 and 1,440 in light or dark (**0** on the home and pricing pages' 20
  page/width/theme pairs; the other five pages changed only their stylesheet fingerprint), **0** computed text under 12px,
  **0** console errors. axe-core WCAG 2.0–2.2 A and AA: **0** violations on the home page at 360 light, 360 dark and 1,440
  light, and on pricing at 360 light.
- Without a script the home page is **12,414** at 360 and **12,190** at 768, 0px over; the four facts and four steps are
  there, and there are no Copy buttons. At a 32px root the page is **29,227** at 360 and **32,646** at 320, 0px over (the
  6/26px debt the last pass recorded did not appear in this run; this pass adds none). Print at 794 is **11,907** (11,963),
  0px over; `forcedColors: active` at 360 is **12,436**, 0px over.
- The site's own suites are **146** tests (the seven `site*` files), all passing; the full suite is **6,433** tests, 6,431
  pass and 2 skip. `site-chrome --check` and `pricing:check` pass; `npm run site:check` still exits 1 on the owner's
  `TODO(owner)` for the terms at `site/legal/index.html:134` (the line moved with the stylesheet fingerprint).

### What this pass deliberately left

- **"Make a token, and keep it" is two lines at 360 and 320.** The Copy button needs 48px of the heading's 280px column and
  the heading is 238px wide at 19px. One line would mean a smaller type size or a Copy button below the heading, which would
  cost the 44px row the Terminal band cost.
- **The build command's URL still breaks inside itself at 320** (`.../sal` / `itaba/...`): a 45-character URL in a 260px
  content box cannot fit, and the alternative (`overflow-wrap: anywhere`) leaves `git clone` alone on its own line at 360.
  The URL is one word to a browser; the Copy button copies it whole.
- **The Copy button is visually on the step's heading line but after the prose in the DOM.** It is still inside `.code`, so
  the focus order is heading, prose, Copy, commands, while the visual order is heading+Copy, prose, commands. Moving it out
  would change the docs page's copy-button structure too, and the button's name ("Copy these commands") says what it copies.
- **The two ways in (`#ways`, 978px at 360) and the nine argument sections are unchanged.** The page is still 12,436 at 360
  (15.5 screens) and the demo is 1,599 of it; the next saving is copy.
- **The captures were not retaken**, and `site/ux/` was not edited.

The next pass's first job is the two ways in (`#ways`, 978px at 360): two cards whose four answers repeat the pricing
page's, and the pricing page's Cloud card is now 408px, the licence card's height, so the row no longer has a tall card
setting it. After that, the page's length: 12,436 at 360 is 15.5 screens, and the console (`#product`, 3,868) and the nine
argument sections are where the words are.

## 2026-11-01, fifth pass: the two ways in answer once, in one paragraph each

Measured with the same probe (Chrome 156 over CDP; reduced motion; light unless said; touch at 320/360/390; a mouse at 768
and 1,440; dark at all five; print at 794; forced colours at 360; no script at 360 and 768; both Curule Cloud states). The
before column is the site at `8bf566c`, exported with `git archive` and served on a second port, measured in the same run;
no number is copied from an earlier pass. The absolute heights are this container's, where `system-ui` resolves to Noto Sans
and the home page is 12,891px at 360 before this pass where the record has 12,436; both halves are the same browser in the
same run, so the differences stand.

### What changed

- **The home page's two ways in answer in one paragraph each, not four labelled answers.** The card was a `<dl>` of two
  `dt`/`dd` pairs — a "Who it is for" row with a 16px person mark, a "What you pay" row with a 16px card mark, and the two
  sentences under them. That is the shape for comparing two ways line by line, and it is the pricing page's job, where the
  cards sit beside the four plans; on the home page the reader is choosing one. The title already answers "who it is for"
  ("We run it for you", "You run it"), and the two marks said the same two things four times. Each card is now a `h3`, one
  `p.way-body`, and its one action: the head **73.38px** (unchanged), the body **168px at 360** (7 lines), the action 44.
  The four label rows (4 × 25.19) and the two answers' 14px gaps are gone, so the cloud card is **407.75 → 343.38** and
  the licence card **455.75 → 343.38**; the two cards are level at 360, and the section **1,026.05 → 849.30**.
- **The licence card stops quoting the rate card's limits.** "Nothing for the Community plan: one open project, up to ten
  agents, no licence key" was the rate card that ends 834px above it (2,731.37 against the sentence's 3,565.23 at 360),
  the same facts in words where the teaser states them in figures ("1 project open, 10 agents per mesh", "no licence key,
  no expiry"); it is **"The Community plan is free; a paid licence lifts the limits."** — the claim without the figures,
  which the four rows above state. It is the two lines (48px) of the card's saving. The four answers' words are
  **91 → 81**, the section's **134 → 114**, and the card's own **58/59 → 53/44**.
- **The section says the same things, in the order a chooser asks them.** Each body runs what the way is, then what it
  costs: *No server to run: sign up, pick a plan, open a workspace in a browser. Same console and agents, on our servers.
  Flat monthly hosting, priced on the sign-up page. Your own model key, billed by your provider: we do not resell model
  usage.* and *Your own infrastructure and model credentials, one container per team. Nothing phones home: no telemetry, no
  update check, no licence server. The Community plan is free; a paid licence lifts the limits. Source: Business Source
  License 1.1.* Every other claim is the card's own and is unchanged.
- **A lone way in reads in two columns, not one 1,120px line.** With Curule Cloud closed there is one card at the section's
  full width, and its old two answers sat side by side there. Its one paragraph now takes `columns: 2` with the same 32px
  gap at 760 and up (**measured `column-count: 2` at 768 and 1,440**), so the closed state keeps the shape it had: the
  card is **288.56 → 239.38** at 1,440 and **312.56 → 287.38** at 768.
- **The tests hold the two shapes and the reason.** `site-cloud.test.ts` now checks that each home card carries no `dt` and
  one `p.way-body` (the pricing page's four labels are checked by `site-copy.test.ts`, which now reads the two pages
  separately), and it pins the new licence sentence. `site.test.ts` has a new test for the paragraph's margins at both
  widths, the two-column rule, and the two pages' shapes. Breaking any of them fails.

### Measurements after this pass

| Page, height at 320 / 360 / 390 / 768 / 1,440 | Before | After |
|---|---|---|
| Home | 13,749 / 12,891 / 12,450 / 12,312 / 11,418 | **13,548 / 12,714 / 12,273 / 12,194 / 11,300** |

The six other pages are unchanged at every width: pricing 14,424 / 13,427 / 12,878 / 10,165 / 9,270; documentation 8,929 /
8,358 / 8,083 / 5,308 / 4,448; security 12,479 / 11,552 / 10,809 / 7,884 / 7,590; contact 4,707 / 4,381 / 4,215 / 3,413 /
2,857; legal 5,565 / 5,037 / 4,743 / 3,419 / 3,313; 404 2,266 / 2,089 / 2,045 / 1,437 / 1,516. Only their stylesheet
fingerprint moved.

| The home page at 320 / 360 / 390 / 768 / 1,440 | Before | After |
|---|---|---|
| `#ways` | 1,153.23 / 1,026.05 / 1,002.05 / 646.28 / 651.48 | **952.48 / 849.30 / 825.30 / 527.91 / 533.11** |
| Its two cards | 486.94 and 503.75 / 407.75 and 455.75 / 407.75 and 431.75 / 477.75 and 477.75 / 405.75 and 405.75 | **398.56 and 391.38 / 343.38 and 343.38 / 319.38 and 343.38 / 359.38 and 359.38 / 287.38 and 287.38** |
| The section's words | 134 | **114** |

| The home page at 360, light | Before | After |
|---|---|---|
| The section | 3,016.94–4,042.98 | **3,016.94–3,866.24** |
| A card's head / body / action | 73.38 / 72 + 96 (3 + 4 lines) / 44 | **73.38 / 168 (7 lines) / 44** |
| The second card's head / body | 73.38 / 96 + 120 (4 + 5 lines) | **73.38 / 168 (7 lines)** |
| The four labels | 4 × 25.19px, four 16px marks | **none** |
| `#product` / `#try` / the footer | 4,042.98 / 4,896.08 / 12,052.80 | **3,866.23 / 4,719.33 / 11,876.05** |

- The section loses **176.75px at 360 and 390, 200.75 at 320, and 118.37 at 768 and 1,440**; the page loses the same, and
  nothing above it moves: the contents row (1,583.28) and `#pricing` (1,777.28) are the same at 360, and the footer is
  176.75px higher only because the section is shorter.
- **The two cards are level at 360, 768 and 1,440** (343.38 each, 359.38, 287.38) because the two bodies are within a few
  characters of each other (236 and 239). At 390 the licence body takes one line more (**319.38 against 343.38**), and at
  320 the cloud card's title wraps to two lines (**398.56 against 391.38**: 31.18px of head, not body).
- **The closed state** (Curule Cloud off): the one card is **455.75 → 343.38** at 360, **312.56 → 287.38** at 768 and
  **288.56 → 239.38** at 1,440; the section is **633.66 → 521.28** at 360 and **534.30 → 485.11** at 1,440, and the page
  **12,294 → 12,182** and **11,262 → 11,212**.
- No page scrolls sideways at 320, 360, 390, 768 or 1,440 in light or dark (**0** on all 70 page/width/theme pairs), the
  probe reports **0** console errors, and **0 axe-core WCAG 2.0/2.1/2.2 A and AA violations** on the home page and on
  pricing at 360 light, 360 dark and 1,440 dark. The smallest computed text is **12px** on every page and the census below
  12px is empty at every width in both schemes.
- Without a script the home page is **12,869 → 12,692** at 360 and **12,311 → 12,193** at 768, 0px over, and the cards are
  the same two paragraphs with no labels (4 `dt` before, 0 now). With `forcedColors: active` at 360 it is **12,891 →
  12,714**, 0px over. Print at 794 is **12,045 → 11,927** and the section **650.14 → 531.77**, 0px over.
- At a 24px user default the home page is **0px over** at 320, 360 and 720: the section is **1,667 → 1,427.81** at 360 and
  the cards **726.98 and 752.19 → 643.39 and 596.59**, the 46.8px difference being the cloud title's second line at 36px,
  not its body. At a 720px viewport (the 200% stand-in) the page is **12,490 → 12,313**, 0px over.
- The target census is unchanged: the two ways hold one 286 × 44 button each at 360, and the only targets under 44 × 44
  are the same inline links in sentences ("Compare the plans", "the security page") and the 1 × 1 tab radios.
- `ux-render` at 360 × 844 reports the **same 19** rows before and after (the closed phone menu's links, the six tiles
  that sit off their snap row, and the 1px hairlines under the 3:1 boundary floor); the `.ways` box it measures is
  **879.5 → 702.75**.

### What this pass deliberately left

- **The pricing page's two ways keep their four labelled answers.** There the cards are a comparison beside the four
  plans, and the labels ("Who it is for", "What you pay") let a reader read the two cards line by line; the same component
  therefore has two shapes, and the stylesheet says which page gets which. Its cards measure 407.75 and 431.75 at 360
  today — the licence card is one line taller than the Cloud card, so that row is still set by the licence card (the
  queue's "408px" is the Cloud card's height), and its five lines are the sentence the plans' limits are pinned in.
- **The two cards' opening sentences are the pricing page's.** "No server to run: sign up, pick a plan, open a workspace in
  a browser." and "Your own infrastructure and model credentials" state what each way is, and two pages that state one
  fact in two phrasings drift; what the home page's card no longer carries is the comparison's detail (the limits, the
  workspace-per-plan sentence, the pointer to the plans).
- **The licence card still closes with "Source: Business Source License 1.1."** The last pass kept the label rather than
  the full sentence and it now ends a paragraph instead of a `dd`; the licence's name is intact, and the footer and the
  FAQ print the sentence.
- **The section still has no lede.** Its two cards are its answer, and a sentence above them ("the same runtime, on our
  servers or yours") would be a fifth sentence for a fact both cards already state.
- **The page is still 12,714px at 360 — 15.9 screens.** This pass took 177px of a component; the console (`#product`,
  3,866.23), the demo (`#try`, 4,719.33) and the nine argument sections are where the words are.
- **The captures were not retaken**, and `site/ux/` was not edited. This pass's frames — the home page's `#ways` at 360
  and 1,440, the section's head under the bar and its second card — were handed over with the report.

The next pass's first job is the page's length: 12,714px at 360 is 15.9 screens, and the six console views (`#product`,
3,866.23, 853.09px tall) and the four demo steps (`#try`, 4,719.33, 1,666.73) are 2,519.83px of it, with the nine argument
sections after them. After that, the documentation row's third chip and the pricing page's cards' repeated roadmap, both
left as they were.

## 2026-11-01, sixth pass: the index that stays, and the price 133px sooner

Measured with the same probe (Chrome 156 over CDP; reduced motion; light unless said; touch at 320/360/390, a mouse at 768 and
1,440; dark at all five; print at 794; forced colours at 360; no script at 360; a 24px and a 32px root at 320 and 360). The before
column is the site at the branch's own start (`bede609`), served on a second port and measured in the same run; no number is copied
from an earlier pass. The absolute heights are this container's, where the untouched page reads **12,284** at 360 where the fifth
pass's entry quotes 12,714 — both halves are one browser in one run, so the differences stand, and every claim below is about a
difference.

### What changed

- **The home page's contents index is the On this page bar the other four long pages have.** The index was four rows of two chips
  (**194px** at 360, 98 at 768 and 1,440) between the hero and the price, and it scrolled away: reading the security section
  (its top at 8,771.9, with a frame at 8,700) the index's own top was **7,165px** above the frame, and a phone's header hides its
  four section links below 600, so it offered four other pages, Contact and `#product` — seven of the page's eight sections could
  not be reached at all without scrolling. It is
  a `nav.toc-bar` with a `ul.toc` now, the same markup as `pricing/`, `docs/`, `security/` and `legal/`: **61px**, one row, and the
  script's own machinery — pinned at 69 under the header (`is-live`), the section being read marked (`aria-current`, a tint, a
  border and a 6px dot), the row scrolled to keep that chip and 24px of its neighbour in view, the edge shadowed where there is
  more (`is-more` at 320/360/390/768; none at 1,440, where the eight chips are 1,440 in 1,440), and the chip brought wholly into
  the row when the keyboard reaches it. Nothing in `assets/site.js` is new: the bar is the component, not a second one.
- **A chip keeps its ledger number.** "01 Plans and prices" … "08 Questions", each number in the 12px tabular figure the sections'
  eyebrows already use (`.toc .n`, 12px, `--muted`, `min-width: 2ch`), so the strip's numbering and the bar's chips are one set of
  eight. The label is 14px, the bar's, where the strip's rows were 15px; a chip is 44px tall where a row was 48.
- **The strip's own rules are gone, not kept beside the bar.** `.index`, `.index ol`, `.index a`, `.index span`, the 720px
  four-column rule and `.index + .section` are deleted; `.toc-bar + .section` already gives the price its 32px under the bar.
  `html:has(.toc-bar)` now gives the home page `scroll-padding-top: 150px`, so a followed section lands below the header **and**
  the bar (it landed at 88), and the bar's own `--toc-h` (61 = a 44px chip, 8 above and below, its line) is the shared one.
- **The page is 133px shorter at a phone's widths, and the price comes up with it.** At 360: the price section 1,729.3 → **1,596.3**,
  its head 1,761.3 → **1,628.3**, the first plan row 2,040.9 → **1,907.9**, its figure 2,054.9 → **1,921.9**, the two buttons
  2,821 → **2,688**, and everything below by the same 133 (the console 3,818.3 → 3,685.3, the demo 4,647.3 → 4,514.3, the reasons
  6,246.3 → 6,113.3, security 8,771.9 → 8,638.9, the questions 10,201.8 → 10,068.8, the footer 11,490.4 → 11,357.4).
- **The tests hold the bar's shape and the reason.** `site-script.test.ts` now counts the home page among the pages with a bar, and
  its shape assertion accepts the hero (the document pages open on a `page-head`); the chip reader accepts the ledger number and
  still demands one plain link per section, in the page's order. `site.test.ts`'s contents test reads the bar (its ground and rule,
  a 44px chip, the number's 12px tabular figure, `#pricing`'s 32px under it, and that no `.index` rule survives) and the large-text
  test pins the number's fixed 12px with the row's own sideways scroll in place of the strip's wrap rules. The reduced-motion test
  now says what it means: nothing below the first screen is watched, and the only observer left is the bar's, over eight sections
  it never hides. No promise was weakened: five tests' assertions changed with the shape they measured (the bar's shape, one
  chip per section, the reduced-motion observer, the contents strip, and the large-text rules).

### Measurements after this pass

| The home page, height at 320 / 360 / 390 / 768 / 1,440 | Before | After |
|---|---|---|
| | 13,058 / 12,284 / 11,892 / 12,113 / 11,107 | **12,925 / 12,151 / 11,759 / 12,076 / 11,070** |

The six other pages are unchanged at every width; only their stylesheet fingerprint moved (64f1f90d78).

| The index at 360 / 768 / 1,440 | Before | After |
|---|---|---|
| The block | 194 / 98 / 98, four rows of two chips (four columns from 720), in the flow | **61 / 61 / 61, one row, pinned at 69** |
| A chip | 164 × 48 / 177 × 48 / 280 × 48 | **92–170 × 44, the row 1,143 / 1,172 / 1,440 wide** |
| The row's own scroll | 328/328, 707/707, 1,120/1,120 (a grid: none) | **1,143 in 360, 1,172 in 768, 1,440 in 1,440 (no shadow at 1,440)** |
| The names on screen at rest | all eight | **two (a swipe; the row follows the reading position)** |

| At 360, light | Before | After |
|---|---|---|
| A followed section lands at | 88 | **150** (all eight, cold and from the top) |
| At scroll 8,700: what names the section | nothing (the index 7,165px above) | **the bar at 69–130, "07 Security" marked, row at scrollLeft 655** |
| The bar's worst text pair, light / dark | — | **6.23:1 / 8.09:1** (marked chip; plain 11.31 and 11.53; the 12px numbers 6.58 and 7.64) |

- **No page scrolls sideways** at 320, 360, 390, 768 or 1,440 in light or in dark (10 page/width/theme pairs on the home page; the
  other six pages changed only their fingerprint), the probe reports **0** console errors, and **0 axe-core WCAG 2.0–2.2 A and AA
  violations** in three runs (360 light, 360 dark, 1,440 light). The smallest computed text is still **12px** on every page.
- **The targets** are the bar's 44px chips (92 × 44 to 170 × 44 at 360); the only controls under 44 × 44 are the same inline links
  in sentences, the Graph caption's 67 × 20 "Full size" inside its sentence, and the 1 × 1 radios.
- **Without a script** the bar is in the flow with no mark and one scrolling row: the page is **12,261 → 12,128** at 360, 0px over.
  **Print** at 794 is **11,813 → 11,828** (+15: the pills wrap over two rows, no sticky, no shadow, no edge). **Forced colours** at
  360 is **12,284 → 12,151**, 0px over, and the marked chip keeps `rgb(0, 0, 159)` and an outline. At a **24px root** the page is
  **19,009 → 18,789** at 360 and **20,962 → 20,690** at 320 (0px over); at **32px** it is **28,829 → 28,401** at 360 (0px over). The
  bar is 61 at a 24px root and **64** at a 32px root, so at 200% text a followed section lands 3px under it — the shared
  component's behaviour on the four document pages, inherited here rather than introduced.
- **The menu still covers the bar** when it is open at depth (the header's z 40 over the bar's 30), and the bar's own scroll
  containment keeps a swipe at the row's end from turning the page.

### What this pass deliberately left

- **The strip's at-a-glance map is what the bar costs.** At rest the reader sees two of the eight names in a 328px row where the
  strip showed all eight in 194px; the rest are a swipe, and the row follows the reading position so the section being read is
  always in view. The alternative — a bar that shows only the current section until it is opened — is a second state and a second
  component, and the four document pages already answer this question the way this pass does.
- **61px of a phone's screen stays pinned under a 69px header** while reading (16% of 800). That is the price the pricing, docs,
  security and legal pages already pay for the same bar, and the reason the page has not had it before is that its index was a
  block of four rows, which cannot stay: a pinned 194px is a quarter of the screen.
- **The page is still 12,151px at 360 — 15.2 screens.** The length is the argument: 1,464 words in a 328px measure, plus 856px of
  the ten bands' padding, 1,322px of section heads with 256px of gaps under them, and a 792px footer. This pass took the 133px the
  index was spending above the price; the cuts that would take a thousand or more are a disclosure around the four reasons or the
  demo's four steps, or moving them to another page, and both delete or hide sentences this record has refused twice for this page.
- **The captured pictures were not retaken**, and `site/ux/` was not edited. This pass's frames — the security section at 360 with
  and without the bar, and the bar above the price — were handed over with the report.
- `npm run site:check` still exits 1 on the owner's `TODO(owner)` for the terms at `site/legal/index.html:134`, as before.

The next pass's first job is the page's length, and the honest shape of it is editorial rather than structural: 12,151 at 360 is
15.2 screens of claims the record will not delete, so the only lever left is which of them the page states and which it leaves to
`pricing/`, `security/` and the documents. After that, the documentation row's third chip and the pricing page's cards' repeated
roadmap, both still as they were.

## 2026-11-02: the roadmap is said once, under the plans

Measured with the same probe (Chrome 156 over CDP; reduced motion; light unless said; touch at 320/360/390, a mouse at 768 and
1,440; dark at 320 and 360; print at 794; forced colours at 320 and 360; no script at 320, 360 and 1,440). The before column is
the site at `70ae013`, exported with `git archive` and served on a second port and measured in the same run; no number is copied
from an earlier pass. The
absolute heights are this container's, where the untouched home page is 12,151 at 360 as the last entry records; both halves are one
browser in one run, so the differences stand.

### What changed

- **The roadmap is said once, in the notice under the plans.** At 1,440 the page printed "Planned, not included" **three** times: on
  the Business card, on the Enterprise card — which includes everything Business does — and in the section's notice under them. A
  reader who chose Business at 360 met it twice 320.2px apart, the card's line at **1,644.1** and the notice at **1,964.3**. The card
  renderer no longer prints a plan's `roadmap`; the section's notice is the one statement, in the place a reader choosing a plan
  reads it. The plan table and the JSON keep each plan's `roadmap`: the data was never the duplicate, the card was.
- **The one statement is the fuller one, and it names OIDC.** The notice keeps its explanation ("Today there is one shared operator
  credential: put the instance behind your VPN or an authenticating proxy.") and takes the card's "(OIDC)", which the old notice had
  dropped: *Planned, not included: single sign-on (OIDC), per-operator identity and roles, and audit-log export with operator
  identity are on the roadmap.* Every claim the two cards made is in it, and the security page's own sentence is unchanged.
- **The notice stands directly under the cards.** It was after the model-usage note; it is now immediately under the plan cards and
  before "Plan prices are for the runtime…". With Business chosen at 360 it is **1,964.3 → 1,745.1**, **49px** under the card's
  action (was 185), and at 1,440 **1,890.8 → 1,716.4**.
- **A card ends on its action.** Removing the line left the meta block's last paragraph with a dangling 8px bottom margin;
  `.plan-meta p:last-child` now has none. So Community and Team lose 8px too (**690.6 → 682.6** and **612.3 → 604.3** at 360), and
  the `.plan-planned` rule is gone with the paragraph.

### Measurements after this pass

| Pricing, height at 320 / 360 / 390 / 768 / 1,440 | Before | After |
|---|---|---|
| The page | 13,925 / 12,976 / 12,467 / 10,047 / 9,095 | **13,917 / 12,992 / 12,459 / 9,956 / 8,990** |

| The plan cards | 360, before → after | 1,440, before → after |
|---|---|---|
| Community | 690.6 → **682.6** | 921.5 → **815.9** |
| Team | 612.3 → **604.3** | 921.5 → **815.9** |
| Business | 788.3 → **705.1** | 921.5 → **815.9** |
| Enterprise | 741.8 → **658.6** | 921.5 → **815.9** |
| The four-card row | — | 937.5 → **831.9** |
| The page with Business chosen | 13,073 → **13,014** | — |
| "Planned, not included" on the page | 2 (card + notice) → **1** | 3 → **1** |
| The card's own line | 67.2 at 360, 89.6 at 1,440 | **none** |

- The page is **105px shorter at 1,440** (9,095 → 8,990), 91 at 768, and 8 at 320 and 390. At 360 it is **16px taller**
  (12,976 → 12,992): the one statement now carries "(OIDC)", which makes it a line longer there (**198 → 222**), and the card a
  phone sees by default — Community — never had the repeated line, so it only loses its 8px margin while the notice gains 24. A
  reader who chooses Business is **59px** better off (**13,073 → 13,014**), and Enterprise the same (**13,027 → 12,968**).
- The page's words at 1,440 are **1,909 → 1,880** and its characters **10,933 → 10,700**; with Business chosen at 360,
  **1,773 → 1,759**. Nothing the notice said was dropped, and the detail it had shortened — the protocol, "OIDC" — is named
  again; what is gone is the repetition.
- No page scrolls sideways: the pricing page is **0px over** at 320, 360, 390, 768 and 1,440 in light, at 320 and 360 in dark,
  at 320 with forced colours and at 320 without a script, and at 794 in print. The six other pages changed only their stylesheet
  fingerprint, and the two rules this pass touched (`.plan-meta`, `.plan-planned`) are used on the pricing page only. Print at 794
  is **9,888 → 9,797**, no script at 360 **11,836 → 11,852** and at 1,440 **8,635 → 8,530**, and `forcedColors: active` at 360
  **12,976 → 12,992**: every one **0px over**. The smallest computed text is **12px** in all of them. The target census is identical
  before and after at every width (**13 / 12 / 14 / 25 / 41** controls under 44 × 44 at 320/360/390/768/1,440: the 1 × 1 radios, the
  24 × 24 checkbox whose label is 44, and the mouse's 36–40px rows at 1,440). axe-core WCAG 2.0–2.2 A and AA reports **0**
  violations on the pricing page at 320 light, 360 light, 360 dark, 768 light and 1,440 light and on the home page at 360, the same
  six runs before and after; the color-contrast *incomplete* census (28/28/28/78/72/46 nodes) is unchanged too.
- The chooser is where it was (**869–1,000** at 360), the visible card is still the chosen one, and the comparison table and the
  phone's plan stack are unchanged: the same seven rows with the same values. `tests/build/site-copy.test.ts` now fails unless no
  card says "Planned, not included", every item of the plan table's roadmap appears once on the page, and the notice sits between
  the cards and the price note; `tests/licensing/pricing-export.test.ts` holds the exporter's cards to the same. The build suites
  (`node --test "dist/tests/build/*.test.js"`) are **224** tests, all passing; `pricing:check` and `site-chrome --check` pass.

### What this pass deliberately leaves

- **The one notice speaks for all four plans, though only Business and Enterprise list the items.** It is the section's sentence,
  and a comparison row with four identical cells would be noise in a table that says what each plan gets.
- **At 360 the default page is 16px taller.** That is "(OIDC)" once, on the line the old notice already had, against the two card
  lines it replaces; the width where a reader meets the repeated cards, Business or Enterprise chosen, is 59px shorter.
- **The notice is still a warning panel.** It is a caveat about what is absent, not an explanation of a mechanism; the ruled-entry
  rule is for the latter.
- **The model-usage note now follows the roadmap**, so the plans section ends on the price caveat rather than a warning. Both are
  caveats; the roadmap is the one about the cards.
- The console captures were not retaken, `site/ux/` was not edited, and `npm run site:check` still exits 1 on the owner's
  `TODO(owner)` at `site/legal/index.html:134`.

The next pass's first job is still the page's length: at 360 the pricing page is 12,992 (13,014 with Business chosen), and the home
page is 12,151 over 15.2 screens. After it, the documentation row's third chip, which the last entry also queued.


## 2026-11-03: the documentation bar's three names, and the edge a row does not have

Measured with the same probe (Chrome over CDP in the pass container, where `system-ui` resolves to Noto Sans; reduced motion;
light unless said; touch at 320/360/390, a mouse at 768/1,280/1,440/1,600; dark at 360; print at 794; forced colours at 360;
a 24px and a 32px root at 320/360/720; no script at 360). The before column is the site at `e123059`, exported with
`git archive` and served on a second port and measured in the same run; no number is copied from an earlier pass. The absolute
heights are this container's (the record's home page at 360 is 12,151 where this container reads 12,581); both halves are one
browser in one run, so the differences stand.

### What changed

- **The documentation page's three sections fit its bar on a phone.** The bar is a row of chips that scrolls sideways where they
  do not fit, and the docs page has exactly three: Start here, The documents, Something missing. At 360 the chips were 114.56 +
  154.88 + 184.95 + two 8px gaps + the row's 32px of padding = 502px in 360, so the third began at 301 and **59 of its 185px**
  were on screen — the words "Some…" under the edge shadow; at 320 it was **19px**. Below 540 the three chips share the row (**104px each at 360, 90.7 at
  320, 114 at 390, 160.3 at 540**), each name wraps inside its 44px chip ("The documents" and "Something missing" on two lines,
  "Start here" one at 360), and the bar is still **61px**. The row is now exactly its viewport at 320/360/390/540
  (scrollWidth = clientWidth; no `is-more`, no shadow, no swipe); from 541 the natural row is unchanged. The labels are 14px and,
  at 340 and below, 12px — the floor: "documents" is 87px at 14 and 74.6 at 12, against 92px of chip at 360 and 78.7 at 320.
  The natural row needs 514px (502 + the 21.6px gutters at that width); 540 leaves 26px of slack for a wider system font (this
  container's font is about 4% narrower than the record's).
- **The section being read is marked with the site's current-page line, not the dot.** The dot costs 22px of padding, which would
  leave 70.7px for "documents" at 320; this row marks the current section with the **1.5px line, offset .22em**, that the header
  and footer give the current page, with the tint and the border it already had. In `forcedColors: active` at 360 the line is still
  `underline` and the marked chip is 104 × 44; the dot is hidden on this row only, and the other bars keep theirs.
- **A row with room no longer scrolls into its own padding.** The row's right padding was the centred column inset — 160px at
  1,440 — and a scroll container counts its end padding as scrollable overflow. The home page's eight chips are 1,215px, so at
  1,440 the row read **1,535px** of scroll (95px of padding, no chip cut), the script set `is-more` and drew the edge shadow with
  nothing behind it, and a drag moved the row 95px into blank. The right padding is now the gutter (32px at 1,440, 16 at 360);
  the left stays the column, which is what lines the first chip up with the page. The row is **1,440px at 1,440**, has no
  `is-more` and cannot scroll. The same correction on the security page at 1,600: its seven chips end at 1,541, so before the row
  claimed 181px of scroll and shadowed an edge with nothing cut; now it is 1,600px and says nothing. Where a chip really is cut the
  range is now only what is cut: at 1,440 the security row is **1,493** (was 1,621; 21px of "Reporting a problem" is cut, and the
  row ends with the 32px gutter, not 160px of blank); at 1,280 the home row is **1,327** (was 1,375; 15px cut).

### Measurements after this pass

| The documentation bar | 320 | 360 | 390 | 540 |
|---|---|---|---|---|
| The row, before | 502 in 320 | 502 in 360 | 502 in 390 | 502 in 540 (fits) |
| The third chip, before | 19 of 185 visible | 59 of 185 | 90 of 185 | 185 |
| The row, after | **320 (fits)** | **360 (fits)** | **390 (fits)** | **540 (fits)** |
| A chip, after | **90.7 × 44** | **104 × 44** | **114 × 44** | **160.3 × 44** |
| The third chip, after | **90.7 whole** | **104 whole** | **114 whole** | **160.3 whole** |
| The labels | 12px, 2 lines | 14px, 2 lines | 14px, 2 lines | 14px, 2 (third) |
| The bar / the page | 61 / 8,929 | 61 / 8,358 | 61 / 8,083 | 61 / 7,206 |

- The docs page's height is unchanged at every width: **8,929 / 8,358 / 8,083 / 7,206 / 5,308 / 4,403 / 4,448 / 4,460** at
  320/360/390/540/768/1,280/1,440/1,600, before and after, because the bar is 61px in both and the two-line labels fit its 44px chip.
  At 541 and 768 the row is the natural **114.6 / 154.9 / 185** in 541 and 768, unchanged; at 1,280/1,440/1,600 it is 185px wide at
  its last chip and ends at 550.4 / 630.4 / 710.4, unchanged.

| The bar at a desk | 1,280 | 1,440 | 1,600 |
|---|---|---|---|
| Home, scrollWidth before → after | 1,375 → **1,327** | 1,535 → **1,440** | 1,695 → **1,600** |
| Home, `is-more` before → after | on → **on** (15px cut) | on → **off** | on → **off** |
| Home, scroll range before → after | 95 → **47** | 95 → **0** | 95 → **0** |
| Home, the last chip's right edge | 1,295.1 | 1,375.1 | 1,455.1 |
| Security, scrollWidth before → after | 1,461 → **1,413** | 1,621 → **1,493** | 1,781 → **1,600** |
| Security, `is-more` before → after | on → **on** (101px cut) | on → **on** (21px cut) | on → **off** |
| Home / security page height | 11,081 / 7,590 | 11,263 / 7,590 | 11,314 / 7,590 |

- At 768 the rows are unchanged (the padding was already the gutter): home 1,277, security 1,363, docs 768; at 540/360/320 the same
  (home 1,258/1,247/1,247; security 1,345/1,333/1,333). **No page changes height** at any width; only the row's scroll range does.
- The docs page's three chips are **44px tall** at every width and the bar **61px**. The only targets under 44 × 44 on the page are
  unchanged (the three "start" cards' arrow links, whose card is the target, and the inline links in sentences).
- The docs page's worst text pair is **5.61:1** in light (the skip button); the bar's own are **6.23:1** for the marked chip
  (`#2150bd` on `#eaf0fc`) and **6.58:1** for a plain one (`#5d5a55` on `#fbfaf8`); dark is unchanged from the last pass (6.57).
- **A reader's larger text:** at a 24px root the docs chips are **91 × 44** at 320 and **104 × 44** at 360, the bar 61, and the page
  **13,844 / 12,650**, 0px over. At a 32px root they are 91/104 × 44, the bar 61, the page **20,692 / 18,463**, 0px over; at 720 the
  row is natural (880 in 720, bar 63.8, the bar's recorded 32px behaviour, unchanged). The labels keep their layout size (14, 12 at
  320) as the header's controls do, so the three names stay whole; the alternative — 28px labels in a 90px chip — cannot fit.
- **The other states:** without a script the page is **8,269** at 360, the row 360, 0px over, the three chips 104 × 44 and no mark;
  in dark it is 8,358, 0px over; print at 794 is **4,690**, the row natural (115/155/185) and 0px over; with `forcedColors: active`
  at 360 the marked chip's line is `underline` and the page is 0px over.
- The probe's failure list is identical before and after on the docs page at 360 (**14**) and on the home page at 1,440 (**37**):
  the closed phone menu's links, the three card links the probe reads as 25.59px targets, the 1px hairlines under its 3:1 boundary
  floor, and the mouse's 36–40px rows. Nothing was added to it.
- `tests/build/site.test.ts` adds **"a bar of three sections fits a phone's row, and a row with room no longer scrolls into its own
  padding"**: the sharing rule, the wrap and the 14/12px labels, the current-page line and the hidden dot, the `.toc` padding
  (right = the gutter), and that the rule is scoped to the page with `#documents` (the pricing page, which has none of it, is
  checked too). The site's own suites — the `site*` files with docs-links, product-name, brand-assets, set-domain and no-mojibake —
  are **160** tests, all passing; `site-chrome --check` and `pricing:check` pass.

### What this pass deliberately left

- **The docs bar's labels do not grow with the reader's root.** They are 14px (12 at 320) at every text size, like the header's
  controls, so the three names stay whole in a 90.7px chip; a 28px label is 87px for "documents" alone and the row would either
  cut or scroll as it did before. The floor is respected (no text under 12px) and the bar is 61px at 24 and 32px roots.
- **The band 514–540 is shared even though the natural row would fit it.** The threshold is 540 with 26px of slack for a wider system
  font; below it the row is the 3-up at every width the record measures, and the 1px flip at 541 from two-line equal chips to
  one-line natural chips is the breakpoint's edge, not a state a reader sees while scrolling.
- **The other bars still scroll where their seven or eight names do not fit:** at 360 the pricing row is 908px and the security row
  1,333; at 1,440 the security row still cuts 21px of "Reporting a problem". The edge shadow and the script's chip reveal are their
  cue, and a row of seven cannot be a 3-up with whole names at 320.
- **The legal page's three-chip row is untouched.** Its words are whole at 360 (472px fits) and at 320 only 8px of the "Terms"
  pill's edge is cut, not a word; the rule is for the page whose *name* was cut (`#documents`). If the legal row ever loses its
  words, the same rule can take `#licence` as well.
- **The documentation map's cards still stretch to their row's height at 768/1,440**, so a card with one document has up to 315px of
  empty panel below it (the "Deploying Curule" card at 1,440 is 598px with its words ending at 307). A masonry would change the
  card order; a stacked table is a change to what the map is. It was measured and left.
- **The home page's printed plate still carries its three view tabs.** `@media print` hides `.tabs`, but `.hero-visual .tabs`
  (0,2,0) sets `display: grid` and beats it, so the printed home page shows a dead Overview/Events/Designer switcher above the
  whole capture (42px + 16px of paper). It is a specificity bug in the print state, found in this pass and not the bar's; the fix
  is one selector (`.hero-visual .tabs` in the print block), and it is recorded here for the next pass rather than folded in.
- **The pricing page's Community card says "1 projects open"** in its three figure cells (`<dt>projects open</dt><dd>1</dd>`, at every
  width), while the home page's rate card says "1 project open". The block is generated by `scripts/pricing-html.mjs` from
  `packages/licensing/src/plans.ts`, so it is not hand-editable here; the plural is the exporter's to fix.
- **Curule Cloud's prices are still in the app**, the legal page's `TODO(owner)` still publishes (`site:check` exits 1), the captures
  were not retaken, and `site/ux/` was not edited. This pass's frames are handed over with the report.

## 2026-11-04: a control and its state show their own edge, and a sheet keeps no switcher

Measured with the same probe (Chrome in the pass container over CDP; reduced motion; light unless said; touch at 360; a
mouse at 794 for print; dark at 360). The before column is the site at `fe37b2a`, exported with `git archive` and served on
a second port and measured in the same run; no number is copied from an earlier pass. The probe's failure list is quoted
whole, because most of it is not this pass's (see what is left).

### What changed

- **A control's own edge is a boundary, and it is the same edge at rest.** The outlined button, the Copy button and the
  menu button took the decorative line: `#d3cdc2` at 1.58:1 on the button's white, 1.37:1 on the code band's `#f1eee8`
  and 1.52:1 on the header's `#fbfaf8`; in dark `#45423b` at 1.74:1, 1.94:1 and 1.87:1. The stylesheet turned it into the
  control line only on `:hover` (`#837d72`, 3.92:1), so at a desk the control's edge appeared under the pointer, and on a
  phone — where nothing hovers — it never did. `.btn:not(.btn-primary)`, `.copy` and `.menu summary` take
  `var(--k-line-control)` at rest now: 4.08:1 on white, 3.53:1 on the code band, 3.92:1 on paper, and 3.75:1 / 4.19:1 /
  4.04:1 in dark. That is the line the fields and the calculator's total already use. It is the seven outlined buttons
  (the home page's "Try the demo" and "How licences work", pricing's "Start free" and the way-in actions, the docs page's
  "Read the security page"), the three Copy buttons on the contact page and the three in the demo's steps, and the menu
  button in all seven headers. The inverse band's outlined buttons keep their own 30% on-deep rule (`.cta .btn` outranks
  this one), and a printed button is still black.
- **The chosen segment of a switch shows which one it is.** The thumb under the Annual/Monthly choice — and under the
  home page's Overview/Events/Designer tabs — was a white pill on `#f1eee8` (1.13:1) edged in `#d3cdc2` (1.37:1); in dark
  a `#1b1a18` pill on `#0e0d0c` (1.19:1) edged in `#45423b` (1.74:1). The period every figure on the pricing page is in,
  and the view the plate shows, were carried by the words alone. The thumb's ring is the control line now: **3.53:1** on
  the trough in light, **4.19:1** in dark. The fill and the layout are unchanged, so nothing moves.
- **A printed page keeps no switcher.** `@media print` hides `.tabs`, but the plate's own `.hero-visual .tabs` (0,2,0)
  set `display: grid` and outranked it, so the printed home page carried a dead Overview/Events/Designer row —
  **730.47 × 42 at 794**, with 16px of paper under it — above the one view a sheet can show. The print block now hides
  `.hero-visual .tabs` by name: the switcher is **none**, the frame moves from y 668.52 to **610.52**, and the sheet is
  **11,942 → 11,884** (−58). The radios still choose the Overview pane, so the sheet still prints a capture.

### Measurements after this pass

| At 360, light | Before | After |
|---|---|---|
| The outlined button's edge on white | 1.58:1 | **4.08:1** |
| The Copy button's edge on the code band | 1.37:1 | **3.53:1** |
| The menu button's edge on paper | 1.52:1 | **3.92:1** |
| The chosen segment's ring on the trough | 1.37:1 | **3.53:1** |
| The same, dark | 1.74 / 1.94 / 1.87 / 1.74:1 | **3.75 / 4.19 / 4.04 / 4.19:1** |
| The home page / the pricing page | 12,581 / 13,419 | **12,581 / 13,419** (colour only) |
| The probe's failures, home light / home dark / docs / pricing | 19 / 18 / 14 / 15 | **17 / 17 / 13 / 14** |

- The four rows that went are the two buttons' and the menu button's pairs on the pages that name them (the shared
  `summary[role=button]` row on the docs and pricing pages loses its summary and keeps the On this page chips and the
  plan chooser, which are decisions below). No page changes height at 360; no page scrolls sideways at 360 or 320; the
  smallest computed text is still 12px.
- The print state at 794: **11,942 → 11,884**, 0px over, the switcher gone and everything else unmoved.
- The site's suites pass: `site` + `site-copy` **67**, `site-chrome` + `site-script` + `site-cloud` + `brand-assets`
  **76**, `site-pricing` **6**. `site-chrome --check` is clean; `npm run site:check` still exits 1 on the owner's
  `TODO(owner)` for the terms at `site/legal/index.html:134`, as it did before this pass.

### What this pass deliberately left

- **The chips of a row keep the decorative rule.** The On this page chips are 1.52:1 in light and 1.87:1 in dark, and the
  plan chooser's four labels 1.52:1; their words are the control and the row says where the pill starts, so the boundary
  is not the only thing that identifies them. The trough's inset ring (1.14:1) and the cards, frames and hairlines
  (1.14–1.45:1) are decoration, not controls. A pass that darkened all of them would restyle every page for a rule that
  does not require it.
- **The probe still reports six links past 416.7px at 360 and five images clipped, and neither is real.** The six are the
  phone menu's links, measured while `<details>` is closed: opened, the panel is 16–344 and every link 23–337 (verified
  with `elementFromPoint`/`getBoundingClientRect` in the same browser). The five images are the console tiles inside the
  six-card snap row (a scroller) or a frame that crops its own picture. The docs page's "Start here" link is 173.8 ×
  25.59 by box, but its pseudo-element covers the card: `elementFromPoint` returns the anchor at the title, the body,
  the path and the card's blank corner (verified), so its target is 328 × 336 and it was not changed.
- **The security page's bar still cuts 21px of "Reporting a problem" at 1,440**, and the pricing row is still 908px at
  360: the scrolling bar with its edge shadow is the shared pattern, and a row of seven cannot be a 3-up with whole
  names at 320.
- **The docs filter's count is still a pause behind Clear** ("0 of 16 documents" for about half a second while all 16
  are back, then "All 16 documents"): it is the deliberate pause the README describes for typing, and the number corrects
  itself.
- **Curule Cloud's prices are still in the app**, the captures were not retaken, and `site/ux/` was not edited. This
  pass's frames — the plate's tabs and the billing switch at 360, the printed plate at 794 — were handed to the /ux page
  with the report.

## 2026-11-04, second pass: a phone chooses a view, and a closed menu takes no room

Measured with `ux-render` (the workspace image's Chrome, 360×900, reduced motion, touch, light unless said) and with the
same browser over CDP for the geometry and the states. The before column is the site at `b86e295` (main), exported with
`git archive`, served on a second port and measured in the same run; no number is copied from an earlier pass. The
absolute heights are this container's, where the untouched home page is 12,581 at 360; both halves are one browser in
one run, so the differences stand.

### What changed

- **A phone chooses one of the six console views, instead of swiping a row of six.** The row was 1,933px of cards in a
  360px scroller: a reader met one capture, and the five others stood outside the viewport behind an ancestor that
  clips, so the probe could only call them unreachable (it cannot scroll a row). The six names and their ledger numbers
  are now a 2 × 3 chooser (each chip **161 × 44** at 360, **141 × 44** at 320, **176 × 44** at 390), and the card below
  is the view chosen: **328 × 451.69** at 360, where the row's card was 309.59 × 440.17. The card's frame is
  **306 × 192** (the image 304 × 190) where it was 287.59 × 180.48 (285.59 × 178.48), and its words read across 278px
  instead of 259.59. It is radio inputs and CSS — the pattern the four plans already use on a phone — so it works with
  no script and the first view is chosen in the markup.
- **The six cards share one grid cell, so switching one moves nothing below it.** The chosen card is `visibility:
  visible`; the other five are in the same cell and hidden, so the row is as tall as its tallest view (Approvals,
  451.69 at 360) and the page below does not jump by the 48px the six cards' own heights differ by. All six remain in
  the page for print, which shows them all.
- **The chosen view is a dot, a rule and a tint.** The chip takes `--accent` at its border, an inset ring and the tint;
  the figure before its name is a dot, so the state is never colour alone. A chip that takes the keyboard's focus draws
  the 2px ring on the label, not on the 1 × 1 radio behind it, and a forced-colour mode keeps the chosen chip as a 2px
  `Highlight` outline and its dot as `Highlight` where the tint is dropped.
- **A closed menu is not laid out.** Chrome's closed `<details>` hides its contents from the reader but leaves their boxes
  in the layout tree: at 360 the six links of the closed panel measured **93.7px wide from x=323 and reached 416.7**,
  which is what the probe reported as six links past the viewport on every page. The panel is `display: none` while it is
  closed (`.menu:not([open]) .menu-panel`); opened at 360 it is **16–344** and every link is **23–337**, **314 × 48**, as
  before. At 320 the panel is 16–304 and the links 23–297; at 600 and 767 the open panel is 552 and 705.66 wide.
- **A capture is a control, so its frame has a control's edge.** The plate and the graph are one press across the frame,
  and a view card is one press across the card, but the frame's border was `#d3cdc2` on the page (**1.52:1**) and a view
  card's `#e4e0d9` (**1.21:1** on the band). Both take `--k-line-control` at rest — **3.92:1** and **3.75:1** — and the
  chooser's unselected labels take it too (**3.75:1** on the band). The decorative rules a card, a hairline and the On
  this page chips keep are rule 8's: a chip's words are the control and the row says where the pill starts.

### Measurements after this pass

| Page, the probe's failures at 360 | Before | After |
|---|---|---|
| Home | 17 | **6** |
| Pricing | 14 | **8** |
| Documentation | 13 | **7** |
| Security | 9 | **3** |
| Contact | 11 | **5** |
| Legal | 9 | **3** |
| 404 | 8 | **2** |

| The home page at 320 / 360 / 768 / 1440 | Before | After |
|---|---|---|
| Its height | 13,415 / 12,581 / 12,173 / 11,263 | **13,515 / 12,685 / 12,173 / 11,263** |
| `#product` | 912.73 / 853.09 / 1,630.36 / 2,074.09 | **1,012.75 / 956.61 / 1,630.36 / 2,074.09** |
| `#try` and everything below (at 360) | 4,586.33 | **4,689.84** (+103.52) |
| The first screen at 360: h1 / actions / price / plate | 150.59 / 462.36 / 526.36 / 641.38 | **unchanged, to the hundredth** |

- At 360 the chooser stands **3,976.38–4,120.38**, the hint is 4,132.38 and the card begins **4,189.16**; at 320 they
  are 4,345.45, 4,446.45 and 4,558.23. The card is the tallest view at both widths (451.69 and 450.69). The six chips
  are 2 × 3 at every phone width (328 × 144 at 360, 288 × 144 at 320, 358 × 144 at 390).
- The page costs **104px at 360, 100 at 320**, and **nothing at 768 or 1,440**, where the chooser is hidden and the six
  are the grid they were. The six other pages are unchanged at every width; only their fingerprint and their menu moved.
- The probe's 11 rows that went on the home page are the six menu links and the five captures; the six on every other
  page are the menu links. The six that remain on the home page at 320 and 360 are the decorative hairlines above
  (1.14–1.52:1): the pressable frame and the view card are no longer among them.
- At 768 the probe reports **19** and at 1,440 **35**, exactly as before: they are the mouse's 36–40px rows and the
  decorative rules, which this pass did not touch. At 320 the same six remain as at 360; the dark run at 360 is 17 → 6.
- The chooser is right with no script: at 360 the page is **12,662** and the first view is the one on screen (one card
  visible, six radios, six labels). Print at 794 is **11,892**, unchanged, and prints all six cards. With
  `forcedColors: active` at 360 the page is 12,685, the chosen label keeps a 2px `Highlight` outline and its dot. At a
  24px root it is **19,807** at 360 (19,737) and at 32px **29,874** (29,864); **0px over** at 320, 360 and 720 at every
  root.
- The smallest computed text is still **12px** (the chips' numbers); a chip's name is 13px at every user text size, as
  the header's controls and the bar's chips keep theirs. The smallest target is a chip's **141 × 44** at 320; the 1 × 1
  radio behind each is not the control. The only targets under 44 × 44 are the same inline links in sentences.
- **0 axe-core WCAG 2.0–2.2 A and AA violations** on all seven pages at 360 light, on the home page at 360 dark and at
  1,440 light. No page scrolls sideways at 320, 360, 768 or 1,440 in light or at 360 in dark; 0 console errors.

### What this pass deliberately left

- **The phone's page is 104px longer.** The chooser is 144px of chips where the old index was 44, against a card 11.5px
  taller; the six captures are one press each and none is clipped, which is the trade. Removing the hint would save 57,
  and putting the six chips in one row of numbers would save the rest and lose the names; neither was taken.
- **The five views not chosen are not read on a phone.** Their descriptions and titles are in the page for a reader who
  chooses them and for print, but a phone reads one at a time; the comparison of six is the chooser's names, not their
  paragraphs. A summary of each beside its chip would be the 1,933px row again.
- **The decorative hairlines stay light.** The card's top rule is 1.45:1, the section rules and the footer's line
  1.14–1.26, and the On this page chips 1.52 — rule 8's exception, where the words are the control. The two boundaries
  that identify a press (the plate/graph frame and a view card) are 3.75–3.92 now, and the outline button, Copy and menu
  button already were.
- **The documentation page's "Start here" links still measure 25.59px.** The card is the target (`::before` covers its
  328 × 336), and the link is a line of the card, as the last pass argued; a 44px row would add 55px to the page and undo
  a deliberate 20px per card.
- **The pricing page's 24 × 24 usage-reports checkbox** is unchanged: its label is the 44px target.
- **No capture was retaken** (the console is being redesigned in parallel), `site/ux/` was not edited, and
  `npm run site:check` still exits 1 on the owner's `TODO(owner)` for the terms at `site/legal/index.html:134`.

The next pass's first job is still the page's length: 12,685 at 360 is 15.9 screens of 800, and the demo (1,666.73) and
the two ways (849.30) are where the words are. After it, the pricing page's Cloud answer and the shared 48px Terminal
row, both queued by the previous passes.

## 2026-11-04, third pass: the plate's bar is its view switcher, and four edges a phone reads

Measured with the same probe (Chrome over CDP; reduced motion; light unless said; touch at 320/360/390, a mouse at 768 and
1,440; print at 794; dark at 360 and 1,440; forced colours at 360; no script at 360; a 24px root at 320/360 and a 32px root
at 320/360). The before column is the site at `6521258`, exported with `git archive` and served on a second port, measured in
the same run; no number is copied from an earlier pass. The absolute heights are this container's (the untouched home page at
360 is 12,662.66 where the record's is 12,685); both halves are one browser in one run, so the differences stand.

### What changed

- **The plate's bar is its view switcher.** The three view labels stood in a 50px trough above a 44px bar of three decorative
  lights, the demo's address and a Full size chip: 50 + 16 + 44 = **110px of chrome** before the picture, so an 800px phone
  screen held **47.63px** of the capture (the top of the Delivered card) and at 320 the picture began at **849.94**, wholly
  below the screen. The labels are inside the frame now, in its one 50px bar (`.frame-bar .tabs`), and the lights and the
  address are gone. The picture begins **752.38 → 692.38 at 360** (320: 849.94 → 789.94; 390: 754.16 → 694.16; 768:
  785.98 → 725.98; 1,440: 222 → 170), and the first screen holds **47.63 → 107.63px** of the crop at 360, **45.84 →
  105.84** at 390, **114.02 → 174.02** at 768; at 320 the frame's top and 10.06px of the picture are on the screen where
  before the whole frame was below it. The page is **60px shorter** at 320/360/390/768 and **15.97** at 1,440 (the left
  column sets the hero there).
- **The Full size link is in the caption it describes, as the graph's is.** Each of the plate's three captions ends with the
  link (the same words, the same accessible name); the caption keeps its line and its fixed height, and the figure is still
  the whole press: the link's cover begins under the bar (`top: 50px`), so a press on the picture or the caption opens the
  capture and a press on Overview, Events or Designer switches it. One link, one name and one tab stop; no duplicate control.
  At 360 the caption is the same 107px, at 320 126.5, at 768 68, at 1,440 87.5. The plate's way to the full size is now an
  inline link in a sentence (the exception WCAG 2.5.5 allows), like the graph's since 2026-11-02; the target is the figure,
  326 × 300 at 360.
- **A view chooser's number is one token.** In the six-view chooser "05 Cost and budgets" printed its number as **"0" over
  "5"** in the 161px chip at 360 (and "01 Mission control" as "0"/"1"): the `.view-n` span was a shrinkable flex item with
  `white-space: normal`, so it broke inside the two digits. It is `flex: none; white-space: nowrap` now: `05` is **15.23 ×
  30 → 16.97 × 15** and `01` **27.11 × 30 → 28.97 × 15**; the chip's name may still take two lines ("Cost and" / "budgets")
  and the chip stays 44 × 161. The label keeps 13px at every user text size.
- **A card that is one press takes a control's edge.** The documentation page's four Start here cards and the 404 page's six
  ways are one press across the whole card (their link's `::before` covers it), but their border was the decorative line:
  **1.26:1** on the paper, while the view cards and the pressable frames took the control line in the last two passes. They
  take `--k-line-control` now (**4.08:1** on the panel and 3.92 on the paper), and a hover keeps it rather than taking it
  back to `--line2`. The probe's boundary group at 1.26:1 on the docs page is **27 → 23 elements** and on the 404 page
  **7 → 0**; the six ways' and four cards' old rows are gone from the failure list.
- **The yearly total fits the cell it is in.** In the plans table "($1,488 a year)" is **119px** of text in the **105.86px**
  the plan column leaves after its padding at 768 — 13.14px into the 14px padding, 0.86px from the next column's rule — and
  at 720 it was **119 in 97**, 22px over, 8px past the cell's inner edge. The unit is the caption's 13px now, under the
  month's figure: **106 in 106** at 768, **99 in 97** at 720 (12px clear of the next cell) and **103 in 103** at 800, with
  the table's height unchanged (674.19 / 626.19 / 682.19 at 720/768/800). The 1,440 page is 3.2px shorter because the
  annual row's note is shorter than the line it sat on; nothing else moved.
- **A printed plate keeps no switcher.** The printed home page carried the 44px browser bar with a dead Full size chip above
  its one capture; the bar is hidden in print now, with the sheet **11,882.88 → 11,838.88** (−44). The other six printed
  pages are unchanged (pricing 9,993.41; docs 4,670.41; security 7,516.84; contact 3,077.61; legal 3,085.13; 404 1,091.94),
  all 0px over 794.

### Measurements after this pass

| Page, height at 320 / 360 / 390 / 768 / 1440 | Before | After |
|---|---|---|
| Home | 13,464.14 / 12,662.66 / 12,218.86 / 12,172.06 / 11,241.31 | **13,404.14 / 12,602.66 / 12,158.86 / 12,112.06 / 11,225.34** |
| Pricing | 14,439.34 / 13,487.05 / 12,840.19 / 10,140.58 / 9,187.53 | 14,439.34 / 13,487.05 / 12,840.19 / 10,140.58 / **9,184.33** |
| Documentation / security / contact / legal / 404 | unchanged | unchanged |

| The home page's first screen at | 320 | 360 | 390 | 768 | 1,440 |
|---|---|---|---|---|---|
| The bar's top | 804.94 | 641.38 (tabs) | 643.16 | 674.98 | 119 (tabs) |
| The picture's top | **849.94 → 789.94** | **752.38 → 692.38** | **754.16 → 694.16** | **785.98 → 725.98** | **222 → 170** |
| The picture visible in an 800/900 screen | **−49.94 → 10.06** | **47.63 → 107.63** | **45.84 → 105.84** | **114.02 → 174.02** | 420 → 420 (whole) |
| The On this page row / `#pricing` | 1,722.73 / 1,783.73 → 1,662.73 / 1,723.73 | 1,583.28 / 1,644.28 → 1,523.28 / 1,584.28 | 1,537.08 / 1,598.08 → 1,477.08 / 1,538.08 | 1,563.23 / 1,624.23 → 1,503.23 / 1,564.23 | 987.47 / 1,048.47 → 971.5 / 1,032.5 |

- The bar is **50px** at every width and the labels are **44px** in three equal cells: 92.66 at 320, 106 at 360, 116 at 390,
  232 at 768, 147.55 at 1,440. The caption's link is **74.55 × 19.5** at 360 (its own line, not a 44px box), and the
  figure is the press. No chip's number or name is cut at any of the five widths.
- No page scrolls sideways at 320, 360, 390, 768 or 1,440 in light or dark (**0** on all 70 page/width/theme pairs), the
  probe reports **0** console errors, **0 axe-core WCAG 2.0–2.2 A and AA violations** on all seven pages at 360 light,
  360 dark and 1,440 light, and the smallest computed text is **12px**.
- Without a script the home page is **12,581** at 360, 0px over: the bar is the same three labels, the first view is chosen
  in the markup and the picture's link is the caption's. Print: the home page is 11,838.88 and the other six are unchanged,
  all 0px over. With `forcedColors: active` at 360 the chosen segment keeps its 2px Highlight outline, the page is 12,602.66
  and the Start here cards' edge is `CanvasText`. At a 24px root every page is **0px over** at 320 and 360; at 32px the
  recorded pricing debt is unchanged (380 at 360 and 360 at 320), and the bar's labels stay 13px and 44px tall.
- The probe's target census at 360 gains one inline link (the plate's caption link, 74.55 × 19.5) and loses the 44px chip;
  no standalone control is under 44 × 44. The only control under 44 on the pricing page is still the 24 × 24 checkbox whose
  label is 44.
- `tests/build/site.test.ts` pins the new shape: the tabs inside the frame and their `~ .frame .tabs` step, the 50px bar and
  its 44px, 13px labels, the cover's 50px offset, the bar hidden in print, the `nowrap` number, the control line on the Start
  here cards and the ways out (and its hover), and the unit's 13px. The build suites are **225** tests and `npm test` is
  **6,489 passing, 2 skipped, 0 failing**; `site-chrome --check` is clean.

### What this pass deliberately left

- **At 320 the first screen still shows only 10px of the picture** (the frame's top edge, where before the frame was 49.94px
  below the screen). The 320 head, the 4-line price line and the 103.69px hero price own the rest; the 360 phone the owner
  reads now holds the Delivered line and the goal.
- **The plate's Full size is an inline link in its caption, not a 44px chip in its bar.** The bar has no room for a fourth
  control at 320 (the tabs would have 60.8px cells and "Overview" is 56px at 13), and the figure is still one press across
  326 × 300. The graph has had the same shape since 2026-11-02; the six view cards keep their 44px rows.
- **The bar's decorative lights and the address `127.0.0.1:7420` are gone.** They were `aria-hidden` decoration; the note
  under the picture still says the demo is scripted and runs on the machine, and the frame is still a window with a bar.
  The address was the only place the demo's port was named, and the demo's own commands name `127.0.0.1:7420`.
- **The chooser's names still take two lines in some 161px chips** ("Cost and" / "budgets", "Mission" / "control"); the chip
  is 44px and the words are whole. The alternative is a shorter name or a wider grid.
- **The pricing page's cards still repeat the host scope, the stack still repeats the limits, the security page's At a
  glance box is still 930px, and the home page is still 12,602.66 at 360.** None of these changed; the next pass's first job
  is still the page's length.
- **The captures were not retaken** (the console is being redesigned in parallel), `site/ux/` was not edited, and
  `npm run site:check` still exits 1 on the owner's `TODO(owner)` at `site/legal/index.html:134`.

## 2026-11-04, fourth pass: the proof's caption fits its slot, the price's notes fit a line, and the three steps share a row

Measured with the same probe (Chrome 156.0.8078.4 over CDP; reduced motion; light unless said; touch at 320/360/390; a mouse at
768 and 1,440; dark at 360 and 1,440; print at 794; no script at 360; a 24px root at 320/360/720 and a 32px root at 320/360). The
before column is the site at `c1ce347`, exported with `git archive` and served on a second port, measured in the same run; no
number is copied from an earlier pass. The absolute heights are this container's (the untouched home page at 360 is 12,604 where
the record's is 12,602.66); both halves are one browser in one run, so the differences stand.

### What changed

- **The plate's Events caption fits the height the three views share.** A tab press is a state of the proof, and it must not
  move what is under it. At 360 the Events caption took **five** lines where the slot reserved four (**126.5px in 107**), so
  pressing Events grew the frame **419 → 438.5**, the note under the plate **1,076.38 → 1,095.88**, the proof
  **1,254.72 → 1,274.22** and the page **12,604 → 12,623**. At 1,040 and 1,100 the same press grew the frame
  **559.5 → 579** and moved the note **688.09 / 690.5 → 707.59 / 710**; at 1,200 and up it did not. The caption says the same claim in
  fewer words — "here filtered" → "filtered"; "things the runtime refused or did not do, with the reason it gives" → "what
  the runtime refused or did not do, and why" — **171 → 147 characters with its link (161 → 137 without)**. It is four
  lines at 360 (107), five at 320 (126.5) and three on a desk (87.5), the heights the stylesheet reserves; all three tabs
  now measure **419 at 360 and 559.5 at 1,040 and up**, and the page and the note are one number for every tab at every
  width measured (320, 340, 360, 390, 420, 540, 719, 720, 768, 900, 1,024, 1,040, 1,100, 1,200, 1,280, 1,366, 1,440, 1,600).
- **The note under the price is held to the prose measure.** At 1,440 the note under the rate card was **1,120px** wide and
  its first line **1,107px**, about **158 characters**; the site's prose measure is 68ch. It takes the stylesheet's own
  `.measure` (the contact page's closing note already uses it) and is **612px**, its longest line **605px**, about
  **86 characters**; it is two lines before and after, so the home page does not change height. The pricing page's two
  notes outside a generated block — under the plans and under the comparison — are held the same way: **1,105 → 602**
  (about 157 → 86 characters) and **1,089 → 593** (156 → 85); their line counts are 2 → 3 and 3 → 5. The model table's
  note is inside the exporter's `run-costs` block and was left (1,068px, one line, 153 characters). The pricing page is
  **9,185 → 9,253** at 1,440 (+68), **10,122 → 10,144** at 768 (+22), and unchanged at 360 and 320, where the wrap is
  already narrower than 612.
- **The three steps' words share a row.** At 1,440 the middle step's heading takes two lines ("The agents work / through
  contracts") and the other two take one, so the middle step's body began **24.69px below** its neighbours' (p tops
  **7,393.58 / 7,418.27 / 7,393.58**; heading heights **24.69 / 49.38 / 24.69**). The steps take a subgrid row at 860 and
  up, as the plan cards and the places to start already do: **every body starts at 7,418.27** and every heading row is
  49.38. The section's row was already as tall as its tallest column, so the page is **11,226** before and after. At 860,
  900, 1,000 and 1,039 the three bodies are level too; below 860 the steps are stacked and unchanged.

### Measurements after this pass

| Page, height at 320 / 360 / 390 / 768 / 1440 | Before | After |
|---|---|---|
| Home | 13,405 / 12,604 / 12,160 / 12,105 / 11,226 | **unchanged** |
| Pricing | 14,440 / 13,488 / 12,841 / 10,122 / 9,185 | **14,440 / 13,488 / 12,841 / 10,144 / 9,253** |
| Documentation | 8,975 / 8,382 / 8,065 / 5,284 / 4,429 | unchanged |
| Security | 12,527 / 11,600 / 10,883 / 7,884 / 7,638 | unchanged |
| Contact | 4,755 / 4,381 / 4,215 / 3,413 / 2,857 | unchanged |
| Legal | 5,513 / 5,037 / 4,741 / 3,419 / 3,313 | unchanged |
| 404 | 2,266 / 2,089 / 2,045 / 1,437 / 1,516 | unchanged |

| The plate at 360 | Overview | Events, before → after | Designer |
|---|---|---|---|
| The caption | 107 | **126.5 → 107** | 107 |
| The frame | 419 | **438.5 → 419** | 419 |
| The note under it | 1,076.38 | **1,095.88 → 1,076.38** | 1,076.38 |
| The proof | 1,254.72 | **1,274.22 → 1,254.72** | 1,254.72 |
| The page | 12,604 | **12,623 → 12,604** | 12,604 |

| The plate at 1,040 / 1,100 | Overview / Designer | Events, before → after |
|---|---|---|
| The frame | 559.5 | **579 → 559.5** |
| The note | 688.09 / 690.5 | **707.59 / 710 → 688.09 / 690.5** |
| The page | 10,550 / 10,745 | unchanged (the left column sets the hero's height) |

| The note under the price at 1,440 | Before | After |
|---|---|---|
| Its width | 1,120 | **612** |
| Its longest line | 1,107 | **605** |
| Characters on that line | about 158 | **about 86** |
| Its lines | 2 | 2 |
| The home page at 360 / 1,440 | 12,604 / 11,226 | **12,604 / 11,226** |

| The pricing page's notes at 1,440 | Plans | Comparison |
|---|---|---|
| Width, before → after | 1,120 → **612** | 1,120 → **612** |
| Longest line | 1,105 → **602** | 1,089 → **593** |
| Characters on it | 157 → **86** | 156 → **85** |
| Lines | 2 → **3** | 3 → **5** |

| The three steps at 1,440 | Before | After |
|---|---|---|
| The heading rows | 24.69 / 49.38 / 24.69 | **49.38 / 49.38 / 49.38** |
| The body tops | 7,393.58 / 7,418.27 / 7,393.58 | **7,418.27 / 7,418.27 / 7,418.27** |
| The page | 11,226 | **11,226** |

- No page scrolls sideways at 320, 360, 390, 768 or 1,440 in light or dark (**0** on all 70 page/width/theme pairs), the probe
  reports **0** console errors on 14 loads, **0 axe-core WCAG 2.0–2.2 A and AA violations** on all seven pages at 360 and
  1,440 in both schemes (28 runs), and the smallest computed text is **12px**. The worst text pair is **5.61:1** in light
  (all text passes in dark too), and the target census is unchanged: the same 1 × 1 radios, the 24 × 24 checkbox whose label
  is 44, the inline links in sentences, and the mouse's 36–40px rows at 1,440.
- Print at 794: the home page is **11,840** unchanged and pricing **9,994 → 10,017**; every page is 0px over. Without a
  script at 360: home **12,581** and pricing **12,249**, unchanged. At a 24px root every page is 0px over at 320, 360 and
  720; at 32px the pricing page's recorded debt is unchanged (**40px over at 320, 20 at 360**). Dark at 360 and 1,440 is
  the height it is in light.
- The site's own suites — `site`, `site-chrome`, `site-copy`, `site-pricing`, `site-script`, `site-cloud`,
  `site-cloud-state`, `site-pages`, `ui-kit-tokens`, `brand-assets`, `no-mojibake`, `docs-links` — are **168** tests, all
  passing. `site-chrome --check` and `build-brand --check` are clean. `npm run site:check` still exits 1 on the owner's
  `TODO(owner)` for the terms at `site/legal/index.html:134`, as the earlier passes recorded.

### What this pass deliberately left

- **The pricing page is 68px taller at 1,440 and 22px at 768** for the two notes' measure. That is the price of a line a
  reader can follow; at 360 and 320 the page does not move.
- **The model table's note is still 1,120px wide (153 characters on its one line)**: it is inside the exporter's
  `run-costs` block, so moving it out is a change to the exporter, not a hand edit of a generated block.
- **The footer's legal block is still 960px wide (about 134 characters a line)** and the FAQ's answers 46rem (about 87),
  both as the footer and FAQ passes measured them. They are the same kind of prose, but neither is the price, and a
  narrower footer or answer is a change to those surfaces, not to this one.
- **The plate's crop still cuts the mission's title at its right edge** ("Build and ship a small idempotent payment e…"), as
  the crop before it did; the whole capture is one press through the caption's Full size link.
- **The plans chooser still changes the page's height when another plan is chosen** (Community 730.64, Team 624.55,
  Business 749.44, Enterprise 658.64 at 360) because the card is the chosen plan, not a shared cell. The six console views
  share one cell; the plans do not.
- **The 32px-root pricing debt is unchanged** (40px over at 320, 20 at 360); this pass adds no overflow, and the 24px case
  is 0.
- **No capture was retaken**, `site/ux/` was not edited, and Curule Cloud's prices are still in the app.

## 2026-11-05: the 320 phone's first screen, a card's focus ring, and the answers' row

Measured with the same probe (Chrome over CDP in the pass container; reduced motion; light unless said; touch at
320/340/359/360/390, a mouse at 768/900/1,024/1,200/1,440; dark at 360 and 1,440; print at 794; forced colours at 360;
no script at 360; a 24px and a 32px root at 320/360/720). The before column is the site at `fc5cecf`, the commit this pass
started from, copied and served on a second port and measured in the same run; no number is copied from an earlier pass.
The absolute heights are this container's; both halves are one browser in one run, so the differences stand.

### What changed

- **The narrowest phone keeps its two ways in on one line.** At 320 the pair needed **155 + 20 + 138.4 in a 288 wrap**, so
  the secondary fell to a second row and the pair was **97.6px** tall: the price began at **601.3**, the capture at
  **789.9**, and the first 800px of the page held **10.1px** of it. The primary takes the bar's 12px side padding
  (**155 → 131**), the secondary the ramp's 15px (**138.4 × 45.6 → 129 × 44**) and the gap the bar's 8, and the pair is
  **268 in 288**: **48px** tall, the price at **551.7**, the capture at **740.3**, and **59.7px** of the capture — the
  Delivered line — on the first screen. The page is **13,405 → 13,356**. At 340 the capture moves **767.8 → 718.2**
  (32.2 → 81.8px on screen) and the page **13,164 → 13,114**; from 346 the pair already fit one row and only the widths
  change; at 360 and above nothing moves.
- **A surface that is one press draws its focus ring round the surface.** The 404's way out already did — its `<a>` is the
  card — but the Start here card's ring was its **173.4 × 25.6** line inside a **268 × 482.4** card, the view card's its
  **498 × 44** row inside a **548 × 541.2** card, and the plate's and the graph's their **74.5 × 19.5** caption line
  inside a **450.7 × 507.5** figure and a **1,120 × 664.8** frame. The inner link is still the tab stop and the name; it
  keeps no second ring. At 390 the Start here card's ring is **358 × 312.1** (was the 173.4 × 25.6 line) and the view
  card's **358 × 446.4** (was the 308 × 44 row). The Start here card also takes the hover the view card and the 404's way
  had: the second step of elevation (shadow 1 → 2) and, where motion is allowed, a 1px lift.
- **The security page's three answers share their first row.** The middle title wraps to four lines at 900 and three at
  1,200 and 1,440, so its paragraph began **44.1 / 22.1px** below its neighbours': at 900 the three paragraphs started
  **649.8 / 693.9 / 671.8**, at 1,440 **687.8 / 709.9 / 687.8**. The list takes two shared rows now, as the steps and the
  plans do: all three start at **693.9** at 900, **688.6** at 1,024, **705.9** at 1,200 and **709.9** at 1,440. The
  answers' cards are the height they were (260.3 / 214.2 / 190.2 / 190.2), and the page is **8,341 / 7,854 / 7,630 /
  7,638** at those widths, unchanged.
- **A figure's caption holds the lede's measure.** The graph's caption is the widest line under a picture: at 1,440 its
  band is 1,118 and its first line ran **1,070px (about 150 characters)**, with 59px on the second. The band keeps the
  frame's width and the words take the lede's **40rem**: the first line **639 (about 88)**, the second **490**, still two
  lines, the page **11,226** and the Full size link at **8,224.6**, both unchanged. At 1,200 the page is 10,941; at
  1,024 the plate's caption goes **872 → 613** (108 → 76 characters), at 900 **760 → 613**, at 768 **648 → 613**, and
  every page is the height it was. The rule is `padding-right: max(18px, calc(100% - 40rem - 18px))`, so a caption
  narrower than 640 is untouched.

### Measurements after this pass

| The home page, height at 320 / 360 / 390 / 768 / 1,440 | Before | After |
|---|---|---|
| | 13,405 / 12,604 / 12,160 / 12,105 / 11,226 | **13,356 / 12,604 / 12,160 / 12,105 / 11,226** |

| The 320 first screen | Before | After |
|---|---|---|
| The two ways in | 155 + 20 + 138.4, 97.6px tall | **131 + 8 + 129, 48px** |
| The price's top | 601.3 | **551.7** |
| The capture's top | 789.9 | **740.3** |
| The capture on an 800px screen | 10.1px | **59.7px** |
| The contents / `#pricing` / the first plan | 1,662.7 / 1,723.7 / 2,059.7 | **1,613.1 / 1,674.1 / 2,010.1** |
| The page | 13,405 | **13,356** |

| The security glance at 900 / 1,024 / 1,200 / 1,440 | Before | After |
|---|---|---|
| The three paragraphs' tops | 649.8 / 693.9 / 671.8; 666.5 / 688.6 / 666.5; 683.8 / 705.9 / 683.8; 687.8 / 709.9 / 687.8 | **693.9 / 688.6 / 705.9 / 709.9, all three** |
| The title row | 46.1 / 90.3 / 68.2; 46.1 / 68.2 / 46.1 | **90.3; 68.2, all three** |
| The page | 8,341 / 7,854 / 7,630 / 7,638 | **unchanged** |

| The captions | Before | After |
|---|---|---|
| The graph at 1,440 and 1,200, first / second line | 1,070 / 59 (about 150 characters) | **639 / 490 (about 88)** |
| The plate at 1,024 / 900 / 768, first line | 872 / 760 / 648 | **613 / 613 / 613** |
| The caption's height at each width | 126.5 at 320, 107 at 360/390, 68 at 768–1,039, 87.5 for the plate at 1,040+; the graph 68 at 1,440 | **unchanged** |
| The home page at 1,440 / 1,200 / 1,024 / 900 / 768 | 11,226 / 10,941 / 11,760 / 11,532 / 12,105 | **unchanged** |

| The focus ring, at 1,440 / 390 | The link | The surface |
|---|---|---|
| A Start here card | 173.4 × 25.6 | **268 × 482.4 / 358 × 312.1** |
| A view card | 498 × 44 / 308 × 44 | **548 × 541.2 / 358 × 446.4** |
| The plate | 74.5 × 19.5 | **450.7 × 507.5 / 356 × 367** (the pane, under its bar) |
| The graph | 74.5 × 19.5 | **1,120 × 664.8 / 358 × 298.4** |

- The six other pages are the height they were at every width: pricing **14,440 / 13,488 / 12,841 / 10,144 / 9,253**;
  documentation **8,975 / 8,382 / 8,065 / 5,284 / 4,429**; security **12,527 / 11,600 / 10,883 / 7,884 / 7,638**; contact
  **4,755 / 4,381 / 4,215 / 3,413 / 2,857**; legal **5,513 / 5,037 / 4,741 / 3,419 / 3,313**; 404 **2,266 / 2,089 / 2,045
  / 1,437 / 1,516** at 320 / 360 / 390 / 768 / 1,440.
- No page scrolls sideways at 320, 360, 390, 768 or 1,440 in light, or at 360 and 1,440 in dark; the probe reports **0**
  console errors and **0 axe-core WCAG 2.0–2.2 A and AA violations** on all seven pages at 360 light, 360 dark and 1,440
  light. The smallest computed text is still **12px**; the worst text pair is the recorded **5.61:1** in light.
- The targets are the same plus the hero's secondary, now **129 × 44**; the only controls under 44 × 44 are the hidden
  1 × 1 radios, the 24 × 24 usage-reports checkbox whose label is 44, and the inline links in sentences. The plate's and
  the graph's Full size links are lines of their captions; their figures are the targets.
- Print at 794 is **11,840** on the home page (the caption prints its 640px measure), **10,017** on pricing and **7,518**
  on security, all 0px over. Without a script the home page is **12,581** at 360; with `forcedColors: active` it is
  **12,604** and the focused card's ring is **rgb(0, 0, 0)** (CanvasText); dark is the light height. At a 24px root the
  home page is **22,009** at 320 (was 22,011), **19,816** at 360 and **16,090** at 720; at 32px **33,744** (was 33,746),
  **29,773** and **20,839**; every one 0px over.
- The site's own suites are **164** tests, all passing; `npm run typecheck` passes; `npm run lint` has 0 errors (the same
  211 warnings); `site-chrome --check` and `brand:check` are clean. `npm run site:check` still exits 1 on the owner's
  `TODO(owner)` for the terms at `site/legal/index.html:134`, as before.

### What this pass deliberately leaves

- **The 320 first screen holds 59.7px of the capture, not the whole picture.** The Delivered line is on the screen; the
  320 head, the three-line price and the rest of the frame are below it. The page is still 13,356 at 320 and 12,160 at
  390; the length is the next pass's job, not a smaller first screen's.
- **The hero's secondary keeps its 15px layout size at a reader's root**, as the bar's controls do. At a 24px or 32px
  root the primary (1rem) grows and the pair wraps again: the pages are 22,009 / 33,744 at 320, both 0px over and 2px
  shorter than before. A 15px link in a 24px reader's text is a control's size, not prose's.
- **The two actions under the plans still stack at 320–410** (184 and 182px in a 288–377 row). They cannot share a 320
  row, and a full-width pair below 411 would be a change to what the section does on every phone narrow enough to wrap,
  not just the narrowest; left.
- **The documentation map's note (1,120px, 149 characters), the home page's security notice (1,120px wide, its first
  line 1,045px and about 111 characters), the FAQ's answers (736px) and the footer's legal block (960px)** still run past
  68ch. This pass took the
  figures' captions, which are the widest lines under a picture; the other four are the same kind of prose on other
  surfaces, not this one.
- **The security page's On this page row still runs 1,504px in 1,440 at a desk** — 64px of "Reporting a problem" is cut
  — and the documentation map's cards still stretch to the tallest in their row (the Deploy card is 580px with 296.9px
  blank at 1,440). The row's edge shadow and the script's chip reveal are the first's cue; a masonry or a stack would
  change what the map is.
- **No capture was retaken**, Curule Cloud's prices are still in the app, and the /ux page itself was not edited; this
  pass's six frames are the `20261105-site-*` files in `site/ux/shots/`.

The next pass's first job is still the page's length: 13,356 at 320 and 12,160 at 390 are where the words and the
figures are, and the plans section's pair and the wide notes above are the candidates this pass measured and left.

## 2026-11-05, second pass: the plan's name at a larger text, the command's ring, and a row's measure

Measured with the same probe (Chrome 156 in the pass container, where `system-ui` resolves to Noto Sans; reduced motion;
light unless said; touch at 320/360/390, a mouse at 768 and 1,440; a 24px and a 32px root at 320/360/390; dark at 360;
print at 794). The before column is the site at `f484811`, exported with `git archive` and served on a second port (8,151) and
measured in the same run; no number is copied from an earlier pass. The absolute heights are this container's; both halves are
one browser in one run, so the differences stand.

### What changed

- **The four plans' names fit their chips at a reader's own text size.** The chooser's name was `.75rem`, so at a 32px root it
  computed 24px: "COMMUNITY" needed **184px in a 134px chip** and "ENTERPRISE" 183, and the pricing page was **380px wide on a
  360 screen** (40px over at 320, 5 at 390); at a 24px root the label's content was **151px in its 138px chip** at 320 and painted
  13px under the chip beside it. It is a control's label and keeps the **12px** the six-view chooser's name and the billing
  sub-label keep, and may break as a last resort, so no font widens the page. At 32px the four chips are **138/138 at 320 and
  158/158 at 360** (were 138/196 and 158/196) and every page is **0px over** at 320/360/390.
- **A command's focus ring is drawn inside the box that clips it.** The licence command is a scroll region a keyboard reaches
  (`pre tabindex="0"`), and its code box clips everything outside its 1px border. The ring was drawn 2px outside the pre with a
  2px offset — 4px of ring where the box left 1px — so under a real Tab at 360 and 1,440 the pre matched `:focus-visible`, its
  computed outline was **2px solid in the accent**, and **no pixel of it was on the screen**. It is drawn **inside** the pre's
  edge now (`outline-offset: -2px`) and is the whole 328 × 51 box at 360, 468 × 51 at 1,440.
- **"What you are not paying for" takes the page's measure.** The list stands in the pricing page's own column, so at 1,440 its
  sentences ran **1,120px and 1,103px a line** — about 140 and 138 characters — while the page's notes take the 68ch measure
  (612px at 14px). They are **663px and 676px** now (the 68ch cap is 680), the third row's one 680px line is unchanged, and both
  long rows keep two lines, so **no page changes height** at any width. The security page's and the contact page's lists stand in
  a split and a column, are narrower than 68ch already, and are untouched.

### Measurements after this pass

| Page, height at 320 / 360 / 390 / 768 / 1,440 (coarse pointer) | Before | After |
|---|---|---|
| Home | 13,356 / 12,604 / 12,160 / 12,113 / 11,282 | unchanged |
| Pricing | 14,440 / 13,488 / 12,841 / 10,164 / 9,317 | unchanged |
| Documentation | 8,975 / 8,382 / 8,065 / 5,288 / 4,477 | unchanged |
| Security | 12,527 / 11,600 / 10,883 / 7,888 / 7,690 | unchanged |
| Contact | 4,755 / 4,381 / 4,215 / 3,413 / 2,905 | unchanged |
| Legal | 5,513 / 5,037 / 4,741 / 3,419 / 3,361 | unchanged |
| 404 | 2,266 / 2,089 / 2,045 / 1,441 / 1,568 | unchanged |

| The pricing page at a reader's root | Before | After |
|---|---|---|
| 24px root: 320 / 360 / 390 | 24,210 / 21,971 / 20,407 | **24,162 / 21,923 / 20,359** |
| 32px root: 320 / 360 / 390 | 37,855 / 33,435 / 31,366 | **37,778 / 33,358 / 31,289** |
| 32px root: px over the screen | **40 / 20 / 5** | **0 / 0 / 0** |
| The chooser's label at 32px: 320 / 360 | 138/196, 158/196 | **138/138, 158/158** |

- The two heights that move are the chips' names taking one line instead of spilling: −48px at a 24px root and −77 at 32px, on
  the one page whose chips are wider than their names. At 16px every page is the height it was, to the pixel, at 320/360/390/768
  and 1,440, in light and in dark (360).
- No page scrolls sideways at 320, 360, 390, 768 or 1,440 in light or dark (**0** on all 70 page/width/theme pairs), the probe
  reports **0** console errors, **0 axe-core WCAG 2.0–2.2 A and AA violations** on the pricing page at 320 light, 360 light,
  360 dark and 1,440 light, and the smallest computed text is still **12px**.
- The ring fix is colour only: no box moves, and the command's own `.code` border is unchanged.
- The rows' cap is a `max-width` on the sentence, so the row's rule and its bold lead keep the column's width; the 68ch is the
  same measure the notes on the page already take.
- Print at 794 is **11,840** on the home page and **10,017** on pricing, 0px over, as before: `.rows` prints at the measure it
  has on screen, and the ring is not printed.
- `tests/build/site.test.ts` holds the chooser's name (12px and `overflow-wrap: anywhere`, next to the six-view chooser's 13px),
  the rows' cap (and that the security and contact lists are not that shape), and the ring's `-2px` offset with the reason the
  box clips it. The build suites are **228** tests, all passing; `site-chrome --check` is clean.

### What this pass deliberately left

- **A plan's figure label is still cut at a 2× text size.** "projects open" needed **96px in the 79px cell** at 360 (71 in 66 at
  320 with a 24px root) and the figure's frame clips it: it reads "project:". Letting the word break reads "project" / "s open"
  at 24px and "projec" / "ts" at 32px, which is worse than the cut; fixing the label at 12px takes the reader's text size off a
  figure's caption; and the three cells cannot reflow to one column without leaving a hole of the card's line colour, because no
  single rem value keeps three cells at 16px (78px) and gives one at 24px (118px).
- **The notice panels still run past 68ch** (1,045px on the home page's security caveat, 1,047 on the pricing page's licence
  note, 999 on the security page's Cloud caveat) and the footer's legal block is 879px. This pass took the one list that is plain
  prose in the page's column; a panel's own width is a change to what the panel is.
- **The plan chooser still changes the page's height when another plan is chosen** (Community 682.6, Team 604.3, Business 705.1,
  Enterprise 658.6 at 360), as the 2026-11-04 pass recorded.
- **The security page's On this page row still cuts 64px of "Reporting a problem" at 1,440**, and the phone's two actions under the
  plans still stack at 320–410; neither changed.
- **No capture was retaken**, Curule Cloud's prices are still in the app, and `site/ux/` was not edited. `npm run site:check` still
  exits 1 on the owner's `TODO(owner)` at `site/legal/index.html:134`.

The next pass's first job is still the page's length and the two wide notes; after them, the figure labels at a 2× text size.

## 2026-11-05, third pass: a step's Copy button keeps off its heading, a figure's caption stays whole, and the prose keeps its measure

Measured with the same probe (Chrome 156 over CDP; reduced motion; light unless said; touch at 320/360/390, a mouse at 768 and
1,440; dark at 360 and 1,440; print at 794; a 24px and a 32px root at 320/360). The before column is the site at `259ee31`,
exported with `git archive` and served on a second port and measured in the same run; no number is copied from an earlier pass.
The absolute heights are this container's; both halves are one browser in one run, so the differences stand.

### What changed

- **A step's Copy button no longer grows over its heading.** At a 24px root the demo's first heading line was **222.9px** in a
  232px column and the Copy button began at **262** and was **82px** wide, so the last **14.9px** of the line — its comma — was
  under the button; at 32px the button was **99px** at 245 and the second line reached **273.6**, **28.6px** under it. The button
  keeps one **64px** width (its word wraps inside it) and the heading reserves **72px** (the button, the bar's 6px inset and a 2px
  gap). The heading's lines now end at **223.7** at 24 and **184** at 32, well left of the button at **280**; the heading takes
  three lines at 24 (74.1 → **111.1**) and four at 32 (148.2 → **197.6**) because it is narrower, and the page is **19,816 →
  19,853** at 24 and **29,773 → 29,822** at 32, 0px over. The licence list uses the same step component: its heading is two lines
  at 360 now (25 → **49**) and the pricing page is **13,488 → 13,509** there; that 21px is the cost of the same reserve.
- **A plan's figure label keeps the 12px caption floor.** At a 32px root "projects open" was **24px** and needed **96px** in the
  79px cell of the Community card, so the figure's frame clipped it to "project" and the missing "s"; at a 24px root the same
  label was 18px and needed **96px in 77px** at 320. It is **12px** at every root, as the plan chooser's name and the six-view
  chooser's are: **79 / 79** at 360 and **77 / 77** at 320 at 32px, and the figures beside it still grow (the amount 36px, the
  value 44px). The card is **1,805.7 → 1,743.3** at 32px/360 and the page **33,435 → 33,296**; at 24px it is **21,971 →
  21,884**. No page overflows at either root.
- **The Community card says "1 project open", not "1 projects open".** The home page's rate card already said "1 project open";
  the pricing page's generated card put a plural label over a figure of one. The exporter writes the singular when the plan's
  figure is one (the row labels of the comparison table keep their plural). The card and its figure row are the same height
  (730.6 and 81.8 at 360) and no page changes height for it.
- **A note and an answer take the prose measure.** At 1,440 the documentation map's note ran **1,063px** on one line (its
  1,120px box, about 152 characters) and the FAQ's answers were **736px** wide (the longest line **727**, about 91). The note is
  **612px** and two lines (56.4px high, was 34.7), the first document card **1,690.7 → 1,712.4** and the page **4,429 → 4,451**;
  an answer is **680px** and its longest line **676** (about 85), still five lines and the same 128px high, so the home page is
  the height it was. Both take the site's **68ch**, as the notes under the plans and the row list already did.

### Measurements after this pass

| Page, height at 320 / 360 / 390 / 768 / 1,440 | Before | After |
|---|---|---|
| Home | 13,356 / 12,604 / 12,160 / 12,113 / 11,282 | unchanged |
| Pricing | 14,440 / 13,488 / 12,841 / 10,164 / 9,317 | **14,440 / 13,509 / 12,841 / 10,164 / 9,317** |
| Documentation | 8,975 / 8,382 / 8,065 / 5,288 / 4,477 | **8,975 / 8,382 / 8,065 / 5,288 / 4,499** |
| Security / contact / legal / 404 | unchanged | unchanged |

- The step's heading and button at 360: at a 24px root the button is **82 × 44 at 262 → 64 × 44 at 280**, the line
  **222.9 → 223.7** (no overlap), and at 32px the button **99 at 245 → 64 at 280**, the second line **273.6 → 184**.
- The plan's label at 32px: **96 in 79 → 79 in 79** at 360, **96 in 77 → 77 in 77** at 320; at 24px/320 it was 71 in 66 and is
  66 in 66 (its text 48). The limits **172.8 → 110.4** at 32px/360, **110.4** at 32px/320 (was 172.8).
- The documentation note at 1,440: **1,120 × 34.7, one line 1,063 → 612 × 56.4, two lines**; the FAQ answer **736 → 680**
  wide, longest line **727 → 676**, five lines and 128px in both.
- No page scrolls sideways at 320, 360, 390, 768 or 1,440 in light or dark (**0** on all 70 pairs), the probe reports **0**
  console errors and **0 axe-core WCAG 2.0–2.2 A and AA violations** on the home, pricing and documentation pages at 360 and
  1,440 in both schemes, and the smallest computed text is **12px**. At a 24px and a 32px root every page is **0px over** at
  320 and 360. Without a script the home page is 12,581 and pricing 12,249 at 360, 0px over; print at 794 is 0px over on all
  seven pages (docs 4,671; home 11,840; pricing 10,017); with `forcedColors: active` at 360 every page is 0px over.
- The site's own suites are **154** tests, all passing; `pricing:check`, `site-chrome --check`, `npm run typecheck` and
  `npx eslint` on the touched files are clean. `npm run site:check` still exits 1 on the owner's `TODO(owner)` for the terms at
  `site/legal/index.html:134`.

### What this pass deliberately left

- **The plan's figure label is 12px at a reader's 24px or 32px root.** A caption at 12px is the ramp's floor, and the figure it
  names still grows; the alternative was the 18/24px label that clipped "projects open" to "project" in its 79px cell.
- **The licence step's heading wraps to two lines at 360** (25 → 49) and the pricing page is 21px taller there. The same 72px
  reserve is what keeps the heading off the 64px button at a reader's larger text; the demo's heading is unchanged at 360.
- **The documentation note is 22px lower at 1,440** (the first card 1,690.7 → 1,712.4), and the FAQ's answers are 56px narrower
  at a desk; at 360 both are already narrower than 68ch and do not move.
- **The page's length is still the next pass's first job**: the home page is 12,604 at 360, and the demo (1,600), the two ways
  (849) and the nine argument sections are where the words are. The security page's On this page row still cuts 64px of
  "Reporting a problem" at 1,440, and the plan chooser still changes the page's height when another plan is chosen.
- **The console captures were not retaken**, Curule Cloud's prices are still in the app, and `site/ux/` was not edited.

## 2026-11-05, fourth pass: a field's ring in High Contrast, the refusal at its field, and the plan that no longer moves the page

Measured with the same probe (Chrome 156 over CDP; reduced motion; light unless said; touch at 320/360/390, a mouse at
768/1,024/1,440; dark at all six; print at 794; forced colours at 320/360/768/1,440; no script at 320/360; a 24px and a
32px root at 320/360). The before column is the site at `1db915e`, served from this worktree before any edit, measured in
the same run; no number is copied from an earlier pass. The absolute heights are this container's; both halves are one
browser in one run, so the differences stand.

### What changed

- **A field's focus ring is an outline, so a forced-colour mode keeps it.** The filter's and the estimate's focus ring was
  `box-shadow: var(--k-ring)` with `outline: none`, and a forced-colour mode drops shadows. Measured at 360 with
  `forcedColors: active`, under a real focus: `outline: none 3px`, `box-shadow: none`, and the border the only change —
  `rgb(0, 0, 0)` at rest, `rgba(5, 0, 73, 0.8)` focused (a composite of 55, 51, 109), **1.86:1 between the two and 1px
  wide**. The three number fields, the model select and the docs filter take the page's outline on `:focus-visible`: **2px
  at a 2px offset, 11.31:1 against the field's white**, at 320, 360, 768 and 1,440. A pointer keeps the border and the
  shadow; no box moves.
- **A refusal stands at the field it names.** The projects hint is 67.2px at 360 (67.2 at 320, 44.8 at 390 and 1,440,
  22.4 at 768) and the error stood **6px under the hint**, so the projects refusal was **79.2px below the input** at 360
  and 320, 56.8 at 390 and 1,440 and 34.4 at 768 — the third thing under the field. It is the input's next sibling now,
  **6px under it at every width**, and the hint follows; `aria-describedby` still reads the hint first and the error last.
  The missions field, which also has a hint, is the same. The error state is the height it was and the default page does
  not move.
- **Choosing a plan moves nothing below it.** At 360 the four cards were 730.6 / 624.5 / 749.4 / 658.6px, and the one
  chosen set the section's height: choosing Team pulled "Do you run it, or do we?" from **2,199.0 to 2,092.9** (−106.1px)
  and the page from 13,509 to 13,403. The four cards share one cell now, as the six console views do; the cell is the
  tallest plan's (Business, 749.4px) and the chosen card takes its height with its action at the bottom, the shape a plan's
  card already has when four share a row at 720. `#ways` is **2,217.8 for all four at 360** (2,444.2 at 320, 2,102.3 at
  390) and the page 13,528 / 14,506 / 12,864 for every choice. The default view grows **18.8px at 360, 65.3 at 320 and
  22.5 at 390**; a choice's movement is 0, where it was up to **125.1 / 137.3 / 100.8**.

### Measurements after this pass

| The field's ring, forced colours at 320/360/768/1,440 | Before | After |
|---|---|---|
| The outline | `none 3px` | **`solid 2px`, `offset 2px`** |
| The shadow | none | none |
| The border, rest → focus | rgb(0, 0, 0) → rgba(5, 0, 73, 0.8), **1.86:1** | unchanged (the outline is the ring) |
| The ring against the field's white | — | **11.31:1** |

| The projects refusal, input → error | 320 | 360 | 390 | 768 | 1,440 |
|---|---|---|---|---|---|
| Before | 79.2 | 79.2 | 56.8 | 34.4 | 56.8 |
| After | **6** | **6** | **6** | **6** | **6** |

| The plans at 320 / 360 / 390 | Before: `#ways` for Community / Team / Business / Enterprise | After |
|---|---|---|
| 320 | 2,378.9 / 2,319.2 / 2,444.2 / 2,306.9 (137.3 apart) | **2,444.2 ×4** |
| 360 | 2,199.0 / 2,092.9 / 2,217.8 / 2,127.0 (125.1 apart) | **2,217.8 ×4** |
| 390 | 2,079.8 / 2,001.5 / 2,102.3 / 2,055.8 (100.8 apart) | **2,102.3 ×4** |
| The page, 320 / 360 / 390 | 14,440 / 14,381 / 14,506 / 14,368; 13,509 / 13,403 / 13,528 / 13,437; 12,841 / 12,763 / 12,864 / 12,817 | **14,506 / 13,528 / 12,864, one height for every choice** |

- The default view grows 65.3px at 320, 18.8 at 360 and 22.5 at 390; the pricing page at 768 / 1,024 / 1,440 (a mouse) is
  **10,144 / 9,346 / 9,253**, unchanged, and so is print at 794 (**10,017**, four cards). Without a script the page is
  **12,268** at 360 (was 12,249), the chosen card is visible and the other three size the cell.
- No page scrolls sideways at 320, 360, 390, 768, 1,024 or 1,440 in light or dark (0 on all 84 page/width/theme pairs),
  the probe reports 0 console errors, the smallest computed text is **12px**, and axe-core WCAG 2.0–2.2 A and AA is **0**
  on the default pages, the estimate with all three errors shown, and each of the four plans chosen. At a 24px root the
  pricing page is 21,951 at 360 and 24,258 at 320; at 32px 33,472 and 38,033, all 0px over, with the cell the tallest plan's.
- `tests/build/site.test.ts` holds the shared cell (and the stylesheet's list of what it hides), the four chips, and the
  field's outline beside the shadow; `tests/build/site-pricing.test.ts` holds the error between the input and the hint.
  The build suites are **232** tests, all passing; typecheck and eslint on the touched files are clean, `site-chrome
  --check` and `pricing:check` pass, and `npm run site:check` still exits 1 on the owner's `TODO(owner)` at
  `site/legal/index.html:134`.

### What this pass deliberately leaves

- **The default view pays the tallest plan's height.** Community's card is 730.6px at 360 and now stands in a 749.4px cell
  with its action at the bottom (65.3px of room at 320, where Business is 819.9 against Community's 754.6). That is the
  price of a choice that moves nothing, and the same blank a plan's card has beside a taller one at 720 and up.
- **The card's action is 125px lower for Team, Business and Enterprise.** It sits at the cell's bottom now, where the card
  at 720 puts it; the section below does not move with it.
- **A refusal still adds its line while it is shown** (26.3px at 360, 40.6 for the missions error at 320/360), as before;
  the hint moves down by it and the page grows by it. The order is what changed, not the height.
- **The estimate's quoted plan still has no way to ask for the quote in the result**; the Enterprise card above has "Talk
  to us". A line in the ledger is the next pass's, if the owner wants the estimate to carry it.
- **The security page's On this page row still cuts 32px of "Reporting a problem" at 1,440** (64px of scroll, 32 of the
  chip) and the page is still 13,528 at 360; the row of seven chips cannot fit the 1,120px column at 14px, and the edge
  shadow is its cue. The console captures were not retaken, Curule Cloud's prices are still in the app, and `site/ux/` was
  not edited. This pass's frames are handed over with the report.

## 2026-11-06: a count that agrees with the map, a button's edge while it says Copied, and the twin a dark visitor opens

Measured with the same probe (Chrome 156 over CDP, reduced motion, light unless said, touch at 320/360/390, a mouse at
768/1440). The before column is this worktree before any edit, served on port 4380 and measured in the same run; no number is
copied from an earlier pass. The absolute heights are this container's system font; both halves are one browser in one run.

### What changed

- **The documentation page's visible count is the map's answer at once.** With a no-match filter the map is empty at once and
  the empty panel says `No document matches “kubernetes operator”`, but the count above it said **"All 16 documents"** until
  the 400 ms pause, then **"0 of 16 documents"**. Clearing the field was the same contradiction the other way: the sixteen
  documents came back while the count still said **"0 of 16 documents"**. The count a reader sees is now written with the
  rows, at once; only the polite live region (`#doc-filter-announce`) waits for the pause, which is what the pause was for —
  a screen reader is still told one answer, not one per keystroke. At 360 typing the same query now gives **"0 of 16
  documents"** while the announce still holds `All 16 documents` until the pause, then the 102-character sentence with the
  query and the Clear. The empty panel is **318 × 228.4** at 360 and **1,120 × 147.6** at 1440; the page is the height it was
  (8,173 at 360, 4,445 at 1440), and the no-match page is 4,101 at 360 and 2,727 at 1440.
- **A copy that says Copied keeps a control's edge.** The success state painted its border with
  `color-mix(in srgb, var(--k-ok) 40%, transparent)`; on the button's hover ground that composites to **#98beae on #f7f5f1,
  1.87:1** in light and **#2f6952 on #22211e, 2.50:1** in dark (1.78 and 2.45 on the panel at rest), under the **3:1** a
  control's boundary needs, for the 2.2 seconds the button says Copied. The edge is `var(--k-ok)` now: **#0a6b49 on
  #f7f5f1, 6.00:1** light and **#43d6a0 on #22211e, 8.71:1** dark (6.54 and 9.41 on the panel), so the state still says what
  went well in colour as it does in words and the button keeps its boundary. The button is **76 × 44** at 360 and **76 × 36**
  at 1440, the address row **169.4** and **93.8**, in both states: nothing moves.
- **A capture's Full size link opens the twin the picture is showing.** The plate swaps the Overview, Events and Designer
  pictures with `<source media="(prefers-color-scheme: dark)">`, but all three Full size links named the light files. In dark
  at 360 and 1440 the picture was `shot-overview-dark.jpg` while the link opened `shot-overview-light.jpg`: a **1440 × 900**
  light capture whose top-left pixel is **rgb(241, 238, 231)** against the dark page's **rgb(19, 18, 17)**. The three links
  carry `data-shot-dark` now and `shotHref()` in `site.js` gives the link the dark twin when the visitor's scheme is dark (and
  follows a change of scheme); the opened dark file's top-left is **rgb(14, 13, 11)**. The light file stays in the markup, so
  a browser with no script still opens it; the six view cards and the graph have no dark twin and keep their one file. The
  halves are the same 1,440 × 900, so no page moves.

### Measurements after this pass

| The documentation filter, after typing `kubernetes operator` | Before | After |
|---|---|---|
| The visible count at 0 ms (map 0 of 16, empty panel shown) | **All 16 documents** | **0 of 16 documents** |
| The count when the 400 ms pause has passed | 0 of 16 documents | 0 of 16 documents |
| The live region at 0 ms | All 16 documents | All 16 documents (it still waits) |
| The live region after the pause | No document matches “…”. 0 of 16… | the same sentence |
| After Clear, the count at 0 ms (map 16 of 16) | **0 of 16 documents** | **All 16 documents** |

| The Copy button | Light, at rest | Light, Copied before → after | Dark, at rest | Dark, Copied before → after |
|---|---|---|---|---|
| Border | #837d72 | **#98beae 1.87:1 → #0a6b49 6.00:1** | #7a746a | **#2f6952 2.50:1 → #43d6a0 8.71:1** |
| Against the ground it is on | #fff, 4.08:1 | #f7f5f1 | #1b1a18, 3.75:1 | #22211e |
| The button at 360 / 1440 | 76 × 44 / 76 × 36 | 76 × 44 / 76 × 36, no move | 76 × 44 / 76 × 36 | unchanged |

| The plate's Full size link, dark scheme at 360 / 1440 | Before | After |
|---|---|---|
| The picture the pane shows | shot-overview-dark.jpg | shot-overview-dark.jpg |
| The file the link names | **shot-overview-light.jpg** | **shot-overview-dark.jpg** |
| The opened image's top-left pixel | **rgb(241, 238, 231)** (light paper) | **rgb(14, 13, 11)** (the dark page) |
| The three views | Overview, Events, Designer all light | all the twin they show; light scheme unchanged |

- Page heights are unchanged at every width: home **13,130 / 12,280 / 11,971 / 12,037 / 11,119**; pricing **14,325 / 13,218 /
  12,583 / 10,026 / 9,102**; documentation **8,960 / 8,173 / 7,930 / 5,132 / 4,445**; security **12,258 / 11,076 / 10,519 /
  7,738 / 7,444**; contact **4,639 / 4,282 / 4,141 / 3,413 / 2,833**; legal **5,464 / 4,887 / 4,641 / 3,420 / 3,262**; 404
  **2,266 / 2,065 / 2,021 / 1,437 / 1,516** at 320 / 360 / 390 / 768 / 1,440.
- No page scrolls sideways at 320, 360, 390, 768, 1,024 or 1,440 in light or dark (**0** on all 84 page/width/theme pairs),
  and the dark sweep confirms the page's ground is `rgb(19, 18, 17)` on every one. No page error is reported.
- The site's own suites are **158** tests, all passing (155 before: the three new tests are the twin's markup, the twin's
  script and the copy boundary; the count is held by the filter test this pass changed); `site-chrome --check` and
  `pricing:check` pass; `npm run typecheck` and `npx eslint` on the touched tests are clean. `npm run site:check` still exits
  1 on the owner's `TODO(owner)` for the terms at `site/legal/index.html:134`.

### What this pass deliberately leaves

- **The six view cards and the graph still show the light captures in dark.** Only the plate has dark twins, and retaking the
  six 720 × 450 pictures and the graph is the console's job, not this pass's.
- **The spoken count still waits 400 ms.** The visible count is now immediate, because it sits beside the rows; the live region
  keeps its pause so a fast typist is still announced one answer, as `site/README.md` says.
- **The copy button's success border is green rather than the neutral control line.** The status colour is the state's own
  colour and clears 6.00/8.71:1; the neutral line would lose what went well from the edge, which the words already say.
- **No capture was retaken**, Curule Cloud's prices are still in the app, and `site/ux/` was not edited. The next pass's
  questions are the six cards' dark twins, the security page's On this page row at 1,440 (its last chip is still cut) and the
  plan stack's repeated limits.

## 2026-11-06, second pass: the period keeps its cell, a scroll region is a stop only while it scrolls, and an empty box asks for a number

Measured with the same probe (Chrome 156 over CDP; reduced motion; light unless said; touch at 320/360/390, a mouse at
768/1,024/1,440). The before column is the commit this pass started from (`91867ff`), extracted to a second copy and served
on port 4392; the after is this worktree on 4391. Both halves were measured in the same run, and the before and after
screenshots at 360 and 1,440 are of those two copies. The absolute heights are this container's; the differences stand.

### What changed

- **The billing period no longer moves the page.** The four plan cards' prices did not share a cell: the annual price's
  second line (`per month, billed annually ($1,488 a year)`) was `display: none` when Monthly was chosen, and the phone's
  period row the same. Choosing Monthly pulled "Two ways in" up **18.8px at 360** (40.6 at 768, 20.3 at 1,440),
  "What you are paying for" up **107.3px at 320, 62.3 at 360 and 43.5 at 390**, and the page by **108 / 62 / 44 / 41 /
  21px at 320 / 360 / 390 / 768 / 1,440** (0 at 600, 719 and 1,024, where both periods are one line). Both prices are in
  one cell of `.plan-price` now, and the phone's two period rows in one cell of the stack's `dl`; the one not chosen is
  `visibility: hidden`, so it keeps its box and leaves the accessibility tree. The choice moves **0px at every width**,
  and the Annual view is unchanged: 14,506 / 13,528 / 12,864 / 11,290 / 10,917 / 10,144 / 9,346 / 9,253 at 320 / 360 /
  390 / 600 / 719 / 768 / 1,024 / 1,440. The cost is the gap the annual figure already had: the Team card's price cell is
  **93.3 → 113.6** at 320, **93.5 → 113.6** at 360 and **72.5 → 92.8** at 768/1,440 in Monthly, and the phone's period
  row **36.8 → 80.3** at 320 and **36.8 → 58.5** at 360/390. Print stacks both prices, as before (10,017px at 794).
- **A box that cannot scroll is not a Tab stop.** The three demo commands, the licence command and the pricing page's two
  comparison tables carried `tabindex="0"` as scroll regions. At 320, 360, 390, 768, 900, 1,024 and 1,440 every one had
  `scrollWidth === clientWidth` and `scrollHeight === clientHeight`: the commands wrap, and the tables fit at 720 and up
  and are not drawn below it. They were **three stops with nothing to scroll on the home page** (64 → 61 Tab stops at
  360, 72 → 69 at 1,440) and **three on the pricing page at 1,440** (58 → 55; one at 360, 50 → 49). The markup marks them
  `data-scroll`, and `needsTabStop()` in `site.js` gives a stop only while the content overflows; a licence command of
  **2,574px in a 326px box** takes `tabindex="0"` and gives it back when the text is short again. The ring rule inside
  the pre stays, for a command that does overflow.
- **An empty number is asked for as a number.** Clearing "Missions a month" (min 0) said **"Enter 0 or more. The estimate
  uses 0."** at 360 and 1,440: the sentence for a value below the minimum, never saying the box was empty. It says
  **"Enter a whole number. The estimate uses 0."** now, and a cleared projects or seats box **"…uses 1."**; a value below
  the minimum (missions = −1) keeps "Enter 0 or more…". The estimate, `aria-invalid` and the field's place are unchanged:
  the field 16,869, 328 × 44 at 360, its refusal 16,919, 328 × 20, and the page 13,500 at 360 and 9,279 at 1,440 in this
  state.

### Measurements after this pass

| The pricing page, Monthly | Before | After |
|---|---|---|
| Page, 320 / 360 / 390 | 14,398 / 13,466 / 12,820 | **14,506 / 13,528 / 12,864** (the Annual heights) |
| Page, 768 / 1,440 | 10,103 / 9,232 | **10,144 / 9,253** |
| Page, 600 / 719 / 1,024 | 11,290 / 10,917 / 9,346 | unchanged |
| "Two ways in", 360 / 768 / 1,440 | 2,199.0 / 2,472.9 / 1,990.1 | **2,217.8 / 2,513.5 / 2,010.4** |
| "What you are paying for", 320 / 360 / 390 | 5,406.0 / 5,014.3 / 4,825.5 | **5,513.3 / 5,076.6 / 4,869.0** |
| The Team card's price cell, 320 / 360 / 768 / 1,440 | 93.3 / 93.5 / 72.5 / 72.5 | **113.6 / 113.6 / 92.8 / 92.8** |
| The phone's Team period row, 320 / 360 / 390 | 36.8 / 36.8 / 36.8 | **80.3 / 58.5 / 58.5** |
| The choice's movement, 320 / 360 / 390 / 768 / 1,440 | &minus;107.3 / &minus;62.3 / &minus;43.5 / &minus;40.6 / &minus;20.3 (page &minus;108 / &minus;62 / &minus;44 / &minus;41 / &minus;21) | **0** |

| A focusable scroll region | Before | After |
|---|---|---|
| The home page's three commands, 360 / 1,440 | `tabindex="0"`; 326/326 and 84/105/147; 466/466 and 84/84/147 | no stop; **64 → 61** / **72 → 69** Tab stops |
| The licence command, 360 / 1,440 | `tabindex="0"`; 326/326 and 51/51; 466/466 and 51/51 | no stop; **50 → 49** / **58 → 55** with the tables |
| The two comparison tables, 1,440 | `tabindex="0"`; 1,118/1,118 and 535/535 / 284/284 | no stop |
| A 2,574px command in a 326px box | — | `tabindex="0"`; given back when short |

| The estimate's number fields, empty | Before | After |
|---|---|---|
| Missions a month, 360 / 1,440 | "Enter 0 or more. The estimate uses 0." | **"Enter a whole number. The estimate uses 0."** |
| Projects open / Agents, empty | "Enter 1 or more. The estimate uses 1." | **"Enter a whole number. The estimate uses 1."** |
| Missions = −1 | "Enter 0 or more. The estimate uses 0." | unchanged |
| `aria-invalid`, the estimate, the refusal's place | true, $0 / month, under the input | unchanged |

- The Annual page heights are the last pass's at every width; the Monthly state now joins them. The print sheet is
  **10,017px** at 794 and shows both prices, stacked.
- No page scrolls sideways at 320, 360, 390, 768, 1,024 or 1,440 in light or dark (**0** on all 84 page/width/theme
  pairs); the probe reports **0** console errors, the smallest computed text is **12px** on every page at 320 and 360,
  the contrast probe finds **0** failing text pairs on the seven pages at 360 in both schemes, and axe-core is **0** on
  the ten states read (the home menu open, the estimate with errors, the map with no match, the map read, the security
  page read, a copy that worked, the 404 at 320, the home at 390 in dark, the pricing page at 1,024, the home at 320).
- With no script the switch still works (the shared cell is CSS); the pricing page is 12,268 at 360 in both periods.
  In forced colours the chosen price is visible and the other is hidden; each is measured.
- The site's suites are **161** tests, all passing (158 before: the three new ones are `needsTabStop`, the empty field's
  words and the billing cell); `site-chrome --check` and `pricing:check` pass, `npm run typecheck` and `npx eslint` on the
  three touched test files are clean, and `set-domain --check` still exits 1 on the owner's one `TODO(owner)` at
  `site/legal/index.html:134`.

### What this pass deliberately leaves

- **The Monthly view pays the Annual's height.** The blank under the shorter price is 20.1–20.3px in the card and 21.7px
  in the phone's period row (43.5px at 320), and the Monthly page is up to 108px taller than it was. That is the same
  trade the plan chooser made (65.3px at 320) for a choice that moves nothing; the Annual view, which is what the page
  opens on, is unchanged.
- **The phone's comparison still shows one period at a time.** The shared cell keeps the annual row's height; showing
  both would close the gap and bring back the four rows the 2026-10-23 pass removed.
- **A page with no script gets no stop for a region that overflows.** None does today (the commands wrap and the tables
  fit); a future long command would be scrollable by touch and not by a scriptless keyboard. A static stop is the defect
  above.
- **The empty field's refusal still appears on the first keystroke**, as before; this pass changed its words, not when it
  shows.
- No product capture was retaken, Curule Cloud's prices are still in the app, and `site/ux/` was not edited (this pass's
  six before and six after frames are under `site/ux/shots/`). Still open from the last pass: the six view cards' and the
  graph's dark twins, the security page's On this page row at 1,440 (its last chip is 32px cut), and the plan stack's
  repeated limits.

## 2026-11-06, third pass: the On this page row fits a desktop, the estimate's strip keeps its lines, and the answer carries its action

Measured with the same probe (Chrome 156 over CDP; reduced motion; light unless said; touch at 320/360/390, a mouse at
1,280/1,360/1,440). The before column is the site at `e6a0b2e`, served on port 8811 and measured in the same run as this
worktree on 8851; no number is copied from an earlier pass. The absolute heights are this container's; both halves are one
browser in one run, so the differences stand.

### What changed

- **The security page's On this page row fits the page's column at 1,440.** The seven chips and their six 8px gaps were
  1,312px, and the column's inset (160px left, 32px right) made the row 1,504 in a 1,440px window, so it scrolled and
  "Reporting a problem" ended at 1,472: **32px of it past the edge**, with only the edge shadow to say the rest was there
  (72px past at 1,360, 112 at 1,280, 152 at 1,200). A desktop mouse has no swipe to give it. From 1,200 that row keeps
  11px a side instead of 16 and a 6px gap instead of 8 — 82px less — and the seven end at **1,390 in the 1,440 window**,
  whole, 50px inside it (1,350 at 1,360, where the edge was 72px past). The marked chip is inset by the same 22px (16
  before the 6px dot, 6 after) as a plain chip's 11 + 11, so the current section still moves nothing: scrolled to "What it
  protects" at 1,440 the row is 1,440/1,440 and the last chip still ends at 1,390. The bar is one row and 61px at every
  width, so the page heights and a followed chip's landing are unchanged: `#report` lands at 149.5 with the bar's bottom
  at 130 and its heading at 221.5 at 1,440, as before.
- **The strip over the estimate is two lines for every plan, so the fields never move.** The strip put the plan and the
  figure on one line when they fitted; at 360 Community's "$138 / month (model usage)" wrapped to a 72px strip and Team's
  "$262 / month (annual)" did not, 46px, so the first field moved **26px under the reader's hand** when the plan changed
  (one project to five), the result 26px and the note under it **43.2px** (the page 13,528 → 13,485). The plan is its own
  line now and the figure the next one — the taller state every plan already could need — and the strip is **72px for
  Community, Team, Business and Enterprise at 320, 360 and 390**. The first field is at 7,921.2 / 7,313 / 6,977.1 for all
  four, and the result begins at 8,497.5 / 7,866.9 / 7,508.6, the same four ways; the fields take the taller state's
  height, so at 360 the Team view is 26px taller and the page 13,485 → 13,511 before the answer's action below.
- **The estimate's answer carries the plan's own action.** The ledger named the plan and stopped: `#result` held **no link
  at all**, while the card that carries the way to buy it stood **4,455.8px above the answer at 1,440 and 6,824.9px at
  360**. The last row is a step now — the card's own action ("Start free", "Get Team", "Get Business", "Talk to us"), its
  address and its emphasis, read from `#plan-<id>` rather than written a second time in the script, so the two cannot
  disagree and a licence enquiry keeps the subject `site.js` puts on the card. A Team ledger ends on "Get Team"
  (`mailto:…?subject=Curule%20Team%20plan`) and a quoted one on "Talk to us", which is the line the 2026-11-05 pass left
  for the owner. The step is **278 × 44 at 320/360/390** and 486 × 40 at 1,440 (a mouse), with the page's 2px focus ring
  on Tab and a 2px outline in forced colours; the result is 60px taller (its 16px gap and the 44px button) and the page
  with it (13,528 → 13,588 at 360 for Community, 13,508 → 13,568 for Enterprise).

### Measurements after this pass

| The security page's On this page row | 1,200 | 1,280 | 1,360 | 1,440 | 360 |
|---|---|---|---|---|---|
| Row / window, before → after | 1,384/1,200 → **1,302/1,200** | 1,424/1,280 → **1,342/1,280** | 1,464/1,360 → **1,382/1,360** | 1,504/1,440 → **1,440/1,440** | 1,344/360, unchanged |
| The last chip's right edge, past the window | 152 → **70** | 112 → **30** | 72 → **&minus;10 (whole)** | 32 → **&minus;50 (whole)** | 968 → 968 (the swipe row) |
| The bar / `is-more` | 61, yes → 61, yes | 61, yes → 61, yes | 61, yes → 61, yes | 61, **yes → no** | 61, yes |
| The page | 7,630 | 7,638 | 7,638 | 7,638 | 11,600 |

| The estimate's strip and the first field | 320 | 360 | 390 |
|---|---|---|---|
| The strip, Community / Team / Business / Enterprise | 72/46/72/72 → **72 ×4** | 72/46/46/72 → **72 ×4** | 72/46/46/46 → **72 ×4** |
| The first field's top, the same four | 7,921.2 / 7,895.2 / 7,921.2 / 7,921.2 → **7,921.2 ×4** | 7,313 / 7,287 / 7,287 / 7,313 → **7,313 ×4** | 6,977.1 / 6,951.1 / 6,951.1 / 6,951.1 → **6,977.1 ×4** |
| The result's top | 8,497.5 / 8,471.5 / 8,497.5 / 8,497.5 → **8,497.5 ×4** | 7,866.9 / 7,840.9 / 7,840.9 / 7,866.9 → **7,866.9 ×4** | 7,508.6 / 7,482.6 / 7,482.6 / 7,482.6 → **7,508.6 ×4** |
| The page | 14,506 / 14,446 / 14,472 / 14,444 → 14,566 / 14,532 / 14,532 / 14,504 | 13,528 / 13,485 / 13,485 / 13,508 → 13,588 / 13,571 / 13,571 / 13,568 | 12,864 / 12,843 / 12,843 / 12,894 → 12,924 / 12,929 / 12,929 / 12,980 |

| The answer's way to its plan | Before | After |
|---|---|---|
| Links in `#result`, all four plans | **0** | **1** |
| The step | — | "Start free" → `../#try`; "Get Team", "Get Business", "Talk to us" → the card's `mailto:` (with its subject) |
| Its size, 320 / 360 / 390 / 1,440 | — | 278 × 44 / 278 × 44 / 278 × 44 / 486 × 40 |
| The card above the answer, 360 / 1,440 | 6,824.9 / 4,455.8 | the same card, no longer the only way |
| The page, 360 (Community / Enterprise) | 13,528 / 13,508 | **13,588 / 13,568** |

- No page scrolls sideways at 320, 360, 390, 768, 1,024, 1,280 or 1,440 in light or dark (**0** on all 98 page/width/theme
  pairs), the probe reports **0** console errors, and no computed text is under 12px. axe-core WCAG 2.0–2.2 A and AA is
  **0** on the six states read: the security page at 1,440 in light and dark, the Team estimate at 320 and 360 (light and
  dark) and the Enterprise estimate at 1,440.
- The step's focus ring is `solid 2px` at a 2px offset under a real Tab at 360, and `solid 2px` in forced colours; the
  card's words and address are one source, and the four cards keep their own actions.
- The site's suites are **164** tests, all passing (161 before: the three new ones are the security row's wide rule, the
  strip's two lines and the answer's step); `site-chrome --check` and `pricing:check` pass, `npm run typecheck` and
  `npx eslint` on the three touched test files are clean, and `set-domain --check` still exits 1 on the owner's one
  `TODO(owner)` at `site/legal/index.html:134`.

### What this pass deliberately leaves

- **Below 1,200 the security row is still the swipe row the shadow marks.** At 1,024 its last chip was 352px past the
  window and at 1,280 it is now 30 (was 112): the row's seven names do not fit that column without a smaller type or
  wrapping to a two-row bar, and a two-row bar is 113px pinned over the page. The wide desktop, where there is no swipe,
  is what this pass fixed.
- **The `is-more` shadow still shows at 1,360 and above while only the row's 32px end padding is past** a whole last chip.
  That is the padding the 2026-11-03 pass chose for a row read to its end, not a cut name.
- **The ledger's own height still differs by the plan it names** (the free plan's extra line, the quoted total's longer
  wrap), so the note below the estimate moves up to 20.4px at 360 and 56.3 at 390 when the plan changes. The fields, which
  the reader is typing in, no longer do.
- **At a reader's 200% text the strip takes three lines for the longer figures** (132px at 360 for Community and
  Enterprise) and two for the shorter (96), so the fields can still move 36px there; the two lines reserved are the 16px
  size's. The 200% test still finds the page its own width and the Enterprise figure whole.
- **The step's words are the card's.** "Get Team" under the ledger is the card's label; if the owner wants "See the Team
  plan" there, the change is in the card's action, where both read it.
- No product capture was retaken, Curule Cloud's prices are still in the app, and `site/ux/index.html` was not edited
  (this pass's six before and six after frames are under `site/ux/shots/`). Still open from the last two passes: the six
  view cards' and the graph's dark twins, and the plan stack's repeated limits.
