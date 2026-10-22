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
5. **No horizontal page scroll at 360 or 320.** A table, a terminal and the console views may
   scroll inside their own box; the page may not.
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

- Home order is now: hero, numbered index, `#pricing`, `#ways`, `#why`, `#how`, `#product`,
  `#try`, `#security`, `#faq`, closing band. The owner can see the price in the first quarter of
  the page instead of the last.
- Explanatory cards (`#why`, the home security answers, pricing's "paying", contact's guidance)
  are ruled entries. Surfaces remain only where there is an action: plans, start cards, document
  cards, addresses, 404 ways, calculator, frames.
- The home page has a numbered "On this page" index under the hero, at 44px a row.
- Console views on a phone are one horizontal snap row with a stated hint and a "Full size" link
  under each capture; the decorative drawings are hidden below 640px.
- Every capture has a "Full size" link, so the text inside a 1440px shot is reachable on a phone.
- Terminal code is 13px and no longer shrunk by the inline-code rule; brand, footer address,
  security glance links and arrow links meet 44px.
- The calculator's quoted plan ends on "Total: Quoted, plus model usage", with no empty figure.
- Sections are closer together (48–104px, from 64–120), and the text-card padding is gone.

## Still wrong / next pass

- The hero's first screen is still tall on a phone (~1,400px): the eyebrow, h1, lede, three proof
  points, two actions and a note before the frame. It could lose the eyebrow or one proof point.
- The pricing page's plan table is 720px wide and scrolls under a sticky first column. The sticky
  column is measured, but a phone reader still has to swipe; a per-plan stacked table would be
  better.
- The site cannot show Curule Cloud's prices: they live in the app. The home page says so; the next
  pass could add a generated "Cloud plans start at" line once the app exposes one stable price.
- The screenshots are 1440px wide and therefore small on a phone even at full size. A 720px capture
  set for the phone would read better than pinch-zooming.
- `site/DESIGN.md` is new; the account pages' record and this one should be read together.
