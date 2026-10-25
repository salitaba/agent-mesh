# The public site: a design record

The surface is `apps/cloud-server/pages`: the pages a stranger reads to understand Curule
Cloud, create an account, confirm an address, choose a plan and pay. Shared styles are
`assets/app.css`; shared behaviour is `assets/app.js`; the pages are static HTML with no
external asset and no inline script or style.

The marketing site (`site/`) keeps the other half of this record, in the same direction:
`site/DESIGN.md`. Read the two together; a rule added there about a card, a target or a state
applies here too.

## Direction: the plain ledger

**Exact, unhurried, warm.**

Curule's product is a record: roles, authority, approvals, an append-only log. The site
should look like a record kept by hand for someone who will read it later — ruled lines,
numbered entries, plain arithmetic, nothing decorative that is not also information.
*Exact* because the buying decision is a price and a set of limits, and every number must
carry its unit, period and condition. *Unhurried* because the reader arrives cold; the
price and the next action should be reachable without a wall of claims, and a paragraph
should be allowed to be one thought. *Warm* because this is a small service, not a bank:
paper rather than white, ink rather than black, rounding and space rather than borders
everywhere.

The direction applies mechanically:

- The home page's sections are numbered entries (`01 Plans`, `02 What you get`, …). The
  number is a small monospace caption marked `aria-hidden`; the h2 is the heading. Legal
  pages index their headings in a contents list instead of numbering them, because a
  reader arrives at a section directly from a link.
- A price always appears with its period and currency; a limit always with what it
  limits. Copy that is only true of one deployment mode is conditional, and a page that
  cannot learn the mode says only what is true in both.
- Rules are 1px `--k-line`; a stronger rule marks a section boundary. Cards are for
  things you act on (a plan, a form), not for every paragraph.
- Actions are verbs: "Create account", "Send the link", "Choose Team". The same action
  keeps the same name in the header, the hero and the account.

## Type

System UI for prose (`--k-font`), monospace for figures, addresses, keys and event ids
(`--k-mono`). The public site reads at **16px**; secondary prose is **15px**; captions,
labels and section numbers are **12px** and never smaller. Display sizes are fluid and
drawn from the same steps: **28 / 36 / 48 / 60px** for the home and 404 h1, **28 / 36px**
for auth and legal h1. Plan prices sit at **36px**; account figures at **30px**. The
dashboard's stricter 11–30 ramp does not apply here, but no public-site text may compute
below 12px at any width.

## Space

One scale, used without ad-hoc values: **4, 8, 12, 16, 20, 24, 32, 40, 48, 56, 64, 88**.
Section rhythm is 40–64px; card padding 24–32px; form gaps 20px; the gap between a
heading and its first line is 8–12px. The page gutter is `--gutter` (20px on a phone).
Content width is `--max`; prose inside legal pages is capped near 68 characters.

## Every view must cover

| State | The page says |
| --- | --- |
| Reading | The content is complete before JavaScript runs. Plans and the account say "Loading…" in words with a skeleton; the skeleton is hidden from assistive tech and a live region says what is happening. |
| Empty | What would be here, why it is not, and the one action that changes it. Never a blank panel. |
| Failed | What failed, whether the reader's data is safe, and the action to retry. A retry re-runs the same request. Failure copy must be true for both hosting-only and usage-selling services. |
| Refused | A link that cannot be used, a password that is wrong, a signed-out page: say what happened, then offer the way forward (send a new link, sign in, reset). |
| Long | Tables and output scroll inside their own box with a border and a reachable edge; the page itself never scrolls sideways at 320px. |
| Phone | Every action is reachable one-thumbed at 360px: targets at least 44px, no hover-only affordance, nothing meaningful hidden only on a phone. A row of navigation links wraps rather than hiding its last item past the edge. |
| Signed in / out | The header and the home hero actions change with the session; the page does not show "Sign in" to someone who is signed in. |
| Dark / light, forced colors, reduced motion, JS off | All content and controls remain legible and operable; animation is optional. |

## Words

- Say "workspace", "agent", "plan", "record". Do not say "mesh" to a stranger.
- "Hosting" and "model usage" are separate lines of the bill. A page must not claim there
  is no model usage when its own plans include some, and must not claim usage is included
  when it is not.
- Use the second person, the present tense, and the active voice. "We send a link", not
  "a link will be sent".
- Controls name their outcome; errors name the cause and the next action.

## What this pass changed (2026-10-20)

Every figure below was measured in Chromium (playwright-core, Chromium 1248) against the
trial service, with `prefers-reduced-motion: reduce`, at 320 / 360 / 768 / 1440px, in
light and dark. Geometry is from `getBoundingClientRect` and `getComputedStyle`; nothing
here is an impression.

- **The home page prices before it argues.** The h1 is now one sentence, the lede states
  what the service is and who runs it, and a line under the buttons says what the plans
  start at. The first plan begins at **y = 693** at 360×800 (was **y = 1737**), at 612
  at 768 and 712 at 1440; "From $149.00 a month" is at y = 485 on a 360px phone. The h1
  computes to **28px** at 360, **48.5px** at 768 and **60px** at 1440. The page is 3,737px
  tall at 360 because it then gives the four facts, the four steps and the billing rules;
  the price is inside the first screen.
- **A failed plans request no longer lies about the bill.** Previously `/api/plans`
  failing fell through to the hosting-only claims, so a usage-selling service told the
  reader it did not sell usage. The failure state now hides both conditional arrangements,
  shows the neutral "Model usage, stated" fact, promises no price, and offers **Try
  again**, which clears the cached failure and re-runs the request. The retry test takes the page from no cards to two cards and
  "From $149.00 a month". "No plan is on offer just now" and "could not be loaded" are
  distinct sentences.
- **Legal pages are navigable on a phone.** The side contents are hidden below 1000px, so
  a `<details>` contents box now sits after the h1: its summary and every link are 44px
  tall, and it duplicates `nav.toc` exactly (a test enforces the mirror). Terms is
  3,574px at 360px with the box; at 1440 the side contents links are 34px tall, above the
  24px inline exception and reachable with a pointer.
- **The five sign-in pages are one family with five jobs.** Each has its own eyebrow,
  h1, lede and rail of three or four steps, exactly one step marked
  `aria-current="step"`: signup (create → plan → workspace → team), login (sign in →
  workspaces → plan → settings), verify (link → once only → expiry), forgot (email →
  open link → sign in) and reset (the link → new password → sign in). At the time, a
  phone-only line under the form said what happens next; the 2026-10-22 pass replaced it
  with the rail itself, now shown at every width. Signup's consent links are **44px tall**
  at 360 (they were 18px); the label grows to 108px to give each line its own target.
- **The account's section strip wraps instead of hiding Settings.** At 360 the strip was
  421px of content in a 328px box with `scrollbar-width: none`: Settings ended at x = 437,
  93px past the edge, with no visible cue. It now wraps onto two rows; scroll width equals
  client width (328px), Settings sits at x = 174 on the second row, and all five panels
  remain reachable. First panel begins at y = 775; the page is 3,007px tall at 360.
- **The type floor is 12px everywhere.** Nine 11px labels on account and legal pages were
  raised; the account's step numerals were the last 11px text and are now 12px. A census
  of every visible text node at 320, 360, 768 and 1440 in both schemes finds nothing
  below 12px.
- **Words match the product.** "Mesh" is gone from the index title, h1 and the two account
  messages ("a workspace", "a team"); a test rejects it on every page and in the script.
  The front page title and meta description describe the hosted service without claiming a
  deployment mode. The password hint reads "A few words in a row make a good password."
  and the forgotten-password page is titled "Forgot your password?" as the link that
  brings people there says.
- **Dead weight removed.** The home redesign left `.how-card` unused, and `.todo`, `.org`
  and `.w3` were already unused (the last two were substrings of the SVG data URI, not
  selectors). The rules are gone. The stylesheet is **40,564 bytes** against its 40,960
  byte budget.

## What this pass changed (2026-10-22)

Same harness: Chromium 1248 against the trial service, `prefers-reduced-motion: reduce`,
at 320 / 360 / 768 / 1024 / 1440. Each defect below was reproduced in the browser before
it was changed, and each figure is from the page after the change.

- **The bar fits a 320px phone when signed in.** The signed-in bar was 5px wider than the
  screen: the nav's right edge sat at 325 on a 320px page (327 on the account). At 380px
  and below the bar now narrows its gutter, its gaps and its link padding: the nav ends
  at 312 (313 on the account), and the page does not scroll sideways.
- **The 404 has one primary action for each state.** A signed-in reader was offered two
  filled buttons ("See the plans and prices" and "Go to your account"), and the page
  cannot know which one the reader needs. The outbound plans link now carries
  `data-primary-out` and is filled only while signed out; a test counts the filled
  answers in both states.
- **A chosen plan is carried to the account.** "Choose Business" led to
  `/account#plan-h`, so the customer arrived at the top of the page with the plan list
  still closed. The link now carries the plan, sign-up keeps the pick, and the account
  opens the list, marks the card with a "Your choice" badge, focuses it and scrolls to it:
  measured `scrollY` 1359 with the card at 246px from the top.
- **A price is said only when one was read.** With the plans failing, the hero said
  "Plans and prices below" directly above "no price is shown". The hero and the foot now
  hold `[data-from-price]` nodes filled from one reading of the plans, and an empty line
  is not drawn. Measured with the plans down: both lines empty and hidden; with them up:
  "From $149.00 a month" at the top and at the foot.
- **The record is drawn on a phone.** The figure was `display: none` below 960px, so the
  only picture of what a workspace produces was absent on the owner's phone. It is now
  drawn at every width: 319px tall at 360, 235 at 768, 335 at 1440. On a phone it sits
  between the hero and the plans, so the first plan begins at **1,052** at 360 (693 in
  the 2026-10-20 record) and the page is 4,364px tall; the price line is still in the
  first screen at 485. The trade is deliberate: a stranger sees the product before
  choosing, and the price is still said before it.
- **The front page ends on Start.** After "04 How billing works" the page ended on prose,
  and a phone read ended with nothing to do. A fifth numbered entry, "05 Start", repeats
  the two doors and the price at the decision point, immediately above the footer.
- **The sign-in rail is on every screen.** The steps through each page's job (with the
  reader's step marked) lived inside `min-width: 900px`, so a phone never saw them. The
  rail now follows the form in the same column at every width, and the "Next:" line it
  duplicated is gone. Measured at 320/360/768/1024/1440: the rail is drawn, as wide as
  the form's card, with no horizontal overflow; its steps are styled outside any media
  query, which a test now checks.
- **The legal pages end on the way back.** The terms and the privacy notice ended on
  their last clause. Each now closes inside the article with the doors the header offers
  for the reader's state, plus the plans; the targets are 44px at 320 and 360.
- **The budget.** The stylesheet is **39,971 bytes** against 40,960. The sign-in panel's
  chrome and the mark's second drawing (a 280px watermark) paid for the additions; the
  header already carries the mark once.

## What this pass changed (2026-10-23)

Same harness: Chromium 156 over CDP against the trial service (`trial --port 7513`, whose
plans are the trial's own fixtures), `prefers-reduced-motion: reduce`, at 320 / 360 / 768 /
1000 / 1440 in light and dark, plus forced colours and a 720px viewport (what a 1440 window
has at 200% zoom). Figures are `scrollHeight`, `getBoundingClientRect` and `getComputedStyle`.

- **The first screen says who keeps the ledger.** A 15px line under the price names the
  operator the terms already name: "Run by Ali Tabatabaei, an individual." It is at y = 517
  on a 360 phone, one line, and the price stays at y = 485. The byline is the 30px the home
  page is taller at 1440 than before; nothing else on the first screen moved.
- **The home page is one ledger.** The four facts are three columns at 1000px and wider
  (each about 340px, from four of about 250), the four steps are a 2×2 grid at the same
  width, and both lists end on a rule. Every entry has the same 14px rhythm (the facts were
  20px) and the same 8px between a section heading and its first line. At 1440 "How it
  works" is 490px tall before and 341 after, and the facts 329 before and 402 after, which
  is the one cost of the wider measure. Total: **4,364 → 4,311** at 360, 3,078 → 3,072 at 768,
  2,671 → 2,701 at 1440 (the byline); 4,622 at 320.
- **A sign-in page is a form and a rail on a wide screen.** The rail sat under the form at
  every width after the 2026-10-22 pass, so at 1440 the form was a lone 448px column and
  the rail began at y = 820 (signup was 1,444px tall). At 1000 and wider they are two
  columns of one centred grid (form 448, rail 320, gap 48–96), still in that DOM order and
  still drawn at every width: signup **1,444 → 975** at 1440, the rail at x = 832, y = 115,
  level with the eyebrow it answers; login, forgot, reset and verify are 900 or shorter.
- **Fields breathe at the record's 20px.** `.field` gap 6 → 8 and margin 16 → 20. Signup
  pays 16px for it at 360 (1,464 → 1,480) and reads as two thoughts rather than a form of
  four.
- **The rail marks where the reader is, not only where the job starts.** The markup keeps
  exactly one step marked, as `pages.test.ts` requires; the script now moves that mark when
  the page's job moves: forgot, once the link is sent, marks "Open the link" (it marked
  "Enter your email"); reset with a dead or missing link marks "The link"; a changed
  password marks "Sign in again". Measured: forgot `[0] → [1]`, reset `[0]`.
- **A workspace's name is the first thing on its card.** 18 → 20px at weight 650, the state
  badge taken to the card's right edge, the sentence and the actions under them: the head
  row is 26px tall at 360 and at 1440, and `Running` no longer trails the name by a variable
  gap. Keyboard focus after an action was re-verified: Pause → the cursor is on Resume,
  Enter resumes it → the cursor is on Open.
- **The account's three figures are three ruled entries on a phone.** At 720 and narrower
  the glance drops its card chrome for a 10px ruled row: the block 220 → 190px and the page
  **2,944 → 2,910** at 360, while 768 keeps the cards (2,141 → 2,138) and 1440 does (2,178 →
  2,174). The section strip, not the cards, is the phone's way around the page.
- **The skeleton has the shape of the phone's page.** Below 720 its three tiles stack as the
  three stats do (3 × 60 + 12 gaps against the glance's 190 + 16 margin), so what arrives
  moves nothing. The account also now says "Loading your account." in its live region while
  the shape is up — the row the design table promised and the page did not have — and the
  line is cleared when the account, a failure or the sign-in redirect arrives, or when the
  stage announces a change of its own.
- **States, walked in the browser.** Loading (held `/api/me`): the skeleton, and the live
  line; failed (503): "The account could not be read just now. Reload the page to try again."
  and no skeleton; refused (signed out): `/login?next=/account`; empty (the only workspace
  deleted): "Make your first workspace", the create form in the card, and the strip down to
  Plan, Balance and Settings; sign-in validation ("Enter your email address.", cursor in the
  field, `aria-invalid`); sign-in refusal ("That email and password do not match an
  account.", password cleared and focused, the confirmation link behind it); and the sent
  state ("Check your email").
- **Widths and schemes.** 320, 360, 768, 1000 and 1440, light and dark; forced colours on the
  home, signup and account; 720 as the 200% zoom stand-in. No page scrolls sideways; nothing
  computes below 12px; no interactive target is under 44px at 320 or 360 (the 20px tick box
  is ticked by its 44px sentence).
- **The budget.** `app.css` is **40,871 bytes** of 40,960 (was 39,971). The byline, the
  wide-screen grid, the ruled phone figures and the skeleton's phone shape cost about 900
  bytes; the second `.section .facts` margin rule and the auth grid's redundant width rule
  paid for part of it. There are 89 bytes left, so the next pass should remove before it
  adds.

## What this pass leaves

- **The rail on a tablet sits under the form.** Two columns of 448 and 320 need about 800px,
  so at 768 the page still stacks (signup 1,451px). A 768-wide split of 60/40 would fit, but
  the form would lose its 30-character measure.
- **The section strip is 32px tall for a pointer.** WCAG 2.2 asks 24px and a phone gets 44px;
  raising it to 40 on a wide screen would move every panel 8px and was not worth it.
- **The consent links are 18px between 721 and 1000px.** They are 44px at 720 and narrower,
  where a finger is likely; the inline-link exception covers the rest.

## What is still wrong

- **A dead reset link is only refused on submit.** The reset page cannot ask the API
  whether its token is still valid: the page's allowed routes have no token check, and
  adding one means changing the control plane outside this surface. The form says "That
  link did not work" with the server's reason after the password is sent, and keeps the
  field; a reader still types before learning. Next pass, if server work is allowed: a
  `GET` check on page load that reuses the same refusal copy.
- **Prose-only inline links remain 18–19px tall.** The Terms page's "Privacy notice" link
  is 112×19 at 360; the signup consent links are fixed, and footer/header links are 44px.
  The W3C inline-link exception applies, and these links are reading rather than doing,
  but a thumb can miss them.
- **The account headings are not numbered entries.** They are labelled regions with
  pinned ids; adding a visible number inside the h2 would enter the accessible name of
  the section (an `aria-labelledby` reference includes hidden text), so it needs an
  `aria-label` on each panel or a number placed outside the heading. A CSS counter would
  also be wrong while the page loads: `display: none` panels do not increment, and
  Settings is visible before the others arrive, so it would be numbered 01 and then 05.
  Left alone rather than half-done.
- **The checkout page is the trial's stand-in.** The real payment provider's page is not
  part of this repository's surface and was not inspected. Prices and periods on the site
  were checked against the trial's plan fixtures (Team $149/month, Business $599/month,
  top-ups for a usage-selling service).
- **No automated accessibility audit.** axe-core is not installed and no dependency was
  added. Contrast is computed from token pairs by `tests/cloud/pages.test.ts` and
  `tests/build/*`; targets, overflow, type sizes and focus order were measured by hand in
  the browser.
- **200% zoom at 360px was not run.** The harness has no zoom emulation; the 320px pass is
  the closest stand-in, and it shows no horizontal overflow. A larger-text phone should be
  the first check of the next pass.

## Next pass

- Check at 200% browser zoom and with a large-text phone profile; measure the same census.
- Add the reset-token check on page load if the control plane can grow a non-mutating
  route, and use the same "That link did not work" copy as verify.
- Number the account's panels as entries only if the accessible names can stay clean;
  otherwise leave them as ruled headings.
- Run axe-core if it is ever available, on the same 320 / 360 / 768 / 1440 grid.
- Look at the checkout stand-in and the payment-return state as a page, not only as a
  flow.
- Re-run the failure, empty, refused and long-output states against a real deployment with
  a model key, where the account's usage table has more than one row.

## 2026-10-23: the large-text and long-table pass

Same surface, same trial service (`trial --port 7517`), Chromium 1248 through
`playwright-core`: 320 / 360 / 768 / 1000 / 1440 in light and dark,
`prefers-reduced-motion: reduce`, 720 as the 200% zoom stand-in, and a large-text profile
made by raising the root to **24px (150%)** at 320 and 360 and **32px (200%)** at 320, 360
and 1440. Each defect below was reproduced before it was changed. Heights are
`document.documentElement.scrollHeight`; positions are `getBoundingClientRect`; names are
from Chromium's accessibility tree.

- **The header now wraps instead of passing the edge when the text is large.** At 24px
  text on a 360 phone the signed-in bar was **390px wide on a 360px page** (the nav began
  at 112 and ended at 390); at 320 it was also 390. At 32px text it was **474px**. The bar
  had no wrap and the header added 14px of padding inside the page's 16px gutter. It now
  takes the page's gutter and, at 720px and narrower, lets the bar and its nav wrap: at
  24px the header is **97px tall** (the mark, then the links on one row) and the page is
  320/360 wide again; at 32px on 360 it is **141px** with the links in two rows; at 320 it
  is 141. Normal text is unchanged: the header is still **61px**, and on a 320 page the
  mark starts at **16** (it was 30) and the nav ends at **304** (it was 313). The account
  is 3,082px tall at 320 and 2,955 at 360 with the same fixture, before and after.
- **At 200% text the balance's two small figures no longer widen the page.** At 32px text
  on 360 the "From credit you added" column reached **401px** and its `$10.00` text
  reached **362** (41 and 2 past the page). The figures' grid items can now shrink, and
  the two secondary amounts are capped at `min(1.375rem, 9vw)`: they are **32.4px** on a
  360 screen and **28.8px** on 320, while "Available" stays **72px**. The page is 360 wide
  with no sideways scroll at either text size. The trade is deliberate: at 200% text the
  secondary figure is only about 4px larger than its 28px label, but it is on the page.
- **A long usage table keeps the name of its row while the money scrolls.** With 14 days
  and 8 workspaces, the by-day table is 781px in a 326px box at 360. Scrolled to the
  money (`scrollLeft` 455), the "Oct 22, 2026" cell was at **x = -438**, off the box; the
  reader saw two columns of figures with no day attached. The first cell of every row
  (header, body and total) is now sticky at the left edge: at the same scroll the day is
  at **x = 17** with the box at 16, and `DAY` and `Total` stay too. At 1000 and 1440 the
  table fits (934/934 and 1,078/1,078), so the rule does nothing there.
- **Following the account's section list gives the cursor to the section.** With the list
  focused, Enter on "Usage" updated the hash and scrolled to the right place, but left
  `document.activeElement` on **BODY**, so the next Tab went to Settings, past the
  section. A same-page link now focuses what it names (after the browser's own jump): the
  heading **Usage** has the cursor and a 2px ring, and the next Tab is the table region.
  Settings focuses its **summary** (the disclosure opens) and the next Tab is "Current
  password". The same handler serves the legal pages: the phone contents' second link now
  puts the cursor on **"What the service is"** instead of the body. All links without a
  target (`#`) are left alone.
- **The account's five sections are numbered entries, with their names intact.** Each
  heading carries `data-entry` 01–05 and draws it in 12px monospace before the title, as
  the home page does. The number is generated content with empty alternative text
  (`content: attr(data-entry) / ""`), so the accessibility tree still says
  **Workspaces, Plan, Balance, Usage, Settings**, not "01 Workspaces". The headings did not
  move; the page height is unchanged. A plan-only account shows 02 and 05, which are the
  sections it has: the numbers belong to the section, not to the count of what is visible.
- **States and schemes.** The account's loading, failed, empty, cancelled and paid states
  were walked again at 320/360 (the paid return leaves "Your payment has arrived." at
  y = 220 with the page at scrollY 0). The long, empty and failed usage tables were
  measured with the same fixtures. 320, 360, 768, 1000, 1440, 720 and the two text sizes
  have no sideways page scroll; the smallest text still computes to **12px** at normal
  text; both schemes were checked.
- **The budget.** `app.css` is **40,958 bytes of 40,960** (was 40,871, a net +87). The
  sticky column, the numbers, the wrap and the figures' cap cost more than that; comments
  and two merged media blocks paid for the difference. Two bytes remain: the next pass
  removes before it adds.
  `tests/cloud/pages.test.ts` now pins the sticky first cell, the number's empty spoken
  form and the wrap; the Settings summary assertion allows the `data-entry` attribute, and
  the header gutter assertion reads 0 (the design record here explains why). The behaviour
  of the jump is pinned in `pages-dashboard.test.ts`.

### What is still wrong

- **A dead reset link is still only refused on submit.** No `GET` token route exists in the
  control plane, and this surface must not add one. The form says "That link did not work"
  with the server's reason after the password is sent; a reader still types before
  learning.
- **The trial's payment page is not this surface and overflows by 5px at 360.** It lives in
  `apps/cloud-server/src/trial.ts`, not in `pages/`, and was looked at as a page
  (title "Pay: a trial", the plan and amount, one button and Cancel) but not changed. The
  real provider's page is still uninspected.
- **The secondary balance figures are capped rather than stacked at 200% text.** At 32px
  text on a 360 phone they are 32.4px against a 28px label. Stacking them would restore the
  hierarchy but add about 60px to every phone's balance.
- **Numbering leaves gaps when a section is absent.** A plan-only account shows 02 Plan and
  05 Settings; that is the section's place in the record, not a mistake, but a reader may
  look for 01.
- **Prose-only inline links remain 18–19px tall**, and the 200% check is still a stand-in:
  720px is what a 1440 window has at 200% zoom, while the 360px text checks raise the root
  rather than change the browser's default size. No axe-core run, and the usage tables
  have not been seen with a real model key behind them.

## 2026-10-23: the way-in pass

Same trial service (`trial --port 7620`), Chromium 1208 through `playwright-core`, 320 /
360 / 768 / 1440 at 800 tall, `prefers-reduced-motion: reduce`. Heights are
`document.documentElement.scrollHeight`; positions are `getBoundingClientRect`.

- **The way in fits one phone screen.** The sign-in family opened 48px below the header at a
  360×800 phone, which left the sign-up form's action at the very bottom (y = 709, bottom
  753) and the line to the other door — "Already have an account? Sign in" — below the fold
  at 818. The column's opening is now `clamp(24px, 4vh, 56px)` (32 at 800), the lede's gap
  to the form is 24 (was 28) and the consent row's gap to the button 12 (was 16): the action
  ends at 729 and the aside at **794**, both in the first screen, and `/signup` is
  **1,480 → 1,440** at 360 (320: 1,627 → 1,587; 768: 1,439 → 1,399; 1440: 963 → 923).
- **A refusal's action stays in the first screen.** After an empty submit the note grows the
  form by 66px, so the submit used to end at 819; it ends at **795**. A two-line refusal
  ("Choose a password of at least 10 characters.") still ends at 819, 19px below an 800px
  screen: the next pass would shorten that sentence or bring the note to the field.
- **A refused sign-in keeps its next action in view.** The resend block the page reveals
  ends at **787** (was 807) and its card at 808 (was 828); the primary "Sign in" is at 568.
- **A refusal describes the field it names, and stops when the field changes.** `invalid()`
  now appends the status region to the field's `aria-describedby` (the password keeps
  `password-hint`, so it reads "password-hint status") and the notice is cleared when that
  field is edited. Before, the mark was cleared on input but the sentence stayed: after
  typing the email the note was still 50px tall and the page 1,506px; now it is empty and
  the page back at 1,440.
- **The account is unchanged.** The plan-less account at 360 is 1,627px, no sideways
  scroll, nothing under 12px, no target under 44px, its first price at y = 708 and the
  "Choose a plan" action at 498. Both schemes, 320 and 1440 included.

## 2026-10-24: the path a stranger takes

Same harness: Chromium 156 (playwright-core, the headless shell) against two trial services — the
unmodified base on `trial --port 7670`, and this pass on `trial --port 7640` — so every "before" was
measured on the same commit with the same fixture, not copied from an earlier record. 360×800 and
1440×900, light and dark, `prefers-reduced-motion: reduce`, a touch pointer at 360. Heights are
`document.documentElement.scrollHeight`; positions are `getBoundingClientRect`; the fixture's
address is 29 characters, so the "Signed in as" line wraps to two lines at 360 in both halves.

- **The tick's refusal is said at the tick, and stops when the tick is ticked.** This was the one
  field the 2026-10-23 sentence was not true of: the consent branch wrote its message into the
  form's top status instead of calling `invalid()`. At 360, after email and password but no tick,
  the sentence sat at y = 314, **353px above the tick** at y = 667, and the tick carried no
  `aria-invalid` and no `aria-describedby`; ticking it left the sentence and the 1,530px page as
  they were. It is now `#agree-error`, a note after the consent row: at y = 685, **12px under the
  sentence it belongs to**, with `aria-invalid="true"` and `aria-describedby="agree-error"`. Ticking
  clears it: the note is 74 → 0px and the page 1,530 → **1,440**. With the refusal up the page is
  1,530px and the submit 775–819 in both halves: the note took the old top note's 90px, so the
  action is still 19px below an 800px screen (see what this leaves).
- **A failed read of the account carries the action its sentence promises.** With `/api/me`
  failing (503) the page said "The account could not be read just now. Reload the page to try
  again." at y = 135–209 and offered **no control** at all; the same was true of `/api/session`
  failing before the account was read. Both now say "... Nothing was changed." and put a
  **106×44 "Try again"** at y = 225, which loads the page and its one read again. A session that
  answers 401 now goes to `/login?next=/account`, as a signed-out page should, instead of showing
  a failure to someone who is not signed in. Measured at 360; the page stays 800 tall and the
  retry is above Settings.
- **A plan list that could not be read has its own retry, and the card at the top no longer
  dead-ends.** With `/api/plans` failing, the plan panel was a **51px sentence** ("... Reload the
  page to try again.") at y = 646 and the page **916px**, with **0 buttons in it** — while the
  card at the top still offered "Choose a plan" and its action jumped straight to that sentence.
  It is now a 133px warning with the sentence "The plans could not be loaded just now, so no plan
  or price is shown." and a 106×44 **Try again** at y = 722; the page is 998px. Pressing it
  re-reads `/api/plans` and draws the answer **in place**: the trial's two cards appear, the page
  is 1,627px again, the first "Choose Team" at y = 979, and no reload happens. The sentence is now
  the same wording and shape as the front page's failed plans.
- **After the link is sent, the page names what the link does.** The card said only "We sent the
  link to … It works once, and the email says when it expires."; nothing said that opening it
  confirms the address *and signs you in*, and the line beside the form still offered "Already have
  an account? Sign in", a door that refuses until the address is confirmed. The sentence now reads
  "Open it: it confirms your address and signs you in to your account." and the aside reads
  "Already confirmed? Sign in." — the same words the confirmation page uses. At 360 the card is
  604 → **656px** and the page **1,469 → 1,521** (1440: 991 → 1,016); the next action is in the
  first screen, and the aside at y = 850 is below the first screen, where it belongs. The sign-in rail no
  longer claims "Your address is already confirmed." (which the page cannot know) but "Your address
  must be confirmed first."; the sign-in page is **1,285px** before and after, and its rail span is
  still two 48px lines with no new overflow.
- **Widths, schemes and the floor.** 320, 360, 390, 768 and 1440 in light and dark on the plan-less
  account: no sideways page scroll (320: 320; 360: 360; 390: 390; 768: 768; 1440: 1440), no text
  under 12px, and the account is 1,757 / 1,627 / 1,579 / 1,078 / 1,036. At 360 the only control
  under 44×44 is still the 20px tick, whose label is 108px tall; at 1440 the 40px fields and 36px
  header links are the pointer's 24px exception, unchanged. The new "Try again" targets are 44px
  tall. Nothing new is coloured: `app.css` is untouched, at **40,958 bytes of 40,960**, because
  every addition reuses the note, button and row classes that were already there.
- **The harness was lying about one thing.** `FakeNode.dataset` returned a fresh snapshot, so the
  script's `field.dataset.refused` never survived a write: the sentence-stops-on-input behaviour
  the last pass measured in a browser could not be tested. It is now backed by the element's
  attributes, and `check()` fires `input` then `change` as a browser does, so the new consent test
  proves both the attachment and the clearing.

### What this pass leaves

- **The consent refusal still puts the submit 19px below an 800px screen.** The note is now at the
  field, but it is the same 74px the top note was; bringing the button fully in would mean a
  shorter sentence (it loses the privacy notice) or a compact error style the budget has no room
  to add. The reader sees the note and the top of the button on the screen they are on.
- **The account's failed read retries by loading the page.** Its first read is the page's whole
  setup, so there is no smaller request to re-run; the button says "Try again", not "Reload".
- **The confirmation page's success is still a flash.** `POST /api/verify` signs the person in and
  the page replaces itself with the account before "Your address is confirmed" can be read; the
  account says "Signed in as …" instead. Keeping the confirmation on screen would add the screen
  this pass removed, so it is left as it is.
- **A direct landing still shows a skeleton with three tiles that a plan-less account never gets**
  (a 628px block on a 982px page, against 1,627px after the read), then the page grows. The
  skeleton cannot know the plan before the read.

## 2026-10-24: the answer at the action

Same harness: Chromium 156 through `playwright-core` against the trial service (`trial --port
7601`), 360×900 with a touch pointer and 1440×900 with a mouse, light and dark,
`prefers-reduced-motion: reduce`. "Before" is this pass's own base commit on the same fixture —
a paid account with one running workspace, and a fresh account with no plan — not a figure copied
from an earlier record. Heights are `document.documentElement.scrollHeight`; positions are
`getBoundingClientRect` plus `scrollY`.

- **A plan action's refusal is said under the button that asked.** The plan panel's status was the
  first thing in the section, above everything it was about. Pressing **Manage billing** at 360 put
  its answer at **y = 1222**, 248px above the button at 1454, and the 138px the sentence took pushed
  that button to 1592 — out from under the pointer that had just pressed it — and left the cursor on
  **BODY**. Pressing **Choose Team** on a plan-less account answered at the plan section's top
  (**y = 623**), 350px above the button at 973 and 98px of new height above it. The sentence is now
  put with its action: in the plan's own row, 112px under the row's buttons (the button does not
  move: 1470 → 1470), and in the card whose plan was chosen, **14px** under its button (973 → 973),
  at the foot of that card. `leaveFor` gives the cursor back to the button the browser dropped it
  from: `document.activeElement` is "Manage billing" / "Choose Team" after the refusal, not BODY.
  The page is 2,910 → 3,100 with the note at 360 (the note is 146px: the trial's message is long).
- **A request made from the card at the top answers in the card.** On a past-due account,
  **Update payment details** lives in the stage card at y = 380, and its refusal was written into
  the Plan section — at 360 that section begins at **y = 1399**, so the sentence appeared about
  **1,050px** below the button, off the screen. The card now carries `#stage-status`, a note under
  its own sentence and above its buttons (y = 360–506 with the same message), the Plan section says
  nothing about an action it did not offer, and the cursor stays on the button. The card is empty
  when there is nothing to say: `.stage-body p` takes the margin that `p:last-child` used to give the
  sentence, so a stage with no message is the same 195px at 360 and 133px at 1440 it was.
- **A plan is promised only when one was read.** With `/api/plans` down, a person with no plan was
  told "A plan is a flat monthly price for your account … Choose one below and pay on the next page."
  over a section that said no price is shown — the same class of untruth the front page stopped
  telling on 2026-10-20. That card now reads **"The plans could not be loaded"** / "No plan or price
  is shown just now, and nothing was changed." with a **133×48 Try again** of its own (y = 417 at 360,
  244 at 1440). Pressing it re-reads the plans in place: the trial's two cards appear, the card
  becomes "Choose a plan", the page goes 917 → 1,620 at 360 (900 → 1,036 at 1440), and the cursor is
  on the card's new title. A retry that fails again leaves the button usable and the cursor on it.
  The Plan section keeps its own Try again for a paid account, whose card has no such button.
- **The allowance says what is left in words.** The middle figure read "From your plan $19.99 of
  $20.00" while its own spoken label said "From your plan: $19.99 left of $20.00". The visible line
  now reads **"left of $20.00"**, which is what the bar is a picture of; nothing moved at 360, 768 or
  1440, because the five characters fit the column.
- **A consent refusal is one line, so the sign-up action stays on the screen.** "Agree to the Terms
  and the Privacy notice to continue." wrapped to two lines (a 74px note) and put **Create account**
  at 775–819, 19px below an 800px screen. The note says **"Tick the box to continue."** — the
  sentence above it already names the Terms and the notice — and measures **50px**: the submit is
  755–799, inside the screen, and the page 1,530 → **1,514**. Ticking still clears it (1,448).
- **Widths, schemes and the floor.** 320 / 360 / 390 / 768 / 1440 in light and dark on the paid
  account: no sideways page scroll (320: 320; 360: 360; 390: 390; 768: 768; 1440: 1440), nothing
  under 12px, and no control under 44×44 below 721px. The account is 2,910 at 360 and 2,173 at 1440
  with the empty usage state — the same as before the pass. The new Try again is 48px tall and the
  stage note reuses the note, button and card classes.
- **The budget.** `app.css` is **40,936 bytes of 40,960** (was 40,958, a net −22). The
  `.stage-warn, .stage-bad` radius rule repeated what `.stage` already sets and paid for
  `.stage-body p { margin-bottom: 0 }`, which is what keeps the card's height when the new status is
  empty. Twenty-four bytes remain.

### What this pass leaves

- **Two Try agains on a plan-less page with the plans down.** The card at the top and the Plan
  section both re-read the plans (230px apart at 1440). The one in the card is the primary and the
  one in the section is small; both work, and the section keeps one because a paid account's card
  has no retry. Removing one would leave a reader at the section with no action.
- **The consent links still sit on 44px lines.** The label is 108px tall at 360, so "I agree to the
  Terms and have / read the Privacy notice." reads as two paragraphs. The targets are the reason
  (a finger is likely below 721), and an expanded hit area would overlap the two links' bands.
- **A plan's price and its paid-until date are still two clauses.** "$149.00 per month. Paid until
  November 24, 2026." is the most the page can say: whether the next period is charged automatically
  is the provider's business, and the page cannot learn it.
- **The usage read's own failure now matters more than it did.** The trial rate-limited this
  pass's repeated reads, which is what the panel's 98px "Too many attempts" note looks like; the
  sentence and its retry were not changed here.

## 2026-10-24: the account's rows on a phone

Same harness: Chromium 156 through `playwright-core` against a trial service of this pass
(`trial --port 7550`) and against the unmodified page files, both on the same fixtures: a fresh
account with no plan, which is what a new customer lands in, and a paid account with one running
workspace and an empty usage table. 320 × 900, 360 × 900, 390 × 900, 768 and 1440, light and
dark, `prefers-reduced-motion: reduce`, a touch pointer below 720. Heights are
`document.documentElement.scrollHeight`; positions are `getBoundingClientRect` plus `scrollY`.

- **The getting-started steps are one row.** The rail in the card at the top was 316px of content
  in a 286px card at 360, so `3 Open` fell to a second row while the 20px rule after `Workspace`
  stayed at the end of the first, pointing at nothing: the steps box was **52px** tall, with
  `Open` at y = 227. On a phone the rule between steps is gone and the row is numbers and names
  with 12px between them: the box is **22px**, `Open` is at y = 197, the card at the top
  **369 → 339** and the page **1,604 → 1,574** at 360 (390: 1,556 → 1,526). At 320 the three
  names are 240px in a 246px box, so they still take two rows — 52px, with no rule left hanging
  at the edge of the first. At 768 and 1440 the rail keeps its rules and does not move.
- **The account's own address is one line.** With this fixture's 23-character address,
  `Signed in as …` was 3px wider than its pill's 304px of text, so it broke after "Signed in
  as" and the capsule held two lines: **55px** tall, the head block **137px**, the card at the top at y = 198. The pill's
  side padding is 8px (was 12): the line fits, the capsule is **32px**, the head **115px** and
  the card at **y = 176**. At 320 the address still takes two lines; at 1440 the pill is 8px
  narrower and nothing moves.
- **The three amounts to add are one row, under a caption.** "Add $10.00" three times is 316px
  in a 280px trough at 360, so the trough took two rows and the third segment stretched to the
  full 280px: **96px**. The trough is now captioned **Add credit** — the phrase the front page
  already uses — and each segment is its amount, with the verb in the caption and in the
  button's own name (`Add $10.00`): three 92px segments in **50px** at 360, three 79px ones in
  the 246px trough at 320. The caption is hidden when the service sells no credit and when the
  plans could not be read, so it never sits over nothing.
- **The amount and its Pay are one row.** The field's 224px basis plus the 62px button and the
  10px gap is 296px in a 286px card, so the button wrapped by 10px and sat 44px under the field:
  the form was **128px**. The basis is 160px (the field still grows to fill a wide card): the
  **214px** field and the **62px** Pay share one row, the form is **74px**, and the balance panel
  **652 → 583**. At 320 the label "Another amount (USD)" takes two lines beside the 174px field,
  so the form is 97px; at 768 and 1440 the row was already one and only the caption is new
  (2,174 → 2,205 at 1440).
- **A failed plans read, retried, now brings the amounts too.** With `/api/plans` down the
  trough was empty, the hint empty and — this pass's caption — hidden; pressing the Plan
  section's **Try again** drew the plan and the prices from the answer, but the credit amounts
  stayed empty until the page was reloaded, because only the page's first paint asked for them.
  The trough is drawn from what the account has whenever the account is drawn: after that retry
  there are **3 buttons** ("Add $10.00", "Add $25.00", "Add $100.00"), the caption and the
  sentence back. It is redrawn only when what it says changes, so a look at the account while a
  workspace starts does not take the cursor from a button.
- **Widths, schemes and the floor.** 320, 360, 390, 768 and 1440 in light and dark on both
  fixtures: no sideways page scroll (320: 320; 360: 360; 390: 390; 768: 768; 1440: 1440), no
  console error, nothing under **12px**, and no control under 44 × 44 below 721px. Forced colours
  draws the amounts and the caption as the system's own. The caption, the group name and the
  buttons' spoken names are in `pages.test.ts`/`pages-app.test.ts`: the three segments' labels,
  their `aria-label`s, the group's `aria-labelledby`, and the caption's hidden state with no
  credit to sell.

### What this pass leaves

- **The steps still take two rows at 320.** The three names are 240px and two 12px gaps are 24,
  in a 246px box: they would fit only with no gap at all between the steps. The clean wrap is
  the better trade.
- **The caption costs 30px on a wide screen.** At 1440 the balance card is 30px taller than it
  was, which is the whole of the page's growth there; on a phone it is paid for by a wrapped
  row.
- **The plan panel's Try again still leaves the cursor on the body when the plans arrive.** The
  panel is drawn again with the answer, so the button that asked is gone; the card at the top
  puts the cursor on its new title in the same case, and the section could too. It was like this
  before this pass and is left for one that changes the section, not its rows.
- **The address strip's Copy button still takes its own line at 360.** The label, the 194px
  monospace host and the 65px button are 327px in 288px — 39px over, not the few pixels the
  identity and the amount field were over — so the fix is the strip's design, not a padding.
- **No new run at 200% text.** The 320px pass is still the stand-in.

## 2026-10-24: the link's life, and the way out before it fails

Same harness: Chromium 156 through `playwright-core` against this worktree's trial
(`trial --port 7644`), 360 × 900 with a touch pointer and 1440 × 900, light and dark,
`prefers-reduced-motion: reduce`. "Before" is the base commit's own pages served by the
same trial, measured again today; no figure is copied from an earlier pass. Heights are
`document.documentElement.scrollHeight`.

- **The card that says the link was sent stops repeating the heading under it.** The
  heading is now "Check your email" and the card opened with the same sentence again in a
  green note ("Check your email for a link to confirm your address."), so the first thing
  under the heading was the heading. The card now opens with what happened: "We sent the
  link to …". At 360 the card is **656 → 566px**, the page **1,529 → 1,439**, and the
  line to the other door ("Already confirmed? Sign in.") moves from y = **854** to 764,
  inside an 800px screen. The card is still focused, so what happened is still announced.
- **The sent card states the link's life, not where to read about it.** It said "It works
  once, and the email says when it expires." The sign-up page's own line now carries the
  period from `verificationHours` ("We send a link to confirm your address; it expires
  after **24 hours**."), and the sent card reads that line before `retitle` clears it:
  "It works once and expires in 24 hours.", exactly as the confirmation page and the email
  say it. With a service set to one hour, the page says **"1 hour"** (a test pins it). At
  360 and 390 the line keeps its two rows and the page its **1,448px**; at 320 the line
  takes a fourth row and the page is **1,595 → 1,620**, at 768 **1,407 → 1,433** and at
  1440 **931 → 956**. The sent card's paragraph keeps the 154px it had.
- **A reset page says how long its link lasts, before anything is typed.** The lede now
  reads "The link works once and expires after 2 hours." from `resetHours` (the same
  number the email gives), and the page that asks for a link repeats it in its own lede.
  At 360 the reset lede keeps its 102px (the words fit the lines it had); the forgot page
  grows **1,143 → 1,169** (+26) at 360 and 768, unchanged at 320 and 1440.
- **The way to another link is on the reset page before the link is tried.** A
  **286 × 44 "Send a new link"** sits under the form at y = 544 at 360 (382 × 44 at 1440),
  so a person holding a link they know is old does not have to type a password and submit
  it to be told there is a way out. The page is **1,137 → 1,181** at 360 (the one button),
  **1,161 → 1,231** at 320 and **1,111 → 1,181** at 390, where the period sentence also
  takes a row; a page with no token is unchanged at **981** because the appended link it
  used to build after a refusal is now this one, and a used link after a submit is
  unchanged at **957** with the cursor on **`#ask`** (before: an anonymous link, appended
  by the refusal).
  Without a script the page now has a working 286 × 44 way out at y = 462 where it used
  to have a hidden form and nothing to do.
- **One action keeps one name.** The reset page's way out was "Ask for a new link" while
  the confirmation page's was "Send a new link"; both are "Send a new link" now.
- **Widths, schemes and the floor.** 320, 360, 390, 768 and 1440 in light on every account
  page: no sideways page scroll (320: 320; 360: 360; 390: 390; 768: 768; 1440: 1440),
  nothing under 12px, and the only control under 44 × 44 below 721 is the 20px consent tick
  whose label is 108px. Dark at 360 on the reset, sign-up and sign-in pages; the new button
  is the existing `.btn` on the existing card. No colour, size or spacing step was added,
  and **`app.css` is untouched at 40,953 bytes of 40,960**.
- **Tests.** `pages-app.test.ts` pins the sent card's opening sentence and the period from
  a one-hour service, the reset page's way out before any failure, its single link after a
  refusal, and the cursor on it; `pages.test.ts` counts the three new `data-policy` spans
  (`signup:verificationHours`, `forgot:resetHours`, `reset:resetHours`) so a period cannot
  become prose.

### What this pass leaves

- **A dead reset link is still discovered only on submit.** No non-mutating token route
  exists in the control plane, and this surface does not add one. The page now says how
  long the link lasts and puts the way out beside the form, so the recovery is one press
  rather than a typed password and a refusal, but the form still appears for a link that
  cannot work. A `GET` check on load, reusing "That link is not valid, or it has expired.",
  is the next step if the service can grow the route.
- **The reset page is 44px taller at 360 for the button.** The alternative — the link only
  after a refusal — is the path this pass removed.
- **The sent card's period is the sign-up page's own line, filled once.** It is painted by
  `paintPolicy` at load, before the card exists, so the first frame of the sent card is
  already right; if the plans cannot be read the page's default ("24 hours") stands, as the
  confirmation page's markup does. A service whose mail says another number and whose plans
  are down would show the default.
- **The account is unchanged by this pass.** Its plan retry, address strip and loading
  skeleton still have the defects the previous sections record.

## 2026-10-25: the card's facts and their actions

Same harness: Chromium 156 through `playwright-core` against this worktree's trial
(`trial --port 7812`, whose plans are the trial's own fixtures), 320 / 360 / 390 / 768 /
1440, light and dark, `prefers-reduced-motion: reduce`, a touch pointer below 721.
"Before" is the base commit's own page files served by the same trial on the same fixture,
measured again today: a Team account with one running workspace and an empty usage table,
and a fresh account with no plan. Heights are `document.documentElement.scrollHeight`;
positions are `getBoundingClientRect` plus `scrollY`.

- **A workspace's plan and the control that changes it are one row.** The card stacked
  "Plan Team" over its own `Change plan` button: a 16px line, a 10px gap and a 44px button
  (76px at a phone, 64 at a pointer) for one fact and one action. The button now sits in
  the plan's line, after the name it changes: the row is **44px** at 360 and **32px** at
  1440, the card **303 → 270** at 360 (**355 → 322** at 320, **273 → 241** at 390) and
  **245 → 213** at 768 and 1440, and the page **2,841 → 2,808** at 360 (**2,205 → 2,172**
  at 1440, **2,668 → 2,635** at 390). Everything below moves up the 33px: Plan
  1,183 → 1,151, Balance 1,615 → 1,582, Usage 2,237 → 2,205, Settings 2,662 → 2,629. The
  opened list still follows the row at full width, and focus stays on the button that
  opened it (`aria-expanded` true, the cursor on `Change plan for Research`).
- **The card at the top's way to the plans gives the cursor to the plans.** The stage
  card's `Choose a plan` link is made by the script when the stage is drawn, after the
  page had wired its own in-page links, so following it moved the page to `#plan-h` and
  left the cursor on **BODY**: the next Tab started at the skip link, above the page the
  reader had just moved to. It is wired where it is made. Enter on it now leaves the
  cursor on **H2#plan-h** ("Choose a plan") at 360, 768 and 1440, and the next Tab is
  the first plan's **Choose Team**. The static links (the section strip, the legal
  pages' phone contents) still land on their headings.
- **The plan section's Try again puts the cursor where the answer is.** With `/api/plans`
  failing, the panel's button re-read the plans, and the button went with the answer it
  asked for: `document.activeElement` was **BODY** at scrollY 0, with the list 431px down.
  Now a successful re-read focuses the section's heading, and a read that fails again
  focuses the new `Try again` (it was BODY in both cases). Measured at 360: success →
  **H2#plan-h**, next Tab **Choose Team**; failure → **BUTTON "Try again"**. The card at
  the top keeps its own behaviour (its retry still focuses the card's title), because the
  cursor is placed only when the button that asked was in the plan section.
- **A workspace's `Change plan` is named with the words on it.** The button read
  "Change plan" and was named "Change the plan of Research"; WCAG 2.5.3 wants the visible
  words in the name, and axe-core reported `label-content-name-mismatch` on the paid
  account at every width and in both themes (**1 → 0** violations). It is now
  **"Change plan for Research"**, which is also what a person saying "Change plan" will
  match. No other page or state had a violation.
- **Widths, schemes and the floor.** The paid and plan-less account at 320, 360, 390, 768
  and 1440 in light and dark: no sideways page scroll (320: 320; 360: 360; 390: 390;
  768: 768; 1440: 1440), nothing computes below **12px**, no control under 44 × 44 below
  721, 20 axe-core runs with no violation, and no console error. The other pages and the
  plan-less account are the same height at every width (1440 / 360 / 390: sign-up
  956 / 1,440 / 1,444, login 900 / 1,285 / 1,258, forgot 900 / 1,161 / 1,085, reset
  900 / 973 / 946).
- **The budget.** `app.css` is **40,938 bytes of 40,960** (was 40,953): the only change is
  the comment above the plan row, which said "on its own line" and no longer does. The
  row itself is the markup, not a rule.

### What this pass leaves

- **The address strip's Copy still takes its own line at 360.** "Address" (46px), the
  186px monospace host and the 65px Copy need **313px in a 286px strip**, so the button
  wraps under the address and the strip is 94px instead of 65. One line needs the label
  gone at every width (a bare host and Copy, which loses the word on a desktop that has
  the room) or 12px type in a 2px gap at 360 (which breaks the host when a workspace's
  name is longer than this fixture's). Both were judged worse than the wrapped line.
- **A plan-less page starts its numbered sections at 02.** 01 Workspaces is not shown, so
  the first heading is "02 Choose a plan" and the last "05 Settings". The numbers are the
  section's place in the record (2026-10-23), not the count of what is visible; renumbering
  would shift Settings when the usage panel arrives after its own read.
- **The usage read is rate limited to 60 an hour per session.** Repeating the page load
  more than that in an hour turns the usage panel into "Too many attempts. Try again in 35
  minutes." with its own Try again; the trial's own limits, not a page state, but it was
  met during this pass's screenshots and a fresh sign-in clears the session's count.
- **The dense usage table was not walked again.** The trial's workspaces answer with a
  stand-in and no model call is made, so the by-day table has no rows to draw; its sticky
  first cell and its arithmetic are held by `pages-app.test.ts` and the 2026-10-23 record.

## 2026-10-25: the answer where the action is

Same harness: Chromium 156 through `playwright-core` against this worktree's trial
(`trial --port 7516`), 360 × 800 with a touch pointer and 1440 × 900, light, `prefers-reduced-motion:
reduce`. "Before" is this pass's own base commit measured again today under the same script, not a
figure copied from an earlier record: a Team account with one running workspace and a call in its
usage table, and a fresh account with no plan. Heights are `document.documentElement.scrollHeight`;
positions are `getBoundingClientRect` plus `scrollY`.

- **A thing asked from the card at the top is answered in that card.** `Open` and `Resume` in
  the card at the top are the page's main action, and their failure was written into the
  *workspace's* card: at 360 the sentence appeared at y = **955** while the button was at
  301–349 — **606px** below it and 155px below an 800px screen, so pressing Open looked like
  pressing nothing. At 1440 it was 474px below the button, in another card. `act()` now takes
  where it was asked and says so in the card's own `#stage-status`, the element
  `Update payment details` already answered in. At 360 the sentence is at 281–379, **36px**
  above the button and inside the card and the screen: the card **195 → 309** and the page
  **2,910 → 3,024** while it is shown. At 1440 the sentence is in the card's own body (259–309)
  beside the button (235–283), and the card is 133 → 199. The cursor stays on the button
  (`aria-disabled` off, so it can be pressed again), and the workspace's own `Open` still
  answers in its own card.
- **An amount's answer sits under the amounts.** The balance card's status was the first
  thing in the card, above the `Add credit` caption and the trough. Pressing **$10.00** with
  the provider down put its sentence at y = 1,902–2,024 and pushed the trough from 1,932 to
  2,070: the three segments the finger was on moved **138px**, out from under it — the same
  138px the plan card paid on 2026-10-24 — and the sentence's bottom was 49px above where
  the segments landed. The status is now between the amounts and the amount field: the trough
  **does not move** (1,932; moved 0), the sentence is at 2,002–2,124, **23px** under the
  pressed segment's bottom, and the panel grows by the same 138px the sentence takes. A typed
  amount's own refusal moved with it: the sentence is now **47px** above the field it names
  (was **147px**, above the caption and the trough), and the field is still pushed down 90px
  while the sentence is shown, because it sits above the form — the trade the card at the top
  already makes with its button.
- **Calling off a deletion gives the cursor back to `More`.** `Keep it` emptied the box that
  had the cursor and nothing put it back: `document.activeElement` was **BODY**, and the next
  Tab was **Copy** at y = 1,047 — past `More` at 843 and past the Delete the person had been
  considering, at the foot of the card. The cursor now returns to `More` (y = 843, its 2px
  ring drawn), and the next Tab is **Delete this workspace** at y = 891. `aria-expanded` and
  the open list are as they were.
- **Widths, schemes and the floor.** The paid account at 320, 360, 390, 768 and 1440 in light
  and dark: no sideways page scroll (320: 320; 360: 360; 390: 390; 768: 768; 1440: 1440),
  nothing under **12px**, no control under 44 × 44 below 721, 20 axe-core runs with no
  violation, no console error; the plan-less account at the same widths is
  **1,757 / 1,574 / 1,526 / 1,078 / 1,036** before and after. With scripts off the account
  still shows its `noscript` sentence and the settings form; sign-up, sign-in and forgot still
  draw their forms, and reset its `Send a new link`.
- **The budget.** `app.css` is untouched at **40,938 bytes of 40,960**: the two fixes are a
  moved element and two script decisions, and no rule was needed for either.

### What this pass leaves

- **The amount field is still pushed down 90px by its own refusal.** The sentence has to be
  above a form the person is typing in; a second status under the field would be a second
  live region for one card, and the field's own refusal is already described to a screen
  reader through `aria-describedby`.
- **A paid account with `/api/plans` down still offers a form that cannot work.** The figures
  draw, the caption and the trough go (leaving a 286 × 6 empty strip at 360), and pressing
  Pay answers "Credit cannot be bought just now. Reload the page to try again." with no
  button. The plan section above has a `Try again`; the balance section has none, and giving
  it one is a section's job, not a row's.
- **The usage read's `Try again` still ends on BODY.** With `/api/usage` refused, the retry
  replaces itself with the tables and `document.activeElement` is BODY at scrollY 1,902 (the
  next Tab is the table's region at 2,349). The read is limited to 60 an hour per session, so
  it is reachable; the fix is the one the plan section got, and it was left for a pass that
  changes that section.
- **The address strip's Copy still takes its own line at 360** (313px in 286), for the reason
  the 2026-10-25 record gives. **The steps still wrap at 320.**
