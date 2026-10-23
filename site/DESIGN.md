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
| Pricing | calculator always has a plan | inputs update on `input` | quoted plan says "Quoted, plus model usage", never an empty figure | Cloud visitor is told the estimate is a licence, and where Cloud's price lives |
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
| Pricing | 12,676 / **13,944** | 13,574 / **14,972** | 10,662 / 9,174 (unchanged) |
| Docs | 9,232 / 9,232 | 9,842 / 9,842 | 6,146 / 4,678 (unchanged) |
| Security | 11,916 / 11,916 | 12,823 / 12,823 | 8,327 / 7,668 (unchanged) |
| Contact | 4,815 / 4,815 | 5,110 / 5,110 | 3,871 / 2,815 (unchanged) |
| Legal | 5,267 / 5,267 | 5,741 / 5,741 | 3,863 / 3,317 (unchanged) |
| 404 | 2,348 / 2,348 | 2,443 / 2,443 | 1,911 / 1,524 (unchanged) |

- **Pricing at 360:** the plan table was 660×676 in a 326px window; the stack is four plans and
  1,558px tall, the run stack 803px. The page is 1,268px taller because all four plans are now read,
  not swiped. At 320 the stack is 1,666px and the page 1,398px taller. At 720 (the 200% stand-in) the
  table is 662×676 in a 662px box and the stack is hidden; the page is 11,152px, unchanged.
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
