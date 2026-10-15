# Clicky Mode — testing

## Automated

Run from the repository root (the app's DOM tests need the root `bunfig.toml` preload):

```sh
bun test shared/clicky-state.test.ts \
  server/tests/clicky- server/tests/mobile- \
  app/tests/clicky- agent-computer/tests/elements-geometry.test.ts
```

| Suite | What it holds |
| --- | --- |
| `shared/clicky-state.test.ts` | Every state transition; Stop from every state; approvals only for the exact, unexpired proposal; "for this task" grants (low risk only, only with "ask once per task"); `yours`/`blocked` actions pointed at, never proposed; "Do it for me" refused for sign-ins, secrets and CAPTCHAs; late model answers dropped; walkthrough next/back/finish; a click on the target finishing a step; the stuck nudge once; handovers activating once and closing. |
| `server/tests/clicky-guardrails.test.ts` | Blocked shortcuts, password and code fields, guide only, `confirm` names in English and Greek, the approvals module's safety categories, triggers that are the person's. |
| `server/tests/clicky-commands.test.ts` | Route validation; a refused command is 200 with its notice; Stop aborts an action in flight and drops the proposal. |
| `server/tests/clicky-actions.test.ts` | Re-probing and re-rating before acting, deny rules, taking control as the person, screen and page coordinates. |
| `server/tests/clicky-sync.test.ts` | Two subscribers see the same snapshots in `seq` order; a compare-and-set conflict is retried. |
| `server/tests/clicky-activation.test.ts` | A help request, secret, sign-in or challenge opens Clicky with the right trigger; a repeat is ignored; handing back closes it; the person's "open by itself" setting off means nothing opens. |
| `server/tests/clicky-brain.test.ts` | The model's grid points become normalized overlays, snapped to element boxes or marked approximate; screen text is inside the untrusted envelope; bad JSON fails cleanly; the streamed `say` extractor (escapes, unicode). |
| `server/tests/clicky-tools.test.ts` | `computer_guide_person` and `point_at`. |
| `server/tests/clicky-pairing.test.ts`, `clicky-pairing.integration.test.ts` | Audiences refused both ways, single use, expiry, the response's cookie pair, no `Set-Cookie`, refused without a device recorder, revoked phones signed out. |
| `server/tests/clicky-store.integration.test.ts`, `mobile-links.test.ts` | Session storage and compare-and-set; phone rows and push links. |
| `server/tests/clicky-progress.test.ts` | Looks after the person acts: the page watch (settled navigations, typing that settles), the check look and its rate limit, stale answers dropped. |
| `server/tests/clicky-gateway.test.ts` | Narration: the gateway's `onBotAction` after the policy check, never for replays, shell and file tools left out, only for a narrating session. |
| `server/tests/api-same-site.test.ts` | The whole-API guard: sibling instances refused (JSON, form, multipart, WebSocket); the app, the desktop, the phone, webhooks, SAML and OAuth form posts allowed. |
| `agent-computer/tests/elements-geometry.test.ts` | Page ↔ screen mapping with the window offset; clamping. |
| `agent-computer/tests/elements-live.test.ts` | Opt-in (`OPENBOT_ELEMENTS_LIVE=1`): element boxes and a masked frame from a real headless browser. |
| `app/tests/clicky-*.test.tsx` | Overlay positions (and letterboxed frames), reduced motion; the bar's hold to talk, Stop, Next/Back; proposal cards and their rules; the events socket's ordering and streaming; activation from the attention hook; onboarding once; settings and phones. |

The `*.integration.test.ts` suites need `TEST_DATABASE_URL` pointing at a migrated, disposable
database (`bun server/scripts/migrate.ts` with `DATABASE_URL` set to it).

App suites added in the second round: `clicky-instruction` (the typed bubble, reduced motion,
"Say that again"), plus `record-steps`, `computer-control-button` and `computer-activity` for the moved
tooltip, the manual take and the "Bot is working" signal.

## By hand, on a running instance

Use a test account and a page that asks for nothing real. Never type real credentials or codes into
a session you are testing, and never let Clicky submit anything that cannot be undone.

1. **Guide.** Open a Bot's computer, press **Show me how**, ask "where do I search?". The pointer lands
   on the search box with the instruction typing out beside it; the bar says "Showing you". Click the box yourself: the step
   is marked done.
2. **Walkthrough.** Ask "how do I open a new tab and go to wikipedia.org?". Steps appear with Back,
   Next and Show me again; the progress survives a reload of the page.
3. **Do it for me.** Switch to **Do it for me** and ask it to click the search box. A card asks
   first; **Not now** leaves a pointer; **Allow for this session** clicks it, and later low-risk
   steps on the same site run without asking. With "ask every time" in Settings, each step asks.
4. **Guardrails.** Ask Clicky to press Ctrl+Alt+Delete, to type into a password field, and to press
   a "Delete account" button: the first two are refused with a reason, the third asks every time
   with "Can't be undone".
5. **Stop.** While it is acting, press ⌃⌥S, then try the Stop pill and the bar's Stop: it halts
   at once, drops back to guide, and does nothing more until you resume.
6. **Opening by itself.** Ask the Bot for a task behind a sign-in. When it hands over, the viewer
   opens with "Noë Bot needs you here" and a pointer on the form; "Do it for me" is not offered.
   Hand back: Clicky says thanks and steps aside.
7. **Phone.** In the HyperNoesis app, open **Noë Bot › Show me how**, pick the same computer, hold to
   talk. The web viewer points while the phone shows the same state and the short reply. Approve a
   low-risk click from the phone; press Stop on the phone during an action. Put the phone in
   airplane mode for a minute and back: it reconnects and shows the current state.
8. **Revoke.** Settings › Phones › Revoke: the phone's next action asks it to connect again.
9. **Greek.** Switch the interface to Ελληνικά and repeat 1 and 3: every label is Greek, and
   Clicky answers in Greek.
10. **Second round.** Ask "how do I search for X?" and follow it: the instruction types out beside
    the pointer; typing the query and pressing Enter moves to the next step by itself, and the
    highlight is never left where the page used to be. Ask for something below the fold: Clicky
    scrolls to it or tells you to. With **Do it for me**, Allow for this session once: typing and
    scrolling then run without asking, a submit still asks. Minimize: it sleeps. Ask the Bot for a
    browsing task and open the viewer: it narrates the Bot's clicks. "Say that again" speaks.
11. **Going to a site.** In Guide, ask "how do I get to wikipedia.org?": the first step points at the
    address bar. In Do it for me, the card says "Open wikipedia.org" with the full address under it;
    a site you did not name always asks first ("You didn't name that site, so I'm asking first.").
    The instance log shows one `[timing] clicky.look` line per look.
