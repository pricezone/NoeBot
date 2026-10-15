# Clicky Mode — safety

Clicky can see a Bot's computer and, when the person allows it, act on it as them. This page is the
whole list of what keeps that safe, where each rule lives, and what it is tested by.

## The rules

1. **Guide first.** A session starts in guide mode: Clicky points and explains and never proposes an
   action. "Do it for me" is a per-session switch the person turns on, and the setting **How far
   Clicky may go** (`clickyActionPolicy`) can forbid it for good (`never`, "guide only").
2. **Nothing acts without a yes.** Every action is a proposal the person answers. It runs only on
   `approve` for that exact proposal id, before it expires (two minutes), in act mode, with a policy
   other than `never` (`shared/clicky-state.ts`, `approve`).
3. **"Allow for this session" covers everyday actions only.** It is offered when the person's setting
   is "ask once per session" (the default). One yes covers the session's low-risk clicks, typing,
   scrolling and everyday keys on the site where it was given (its registrable domain), for at most
   two hours, until Sleep, Stop, guide only, or the Bot needing the person ends it. On another site
   Clicky asks again. Anything rated `confirm` (a submit, a send, a payment, deleting, closing
   a tab, Enter in a form) is asked about every time, and `yours`/`blocked` are never offered. Each
   action is still probed and rated again just before it runs, against the page it was proposed on.
   The auto-step limit (12 in a row without the person) stays.
4. **The server rates every action, never the model.** `server/src/clicky/guardrails.ts` decides:
   - **blocked** — typing into a password, code or card field; any key that is not an everyday one.
     Clicky presses only an allowlist (Enter, Tab, Shift+Tab, Escape, the arrows, Backspace, Delete,
     Home, End, Page Up/Down, Space, and the browser's Ctrl+A/C/X/Z/Y/F/L/T/R/W, Ctrl+Shift+T/Z);
     every Ctrl+Alt, Alt+F, Super and function-key combination, Alt+F4 and Ctrl+Q are refused, so no
     desktop shortcut (a terminal, a logout, a lock) is reachable. Also very long typed text, and
     anything when the person chose guide only.
   - **yours** — passwords and codes, security and sharing settings, payments (the approvals
     module's `safetyRequirement()`), a part of the page that belongs to another site, and every
     sign-in, secret or CAPTCHA the Bot handed over. Clicky points at it; the person does it.
   - **confirm** — pasting (Ctrl+V, Shift+Insert), closing a tab, reloading, a button that sends the
     form it is in, anything outside the Bot's own browser page, a keyboard whose receiver Clicky
     cannot tell, and targets named like submit, send, pay, buy, delete, confirm, sign, publish,
     transfer, share, invite, add, allow, authorize, grant, accept, approve, install, connect, save,
     post, reply, forward, merge, enable, disable, subscribe, upgrade (English and Greek).
   - **opening a site** — https only, with no name or password in the address; `low` only when the
     person's own words this session named that site ("gov.gr" covers its hosts), otherwise
     `confirm`. The gateway also applies the navigation target guard (no private or metadata hosts
     on a hosted deployment), and the deny rules see it as a navigation.
   - **low** — everything else.
   `yours` and `blocked` never become proposals: Clicky shows where instead. Ratings use what is
   really there: the element under the point as the browser reports it (and, on a desktop computer,
   the window that is really on top there and the window that really has the keyboard, which must be
   the Bot's own browser), not the model's description of it.
5. **Checked again just before acting.** Clicky first holds control for the person, then probes the
   target on the live screen, repeats the rating and applies the deployment's own deny rules
   (`evaluateActionPolicy`). The page address and the element seen when the action was proposed are
   kept on the proposal; a different page, a different element, a sensitive field or a deny rule
   fails the action rather than running it. The card shows the element as probed, not the model's
   words for it.
6. **Acting is the person's own input, with the person holding control.** If nobody holds the
   computer, "Do it for me" first asks for and takes control as the person, through the same handover
   the person uses (which waits for the Bot's current action and interrupts it like any takeover).
   Control stays with the person until they hand it back. Bot actions are refused meanwhile, as for
   any human holder. If somebody else holds the computer, or Clicky cannot tell who does, it does
   nothing and says so.
7. **Stop wins.** Stop is accepted from every state, from the web app (the Stop button, the app-wide
   Stop pill, ⌃⌥S, Escape while acting) and from the phone. It aborts the action in flight, drops
   the proposal and any task grant, returns Clicky to guide mode, and nothing else happens until the
   person resumes. Late model answers and late action results are discarded.
8. **The screen is not an instruction.** Everything read from the screen (element names, page text,
   the picture) reaches the model inside the untrusted-content envelope (`untrusted-content.ts`). A
   page that says "click Delete" is information, not a request; the person's words win.
9. **The model sees as little as it can.** Frames sent to the model are masked first: sensitive fields
   of the Bot's page, including those inside shadow roots, are hidden by `secret-masking.ts` before
   the frame is grabbed (`agent-computer/src/elements.ts`), and on a desktop computer everything
   outside the page's own area (other windows, the terminal, the browser's own menus) is blacked out.
   The unmasked desktop screenshot route is never used for Clicky's model calls. Limits: a window
   lying over the page's area would still show, and a secret written into the page as ordinary text
   is ordinary text.
10. **Overlays are drawn by the viewer.** Nothing is drawn on the computer itself, so a screenshot the
    Bot or Clicky reads never contains Clicky's own pointer.
11. **Only this deployment's own pages may drive it.** Hosted instances share a parent domain that
    is not on the Public Suffix List, so a sibling instance counts as the same site and its requests
    carry this person's cookie. The whole API is guarded (`apiSameSiteGuard`, registered first in
    `createApp`): every POST, PUT, PATCH, DELETE and WebSocket upgrade under `/api` is refused when its
    `Origin` is not this deployment's or one it trusts, or when `Sec-Fetch-Site` says same-site or
    cross-site from an untrusted origin, and a browser's body must be JSON (multipart only for
    attachments and dictation). Callers that are not browsers and carry their own proof (SAML and
    OAuth form posts, SCIM, signed webhooks, the agent tools, the desktop's own token) are exempt.
    The computer routes, Clicky, `/api/mobile` and the conversations socket keep their own stricter
    guard too (`server/src/computer/same-site-guard.ts`). The phone
    sends neither header. Clients may only `activate` Clicky for a person's own question; the Bot's
    needs are opened by the server. Questions are rate-limited per person and computer.
12. **Everything important is audited.** `clicky.session_started`, `clicky.action_proposed`,
    `clicky.action_approved` (with `once` or `session`), `clicky.action_denied`,
    `clicky.action_performed` (with what was probed, the host and the size of what was typed),
    `clicky.action_failed`, `clicky.action_blocked` (with the reason), `clicky.mode_changed`,
    `clicky.guide_installed`, `clicky.stopped`, `mobile.device_linked`, `mobile.device_revoked`, and
    refused or replayed phone links as `session.refused`, beside the computer's own
    `computer.help_requested / control_taken / control_released` rows. The approval's row is written
    before the action runs; if it cannot be written, the action does not run.

## Phones

- A phone is linked through the person's HyperNoesis account, which already has two-factor and
  passkeys: HyperNoesis mints a one-minute, single-use token for the audience `mobile`, signed with
  the instance's own secret. The instance refuses it on the web sign-in route and refuses web tokens
  on the phone route.
- The phone's session lasts 24 hours and does not slide. The server enforces it: a session meant to
  live a day is never extended, whatever cookies a client sends. The phone renews it through
  HyperNoesis without asking the person, and a renewal replaces its previous session.
- Every phone is listed in **Settings › Phones** with a Revoke button, which deletes its session and
  closes its live Clicky connection at once (sessions are also re-checked every minute).
- Notifications say only that Noë Bot needs the person, in their language; the Bot's own words
  stay inside the app, never on a lock screen.
- There is no local listener and no LAN discovery: the computer is in the cloud and everything goes
  over the instance's HTTPS address.
- `OPENBOT_NATIVE_APP_SIGN_IN=off` keeps push notifications on without trusting the fork's own
  `openbotmobile://` scheme, which any Android app could register.

## Tests

`shared/clicky-state.test.ts` (stop from every state, approvals, grants, late answers),
`server/tests/clicky-guardrails.test.ts`, `server/tests/clicky-commands.test.ts` (stop aborts an
action in flight), `server/tests/clicky-pairing.test.ts` (audiences, single use, the cookie pair,
revocation), `server/tests/clicky-brain.test.ts` (untrusted envelope). See
[clicky-mode-testing.md](clicky-mode-testing.md).
