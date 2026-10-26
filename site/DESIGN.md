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

