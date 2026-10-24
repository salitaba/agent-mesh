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
