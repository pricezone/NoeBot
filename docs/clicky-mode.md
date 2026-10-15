# Clicky Mode ("Show me how")

People know it as **Show me how** (Greek «Δείξε μου πώς»); the code calls it Clicky, and so does
this page. It speaks in the first person and never names itself in a sentence.

Clicky is a companion that sits beside a Bot's computer screen. It sees what is on the screen, talks
with the person, points at the place that matters, walks them through a task one step at a time, and
does things on the computer only when they say so. When the Bot needs the person on its computer (to
sign in, type a code, solve a CAPTCHA, approve something), Clicky opens by itself and shows them
exactly where.

It brings together three ideas:

- **OpenClicky**: a pointer of its own beside the real one, markers, captions and a structured bridge
  for drawing them, local tools first and computer use only as the last step.
- **Bluey**: the phone as microphone and remote. Press and hold to talk, release to send, approve or
  stop from the phone, and the same state on both screens.
- **Clicky / HeyClicky**: the teacher. "Show me what to click", walkthroughs that remember where you
  are, calm approval cards, help that appears when it is needed.

Safety: [clicky-mode-safety.md](clicky-mode-safety.md). Linking a phone:
[clicky-mode-pairing.md](clicky-mode-pairing.md). Testing:
[clicky-mode-testing.md](clicky-mode-testing.md). How it was planned:
[clicky-mode-plan.md](clicky-mode-plan.md).

## What a person sees

**On the computer screen (web app).** The full-window viewer carries Clicky's layer: a small pointer
with Noë Bot beside it, and next to it a bubble that types out the instruction (the current step, or
Clicky's answer); boxes around elements; numbered markers. While Clicky is looking again after the
person did something, the marks are drawn dimmed. Under the viewer, a bar shows what Clicky is doing
(Asleep, Ready, Listening, Thinking, Showing you, Needs your OK, Doing it, Paused, Stopped) in one
short line, the current step with Back, Next and Show me again, a text box and a hold-to-talk button,
the Guide / Do it for me switch, and Stop. "Say that again" in its menu reads the instruction aloud
and types it out again. The small preview in the Bot's panel shows the screen only.

**Following the person.** Clicky sees the whole page (what is above and below the screen, its text,
how far it is scrolled), not only what is on the screen. When the person clicks on the step's target,
presses Enter or Tab, types, or the page changes, Clicky looks again: the step it was about is marked
done when it is, and the next one is pointed at where it is now. It can scroll a target into view.
To go to a site, a guide step points at the browser's address bar ("Click the address bar and type
gov.gr"); in Do it for me, Clicky proposes opening the address itself.

**Taking the wheel.** While Clicky is guiding the person, the viewer takes control of the computer for
them, so their clicks and typing go straight to the page; it gives control back when Clicky sleeps,
stops, finishes the walkthrough or the viewer closes. Minimizing the viewer puts Clicky to sleep.

**Showing what the Bot does.** Opening the viewer while the Bot is working, or the Bot starting work
while the viewer is open, shows what it is doing instead (the server decides, from the open screen
and the Bot's activity): Clicky points at each element the Bot clicks or types into and says so ("Noë Bot is clicking
“Sign in”"). It only watches and never takes control. A question asked meanwhile makes it guide the
person again, and the Bot waits.

**When Clicky wants to act.** A card says what it will do and why. For everyday actions: Allow for
this session (one yes covers the rest of the session's everyday actions) or Not now. For anything
that cannot be undone (a submit, a send, a payment, deleting, closing a tab): Allow, for that one
action, under "Can't be undone". Things that are always the person's (passwords, codes, payments,
security settings, CAPTCHAs) are never offered; Clicky points at them instead.

**When the Bot needs the person.** The viewer opens, Clicky says "Noë Bot needs you here" with the
Bot's own reason, and points at the place to act. "I'll guide you" keeps it at pointing; "Do it for
me" (not offered for sign-ins, codes or CAPTCHAs) lets Clicky propose the actions. When the person
hands the computer back, Clicky says so and steps aside. When the Bot finishes the task while Clicky
is open, Clicky follows up with what happened.

**On the phone (HyperNoesis app › Noë Bot › Clicky).** Pick the computer, then press and hold the
big button to talk and release to send. Double-tap Noë Bot to wake or put Clicky to sleep. The phone
shows the same state, the short reply, the current step, a small picture of the screen with Clicky's
markers, Approve and Deny, and an always-visible Stop. "Noë Bot needs you" arrives as a notification
and opens Clicky for that computer.

**Settings › Show me how.** Open by itself when Noë Bot needs you; how far it may go (ask once per
session, the default; ask every time; guide only); brief or detailed guidance; read replies aloud. **Settings › Phones**
lists linked phones, each with Revoke.

## Architecture

```
 web app: viewer overlay + bar ─┐                        ┌─ gateway onControlEvent (handovers)
 phone: HyperNoesis app ────────┤ HTTPS + WebSocket      ├─ onWaiting (in-run suspensions)
                                ▼                        ├─ onRunBusy (runs start/end)
     /api/computers/:botId/clicky  ── server/src/clicky ─┤
                                       │      │          └─ viewer input (clicks on the screen)
                         shared/clicky-state.ts (reducer)
                                       │
          brain (vision call, deployment model)   guardrails   actions (as the person's input)
                                       │                              │
      agent-computer /elements, /elements/at, /elements/frame, /elements/text, /human/:kind
```

- **Protocol**: `shared/clicky.ts`. Overlays are normalized to the computer's screen (0–1), so the
  same overlay fits the full viewer, the inline preview and the phone's picture.
- **State machine**: `shared/clicky-state.ts`, one pure reducer. Everything that changes a session
  passes through it: a command, the model's answer, an action finishing, a handover ending, the
  clock. It returns the next session and the effects for the server to carry out. States: idle,
  listening, thinking, guiding, awaiting_permission, acting, paused, stopped.
- **Sessions**: one per person and Bot, kept in `clicky_sessions` and resumed within 30 minutes.
  Every change bumps `seq`, written compare-and-set; the event hub fans changes out over WebSocket
  and Postgres `NOTIFY` (the payload names the session, listeners read it from the database).
- **The brain**: one vision call per turn on the deployment's own model (`CLICKY_MODEL` to choose
  another), with a masked, downscaled frame, the elements on and off the screen with their boxes, the
  page's title, text and scroll position, the walkthrough so far and the person's words. The
  elements, the picture and the text are read side by side, each with its own time budget (3 s, 4 s,
  1.5 s); a part that is late is left out and the model is told, and a look fails only when both the
  elements and the picture are missing. The model call gives up after 12 s without output or 30 s in
  all. Every look and check logs one `[timing] clicky.look|check` line naming each part's time and
  any part that failed. On a desktop the browser's address bar is listed as a control (`addressbar`).
  After the
  person (or Clicky) does something, a smaller "check" look says whether the step is done and where
  the next target is; it waits for the page to settle (`/elements/state`) and has its own rate limit. Screen content is untrusted data. The reply's `say` streams to both
  screens; points are snapped to real element boxes when one is near.
- **Actions**: re-checked just before running, then performed as the person's own input while the
  person holds control: clicks and the wheel through XTEST on a desktop computer (which also reaches
  system dialogs and file pickers), page coordinates in page mode; typing and Enter/Tab into the page
  through the page's own keyboard (it cannot reach another window); scrolling a target into view;
  opening an https address in the Bot's tab (`/human/open`, behind the gateway's navigation guard).
- **Narration**: the gateway tells Clicky about each Bot action after its policy check
  (`onBotAction`). When that person has the Bot's screen open (the `/stream` relay reports viewers,
  per process) and Clicky is asleep or idle, the server starts narrating; a client's `watch` counts
  only while the Bot is at work. A narrating session turns each action into a pointer
  (`/elements/ref`).
- **The Bot's side**: `computer_guide_person` lets a Bot show the person steps with Clicky pointing at
  each element, and `computer_request_help` takes an optional `point_at` element.

## Opening by itself

Every way a Bot can need the person goes through the computer gateway's handover events or an in-run
suspension, and both reach Clicky:

| What happened | Trigger | Offers "Do it for me" |
| --- | --- | --- |
| `computer_request_help` (browser run, in-run, or the sign-in service) | `takeover` | yes |
| A Cloudflare or visible challenge stopped the Bot | `challenge` | no |
| `computer_request_sign_in` (private sign-in form) | `sign_in` | no |
| `computer_request_secret` | `secret` | no |
| An approval the person must carry out themselves | `approval` | yes |

Activation is idempotent per request, needs the person's **Open by itself** setting (on by default),
draws the Bot's reason at once and then a pointer from a model look at the screen (or from the
`point_at` element when the Bot named one). The person's own handing back, a cancelled request or a
supplied secret close it again. The web app's attention hook also asks for activation when it sees a
pending request, for a server that missed the event.

## Configuration

| Setting | Meaning |
| --- | --- |
| `CLICKY_MODE` | `off` turns Clicky off: no routes, capability `clicky.enabled` false. On by default. |
| `CLICKY_MODEL` | The model Clicky looks with. Defaults to the deployment's model; on a metered deployment it must be one the gateway offers. |
| `CLICKY_REASONING_EFFORT` | How much the model thinks before a look, sent as `reasoning_effort` on the OpenAI-compatible path. Default `none` (measured: a thinking Qwen took 22.6 s to its first word, 2.1 s with `none`); empty sends nothing. An endpoint that refuses the field is asked again without it. |
| `TRANSCRIPTION_*` | Hold to talk needs transcription; without it `clicky.voice` is false and only typing works. |
| `OPENBOT_MOBILE_LINK_BASE` | Where push links point, e.g. `hypernoesis://noebot/`. Default `openbotmobile://`. |
| `OPENBOT_NATIVE_APP_SIGN_IN` | `off` keeps push (which needs `EXPO_PROJECT_ID`) without trusting `openbotmobile://` for sign-in. |
| `TRUSTED_ORIGINS` | Other pages allowed to call the computer routes and `/api/mobile` from a browser (this deployment's own sign-in, public and app addresses always are). |

Linking a phone does not need Clicky: with `CLICKY_MODE=off`, or with no computer, the phone still
links and its Noë Bot screens work; only the Clicky screen says it is unavailable.
