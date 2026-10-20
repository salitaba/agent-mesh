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
   actions take their own row and controls may grow to fill it.
2. **The state, before the content** — a banner for stale or refused, an
   `ErrorState` with a retry, an `EmptyState` with the next move. Never an empty
   card, never zeros standing in for "not read".
3. **The content** — sections with an `h3`; rows ruled by `--line`; cards only
   for a thing that can be pressed or a group that genuinely belongs together.
4. **The end** — long lists say how many they left off; long output is scrollable
   and its controls stay outside the scrolling text.

Overview is the one deliberate variation: its brief is short because the mission
hero directly under it is the page's real headline. The two are not peers: the
page name is a signpost, the hero is the news.

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
  a count, as Events already does; the search stays out.
- The Graph phone view is a list of seats (who they talk to, how many messages)
  and the ranked links, not a 900 px drawing that scrolls inside its frame.

## Open problems (carried forward)

- The project strip at 360 px carries four controls; even at 44 px, several
  projects make it a horizontal scroller. A phone could show the current project
  and open a full-height Projects sheet instead of a scrolling tab trough.
- The Events ledger's fold bar still hides a group of routine rows behind a
  control whose wording ("4 routine events") is longer than its utility on a
  phone; the pattern should be one row that says it can be opened.
- The Designer is out of this pass's surface, but its phone inspector is the next
  place where desktop controls are still being stacked.
- `YourProduct`'s live-UI poll (`productlive.ts` `refresh`) keeps the screen on a
  thrown request but does not check an HTTP error body: a 5xx `{error}` would be
  handed to `absorb` as an answer. Not observed against a running UI, so this pass
  did not change it; the next pass should prove it against a failed poll before
  touching it.
- Overview's avatar initials are 11 px glyphs in a 22 px disc. They are marks, not
  words, and stay at 11 on a phone.
- The public site (`apps/cloud-server/pages`) has its own memory; this pass did
  not change it.

## What the next pass should take

1. A phone project switcher (one row, one sheet) to remove the last horizontal
   scroller from the shell.
2. The Events fold bar (above), then the same disclosure pattern on any page whose
   filter row grows past one line. Files' filter fold is done.
3. Prove or disprove the `YourProduct` live-UI poll behaviour above against a
   failed `/ui` response, then fix it if it is real.
4. Read the console with a real thumb on a real phone: the measurements here are
   Chromium at 360 px with touch emulation only in CSS, not a hardware device.

## Pass log

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
