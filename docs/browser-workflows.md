# Browser workflows on any website

The gov.gr declaration run (`docs/gov-gr-declaration-run.md`) was one example of a wider kind of
work: a Bot browsing a site, filling its forms, signing in through the person, handling a
two-factor code, and asking before an irreversible submit. This page records what the Bot can do
for that kind of work on any website, how it is tested, and how fast it is.

## What the Bot can do

**Every acting call returns the page it produced.**
- **Which calls:** navigate, click, type, key, scroll, select, check, upload, hover, fill, dialog,
  tabs and back.
- **What comes back:** a `page` object with the URL, title, HTTP status (for navigations), a fresh
  `snapshotId` and compact element lines. After an action on the same page, only what changed is
  returned.
- **Optional fields:** `dialog`, `opened` (a new tab is now active), `download`, `loading` and
  `notes`.
- **Effect:** the Bot no longer needs a snapshot round trip before every step.

**Tools**
- **Forms:** `computer_fill` fills a whole page in one call, with an optional click or submit.
  Each field is governed and audited under its single-field tool's name. `computer_select`,
  `computer_check`, `computer_upload` (workspace files only) and `computer_hover` cover the rest.
- **Pages, windows and dialogs:** `computer_scroll` takes an optional `ref` for inner panels.
  `computer_tabs` and `computer_back` manage windows, and `computer_dialog` answers a held
  JavaScript dialog.
- **Showing and handing over:** `computer_show_screen` shows the person a picture of the screen.
  The secure sign-in, secret and takeover requests keep their names.

**Errors that say what went wrong.**
- **Precise causes:** a covered element names what covers it, with that element's ref (a consent
  banner lists its buttons). Disabled, read-only and not-editable elements say so, and a select
  or checkbox suggests the right tool.
- **Stale refs:** only an element that left the page says to re-snapshot.
- **Navigation:** DNS, connection, certificate and blocked errors are site errors with a hint,
  not "computer unavailable". A slow page is returned as `loading` instead of failing after 30 s.
- **Hidden internals:** no Playwright call log reaches the model or the person.

**Sign-in and two-factor on any site.**
- **Where fields are found:** in frames and in open shadow DOM.
- **Popups:** an OAuth popup that closes itself is followed back to the window that opened it.
- **Codes:** split one-digit code boxes get one digit each. Code fields are recognised by
  `autocomplete`, numeric length and multilingual words, and postcode, promo and coupon fields
  are excluded.
- **Fields left alone:** a newsletter email field is not taken for a username, and
  remember-device is never ticked.
- **Checked outcomes:** every submit is classified as signed-in, error (with the site's message),
  code-requested, push-approval (a waiting card with Continue) or captcha (takeover). A wrong code
  is reported as wrong.
- **Same-site rule:** a typed credential only continues to the same site, by registrable domain.
  Any other move re-opens the secure form naming the new host.

**Cards that appear at once, in every tab.**
- **Step signal:** the tab driving a turn sends a step signal at each run and each waiting card.
  Watching tabs read the history at once, and keep polling while the turn runs.
- **Server records:** every waiting card has a server record (sign-in, secret, takeover,
  approval, question, and a new record for choice and approval cards).
- **Answering from another tab:** such an answer resumes the run in the tab that holds it. If that
  tab is gone, the answer is sent as a message.
- **Screenshots:** a question asked during a browser task shows a picture of the Bot's screen
  above its options, in every tab and after a reload.

**Recovery, status and language.**
- **One recovery card:** failed turns, failed sends, paused tasks, history and voice failures,
  render crashes and a turn that stopped before finishing all share it. It has real actions:
  Retry, Continue, Resume, Take over, Ask again, Open screen.
- **Status row:** it says what the Bot is waiting for and for how long.
- **Language:** the cards follow the person's language (English or Greek).
- **Animations:** the avatar follows each browser step:
  - search when opening a page;
  - nerd when reading;
  - typing for single steps, and the PC on fire for a streak of form filling;
  - presenting when showing the screen;
  - server when a command runs long;
  - powered-up after a sign-in.

**Speed.**
- **Measurement:** per-run phase timings (`[timing]` log lines and `Server-Timing`).
- **Model:** a prompt-cache key per thread, and old snapshots collapsed in fixed blocks of ten.
  Reasoning effort defaults to `low` and is set with `BOT_REASONING_EFFORT`.
- **Caches:** the Learning container is cached per thread, and the agent build for 10 s.
- **Saved-call ledger:** browser-executed writes are verified instantly against the server's own
  record of the streamed call, with no replay.
- **Warm-up:** the browser is warmed while the person types.
- **Behind `COMPUTER_TOOLS_IN_RUN`:** computer tools execute on the server inside the run, so there
  is no new run per step. A turn also survives the tab closing.

## How it is tested

**Real-browser fixtures** run in CI's computer job (`OPENBOT_COMPUTER_BROWSER=1`):

| Area | Cases |
|---|---|
| Logins | one-step, two-step, no `<form>`, cross-origin step, iframe, shadow DOM, newsletter decoy, popup that closes itself, wrong password |
| Codes | code-only page, split 6-box code, numeric-only field, postcode decoy, wrong code, push approval, remember-device, captcha after submit |
| Pages | HTTP status, slow page answered early, missing site, 404/500, SPA route change, diff after an action, iframe and shadow-DOM text |
| Elements | covered button with consent banner, disabled field, select / checkbox / radio / date / file / custom drop-down, inner scroll panel, hover |
| Windows and dialogs | `target=_blank`, `window.open`, closing popup, tabs list/switch/close, back, confirm / prompt / alert held and answered, unanswered dialog dismissed |
| Downloads and uploads | download saved to the workspace, upload from the workspace, path outside the workspace refused |
| Challenges | markers in the page and in frames for each vendor |
| Workflow | a multi-page form with a preview and a confirmation, one fill per page |

Unit tests cover the server, app and prompt sides. `bun run bench:browser` measures a live
instance end to end, using tasks on the-internet.herokuapp.com.

## Timings

| Build | Task | Wall time | Steps right | Notes |
|---|---|---|---|---|
| Before (production, 2026-10-13) | 4 steps on the-internet.herokuapp.com: dropdown, checkboxes, dynamic loading, JS confirm | 3 min 10 s | 0 / 4 | Three 30 s navigation timeouts with raw call logs. A click on the `<select>` could not choose. The turn ended silently after the click. |

The rows for this build, with in-run tools off and on, are added after the live benchmark.
