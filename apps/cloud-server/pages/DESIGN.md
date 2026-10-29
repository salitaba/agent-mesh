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

## 2026-10-25: the credit that could not be bought

Same harness: Chromium 156 through `playwright-core` over CDP against this worktree's trial
(`trial --port 7812`), 320 / 360 / 390 / 768 / 1440 in light and dark,
`prefers-reduced-motion: reduce`, a touch pointer below 721, and the pair at 360 light with
`deviceScaleFactor: 2`. "Before" is the base commit's own pages, served by the same trial and
measured again today; no figure is copied from an earlier record. The failed state is the paid
account with `/api/plans` answered **503**; the normal state is the same account with the plans
up. The trial limits `/api/usage` to 60 reads an hour per session and two runs of the same page
differed by the 106px of the empty usage card when it tripped, so **both halves hold `/api/usage`
to one fixed empty answer** and every height below is the same fixture on both sides. Heights are
`document.documentElement.scrollHeight`; positions are `getBoundingClientRect` plus `scrollY`.

- **The balance card no longer offers a credit form it cannot fill.** The amounts to add, the
  caption above them and the field's limits are all read from the plans. With that read failed the
  card drew a caption-less, amount-less trough — its 3px padding either side of nothing, a 286 × 6
  pale bar under the rule at 360 — then "Another amount" and **Pay**. Pressing it wrote
  "Credit cannot be bought just now. Reload the page to try again." (98px at 360, 50 at 768),
  put the sentence in the card's status, marked the **amount field** `aria-invalid="true"` and sent
  the cursor into it, and left the card with **no control at all** while the only retry on the page
  was about **400px above**, in the Plan section (y = 1,432 against the Pay's 1,834). The caption,
  the trough, the form and its hint are now not drawn, and a warn note in their place says **"The
  amounts could not be loaded just now, so no amount is shown."** with a **107 × 44 Try again**
  (107 × 40 for a pointer) 15px under it. Measured
  at 360: the note **157px** (three lines), the card **362 → 434**, the page **2,573 → 2,646**;
  320 **362 → 434** (page 2,696 → 2,769), 390 **362 → 410** (2,519 → 2,568), 768 **282 → 306**
  (2,053 → 2,077), 1440 **284 → 309** (2,089 → 2,113). The only visible control in the card goes
  from `Pay` to `Try again`.
- **The note's Try again fills the card in place, and leaves the cursor on the amounts.** The read
  is the page's own, so the answer is drawn where the card is: with `/api/plans` still down, the
  button is held, answers "Trying again", comes back saying what it said, and the cursor is on
  **`Try again`** with the page unchanged (2,646 at 360). When it answers, the three amounts
  ("Add $10.00", "Add $25.00", "Add $100.00"), the caption, the **74px** form and the 67px hint
  return, the note is emptied and hidden, and `document.activeElement` is **"Add $10.00"** — the
  first of the things that arrived. The page is then the normal load exactly: **2,808** at 360,
  2,952 at 320, 2,665 at 390, 2,136 at 768, 2,172 at 1440, the same figures a plain load of the
  same fixture gives.
- **The plan section's failed retry no longer puts the cursor on Manage billing.** Its failure
  branch focused `$("#plan").querySelector("button")`, and for a paid account the first button in
  that section is the plan row's **Manage billing**, not the note's Try again 42px below it. It now
  takes the note's own button. Measured at every width and in both schemes, with the plans still
  down: `document.activeElement` is **BUTTON "Try again"** (was **BUTTON "Manage billing"**).
- **A service that sells no credit is not a failure.** The note is drawn only when the plans were
  not read (`state.plansKnown` false). With `topups: null` and the plans read, nothing failed: the
  balance panel is not drawn at all, and the note keeps no children to say otherwise.
- **Widths, schemes and the floor.** 320, 360, 390, 768 and 1440 in light and dark, in the failed
  state and in the normal one: no sideways page scroll (320: 320; 360: 360; 390: 390; 768: 768;
  1440: 1440), nothing under **12px**, no control under 44 × 44 below 721, **20 axe-core runs with
  no violation**, no console error. Forced colours draws the note's border, its warning mark, the
  sentence and the button; scripts off still shows the page's `noscript` sentence and the settings
  form, and the note stays hidden. The plan-less account is **1,757 / 1,574 / 1,526 / 1,054 /
  1,036** before and after (320/360/390/768/1440).
- **Nothing else moved.** The normal paid account is the same height at every width before and
  after — **2,952 / 2,808 / 2,665 / 2,136 / 2,172** — with every section at the same `y` and the
  same height; sign-up **1,620 / 1,448 / 1,448 / 1,433 / 956**, login 1,389 / 1,293 / 1,263 / 1,256
  / 900, forgot 1,169 / 1,169 / 1,089 / 1,064 / 900, reset 1,029 / 981 / 950 / 905 / 900 and the
  front page 4,622 / 4,311 / 4,114 / 3,073 / 2,701 are unchanged down to the pixel. **`app.css` is
  untouched at 40,938 bytes of 40,960**: the note and the button are the `.note note-warn` and
  `.btn` the plan section already draws, and the new element is one hidden line of markup.
- **Tests.** `node --test dist/tests/cloud/pages-app.test.js dist/tests/cloud/pages.test.js
  dist/tests/build/pages-workflow.test.js dist/tests/build/ui-kit-tokens.test.js` — **118 pass, 0
  fail**. `pages.test.ts` reads `#topup-fail` from `NEEDS` and finds it once on the account page;
  the card's last four children are still `topup-options`, `topup-status`, `topup`, `topup-hint`.

### What this pass leaves

- **The note is three lines at 360.** "The amounts could not be loaded just now, so no amount is
  shown." repeats the Plan section's own sentence shape, and that shape costs 157px against the 102
  it replaced — the card is 72px taller while the read is failed. A shorter sentence would be
  shorter, and would stop being the same sentence the site says elsewhere.
- **A failed read still leaves nothing to buy.** The card's one way forward is the read; a person
  who wants credit at that moment waits for it, as they do in the Plan section.
- **The usage read's `Try again` still ends on BODY** — the defect the last pass recorded is
  untouched, because it belongs to that section, not this one.
- **The sticky section strip can cover a target that scrolls under it.** After the balance's retry
  scrolls the page to the card at 768, "Manage billing" sits at 81–113 under the `sticky` subnav
  (61–110), and axe reports `target-size` on it and on "Change plan". It is a property of the strip
  and of where the page happens to be scrolled, not of this card: at scroll 0 there is none, and a
  scroll of the unmodified page can put a button there too. A fix is the strip's, not this card's.
- **The address strip's Copy still takes its own line at 360** (313px in 286); the steps still wrap
  at 320; the plan-less page still starts its numbered sections at 02.

## 2026-10-25: the answer after the answer

Same harness: Chromium 156 through `playwright-core` against this worktree's trial
(`trial --port 7581`), 320 / 360 / 390 / 768 / 1440 in light and dark,
`prefers-reduced-motion: reduce`, a touch pointer below 721, and the pair at 360 light with
`deviceScaleFactor: 2`. "Before" is the base commit's own pages served by the same trial on the
same fixtures, measured again today: a Team account with one running workspace and an empty usage
table, a fresh account with no plan, and a Team account with no workspace yet. Heights are
`document.documentElement.scrollHeight`; positions are `getBoundingClientRect` plus `scrollY`;
the accessibility runs are axe-core over the same 64 views.

- **A retry's answer takes the cursor to the answer.** `/api/usage` answered 503, and pressing
  **Try again** from the keyboard left `document.activeElement` on **BODY** at scrollY 1,904:
  the button went with the answer it asked for, the new sentence ("The usage could not be read
  just now.") was not attached to anything, and a retry that did answer said "Nothing has been
  used yet." with the cursor on BODY again (page 2,831). A failed retry now focuses the new
  **Try again** (44px tall at 2,461) with `aria-describedby="usage-fail"`, so the button and the
  reason beside it are read together; a retry that answers focuses **`#usage-h`** ("Usage", at
  2,227), whose next Tab is the table's region. The page is 2,724 with the failure and 2,831
  with the empty table, before and after: the fix moves the cursor and attaches the sentence,
  and adds no height.
- **The name a workspace needs is the field's own refusal, and it stops when the field is
  changed.** An empty **Create workspace** wrote "Give the workspace a name." into
  `#create-note` (50px at y = 765) and set `aria-invalid="true"` on `#workspace-name`, but the
  field described nothing, and typing one character into it cleared the mark while the sentence
  and its 50px stayed: the page was 2,395 before and after. It now goes through `invalid()`, as
  the other forms do: the field is described by `create-note`, and changing it clears both — the
  note is 0px and the page **2,333** (**−62**). The sentence itself did not change.
- **A deletion is one request, and says it is working.** With the delete answer held 900ms, two
  presses 100ms apart sent **2** `POST /api/workspaces/…/delete`: the confirmation form was the
  one form on the page not sent through `onSubmit`, so it had no double-send guard. It is sent
  through it now: one request for **2 → 1** presses, the button reads **"Deleting it"** and is
  disabled while the answer is out (the form is `aria-busy`), and a failure gives the label and
  the cursor back to the button. The card's own status still says "The workspace could not be
  deleted just now."; no height changed.
- **A redirect no longer loses the sentence it had to carry.** A 401 from `/api/session` or from
  an action replaced the page with `/login?next=/account`, whose status was empty (page 1,285 at
  360, the submit 478–522): a person was signed out with nothing saying so. It now goes to
  `/login?next=/account&signedout=1`, and the status reads **"You are signed out. Sign in to see
  your account."** — 74px at y = 289, the page **1,375** and the submit 568–612 (320: 98px, page
  1,495, submit 592–636), all inside an 800px screen. A confirmed address had the same gap:
  `/verify` replaced itself with `/account` before its own sentence could be read, and the
  account's notice was empty. The link now lands on **`/account?confirmed=1`**, the notice says
  **"Your address is confirmed."** (50px at y = 176 at 360), and the address returns to
  `/account`. The sentence costs the account the 50px note and its 16px gap: 2,831 → **2,897**
  paid, 1,597 → **1,663** plan-less (at 320: 2,927 → 2,993 and 1,757 → 1,823), and it is read
  and shown before the stage card.
- **Widths, schemes and the floor.** The paid account is **2,927 / 2,831 / 2,635 / 2,136 /
  2,172** and the plan-less one **1,757 / 1,597 / 1,526 / 1,078 / 1,036** at 320 / 360 / 390 /
  768 / 1440, unchanged by this pass; the confirmed and signed-out states are the ones above.
  No view scrolls sideways, nothing computes below **12px**, no control is under 44 × 44 below
  721, and **64 axe-core runs** (20 account, 12 sign-in/404, 20 confirmed, 10 signed-out, 2
  forced colours) find **no violation**. Forced colours draws the note, the status and the
  buttons as the system's own; with scripts off every page still shows what it showed, and the
  login note (which is set by the script) is absent.
- **The budget.** `app.css` is untouched at **40,938 bytes of 40,960**: the note, the status and
  the buttons are the classes the pages already draw, and the two messages are one string
  passed in the address and one `say()`.
- **Tests.** `tests/cloud/pages-app.test.ts` now pins the once-only deletion (`2` submits →
  `1` request), the create field's `aria-describedby` and the sentence going on `input`, the
  usage retry's two cursors and the described retry button, the signed-out status on the login
  page, and the confirmation notice on the account; `pages.test.ts` finds `#usage-h` in
  `NEEDS`. `node --test dist/tests/cloud/*.test.js` — **864 pass, 0 fail**; the six
  page-related `dist/tests/build/*.test.js` — **28 pass, 0 fail**.

### What this pass leaves

- **A sign-out that fails still drops the cursor to BODY.** The header button says "Try signing
  out again" but the button is disabled while the request is out and nothing restores the
  cursor or announces the failure. It is the only action on the page that is not a form's.
- **A dead reset link is still discovered only on submit.** No `GET` token check exists in the
  control plane, so the form still appears for a link that cannot work.
- **The usage read's first failure is still not a live region.** Its retry now carries the
  reason, which is the repeat a person hears; the first sentence is read by browsing to it.
- **The sticky section strip can still cover a target that scrolls under it** at 768, the
  property the previous pass recorded.
- **The delete's busy window takes the cursor to BODY** while its button is disabled, as every
  form on the page does; a failure puts it back on the button.
- **With scripts off `/verify` still says "Checking the link."** beside its `noscript`
  sentence, unchanged.

## 2026-10-26: the answer a failed act leaves behind

Same harness: Chromium 156 (playwright-core 1.64, the headless shell) against this worktree's trial
(`trial --port 7531`, whose plans are the trial's own fixtures), 320 / 360 / 390 / 768 / 1440 in light and
dark, `prefers-reduced-motion: reduce`, a touch pointer below 721, and axe-core 4.14 over the same views.
"Before" is the base commit's own `app.js` and page files, served by the same trial on the same fixtures and
measured again today: a Team account with one running workspace and a Team account with no workspace yet.
Heights are `document.documentElement.scrollHeight`; positions are
`getBoundingClientRect` plus `scrollY`; names are Chromium's own `document.activeElement`.

- **A sign-out that fails keeps the cursor, and says what happened.** The bar's button was disabled while the
  request was out, and disabling a control takes the cursor off it: at 360 `document.activeElement` was
  **BODY**, so the next Tab started again at the skip link above the whole page, and the only answer was the
  button's new name ("Try signing out again"), which a reader is not told when the name changes under a cursor
  that never left it. There was no status line in the header to say it in. It is now **held**
  (`aria-disabled`, the idiom every other control on the page uses) rather than disabled, so the cursor never
  moves, and the header carries a `.sr` status line, `#bar-say`, on all ten pages: after a 503 the line reads
  **"You are still signed in. Something went wrong on our side. Try again in a moment."** and the cursor is on
  the button at 320, 360, 390, 768 and 1440. A second press while the first request is out is not sent
  (**2 presses → 1 `POST /api/logout`**). The bar still wraps when the label grows (61 → 97px at 360 and
  61 → 141 at 320, the page 2,808 → 2,844 and 2,939 → 3,019) — before and after, because the words are the
  design's and a shorter label would lose the verb (see what this leaves).
- **A change that went through and a read that did not now says so where the change was asked.** With
  `/api/me` failing on the read that follows a successful **Pause**, the card kept saying **Running** — which
  was no longer true — with an empty 1px note, no control, and the cursor on Pause: the page had no answer and
  no way to ask again. Every action that re-reads the account after it went through — open, pause, resume,
  delete, change plan and create — now uses one helper: the card's own note (or `#stage-status` at the top, or
  `#create-note` at the form) says **"That worked, but your account could not be read again just now, so this
  page is out of date."** and carries a **Try again** that re-runs the same read. At 360 the card is
  **270 → 424px**, the note **142px** at y = 251, and the page **2,808 → 2,962** while it is shown; pressing Try again draws the answer in place — the card reads
  **Stopped**, the note goes back to 0px and the cursor lands on **Resume**. A retry that fails again leaves
  the sentence, the button and the cursor on it. The same sentence in the card at the top (Resume asked from
  there) sits in `#stage-status` and the cursor stays on the Resume that asked.
- **The page's own usage read is heard when it fails.** `GET /api/usage` failing on the page's first draw
  replaced the skeleton with a warning sentence and a Try again that only takes the cursor when a person
  pressed it — so a reader heard **nothing at all** (measured: 0 status areas with text on the account page).
  The panel now has its own `.sr` line, `#usage-say`, and a first read that fails says **"Usage. Usage could
  not be read just now. Try again in a moment."** there; it is cleared when a read answers. The visible
  sentence and the retry's `aria-describedby` are unchanged.
- **A workspace the service refuses to make is heard.** The form's note, `#create-note`, is where `onSubmit`
  writes every failure of that form, but it was a plain paragraph: with the service answering 409 the visible
  note ("A workspace with that name already exists.") sat 12px under the button at y = 742 at 360 and **no
  status area on the page had any text**. It is `role="status" aria-live="polite"` now, so the refusal, the
  page's own "Something went wrong in this page" and the plan-full hint are read out. Because that line is
  also drawn again on every look at the page, `hint()` no longer writes a sentence and class that are already
  there: the same words are not said twice (a test pins the note's text node across a re-render).
- **Widths, schemes and the floor.** Ten pages (account, front, 404, terms, privacy signed in; sign-up,
  sign-in, forgot, reset, verify signed out) at 320, 360, 390, 768 and 1440, light and dark: no sideways page
  scroll, nothing computes below **12px**, and **106 axe-core runs** (100 page views, the read-back state in
  both schemes, and the failed sign-out on four pages) find **no violation**. Every page is the same height
  before and after to the pixel — account 2,927 / 2,808 / 2,635 / 2,136 / 2,172, front 4,528 / 4,151 / 4,056 /
  3,039 / 2,667, sign-up 1,612 / 1,440 / 1,440 / 1,425 / 948, sign-in 1,381 / 1,285 / 1,255 / 1,248 / 800,
  forgot 1,185 / 1,161 / 1,081 / 1,056 / 800, reset 1,021 / 973 / 897 / 800, verify 1,249 / 1,199 / 1,145 /
  1,143 / 800, 404 800 at every width, terms 4,141 / 3,786 / 3,540 / 2,592 / 2,569 and privacy 3,122 / 2,823 /
  2,603 / 1,846 / 1,851 — the header's new line is `.sr` and absolutely placed, and the usage line is one
  clipped line in a panel. The only controls under 44 × 44 below 721 are the prose links the record already
  names.
- **The budget.** `app.css` is untouched at **40,938 bytes of 40,960**: a held button, a status paragraph and
  a sentence are all classless additions to markup the stylesheet already draws. Twenty-two bytes remain.
- **Tests.** `dist/tests/cloud/pages*.test.js` — **174 pass, 0 fail** (`pages-app.test.ts` alone: 90). The new
  tests pin the held sign-out and its single request and its line, the read-back sentence at the card, at
  `#stage-status` and at the form with its retry and its cursors, the usage line, and the refusal's role. Each
  was mutation-checked: disabling the button again, making the read-back helper a no-op, dropping the usage
  line, dropping `role="status"` from the note, and restoring the old `hint()` each made exactly its test fail.

| measured at 360, light | before | after |
| --- | --- | --- |
| A sign-out that fails: cursor | **BODY** (the next Tab is the skip link) | **the Sign out button** |
| … what is said | nothing | "You are still signed in. Something went wrong on our side. Try again in a moment." |
| … presses sent, of two | 1 (the button was disabled) | 1 (held) |
| … header / page | 61 → 97px / 2,808 → 2,844 | 61 → 97px / 2,808 → 2,844 |
| Pause, then the read fails: the card | 270px, a 1px empty note, no control, still "Running" | 424px, a 142px note with **Try again**, still "Running" |
| … the page | 2,808 | 2,962 |
| … pressing Try again | — | "Stopped", the note 0px, the cursor on **Resume** |
| The usage read failing as the page draws | 0 status areas with text | 1 ("Usage. Usage could not be read just now. Try again in a moment.") |
| A refused workspace name | 0 status areas with text, the note a plain `p` | 1, the note `role="status" aria-live="polite"` |

### What this pass leaves

- **The bar grows when the sign-out failure is named.** 61 → 97px at 360, 61 → 141 at 320 and 61 → 101 at
  390, because "Try signing out again" is longer than "Sign out" and the nav wraps. Making it "Try again"
  would fit, and would not say what is being tried; a shorter visible label with the sentence in the bar's
  line is the same trade one level down. The page under it moves by the same 36 or 80px, on a screen the
  person is already looking at.
- **A retry that fails again does not say the sentence a second time.** The note already reads it, so only
  the button's word changes ("Trying again", then "Try again" again) and the cursor stays on it; a reader who
  presses it again hears the button, and the sentence is still the line above it. A third way — reload the
  page — is not offered beside it.
- **The read that follows a change is still a second request.** A page that has just changed one fact asks
  for the whole account again; the alternative is a partial answer the projections do not have.
- **`#create-note` is a status for the form's hints too.** With the plan full, "Your plan includes 1
  workspace…" is read once when the form is drawn, which is the sentence that explains why there is no form;
  it is no longer repeated on every look, but it is said at load where a page used to say nothing.
- **The account's failed read at the form focuses the card at the top.** When the read after a create
  answers, the form has gone (the plan is full), so the cursor goes to `#stage-title` rather than to a field
  that is no longer drawn.
- **Nothing was added for the dead reset link, the sticky strip over a target at 768, or the delete's busy
  window.** They are the previous passes' entries, unchanged.

## 2026-10-26: the dead link refused before the password, and the empty usage that was a card

Same harness: Chromium 156 (playwright-core 1.64, the headless shell) over CDP against this worktree's trial
(`trial --port 7531`, whose plans are the trial's own fixtures), 320 / 360 / 390 / 768 / 1440 in light and dark,
`prefers-reduced-motion: reduce`, a touch pointer below 721, and axe-core 4.14 over the same views. "Before" is the
base commit's own page files (`6102779`), rendered at the same address against the same trial on the same fixtures and measured again today:
a Team account with one running workspace and an empty usage table, a reset page holding a dead token, and `/verify`
with scripts off. Heights are `document.documentElement.scrollHeight`; positions are `getBoundingClientRect` plus
`scrollY`; names are Chromium's own `document.activeElement`.

- **A dead reset link is refused before a password is typed.** The page could only learn that its token was no
  good by sending a password: at 360 with `?token=dead-token` it was titled **"Choose a new password"**, drew the
  form, and had an empty status, so a reader typed before the service refused them. The control plane now has a
  read-only `GET /api/reset/check?token=…`: it runs the same check as the reset itself, writes no event, spends
  nothing, and answers **200 `{ok: true}`** or a **200 `{ok: false, message}`** with the same sentence the
  confirmation page uses. A dead link is a successful read whose answer is no, so the page's console does not
  record a failed request on a page where nothing failed. The page asks before it draws the form. After: title
  **"That link did not work"**, the refusal at
  **y = 226** (a 74px note), the form hidden, the way out at **y = 316**, the cursor on **"Send a new link"**, the
  page **1,173 → 949**, one `GET` and **no `POST`**. A check that cannot answer (429, offline, a 5xx) is not a
  refusal of the link: the form is drawn and the submit says what the service says. The route is held by
  `web-accounts.test.ts`: asked twice, the
  link still resets; after it is used, the check says no with the same sentence; a confirmation token is not a
  reset link; and `POST /api/reset/check` is a **405 with `Allow: GET`**.
- **A button that is working keeps the cursor.** `onSubmit` disabled every button in its form, and a disabled
  control loses the cursor in most browsers, so through a deletion's busy window `document.activeElement` was
  **BODY** at 360: the next Tab started again above the page, and the only sign of work was a word change under a
  cursor that had gone. The buttons are **held** now (`aria-disabled`, the idiom the sign-out and the stage
  already use); the busy guard is what stops a second send. Measured with the delete answer held 1,000ms: the
  cursor is on **BUTTON "Deleting it"** with `aria-disabled="true"` (was **BODY**), two presses still send **1**
  `POST`, and a success puts the cursor on `#stage-title` as before. Every form goes through the same helper;
  forgot measures the same cursor on its **"Send the link"**, and the resend form's one-minute hold survives the
  answer, so the button is still held for the wait it asked for.
- **With scripts off, `/verify` no longer says "Checking the link." beside the sentence that says it cannot
  check.** The status was in the markup with `aria-busy="true"`, so a browser with no script drew both. The
  markup's status is empty and the script writes **"Checking the link."** where something is checking: with
  scripts off the page is **963 → 897** at 360, the status has no text, and `aria-busy` stays for the script; with
  a script the answer function sees **"Checking the link."** while the `POST` is out (pinned in `pages-app.test.ts`).
- **An empty usage panel is a ruled entry, not a 240px card with a picture.** The state was a dashed card with a
  56px bars tile, 32px of padding and centred text: **240px** at 360 for zero calls, and the decor was the only
  thing in it that was not a sentence. A card is for something a reader acts on; this has no action. It is now a
  **99px** ruled entry under the section's own line — **"Nothing has been used yet."** and when calls will appear —
  with no tile and no box. At 360 the Usage panel is **384 → 243px**, the page **2,831 → 2,690** and Settings
  **2,652 → 2,511**. At the same scroll of **1,800** on a 360 × 800 screen, Settings was at **y = 852**, below the
  screen; it is at **y = 711**, inside it. At 320 the entry is **122px** (three lines) and the page **2,952 →
  2,834**; at 390 **2,687 → 2,546**; at 768 **2,136 → 2,020** and at 1440 **2,172 → 2,057**, where the entry is
  **99px**. The sentence still says what would be here and why it is not, as the empty-state row
  of the design table asks; only the card and its picture are gone.
- **Widths, schemes and the floor.** The paid account at 320 / 360 / 390 / 768 / 1440 in light, at 360, 768 and
  1440 in dark, and at 360 in forced colours: no sideways page scroll (320: 320; 360: 360; 390: 390; 768: 768;
  1440: 1440), nothing computes below **12px**, and no control is under 44 × 44 below 721 (at 768 and 1440 the strip's 32px links and
  the 40px buttons are the pointer's own sizes, as before). The dead reset page at the same five widths and at 360
  in dark: no overflow, smallest text **12px**, no target under 44 below 721, and the button that takes the cursor
  is 44px. **16 axe-core runs** (9 account, 7 reset) find **no violation** and there is no console error; forced
  colours draws the empty entry's top rule. With scripts off the account and reset still show their `noscript`
  sentences and settings form, and `/verify` now shows one sentence, not two that disagree.
- **The budget.** `app.css` is **40,851 bytes of 40,960** (was 40,938, a net **−87**): `.empty` left the card
  list, its dashed chrome and centring became one top rule and start alignment, and the now-unused
  `.tile-bars` rule went. 109 bytes remain.
- **Tests.** `dist/tests/cloud/pages*.test.js` and `web-accounts.test.js` — **210 pass, 0 fail**; typecheck and
  lint are clean (0 errors). The new reset test fails when the check's refusal branch is removed, and the held
  button test fails when `onSubmit` disables its buttons again.

| measured at 360, light | before | after |
| --- | --- | --- |
| A dead reset link on load | "Choose a new password", the form shown, status empty, page 1,173 | "That link did not work", the form hidden, the sentence, cursor on **Send a new link**, page 949 |
| … requests on that load | 0 (the token is only tried on submit) | 1 read (`GET /api/reset/check`), 0 writes |
| A deletion while its answer is held | cursor **BODY**, the button disabled, 1 request of 2 presses | cursor **BUTTON "Deleting it"**, `aria-disabled`, 1 request of 2 presses |
| `/verify` with scripts off | 963px, "Checking the link." beside the noscript sentence | 897px, the status empty |
| The account with one running workspace | 2,831px | **2,690px** |
| The empty Usage entry | 240px dashed card with a 56px icon | **99px** ruled entry |
| The Usage panel | 384px | **243px** |
| Settings begins at | y = 2,652 | **y = 2,511** |
| At scroll 1,800, Settings | y = 852, below an 800px screen | **y = 711**, inside it |
| The account at 320 / 390 / 768 / 1440 | 2,952 / 2,687 / 2,136 / 2,172 | **2,834 / 2,546 / 2,020 / 2,057** |
| The empty entry at 320 / 390 / 768 / 1440 | 240 / 240 / 215 / 215 | **122 / 99 / 99 / 99** |

### What this pass leaves

- **The sticky section strip still covers a control at a scroll a person chose by hand.** Re-measured today at 768
  with the page at scroll 966: **Manage billing** is at 80.5–112.5 under the strip at 61–110, and axe reports
  `target-size` on it and on **Change plan**. It is the property the 2026-10-25 entry recorded; removing it means
  giving up the strip's stickiness on a wide screen, so it was left rather than traded in this pass. A keyboard
  still reaches the button; a hand aiming at its top 29.5px hits the strip.
- **The check is a second request, and it shares the token's limit.** `GET /api/reset/check` counts against
  `tokenIp` (30 an hour per address, the counter the submit uses), so a person who reloads the reset page many
  times can meet the limit at the check; the page then draws the form, because a limit is not a refusal of the
  link, and the submit says the limit in the service's words. The check also cannot promise the link will still be
  good when the password is sent: an expiry in between is refused on submit, with the same sentence.
- **The empty usage is still 243px, and 90px of it is the section's standing line.** Folding the whole section
  behind a disclosure would hide that explanation and make the count of calls the only thing a folded row says;
  the two sentences are what the empty-state row asks for, and the card was the part that was not information.
- **Prose-only inline links remain 18–19px tall**, and the answer to the sticky strip is the same entry it was:
  both are reading rather than doing, and both are left for a pass that changes the strip or the legal measure.
  The usage read's first failure was measured again and is announced: `#usage-say` has the sentence on the first
  failed read, so that item is closed and not repeated here.

## 2026-10-26: the account's captions, and the charge beside the day

Same harness: Chromium 156 through `playwright-core` over CDP against this worktree's trial
(`trial --port 7531`, whose plans are the trial's own fixtures), 320 / 360 / 390 / 768 / 1440 in light and dark,
`prefers-reduced-motion: reduce`, a touch pointer below 721, forced colours at 360, the root raised to 24px and 32px
for the large-text checks, and axe-core 4.14 over eight of the views. "Before" is the base commit's own page files,
served by the same trial through request interception and measured in the same browser session as the after — not a
figure copied from an earlier record. The fixtures are a Team account with one running workspace and an empty usage
table, the same account with a 41-character workspace host, a Team account with no workspace yet, and a fresh account
with no plan. Heights are `document.documentElement.scrollHeight`; positions are `getBoundingClientRect` plus
`scrollY`; names are Chromium's own `document.activeElement`.

- **The identity is a caption line, not a capsule.** `#who` was a bordered, rounded, filled pill with 4px 8px of
  padding and 14px text: at 360 a 30-character address made it a 328 × **55px** box and broke the address after
  "acct-" ("Signed in as acct-" / "1793…@example.com") — a card drawn around a fact the page does not act on. It is a
  caption and the address in the record's monospace now, with no border, fill or radius: **55 → 22px** at 360,
  **55 → 42** at 320 (two lines), **32 → 22** at 390, and the same 22 at 768 and 1440, where it sits at the right of
  the h1 and the head keeps the h1's height. The stage card moves from y = **198** to **165** and the account is
  **2,546 → 2,507** at 360 with the usage answer held to its empty one, as every height below is. The pin in
  `pages-app.test.ts` that wanted `#who` to be one text node now asserts that the
  text node is inside `.who-a`: an address that looks like markup is still one text node, and the caption is the page's
  own word.
- **The address strip is a caption, and Copy never falls onto a line of its own.** At 360 the 25-character host and the
  label could not share a line, so "Copy" sat alone under the host at **x = 25**, and the strip was **94px** of a
  270px card; at 320 the label, the host and Copy were three rows (**119px**). At 720 and narrower "Address" is a 12px
  caption on its own row and the host and Copy share the row under it: the strip is **94 → 88** at 360
  (**119 → 90** at 320, 94 → 88 at 390) and Copy is at **x = 263**, level with the host's chip, instead of x = 25 under
  it. The case the fixture did not have is the one that made this a layout rather than a nudge: with a **41-character**
  host the strip was **140 → 90px**, Copy stays on the host's row while the host wraps to two lines inside its own
  column, the card **372 → 322** and the page **2,675 → 2,612**. At 768 and 1440 nothing moves: the label stays
  inline, the strip is **53px**, the card 213 and the page 2,021 / 2,058, as before.
- **A day's charge is the second column.** At 360 the by-day table is 722px in a 326px box and "Charged" began at
  **x = 543**, 217px past the right edge: the one figure the section promises — what the calls were charged to the
  balance — could not be read without a sideways swipe, while the days stayed pinned at the left. The columns are now
  **Day, Charged, Calls, Failed, Input tokens, Output tokens**: the charge cell begins at **x = 115** and ends at 295,
  wholly inside the box, and the tokens still scroll (722). The bar that compares a day with the busiest one is in the
  charged cell, which puts it beside the day it belongs to. Measured with a four-day answer at 360; the by-workspace
  table takes the same order, and the day, `Total` and every row's name stay sticky at the left.
- **A plan-less page says "Choose a plan" once.** The stage card and the Plan panel both carried the heading
  "Choose a plan" (the panel's 316px below the card's), so the page's heading list said the step twice and a reader
  could not tell the step from the list it points at. The panel now reads **"02 Plans"** — the list, the word the front
  page uses for the same thing — while the card keeps the step's words and its button, which still lands on that
  heading: measured 360, `#plan-h` focused at `scrollY` 440 with the heading at 124. The page is **1,549 → 1,535**
  (the identity line's 14px).
- **Widths, schemes and the floor.** The paid account at 320 / 360 / 390 / 768 / 1440 in light: no sideways page
  scroll (320: 320; 360: 360; 390: 390; 768: 768; 1440: 1440), nothing computes below **12px**, no control under
  44 × 44 below 721, no console error; dark and forced colours at 360 are the same 2,507 with no overflow. Ten pages
  (account, front, 404, terms, privacy, sign-up, sign-in, forgot, reset, verify) at the same five widths: no sideways
  scroll, the floor at 12px, and the only small controls are the two the record already names (the 20px consent tick
  whose sentence is 108px, and the Terms page's prose link). The **eight axe-core runs** (320/360/768/1440, before and
  after) find no violation but the one the last two passes recorded: at 768, scrolled to 966, the sticky strip covers
  the top of **Manage billing** and **Change plan**, in both halves.
- **The budget.** `app.css` is **40,929 bytes of 40,960** (was 40,851, a net **+78**): the caption rules, the phone
  rules that put the label on its own row and let a long host shrink, and the mono identity cost about 200 bytes; the
  pill's chrome, the Copy button's negative margin, the address's place in the margin reset and the shortening of three
  comments paid for the rest. Thirty-one bytes remain.

| measured at 360, light | before | after |
| --- | --- | --- |
| The identity line | 55px, a bordered pill, the address broken after "acct-" | **22px**, a caption and the address in monospace |
| … at 320 / 390 / 768 / 1440 | 55 / 32 / 32 / 32 | **42 / 22 / 22 / 22** |
| The stage card begins at | y = 198 | **y = 165** |
| The account (empty usage held) | 2,546px | **2,507px** |
| … at 320 / 390 / 768 / 1440 | 2,811 / 2,524 / 2,021 / 2,058 | **2,769 / 2,507 / 2,021 / 2,058** |
| The address strip | 94px, Copy alone at x = 25 | **88px**, Copy at x = 263 on the host's row |
| … 320 / 390 | 119 / 94 | **90 / 88** |
| … with a 41-character host | 140px, Copy on a third row, card 372 | **90px**, Copy beside a two-line host, card **322** |
| The usage table at 360 | 722px in a 326px box, "Charged" at x = 543 | **"Charged" at x = 115–295**, the tokens scroll |
| A plan-less page's headings | "Choose a plan" twice | **"Choose a plan", "Plans"** |
| The plan-less page | 1,549px | **1,535px** |
| At 200% text | 5,084px, the identity 144px | **5,102px**, the identity 166px, no overflow |

### What this pass leaves

- **The identity costs four lines at 200% text.** Raising the root to 32px at 360 makes the address 166px against the
  pill's 144, because the monospace face is wider per character; the page is 18px taller and still does not scroll
  sideways. The alternative — the address in the body face — would take the one place on the page where the record's
  own type rule (addresses in monospace) applies.
- **The strip still starts at 02 on a plan-less page.** "01 Workspaces" is not shown, so the first numbered heading is
  "02 Plans". The numbers are the section's place in the record, not the count of what is visible; the heading now
  names the list, which is the part a reader can act on.
- **A four-plus-one wrap on the phone.** At 360 the section strip now fits "Workspaces Plan Balance Usage" on one row
  and leaves "Settings" alone on the second (109px). The items' widths are the font's, not this pass's; the strip still
  wraps rather than hiding the last one past the edge, which was the 2026-10-20 fix.
- **The sticky section strip still covers a control at a scroll a person chose by hand.** At 768, scroll 966,
  **Manage billing** sits at 80.5–112.5 under the strip at 61–110 and axe reports `target-size` on it and on
  **Change plan** — before and after this pass, the property the 2026-10-25 and 2026-10-26 records describe. Removing
  it means giving up the strip's stickiness on a wide screen, which is a larger trade than this pass makes.
- **The address strip is still a strip.** On a phone it is 88px under a 20px card padding, and its caption is 12px:
  the host is the one thing a person copies, and it is now on one row with the control, but the address is still the
  card's quietest line rather than something the card is about.
- **Nothing was added for the checkout stand-in, the usage read's rate limit, or the prose links.** They are the
  previous passes' entries, unchanged and still true.

### Next pass

- Give the sticky strip a way not to cover a target at a hand-chosen scroll — a scroll-aware inset, or giving up
  `position: sticky` above 1000px — and re-run the 768 axe case that has now failed three passes.
- Look at the account's first screen with a 200% text profile again: the identity is the one thing this pass made
  taller there, and the glance, stage and strip have not been re-measured at that size since 2026-10-23.
- A real usage table with a model key behind it, to see the charged column and its bars with more than a fixture's
  four rows.

## 2026-10-26: the strip out of the way, and what the facts are worth

Same harness: Chromium 156 through `playwright-core` over CDP, axe-core 4.14, the trial on `trial --port 7631`
(plans: Team $149/month, Business $599/month). "Before" is the base commit's own `account.html`, `app.css` and
`app.js` served by the same trial through request interception in the same browser session as the after, not a
figure copied from an earlier record; `/api/usage` is held to one empty answer in both halves, because the
trial's 60-reads-an-hour limit had already turned the panel into its warning. Fixtures: a Team account with one
running workspace, the same plan with no workspace yet, and a fresh account with no plan. 320 / 360 / 390 / 768
/ 1440 at 800 tall, light and dark, `prefers-reduced-motion: reduce`, a touch pointer below 721. Heights are
`document.documentElement.scrollHeight`; positions are `getBoundingClientRect` plus `scrollY`.

- **The section strip is in the flow, so it never covers the button under it.** Above 720 the strip was
  `position: sticky; top: 61px`, and the page scrolls under it: at 768 with the page at scroll 966 the strip
  (61–110) covered the top 28px of **Manage billing** and **Change plan** (82–114), and axe-core reported
  `target-size` on both — the same two nodes the 2026-10-25 and 2026-10-26 records left for this pass. At 1440,
  scroll 600, it covered 8px of Open, Pause and More. Any sticky bar of that height does this; the only fix that
  does not move the page is to stop it floating. It is now static at every width, as it already was below 721:
  **2 controls covered → 0** at 768, **4 → 0** at 1440, **2 → 0** on the workspace-less account at 1440, and
  **axe `target-size` 2 nodes → 0** at 768/966, in both schemes. The strip's marking of the section in view
  (`aria-current="location"`, kept by the page's observer) is unchanged, and the phone is untouched.
- **The three facts are three ruled entries, not three cards, on a wide page too.** The glance was a card at
  768 and 1440 and a 10px ruled row at 720 and narrower, so the same three facts had two bodies. A card is for
  something a person acts on; this is a record. The ruled rules now hold at every width, and the columns share
  one rule above and one below: the glance is **114 → 102** at 768 and at 1440, every section below moves up the
  12px (Workspaces 498 → 486 at 768, Plan 857 → 845 at 1440), and the page is **2,021 → 2,009** and
  **2,058 → 2,046**. At 320, 360 and 390 the glance keeps its 190px: it was already ruled there.
- **The balance tile answers "what have I spent".** The first screen said `BALANCE $10.00 available` and the
  amount used of what the plan includes was only in the Balance panel 1,100px down (`$10.00 left of $10.00`) and
  in the Usage panel 1,600px down. The tile's note is now **`$0.00 of $10.00 used`**, from the plan's allowance
  and the balance the service sent; with the plans unread, or on a plan that sells hosting only, there is no
  allowance to speak of and the note stays `available`, as before. Nothing else about the tile moved.
- **The allowance carries its period.** The Balance panel said `left of $10.00` while the plan panel said "each
  month": a limit without the period it is for, which the direction does not allow. The figure now reads **`left
  of $10.00 a month`**, the plan's own `period`, with the two words joined by a no-break space so the line breaks
  as "left of $10.00" / "a month" rather than leaving "month" alone. The service's own words are in the meter's
  `aria-label` too. At 390 and wider the figure still fits one line, so nothing moves; at 360 the Balance panel
  is **541 → 562** and the page **2,507 → 2,527** (**2,769 → 2,790** at 320), which is the whole cost of the
  period on a phone.
- **Widths, schemes and the floor.** 320 / 360 / 390 / 768 / 1440 in light, 360 and 1440 in dark, on all three
  fixtures: no sideways page scroll (320: 320; 360: 360; 390: 390; 768: 768; 1440: 1440), nothing computes below
  **12px**, and the only control under 44 × 44 below 721 is still the stage heading, which is a `tabindex="-1"`
  landing place and not a control. **20 axe-core runs on the three fixtures have no violation** (the two
  `target-size` nodes at 768 were the only ones, and they are gone), and the plan-less and workspace-less
  accounts are unchanged at **1,516 / 1,036** and **2,146 / 1,676**. With scripts off the account still shows
  its `noscript` sentence and the settings form; forced colours draws the new rules and the number.
- **The budget.** `app.css` is **40,906 bytes of 40,960** (was 40,929, a net **−23**): the strip lost its
  `position`, `top`, `z-index` and background, `.stat` left the card list, and the card chrome the glance no
  longer draws paid for the ruled rules and the media blocks; three comments were shortened. Fifty-four bytes
  remain.
- **Tests.** `dist/tests/cloud/pages*.test.js` and `dist/tests/build/pages-workflow.test.js` — **131 pass, 0
  fail**. The glance's note and the balance figure's period are pinned in `pages-app.test.ts` and
  `pages-dashboard.test.ts`; nothing pins the strip's stickiness, and a test could now: `.subnav` has no
  `position` at all.

| measured | before | after |
| --- | --- | --- |
| A control under the strip, 768 at scroll 600 / 966 | **2** covered (Manage billing, Change plan) | **0** |
| … 1440 at scroll 600 | **4** covered (Open, Pause, More, Copy) | **0** |
| … axe `target-size` at 768, scroll 966 | **2 nodes**, serious | **0** |
| The glance at 768 / 1440 | 114px, three cards | **102px**, ruled entries |
| The account at 768 / 1440 | 2,021 / 2,058 | **2,009 / 2,046** |
| The Balance tile's note | `available` | **`$0.00 of $10.00 used`** |
| The allowance's line | `left of $10.00` | **`left of $10.00 a month`** |
| The account at 360 / 320 | 2,507 / 2,769 | **2,527 / 2,790** (the period on a narrow phone) |
| `app.css` | 40,929 bytes | **40,906** |

### What this pass leaves

- **The strip no longer says where you are while you scroll.** It is a contents line at the top of the page; the
  sections' headings carry the record's numbers and the reader meets them as they go. The alternative — a rail
  in the gutter — needs about 180px of margin, which the page's 1080px measure only has at 1280 and wider, and
  was not worth the breakpoint in this pass. The axe case that failed three passes is closed.
- **The period costs 20px on a 360 phone and 21 on a 320 one.** The figure wraps; a shorter phrase ("$10.00 left
  a month") would keep the line and lose "of what". Left as the truthful one.
- **The used figure is the plan's allowance, not every dollar spent.** A spend draws on the plan's included
  usage first and on bought credit after it (the gateway's ledger), so `allowance − included` is what the calls
  used of the plan; money spent from purchased credit is only visible as a smaller "from credit you added". The
  tile says "of $10.00 used", which is the allowance it names, and does not claim to be the whole bill.
- **The glance is still three facts and not the page's four questions.** "What do I do next" is the card above
  it; "what am I on" and "what have I spent" are the plan and balance entries; "is it running" is the card and
  the workspaces entry. The Usage panel remains the place the bill is itemised.
- **Nothing was added for the checkout stand-in, the dead reset link (closed 2026-10-26), the usage read's rate
  limit, or the prose-only inline links.** They are the previous entries, unchanged and still true.

## 2026-10-28: the bill a phone can read

Same harness: Chromium through `playwright-core`, 320 / 360 / 390 / 768 / 1440, light and dark, forced colours at
360, the root raised to 32px at 360, `prefers-reduced-motion: reduce`, a touch pointer below 721. "Before" is the
base commit's own `app.css` served by the same trial (`trial --port 7631`) and measured again today, not a figure
copied from an earlier record. The fixture is the same on both sides: a Team account, one running workspace, and a
four-day usage answer held by request interception (the trial's own usage is empty). Heights are
`document.documentElement.scrollHeight`; positions are `getBoundingClientRect` plus `scrollY`.

- **The usage tables are read, not scrolled, on a phone.** Below 721px the by-day table was **722px of content in
  a 326px box**: `Day` at x = 17 and `Charged` at 131–295 were inside, `Calls` began at **311** and the two token
  columns at 463 and 595, so four of the six columns — the calls, the failures and what the tokens were — could
  only be reached by a sideways swipe, and the sticky first cell kept the day beside them but not their meaning.
  Each row is now an entry: the day on the first line, `Charged $2.74` beside it, then `Calls 34  Failed 1
  Input 184,000  Output 12,600` on the second. The wrap's scroll width is **326 = its client width** at 360
  (**286** at 320, **356** at 390), and all six facts are on the card. The by-workspace table is the same story
  (**693 → 326**).
- **The date and its charge line up down the table.** The day's cell takes a fixed **7rem** so the money begins at
  **x = 139** on every row — the body rows and the total — instead of at the end of each date's own width.
- **The header row is the labels, drawn in the cells.** On a phone the `thead` is not drawn; each figure cell
  carries its column's first word in generated content. The word is drawn and spoken — not the empty-alternative
  form the section numbers use — because on a phone it is the only label the cell has. The wide table keeps its header
  row and its sticky first cell unchanged; the labels are an attribute on the cells, so no test that reads the
  table's text moves.
- **The cards stop being cards under the entries.** The table wrap's fill, the day cell's sticky white background
  and the total row's fill are off below 721, so the rows are ruled entries on the page's paper, with the section's
  own caption above them.
- **Widths, schemes and the floor.** 320 / 360 / 390 / 768 / 1440 in light with the four-day answer: no sideways
  page scroll (320: 320; 360: 360; 390: 390; 768: 768; 1440: 1440), and the tables no longer scroll at all below
  721. At 360 in dark and in forced colours the entries are legible and the rules are the system's. At 200% text
  (root 32px) the row becomes four lines — the day, the charge and calls, then the failures and the tokens — and
  the page is still 360 wide. The account with no calls is unchanged at **2,527** at 360: the empty state has no
  table to lay out. Axe-core over 320, 360 and 768 with the four-day answer finds **no violation** (0).
- **The cost is height, and it is small.** The by-day table is **327 → 369px** at 360 (five rows), the account
  **2,914 → 2,939** with the four-day answer (**3,154 → 3,200** at 320, **2,893 → 2,918** at 390), and 768 and
  1440 are unchanged at **2,452 / 2,432** because the table there is the table it was. A 14-day answer would be
  about 500px taller on a phone than the sideways table; the reader gets every figure for it.
- **The budget.** `app.css` is **40,929 bytes of 40,960** (was 40,906, a net **+23**): the phone rules cost about
  850 bytes and the two scrolling surface fades on the table wrap (now only an edge shadow at 721–1000) plus
  shortened comments paid for most of it. Thirty-one bytes remain.

| measured at 360, light | before | after |
| --- | --- | --- |
| The by-day table, box / content | 326 / **722** | 326 / **326** |
| Columns readable without a swipe | Day, Charged | **all six** |
| `Calls` begins at | x = 311 (past the 326 box) | **x = 262**, inside it |
| The by-workspace table | 326 / 693 | **326 / 326** |
| The by-day table's height | 327px | **369px** |
| The account with four days | 2,914px | **2,939px** |
| … at 320 / 390 | 3,154 / 2,893 | **3,200 / 2,918** |
| … at 768 / 1440 | 2,452 / 2,432 | **2,452 / 2,432** |
| axe-core (320, 360, 768) | 0 | **0** |
| `app.css` | 40,906 bytes | **40,929** |

### What this pass leaves

- **A phone pays about 8px a row for the labels.** A day is 68px against the 48px of a table row; a fortnight of
  calls is about half a screen more scroll than the sideways table. It is the price of not hiding four columns.
- **The edge cue at 721–767 is a shadow, not a fade.** The wrap's two `local` surface fades went to pay for the
  phone rules; the fixed 10px edge shadow and the thin scrollbar remain. At 768 the by-day table still needs 17px
  of scroll for its last column, as it did before.
- **The date is fixed at 7rem.** A longer day label than this fixture's ("Oct 27, 2026") wraps inside its 112px
  column rather than pushing the charge off its line; the by-workspace table's "A deleted workspace" takes two
  lines for the same reason.
- **The first screen is still 494px of summary.** The card, the three facts and the contents line have not moved;
  making the page answer "what am I paying for and what am I using" any sooner means changing those, not the bill.
  The Workspaces heading still begins at y = 735, at the foot of an 800px screen.

## 2026-10-28: the first screen, and the bill before the form

Same harness: Chromium through `playwright-core` against the base commit's pages served by `trial --port 7601` and
this pass's pages by `trial --port 7631`, on the same fixture (a Team account with one running workspace), 320 /
360 / 390 / 768 / 1440, light and dark, forced colours at 360, the root raised to 32px at 360, a touch pointer
below 721. Heights are `document.documentElement.scrollHeight`; positions are `getBoundingClientRect` plus
`scrollY`.

- **The first screen ends on the workspace, not on its heading.** At 360 the order was a 195px card, 190px of
  three stacked facts and a 109px contents line — 494px before the first section — so `01 Workspaces` began at
  **y = 735** and the workspace's name at 794, with its three controls at 832, below an 800px screen. The three
  facts are now three ruled lines with the note beside the figure (label, value and note on one line; the
  workspaces note still wraps at 360, so the block is **154px**, not 132), and the contents line is one row of
  five 13px links at 44px with 6px of side padding and 2px between them (their measured widths are 102, 53, 64,
  75 and 77 = **319 in 328**). `01 Workspaces` begins at **y = 627**, the workspace's name at **687** and
  `Open / Pause / More` at **725–769** — its whole row is on an 800px screen. The page is **2,527 → 2,420** at
  360, **2,507 → 2,379** at 390 and **2,790 → 2,749** at 320.
- **The bill comes before the form that buys more of it.** The Payment panel was 1,486px down and the Usage
  panel 2,087px: a customer reading the bill met `Add credit`, the three amounts and `Another amount` first.
  Usage is now the third section and Balance the fourth, in the page, the contents line and the numbers
  (`03 Usage`, `04 Balance`), and the scrollspy reads them in that order. Usage begins at **1,378** (was 2,087),
  Balance at **1,639** (was 1,486) and Settings at **2,241** (was 2,348). At 768 and 1440 the page height is
  unchanged (2,065 / 2,046) and the swap is the same 479px.
- **A phone's table keeps its column headers, drawn or not.** `display: none` took the header row out of the
  accessibility tree, and the `data-h` word was the only name a cell had. The header row is now clipped
  (`position: absolute; 1px; clip-path: inset(50%)`) so it is drawn for the eye nowhere but still a row of
  `<th scope="col">` for a reader, and the `data-h` label is drawn with an empty alternative (`attr(data-h) /
  ""`) so it is not said twice. Chromium's `Accessibility.getFullAXTree` at 360 lists the six `columnheader`
  cells **DAY, CHARGED, CALLS, FAILED, INPUT TOKENS, OUTPUT TOKENS** in the by-day table and the same six in the
  by-workspace table, with the value cells named **$2.74, 34, 1, 184,000, 12,600**; before the change there were
  no `columnheader` nodes at all. axe-core with every rule (not only WCAG) finds **0** violations at 360 and
  768.
- **Widths, schemes and the floor.** 320 / 360 / 390 / 768 / 1440 in light, 360 in dark and in forced colours,
  and the root at 32px: no sideways page scroll (320: 320; 360: 360; 390: 390; 768: 768; 1440: 1440), nothing
  computes below **12px**, and the account with no calls is 2,749 / 2,420 / 2,379 / 2,065 / 2,046. With a four-day
  usage answer both passes together give 3,138 / 2,831 / 2,790 / 2,452 / 2,432 against the base's 3,154 / 2,914 /
  2,893 / 2,452 / 2,432: the table's 42px is given back by the first screen. At 200% text
  the first screen is 5,105px tall, the facts wrap to two lines each and the strip to 137px, and the page is
  still 360 wide. The plan-less account (1,516px at 360) draws its stage card with the steps and puts the first
  plan at 544 in the first screen; a paid account with no workspace puts the create form in the stage card at
  358.
- **The budget.** `app.css` is **40,950 bytes of 40,960** (was 40,929, a net **+21**): the compact facts, the
  one-row contents line and the clipped header row cost about 90 bytes, and shortened comments and the folding
  of two media-query lines paid for the rest. Ten bytes remain.

| measured at 360, light | before | after |
| --- | --- | --- |
| The three facts | 190px, label and note stacked | **154px**, label, figure and note on a line |
| The contents line | 109px, two rows (Settings alone) | **45px**, five links in 319 of 328 |
| `01 Workspaces` begins at | y = 735 | **y = 627** |
| The workspace's name / controls | 794 / 832–876 | **687 / 725–769** |
| Usage begins at | 2,087 | **1,378** |
| Balance begins at | 1,486 | **1,639** |
| Settings begins at | 2,348 | **2,241** |
| The account at 360 / 390 / 320 | 2,527 / 2,507 / 2,790 | **2,420 / 2,379 / 2,749** |
| … at 768 / 1440 | 2,065 / 2,046 | **2,065 / 2,046** |
| `columnheader` nodes at 360 | 0 | **12** (six per table) |
| axe-core, every rule, 360 / 768 | — | **0** |
| `app.css` | 40,929 bytes | **40,950** |

### What this pass leaves

- **The workspaces note still takes a second line at 360.** "1 workspace in your plan" is 152px against the 328px
  line and the figure and label need the rest; the block is 154 instead of 132. A shorter note ("1 in your
  plan") would buy the 22px and lose the noun.
- **The contents line is one 13px row because its padding went from 12 to 6.** The targets are still 44px tall;
  the current section's pill hugs its word more tightly than before. At 320 the five links do not fit and the row
  wraps (91px), with Settings alone on the second line, as the 2026-10-26 record had it.
- **The Balance panel still carries the top-up form.** The order changed, so the form is no longer met on the way
  to the bill; folding it behind an `Add credit` disclosure would have saved another ~220px and was the other
  candidate. It was not taken because hiding the way to add credit from a customer whose balance is low is the
  worse trade, and because the record's order was the thing that was wrong.
- **The three facts at 768 and 1440 are unchanged** (102px, three columns): there is room for the columns, and
  this pass changed the phone's composition only.
- **Nothing was added for the auth pages or the signed-out home.** The first minute a stranger sees is still the
  front page's; this pass is the account's own record.

## 2026-10-28: the balance's one line, and the form behind it

Same harness: Chromium through `playwright-core` over CDP, axe-core 4.14, 320 / 360 / 390 / 768 / 1440 in light and
dark, forced colours at 360, the root raised to 32px at 360, `prefers-reduced-motion: reduce`, a touch pointer below
721. "Before" is the base commit's own pages served by `trial --port 7601`; this pass's pages are served by
`trial --port 7851`, because the allocation's 7611 is the before trial's gateway tenant port (`base + 10`) and the
before service was left running. Both sides hold the same fixture: a Team account with one running workspace named
Research and the same four-day usage answer, held by request interception on both sides — the trial's stand-in is
never called on its own, so the real usage table is empty. Heights are `document.documentElement.scrollHeight`;
positions are `getBoundingClientRect` plus `scrollY`; names are Chromium's accessibility tree.

- **The balance is the record, and adding credit is one 44px line under it.** At 360 the panel was **562px**: the
  three figures (242px), then the top-up block — a 22px caption, the 50px trough of three amounts, the 74px
  "Another amount" and Pay, the 45px hint and the 20px under the figures, **240px** in all — inside a 523px card.
  The block is now one native `<details>` whose summary is the row **"Add credit"** with the record's chevron; the
  figures' own rule is its top edge, and the row is **44px** tall (286 × 44 at 360, 246 × 44 at 320, 316 × 44 at
  390). The panel is **562 → 374** at 360, **603 → 393** at 320 and **541 → 353** at 390; the page
  **2,812 → 2,624**, **3,119 → 2,909** and **2,771 → 2,583**, and Settings begins at **y = 2,633 → 2,445** at 360.
  The row is the action's name; the old caption that repeated "Add credit" inside the form is not drawn on a phone.
- **The row opens the whole form, unchanged.** Entering it at 360 opens the disclosure and the panel is **563px** —
  the old 562 plus the row — with the three amounts, their status, the field and Pay, and the hint, exactly where
  the 2026-10-25 pass put them. The first amount still sends one `POST /api/checkout` (`amountMinor`) and assigns the
  payment page (measured). The summary is a `DisclosureTriangle`, focusable, named **"Add credit"**,
  `expanded=false`; the `<details>` is the browser's own, so the form is in the markup and a browser without the
  script still has it (the account's panels need the script, as before).
- **A wide screen keeps the form open; the phone gets the row.** The summary is `display: none` above 720 and the
  script opens the details where `min-width: 721px` matches, so at 768 and 1440 the panel is the panel it was —
  **439** and **426px**, pages **2,452** and **2,432** — with the caption, trough and form drawn and no row. Crossing
  the breakpoint closes or opens it (measured 1440 → 360 → 1440: open, 52px closed, open again); the open state is
  not remembered across the crossing.
- **A failed plans read is unchanged, and its retry now opens the row.** With `/api/plans` answering 503 the panel is
  **473px** — the figures, the 157px "amounts could not be loaded" note and its 44px Try again — the page **2,361**,
  in both halves; the row and the form are hidden with the amounts they cannot fill. Pressing that Try again fills
  the amounts in place, and because the row is closed on a phone the retry opens it before giving the cursor to the
  first amount: `document.activeElement` is **$10.00** (the cursor contract the 2026-10-25 pass set), and the panel
  is 563px.
- **Widths, schemes and the floor.** 320 / 360 / 390 / 768 / 1440 in light, 360 in dark and in forced colours, and
  the root at 32px: no sideways page scroll (320: 320; 360: 360; 390: 390; 768: 768; 1440: 1440), nothing computes
  below **12px**, and no control is under 44 × 44 below 721 except the stage title (a `tabindex="-1"` landing place)
  and the 41 × 44 "Plan" contents link, both the record's existing exceptions. At 200% text the page is **6,285 →
  5,728** and the panel **1,226 → 669**, still 360 wide. **14 axe-core runs** (WCAG and every rule, both the resting
  and the opened panel at 320, 360, 390, dark, forced colours and 200% text, and the resting one at 768 and 1440)
  find **no violation**; the before's three runs also found none. The row's accent is `--k-accent-ink` on the card,
  the pair the stylesheet test already holds at 4.5:1.
- **The budget.** `app.css` is **40,947 bytes of 40,960** (was 40,950, a net **−3**). The row, its marker and its
  chevron and the phone's margin rule cost about 600 bytes; eighteen comments were shortened, one was removed and
  the figures' margin was folded into the existing phone rule to pay for them. Thirteen bytes remain: the next pass
  removes before it adds.
- **Tests.** `dist/tests/cloud/pages*.test.js` — **177 pass, 0 fail**; the two page-related build tests — **11 pass,
  0 fail**; typecheck and lint clean (0 errors). `pages.test.ts` pins the card's order (figures, failed note,
  details), the summary's words, the four elements inside it and the 44px phone row;
  `pages-app.test.ts` pins the row's hidden state when the plans are down and that the balance's retry opens it
  before focusing the first amount.

| measured at 360, light | before | after |
| --- | --- | --- |
| The Balance panel | 562px | **374px** |
| … at 320 / 390 | 603 / 541 | **393 / 353** |
| … at 768 / 1440 | 439 / 426 | **439 / 426** |
| The account page | 2,812px | **2,624px** |
| … at 320 / 390 | 3,119 / 2,771 | **2,909 / 2,583** |
| Settings begins at | y = 2,633 | **y = 2,445** |
| The top-up block | 239px: caption, trough, form, hint, margins | **a 286 × 44px row** |
| Opening the row | — | panel 563px, the amounts and Pay return |
| A failed plans read | 473px panel, 157px note, page 2,361 | **473 / 157 / 2,361**; the retry opens the row, cursor on **$10.00** |
| At 200% text (root 32px) | 6,285px page / 1,226px panel | **5,728 / 669** |
| axe-core | 3 runs, 0 | **14 runs, 0** |
| `app.css` | 40,950 bytes | **40,947** |

### What this pass leaves

- **The three figures are still 242px of the panel's 374 at 360.** The 36px Available is a row of its own and the
  allowance and purchased credit share the row below; the ruled-row shape the glance's three facts took on
  2026-10-28 has not been applied here. They are now the largest block on the panel, and the next coherent fix.
- **A quick amount costs one press more.** A customer who used to tap $10.00 now taps **Add credit** and then
  $10.00. The row is named, 44px and in the same place, and the balance-left notice still says when credit is
  needed; the trade bought 188px of the page.
- **The open state is not remembered across the breakpoint.** A phone that had the form open, rotated to a wide
  screen and back finds the row closed; the form is one press away and its contents are unchanged.
- **The failed read's 20px gap is now the note's own margin.** The figures' margin is gone at phone so the row's
  rule sits on them; `#topup-fail` takes the 20px back, which is why the failed state is the same 473px.
- **The usage answer is still a fixture.** The trial's workspaces answer with a stand-in and make no call, so the
  four-day table was held by request interception on both halves; a real model key behind the gateway is still the
  first check for the bill's own arithmetic.
- **The auth pages, the 19px prose links and the checkout stand-in are untouched.** They are the earlier entries.

## 2026-10-28: the balance's three figures are ruled rows

Same harness: Chromium through `playwright-core` over CDP, axe-core 4.14, 320 / 360 / 390 / 768 / 1440 in
light and dark, forced colours at 360, the root raised to 32px at 360 and 320, `prefers-reduced-motion:
reduce`, a touch pointer below 721. "Before" is the base commit's own `app.css`, served by a trial of
`main` (`trial --port 7711`) and measured in the same browser session; this pass's pages are served by
`trial --port 7850`, because 7721 is the before trial's gateway tenant port (`app + 10`) and was listening.
Both sides hold the same fixture: a Team account with one running workspace named Research, with
`/api/usage` held to one empty answer by request interception in both halves (the trial's 60-reads-an-hour
limit had already turned the panel into its warning once). Heights are
`document.documentElement.scrollHeight`; positions are `getBoundingClientRect` plus `scrollY`.

- **The balance's three figures are the ruled rows the glance's three facts are.** On a phone the panel
  drew its record as a two-row grid inside a card: 36px `Available` on a line of its own, then the
  allowance and the added credit side by side under their captions, **241.8px** in all. Each figure is
  now one entry of the same flex row the glance uses — label, figure and note on a line, a 1px rule
  above each — and the entries are **80.8 / 120 / 120 → 54.4 / 60 / 44**: the figures block is
  **241.8 → 159.4**, the panel **374.3 → 291.9** and the page **2,232 → 2,150** at 360, with Settings at
  **y = 2,053 → 1,970.7**. At 320 the panel is **393.4 → 291.9** (page 2,539 → 2,438) and at 390
  **353.5 → 291.9** (2,191 → 2,130). The row is the glance's own selector, not a copy of it: the phone
  rule is `.stat, .figures > div`, so the two cannot drift.
- **A figure's amount no longer sets the height of its row.** The 36px `Available` shares its line with
  its label (54.4px), the allowance's entry is two lines — its label and `$10.00`, then the bar with
  `left of $10.00 a month` (60px) — and the added credit is 44. The `line-height: 1.15` the glance's
  figure already used is what makes the first row 54 rather than 70.
- **Nothing above or below the panel moved.** `04 Balance` begins at **y = 1,638.8** before and after at
  360, and the 44px `Add credit` row is at **1,940 → 1,857.7** with its 44px height and its form behind
  it unchanged: opened, the panel is **563.4 → 481** at 360 and **605 → 503.4** at 320. At 768 and 1440
  the wide layout is untouched — the panel **439.3 / 425.8**, the pages **2,065 / 2,046**, all the same
  as before — because the glance and the balance already read as the same three ruled columns there;
  it was only the phone whose glance had taken the row and whose balance had not.
- **The states that are not the plain one.** With `/api/plans` answering 503 the panel's figures are
  **199.3 → 143.4**, the panel **472.8 → 416.9** and the page **2,361 → 2,305**, with the 157px note and
  its Try again where they were (768: 1,990 / 348.7 in both halves). At root 32px the figures are
  **514.4 → 434.1** and the page **4,549 → 4,468** at 360 (**4,843 → 4,760** at 320), still 360 wide.
- **Widths, schemes and the floor.** 320 / 360 / 390 / 768 / 1440 in light, 360 and 1440 in dark, forced
  colours at 360: no sideways page scroll (320: 320; 360: 360; 390: 390; 768: 768; 1440: 1440), nothing
  computes below **12px**, and the only control under 44 × 44 below 721 is the 41 × 44 `Plan` contents
  link the record already names. **24 axe-core runs** (12 views × both halves, WCAG 2.0–2.2 A and AA, the
  open panel and the 200% text included) find **no violation**, and there is no console error. Forced
  colours draws the rows' rules and the bar; with scripts off the page is the same **800px** with the
  same settings form in both halves, because the account's figures are drawn by the script, as before.
- **The budget.** `app.css` is **40,947 → 40,940 bytes of 40,960** (a net **−7**). The four phone rules
  that made the two-row grid — the 1fr 1fr columns, the full-width first figure, the min-width and the
  `9vw` font size line — paid for the row shape and its four new declarations; the comment that
  repeated the base's "the balance is the record" went, and three comments were shortened. Twenty bytes
  remain.
- **Tests.** `dist/tests/cloud/pages*.test.js` — **177 pass, 0 fail**; the two page-related build tests —
  **11 pass, 0 fail**; typecheck and lint clean. `pages.test.ts` no longer pins `.figures > div
  { min-width: 0 }` (the grid it protected is gone); it pins the amount's `min(1.375rem, 9vw)` cap, the
  shared `.stat, .figures > div` row, the block figures and the inline `.of` instead.

| measured at 360, light | before | after |
| --- | --- | --- |
| The three figures | 241.8px: 80.8, 120, 120 | **159.4px: 54.4, 60, 44** |
| The Balance panel | 374.3px | **291.9px** |
| The account page | 2,232px | **2,150px** |
| Settings begins at | y = 2,053 | **y = 1,970.7** |
| … at 320 / 390 | 393.4 / 353.5 panel, 2,539 / 2,191 page | **291.9 / 291.9**, **2,438 / 2,130** |
| … at 768 / 1440 | 439.3 / 425.8 panel, 2,065 / 2,046 page | **439.3 / 425.8**, **2,065 / 2,046** |
| The open panel, 360 / 320 | 563.4 / 605 | **481 / 503.4** |
| A failed plans read, 360 | 199.3 figures, 472.8 panel, 2,361 page | **143.4 / 416.9 / 2,305** |
| At 200% text, 360 / 320 | 514.4 / 508.6 figures, 4,549 / 4,843 page | **434.1 / 425.8**, **4,468 / 4,760** |
| axe-core, 12 views | 0 | **0** |
| `app.css` | 40,947 bytes | **40,940** |

### What this pass leaves

- **The allowance's entry is two lines.** `From your plan` (121px) and `$10.00` (66) leave 78px of a 286px
  row at 360, and the bar with `left of $10.00 a month` is 186px, so they take the second line: the
  entry is 60px against the 44 of its neighbours. A shorter note ("$10.00 left a month") would fit one
  line and lose the "of what"; the sentence is the record's, not this pass's.
- **The bar is 44px wide and does not grow at 200% text.** It is a picture of the allowance beside the
  words that state it, and the words double while the bar does not; an `em`-based width (about 60px at
  root 32) was not measured against the row.
- **The row loses the caption's column.** At 768 and 1440 `Available` still sits above a 36px figure in
  its own column; on a phone it is a small label at the start of the row, level with the amount's
  baseline. That is the glance's shape, and the two are now one rule.
- **The checkout stand-in, the dead reset link's recoveries and the prose-only inline links are
  untouched.** They are the earlier entries.

## 2026-10-28: the balance's figures end their rows

Same harness: Chromium through `playwright-core` over CDP, axe-core 4.14, 320 / 360 / 390 / 768 /
1440 in light, 320 / 360 / 390 / 1440 in dark, 360 in forced colours, the root raised to 32px at 360,
`prefers-reduced-motion: reduce`, a touch pointer below 721. "Before" is a trial of `main` on port
7761 and this pass's pages on 7781, both signed in to the same account: a Team plan, one running
workspace named Research, `$10.00` available, `$10.00` from the plan and `$0.00` from credit. Heights
are `document.documentElement.scrollHeight`; positions are `getBoundingClientRect` plus `scrollY`.

- **The three figures end their rows, so the three amounts are one column.** Label, figure and note
  were an inline sentence on a phone: the amounts began at **120.3 / 168.2 / 222.2** and none of the
  three could be compared with another. The name is at the row's start and the figure at its end now
  — `margin-right: auto` on each figure's label, inside the ruled row the glance and the balance share
  — and the three amounts end at **344** (320: 304; 390: 374), one under another. The figures block is **159.4 → 156.8**, the
  Balance panel **291.9 → 247.3** and the page **2,150 → 2,105** at 360, with Settings at
  **1,970.7 → 1,926.1**; at 320 the panel is **291.9 → 247.3** (page 2,418 → 2,373) and at 390
  **291.9 → 247.3** (2,130 → 2,085).
- **The balance is not a card on a phone, and its entries take the page's width.** The figures sat in
  a card with 20px of padding, so a row was **286px** of the 328 the page has; the glance above it has
  had no card on a phone since 2026-10-23. The card's padding, border, background and shadow are gone
  below 721 and the rows run **16 → 344**: the `Add credit` row is **286 → 328** wide at its 44px,
  its form and the three amounts with it, and the failed read's note is 328 wide, which is the line
  its sentence was missing: at 320 the hint under the form is **67.2 → 44.8px**, one line shorter.
- **The allowance's measure is the entry's own line, and the bar is a share of it.** The bar was a
  44px picture beside the words; it now takes the width the words leave on the line under the row —
  **44 → 185.5px** at 360, **145.5** at 320 and **215.5** at 390 — with `flex: 1` and a `min-width`
  of **3em** in the note's own type, so at root 32px it is **78px** where it was 39.1, and it grows
  with every wider phone. Every character stays: `From your plan`, `$10.00`, `left of $10.00 a month`,
  the period and the currency, and the meter's spoken label with them.
- **The allowance's entry is still two lines: the one thing this pass could not do.** At the 12px
  floor the label (121.2), the amount (66.3) and the note (124.1) are **327.6px of a 328px row**
  before the bar has room for a single pixel, and **374.6** with its 39px floor; a row of one line
  would have to lose the "of what" — the shorter note the previous pass weighed — or the bar, and a
  note written after the amount would end the column of figures. The row is **57.4px**: its name and
  figure on one line, its measure under. It was 60.
- **A failed plans read keeps its answer and gains the room.** With `/api/plans` answering 503 the
  panel is **416.9 → 334.9px**, the note **157 → 133** at 328 wide, the page **2,305 → 2,223**; the
  retry still answers in place and still leaves the cursor on **`Try again`** when it fails again and
  on **`$10.00`**, with the disclosure opened, when the amounts arrive. Opened on the account with
  plans up: panel **481 → 436.4** at 360 (**503.4 → 436.4** at 320, where the hint loses its third
  line), page 2,339 → 2,294.
- **Widths, schemes and the floor.** 320 / 360 / 390 / 768 / 1440 in light, 320 / 360 / 390 / 1440 in
  dark, 360 in forced colours and at root 32px: no sideways page scroll (320: 320; 360: 360; 390: 390; 768: 768; 1440:
  1440), nothing computes below **12px**, and the only control under 44 × 44 below 721 is the 41 × 44
  `Plan` contents link the record already names. At 768 and 1440 nothing moved to the pixel: the
  panel **439.3 / 425.8**, the figures **120.2**, the pages **2,065 / 2,046** and the rows 99.2, so
  every rule this pass adds lives inside `max-width: 720px`. **6 axe-core runs** (360 light, 1440 dark
  and the opened panel, both halves) find **no violation**; there is no console error in any state but
  the failed read, which logs the 503 it was given in both halves, as before; with scripts
  off both halves are the same 800px, because the figures are the script's, as before. At root 32px
  the panel is **589.1 → 536.7** and the page 4,427 → 4,374 at 360 wide; the figures drop below their
  labels there, which is where they have room.
- **The budget.** `app.css` is **40,940 → 40,930 bytes of 40,960** (a net **−10**). The four rules
  cost about 250 bytes and paid for themselves: ten comments went or were shortened — three removed
  (a workspace, the plan or the one picked, the steps) and seven cut to a clause (the icons' legend,
  the stylesheet's opening line, the balance's old "one named line", the row's name, the empty
  result, the skeleton, the bar's text).
- **Tests.** `dist/tests/cloud/pages*.test.js` — **177 pass, 0 fail**; the two page-related build
  tests — **11 pass, 0 fail**; typecheck and build clean, lint at its 211 pre-existing warnings.
  `pages.test.ts` now pins the figure's `margin-right: auto`, the measure line's `flex: 1 0 100%`,
  the bar's `flex: 1` with its `3em` floor, and the card's zero padding below 721.

| measured at 360, light | before | after |
| --- | --- | --- |
| The three figures | 159.4px: 54.4, 60, 44 | **156.8px: 54.4, 57.4, 44** |
| The amounts' left edges | 120.3 / 168.2 / 222.2 | **239.4 / 277.7 / 289.8 — all ending at 344** |
| The allowance's bar | 44px | **185.5px** (145.5 at 320, 215.5 at 390) |
| The Balance panel | 291.9px | **247.3px** |
| The account page | 2,150px | **2,105px** |
| Settings begins at | y = 1,970.7 | **y = 1,926.1** |
| … at 320 / 390 | 291.9 / 291.9 panel, 2,418 / 2,130 page | **247.3 / 247.3**, **2,373 / 2,085** |
| … at 768 / 1440 | 439.3 / 425.8 panel, 2,065 / 2,046 page | **439.3 / 425.8**, **2,065 / 2,046** |
| The open panel, 360 / 320 | 481 / 503.4 | **436.4 / 436.4** |
| A failed plans read, 360 | 416.9 panel, 157 note, 2,305 page | **334.9 / 133 / 2,223** |
| At 200% text, 360 | 589.1 panel, bar 39.1 | **536.7, bar 78** |
| axe-core, 6 views | 0 | **0** |
| `app.css` | 40,940 bytes | **40,930** |

### What this pass leaves

- **The allowance's entry is two lines, by arithmetic.** One line needs 374.6px of text and bar in a
  328px row; even without the bar it is 327.6px, four tenths of a pixel of nothing, so the measure
  keeps its own line. The next pass that wants one line must shorten the *label* ("Plan allowance"
  would leave 16px) or the *note*, and say which word it dropped.
- **At 200% text the figures fall under their labels.** A row is a wrapping flex line, so a 24px
  `From credit you added` takes a line of its own and the amount follows it at the left instead of the
  right: nothing overflows and nothing is lost, but the column holds only at normal text.
- **The glance above the panel keeps its inline figures.** Its rows are the same rule and its notes
  trail their values; giving it the column too would move the price and the balance figure to the
  row's end, which this pass did not measure and judged a different drawing.
- **The address strip's Copy, the steps at 320, the checkout stand-in, the dead reset link and the
  prose-only 19px links are unchanged.** They are the earlier entries.

## 2026-10-29: the money is one ledger

Same harness: Chromium 156 through `playwright-core` over CDP, axe-core 4.14, 320 / 360 / 390 / 768 / 1440
in light and dark, forced colours at 360, the root raised to 32px at 360, `prefers-reduced-motion: reduce`, a
touch pointer below 721. "Before" is `main`'s own pages served by a trial on **7961**, this pass's pages by a
trial on **7981**, both signed in to the same account made through the same script: a Team plan at $149.00 a
month, one running workspace named Research, $10.00 available, $10.00 from the plan, $0.00 from credit. Every
height is `document.documentElement.scrollHeight`, every position `getBoundingClientRect` plus `scrollY`.

- **The glance's three facts are the balance's ruled rows.** On a phone the three facts wrote their notes as
  sentences trailing their figures — `Workspaces 1 running · 1 workspace in your plan` on one line, the plan's
  price and the balance's used figure after their amounts on theirs — while the panel below drew the same
  kind of figures as ruled rows with the note on a line of its own. Two grammars for one ledger. The name now
  starts the row and the figure ends it (`margin-right: auto` on the row's `dt`), and the note is the line
  under, in the panel's own rule rather than a copy of it: `.stat dt` joins `.figures dt`, and `.stat-n` joins
  `.figures .of` in one declaration block, so the two cannot drift. At 360 the three figures end at **344,
  344 and 344** (they ended at 190, 205 and 166.6) and the three notes start at **16** (the plan's started at
  215 and the balance's at 176.6). The rows are **57.6 / 59.2 / 57.1** (64.2 / 45 / 44) and the block
  **154.2 → 174.8**.
- **The rows are 4px, and the balance pays 8px back for them.** A row's padding goes 6 → 4 in the rule the
  two blocks share, so the panel's figures are **156.8 → 148.8** and the panel **247.3 → 239.3** at 360, while
  768 and 1440 keep **423.3** and **425.8**, where the rule does not apply. The page is **2,105 → 2,118** at
  360, **2,373 → 2,365** at 320 — where the balance row's note already fitted inline, so the column buys a
  line instead of spending one — and **2,085 → 2,118** at 390, where all three facts had fitted one line each.
  Settings begins at **1,941.1 → 1,953.7**; `01 Workspaces` at 627 → 647.7, the workspace's name at 665.5 →
  686.2 and its `Open / Pause / More` row at **745.2–789.2**, still inside an 800px screen.
- **A note that has nothing to say takes no line.** With `/api/plans` answering 503 the workspaces and plan
  facts have no note at all, and a `dd` that takes the line under the row would have been two lines of
  nothing: `.stat-n:empty` is not drawn. Measured: both notes are **0 × 0** (36.4px saved), the glance is 134 → **146.1** (the
  balance's `available` is the one note it has), the panel **334.9 → 330.9** and the page **2,223 → 2,231**.
  The section's retry still leaves the cursor on **Try again** when the read fails again (page 2,231), and on
  **`#plan-h`** when the plans arrive (page 2,118).
- **The allowance's entry stays two lines, and the arithmetic is why.** A one-line entry needs the label
  (121.2), the amount (66.3), the note (134.5, measured today: this browser renders the 13px note 10px wider
  than the previous record's 124.1) and two 10px gaps — **342px** — in a 328px row before the bar has a pixel,
  and **389px** with the bar's 39px floor. So the measure keeps its own line, which is now the grammar of
  every row in both blocks rather than the exception in one. The bar is unchanged at **185.5 × 6**.
- **States, schemes and the floor.** 320 / 360 / 390 / 768 / 1440 in light and dark: no sideways page scroll
  (320: 320; 360: 360; 390: 390; 768: 768; 1440: 1440), nothing computes below **12px**, and the only control
  under 44 × 44 below 721 is the 41 × 44 `Plan` contents link the record already names, in both halves. Dark is
  the same height as light at 320, 360, 390 and 768. **8 axe-core runs** (320, 360 and 768 light, 1440 dark, WCAG 2.0–2.2
  A and AA and again with every rule) find **no violation**, and there is no console error but the 503 a failed
  read logs in both halves. Forced colours draws the rules and the notes in the system's own black; with scripts
  off both halves are **800px** with the money blocks empty, as the script draws them, and the settings form as
  before. At **200% text** (root 32px) the page is **4,374 → 4,335**, the glance **423.8 → 396.1** and the panel
  **536.7 → 524.7**, and the balance row's figure now ends its row (**307.2 → 344**) where the note used to
  wrap beside it; the workspaces and plan figures still fall under their labels there (see what this leaves).
  The `Add credit` row is still 44px and opens the same form: opened, the panel is **436.4 → 428.4** and the
  page **2,294 → 2,307**.
- **The budget.** `app.css` is **40,930 → 40,908 bytes of 40,960** (a net **−22**). The two selectors joined two
  rules that already existed and the row's padding is one digit shorter; the balance's own ruled-entry comment
  went and the one above the shared row now names the grammar both blocks keep. `pages.test.ts`
  pins the glance's `dt` and its full-line note beside the panel's, so a later pass cannot take one without the
  other; each assertion was mutation-checked and each failed alone.

| measured at 360, light | before | after |
| --- | --- | --- |
| The three figures' right edges | 190 / 205 / 166.6 | **344 / 344 / 344** |
| The three notes' left edges | 16 / 215 / 176.6 | **16 / 16 / 16**, each 328 wide |
| The glance's rows | 64.2 / 45 / 44px | **57.6 / 59.2 / 57.1** |
| The glance | 154.2px | **174.8px** |
| The panel's figures / the panel | 156.8 / 247.3px | **148.8 / 239.3** |
| The account page | 2,105px | **2,118px** |
| … at 320 / 390 | 2,373 / 2,085 | **2,365 / 2,118** |
| … at 768 / 1440 | 2,009 / 2,046 | **2,009 / 2,046** |
| Settings begins at | y = 1,941.1 | **y = 1,953.7** |
| The workspace's controls, at 360 | 724.5–768.5 | **745.2–789.2** (still on an 800px screen) |
| `/api/plans` 503: the glance / the page | 134 / 2,223px | **146.1 / 2,231** with both empty notes at 0px |
| The `Add credit` row, opened | panel 436.4, page 2,294 | **428.4 / 2,307** |
| At 200% text | 4,374 page, 423.8 glance, balance figure ending at 307.2 | **4,335 / 396.1 / 344** |
| axe-core, 8 runs | 0 | **0** |
| `app.css` | 40,930 bytes | **40,908** |

### What this pass leaves

- **The glance's third line cost 13px of page at 360 and 33 at 390.** The two facts whose notes fitted inline
  now pay a line for the column, and only the balance's 8px of padding comes back. At 390, where all three
  notes fitted, the price is the whole 33px. It is the drawing's cost, not a rounding, and the first screen
  still ends on the workspace's controls (745.2–789.2 of 800).
- **At 200% text two of the three glance figures still fall under their labels.** A row is a wrapping flex
  line: a 48px `Workspaces` (194.2 wide) leaves no room for the 52px `1 running` after it, so the figure takes
  the next line at the left. The balance row, whose label is short, now ends at 344. Nothing overflows and
  nothing is lost.
- **The glance's workspaces note is still a plan fact beside a running count.** `1 workspace in your plan`
  under `1 running` is true of the plan, not of the count; it takes the second line at 360, which is where the
  column now puts it anyway.
- **The address strip's Copy, the steps at 320, the checkout stand-in, the dead reset link and the prose-only
  19px links are unchanged.** They are the earlier entries.

## 2026-10-29: the plan is a record on a phone

Same harness: Chromium 156 through `playwright-core` against this worktree's trial (`trial --port 7812`, whose
plans are the trial's own fixtures), 320 / 360 / 390 / 768 / 1440 in light and dark, `prefers-reduced-motion:
reduce`, a touch pointer below 721, and axe-core 4.14 over all 100 views. "Before" is `main`'s own
`app.css` served by the same trial through request interception in the same browser session as the after, not a
figure copied from an earlier record. The fixtures are a Team account with one running workspace named Research,
the same plan with no workspace yet, and a fresh account with no plan; `/api/usage` is held to one empty answer in
both halves (the trial limits it to 60 reads an hour per session, and the table is empty anyway). Heights are
`document.documentElement.scrollHeight`; positions are `getBoundingClientRect` plus `scrollY`.

- **The plan is a record at the page's edge on a phone, as the balance is.** The balance stopped being a card below
  721 on 2026-10-28 so its entries could take the page's 328px; the plan's row kept its card and its 20px of padding,
  and its content box stayed **286px**. Its two actions need **296px** (`Manage billing` 136 + `Change plan` 148 + the
  12px gap), so they stacked: **100px** of buttons in two rows. Its first term, `$10.00 of model usage each month`,
  took **48px** for two lines. Below 721 the row now takes the page's width like the balance's entries, with its top
  rule as the record's first line: at 360 the row is **353 → 232px**, the two actions are **one 44px row** (both at
  x = 16–319), the term is **48 → 24**, the Plan panel **391 → 270** and the page **2,264 → 2,143**.
- **The two phone widths the record draws gain the most.** At 390 the panel is **311 → 248** and the price's own line
  `$149.00 per month. Paid until November 29, 2026.` is **45 → 22px** (the card's 316px could not hold it; the
  page's 358px does). At 320 the panel is **391 → 350**: the row is 288px there, so the two actions still need two
  rows (296 > 288) and the price line still takes two. Everything below the panel moves up by the same amount:
  Usage 1,522 → 1,401, Balance 1,805 → 1,684 and Settings 2,085 → 1,964 at 360.
- **A failed plans read is the same record.** With `/api/plans` answering 503 the panel is **330 → 288** at 360 and
  the page **2,298 → 2,256**; at 1440 it is **290** before and after, as the row is still a card there.
- **Nothing else moved.** 90 of the 102 views the harness takes are the same height to the pixel: the plan-less
  account at 320 / 360 / 390 / 768 / 1440 (1,744 / 1,563 / 1,515 / 1,078 / 1,036) and the seven public pages at
  every width and in both schemes. At 768 and 1440 the paid account is **2,008** and **2,045** in both halves and
  the panel **277** — the rule is inside `max-width: 720px`. No view scrolls sideways (320: 320; 360: 360; 390: 390;
  768: 768; 1440: 1440), nothing computes below **12px**, the list of controls under 44 × 44 is unchanged, **100
  axe-core runs** find **no violation** in either half, and there is no console error. With scripts off the account
  is the same **800px** and `/verify` the same **897px**, because the plan's row is the script's, as before.
- **The budget.** `app.css` is **40,908 → 40,950 bytes of 40,960**: the phone rule is 98 bytes and the two comments
  that only repeated their rules ("The sections: a contents line." and "Too much text wraps.") paid for it. Ten bytes
  remain.

| measured at 360, light | before | after |
| --- | --- | --- |
| The plan's content box | 286px of the page's 328 | **328** |
| The row / the panel | 353 / 391px | **232 / 270** |
| The two actions | two rows, **100px** | **one 44px row**, x = 16–319 |
| `$10.00 of model usage each month` | 48px (two lines) | **24** |
| The price's own line | 45px | 45 (330 in 328; see below) |
| The account page | 2,264px | **2,143** |
| … at 320 / 390 | 2,383 / 2,116 | **2,342 / 2,052** |
| … with no workspace yet, 360 | 1,936 | **1,815** |
| … at 768 / 1440 | 2,008 / 2,045 | **2,008 / 2,045** |
| A failed plans read, 360 / 1440 | 2,298 / 1,986 | **2,256 / 1,986** |
| axe-core, 100 views | 0 | **0** |
| `app.css` | 40,908 bytes | **40,950** |

### What this pass leaves

- **The price is still a sentence, and still 14px.** `$149.00 per month. Paid until November 29, 2026.` needs
  **330px** in the row's 328 at 360, so it keeps two lines there (it is one line at 390, and at 320 in neither).
  Making it the section's figure — the account's 30px, as the balance's figures are — was built and measured first:
  a `figures` block of `Price` and `Paid until` makes the panel 405px at 768 and 1440 (**+128** on the page there)
  because the block's 36px figure and its note are taller than the sentence they replace, so it was not taken.
  The next pass that wants the price as a figure at every width has to pay those 128px, or put the figure only where
  a phone can afford it — which is two bodies for one fact.
- **The two actions still stack at 320.** They need 296px and the page has 288: the same arithmetic the plan's row
  had at 360 before this pass, one phone narrower.
- **The card is gone at a phone, and the card was also the row's colour.** The plan's row is now the page's paper,
  like the balance's entries; a plan that a person scans for as a panel now reads as a ruled entry. That is the
  grammar the record chose for money on 2026-10-28 and this pass applied it to the plan.
- **Nothing was added for the glance's 13px balance note, the address strip's Copy, the steps at 320, the checkout
  stand-in, the dead reset link or the prose-only 19px links.** They are the earlier entries, unchanged and still
  true.

## 2026-10-29: the workspaces are records too, on a phone

Same harness: Chromium through `playwright-core` against this worktree's trial (`trial --port 7601`), with the
half built from `main` on 7621 signing in to the same fixture, 320 / 360 / 390 / 719 / 720 / 721 / 768 / 1440 in
light and dark, `prefers-reduced-motion: reduce`, a touch pointer below 721, and axe-core over the 320, 360, 768
and 1440 views in both schemes. The fixture is a Team account with one running workspace named Research, made by
the same script in both halves; the same workspace paused (Resume), a second account's first workspace caught
while Starting, and the first account with `/api/plans` answering 503. Heights are
`document.documentElement.scrollHeight`; positions are `getBoundingClientRect` plus `scrollY`.

- **On a phone every row of the account is now a record at the page's edge, the workspace included.** The glance,
  the balance and (since the last pass) the plan stopped being cards below 721; the workspace kept its 20px of
  padding, so its content box was the page's 328px minus 42 — **286px** — and it began **21px in from every rule
  above and below it**: the name at x = 37 where `01 Workspaces`, `02 Plan`, `Team`, `$10.00` and `Add credit` are
  at 16, the actions at 37 where `Manage billing` is at 16, and its address strip at **17–343**, a pixel in from
  both edges. The phone rule that zeros a record's card now names `.row` instead of the plan's own row: the
  content box is **37–323 → 16–344**, the row **264.2 → 239.2px**, and the page **2,077 → 2,052**.
- **At 320 that 42px was the width the three actions needed.** `Open 71.5 + Pause 75.7 + More 94.2` and two 8px
  gaps are **257.4px** in the card's 248, so `More` took a second row: the row was **318.4px** and the page
  **2,264**. Given the page's 288 they are one 44px row at x = 16–273.4, the row is **239.2** and the page
  **2,185** — **79px**, the most any width gains. The address gains one too: `research-…localhost` is 217.9px and
  had 180px, so it wrapped into a **177.9 × 46.2** chip of two lines; at the edge it has 219.9 and is
  **219.9 × 25.4**, one line.
- **390, 719 and 720 gain the same 25px, and 721 is the same page it was.** 2,055 → **2,030** at 390, 1,788 →
  **1,763** at 719 and 720; at 721 the card returns in both halves and the page is **2,056**, as 768 (**2,065**)
  and 1,440 (**2,102**) are unchanged to the pixel. Everything above the record is where it was — the stage
  165–359.8, the glance 375.8–550.7, the contents line 562.7–607.7, `01 Workspaces` at 647.7 — and everything
  below moves up by the saving: the plan 1,047.1 → **1,022.1**, Usage 1,357.4 → **1,332.4**, Balance 1,618.5 →
  **1,593.5**, Settings 1,897.7 → **1,872.7**, the "Your plan includes 1 workspace…" note 962.3 → **937.3**.
- **The other states keep the grammar.** A workspace that is Starting is **319.8 → 294.8px** with its phase bar,
  its sentence and "Open it when it is ready" at the edge; paused, the record is 302.4px with `Resume` at 16 and
  "Paused by you. Its files are kept…" under the name; with `/api/plans` answering 503 the record loses its plan
  line and is **208.2 → 183.2px** (the panel 391 → **366**, the page 2,190 → **2,165**), and no state overflows.
- **The budget.** `app.css` is **40,950 → 40,953 bytes of 40,960**. The address rule is 68 bytes, and it was
  paid for by writing what was already two copies of one thing as one: the balance's card and the record's row
  were the same four declarations twice, so `.row, #balance-panel .card { … }` with the top rule as `.row` turns
  205 bytes of rules into 140 beside the new 68. Seven bytes remain.

| measured at 360, light | before | after |
| --- | --- | --- |
| The record's content box | 37–323 (286px of the page's 328) | **16–344 (328)** |
| The row | 264.2px | **239.2** |
| `Open` / `Pause` / `More` | x = 37–294.4 | **x = 16–273.4** |
| The address strip | 17–343px (1px in at both edges) | **16–344** |
| `Copy` | 262.9–323 | **283.9–344** |
| The account page | 2,077px | **2,052** |
| … at 320 / 390 | 2,264 / 2,055 | **2,185 / 2,030** |
| `More` at 320 | a second row, 318.4px | **the first row**, 239.2 |
| The address chip at 320 | 177.9 × 46.2 (two lines) | **219.9 × 25.4** (one) |
| … at 719 / 720 (rule's edge) | 1,788 | **1,763** |
| … at 721 / 768 / 1,440 | 2,056 / 2,065 / 2,102 | **2,056 / 2,065 / 2,102** |
| A workspace while Starting, 360 | 319.8px | **294.8** |
| axe-core, 8 views | 0 | **0** |
| `app.css` | 40,950 bytes | **40,953** |

### What this pass leaves

- **The address still holds three lines on a phone, where two would do above 390.** `Address` (45.4) + the chip
  (217.9) + `Copy` (60.1) + two 8px gaps are **339.4px**, which is why the label takes a line of its own at 320
  and 360 (288 and 328). From 390 the record is 358 and the three fit with 18.6px to spare, so the block is
  **88.2px where 65 would do** — 23.2px, at 390, 480 and 720 alike. It needs a break rule of its own and the
  last seven bytes of the stylesheet, and it is the next pass's to draw.
- **The card was also the row's colour, and the address was a band.** A reader who scanned for a workspace as a
  white panel now meets a ruled entry with a ruled address under it — the grammar the plan and the balance took
  on 2026-10-28 and 29. The tint that separated the address from the record went with it.
- **The stage card still repeats the record's own sentence and button.** At 360 `Research is running` + `Open it
  to describe your team and start a mission.` + `Open` is **194.8px**, and the record 300px below says
  `Research / Running / Open` again. It is the page's one call to action, not a decoration, so it is a question
  for a pass that can change the script, not this one.

## 2026-10-29: the contents line is one row on a 360 phone

Same harness: Chromium through `playwright-core` against this worktree's trial (`trial --port 7511`, whose plans
are the trial's own fixtures), 320 / 360 / 380 / 384 / 389 / 390 / 768 / 1440 in light, 360 in dark and forced
colours, `prefers-reduced-motion: reduce`, a touch pointer below 721, the root raised to 32px at 360, and
axe-core 4.14 over six views. "Before" is the base commit's own `app.css`, stashed, rendered at the same address
on the same account and restored, not a figure copied from an earlier record. The fixture is a Team account with
one running workspace named Research, $10.00 available, $10.00 from the plan and $0.00 from credit. Heights are
`document.documentElement.scrollHeight`; positions are `getBoundingClientRect` plus `scrollY`.

- **The account's five sections share one 45px line down to a 360 phone.** At 360 the five labels were 352.3px
  of content in the 328px line (Workspaces 100, Plan 44, Usage 57.2, Balance 69.7, Settings 73.4 and four 2px
  gaps): Settings fell to a second 44px row at **x = 16, y = 606.2**, the strip was **91px** rather than the
  45px the page draws at 390, and `01 Workspaces` began at **691.2**. Below 390px the labels are now a caption's
  **12px** with 4px of side padding and a 44px floor: the five are **89.2 / 44 / 49.7 / 61.3 / 64.7** wide from
  x = 16 to 332.9, one 45px row, and Settings sits at **x = 268.2, y = 560.2**. The line ends 11px short of the
  page's edge.
- **The workspace's controls are back in the first screen.** The 46px the second row took put `Open / Pause /
  More` at **768.7–812.7** on the 360 × 800 screen — 12.7px past its foot — with the workspace's name at 730.7.
  The row is now **722.7–766.7**, the name at **684.7** and the heading at **645.2**, so the first screen ends on
  the three controls as the 2026-10-28 pass intended. The page is **2,117.6 → 2,071.6** at 360 and everything
  below moves up the same 46px: Plan 1,065.6 → 1,019.6, Usage 1,375.9 → 1,329.9, Balance 1,659.3 → 1,613.3,
  Settings 1,938.6 → 1,892.6.
- **The narrowest phones keep their page and lose one pixel of label type.** At 320 the five labels still need
  **316.9px in 288** and Settings keeps its own row at 91px, so nothing there moves: the page is **2,242.3**
  before and after, the heading 691.1 and the controls 768.6–812.6. The type is **12px** instead of 13 and the
  padding 4 instead of 6, at the record's floor. At 390 the line is the 13px / 6px one it was — the links are
  100 / 44 / 57.2 / 69.7 / 73.4 wide, the strip 45px and the page **2,027.1** — and 768 and 1440 are unchanged
  at **2,008.5** and **2,044.7**.
- **The line gives way with the bar, not at a break of its own.** The new rule is `@media (max-width: 389px)`:
  at 389 the 13px line would have 4.7px to spare and at 390 it has 5.7, so the handover is where the full-size
  line has room rather than at the 384.3px the arithmetic needs. The bar's own compact rules still start at 380,
  so at 381–389 a reader sees the 12px contents line and the full-size bar; at 390 both are full size. The step
  is 1px of type, not a second design.
- **Widths, schemes and the floor.** 320 / 360 / 380 / 384 / 389 / 390 / 768 / 1440: no sideways page scroll
  (320: 320; 360: 360; 384: 384; 389: 389; 390: 390; 768: 768; 1440: 1440), nothing computes below **12px**,
  and the five labels are 44px tall and at least 44px wide (the Plan label is exactly 44). Dark and forced
  colours at 360 are **2,072px** and draw the line as the system's own. At root 32px (200% text) the page is
  **4,306px** before and after and still 360 wide. **Six axe-core runs** (320, 360, 390, 768, 1440 dark and 360
  forced colours, WCAG 2.0–2.2 A and AA) find **no violation**, and there is no console error.
- **The budget.** `app.css` is **40,953 → 40,950 bytes of 40,960** (a net **−3**). The 96-byte rule was paid for
  by seven bytes from the opening comment, 21 from the icons' note, 11 from the price line's, 11 from the
  section rule's, seven from the trough's, six from the sticky name's and 36 from the phone-money note.

| measured at 360, light | before | after |
| --- | --- | --- |
| The contents line | 91px, Settings alone at x = 16, y = 606.2 | **45px**, Settings at x = 268.2, y = 560.2 |
| The five labels' widths | 100 / 44 / 57.2 / 69.7 / 73.4, 13px | **89.2 / 44 / 49.7 / 61.3 / 64.7**, 12px |
| `01 Workspaces` begins at | y = 691.2 | **645.2** |
| The workspace's name | 730.7 | **684.7** |
| `Open` / `Pause` / `More` | 768.7–812.7 (12.7px below an 800 screen) | **722.7–766.7** |
| The account page | 2,117.6px | **2,071.6** |
| … at 320 | 2,242.3 | **2,242.3** (two rows, 12px) |
| … at 380 / 384 | 2,095.4 / 2,095 | **2,049.4 / 2,049** |
| … at 390 / 768 / 1440 | 2,027.1 / 2,008.5 / 2,044.7 | **2,027.1 / 2,008.5 / 2,044.7** |
| At root 32px, 360 | 4,306px | **4,306** |
| axe-core, 6 views | — | **0** |
| `app.css` | 40,953 bytes | **40,950** |

### What this pass leaves

- **A 320 phone keeps the old first screen.** The five labels need 316.9px and the page has 288; at the 12px
  floor and 4px of padding it would take 1px of side padding and no gap to fit, and the names would touch. The
  controls still end at 812.6, 12.6px below an 800px screen. The wrap is the better trade, as the 2026-10-26
  record said.
- **The contents line is 12px while the bar above it is full size at 381–389.** The line's breakpoint is 389 and
  the bar's is 380; they are two rules because the bar's was measured for a different overflow (325 in 320).
  Moving the bar's would take its 20px logo and 7px link padding to 389 for no gain of its own.
- **The address strip still draws its caption on a row of its own.** At 360 and 390 it is **88.2px** where the
  three things fit on one 65px row at 390; the break rule the 2026-10-29 workspaces pass named is still the next
  pass's.
- **The stage card still repeats the record's sentence and `Open`.** The 46px this pass returns is not the
  duplicate; it is the page's own composition, unchanged.
- **The checkout stand-in and the prose-only 19px links are untouched.** They are the earlier entries.
