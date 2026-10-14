# Clicky Mode — implementation plan

Clicky Mode is a screen-aware companion for Noë Bot's Computer. It sees the screen, talks with the
person, points at the part of the screen that matters, walks them through a task step by step, and
acts on the computer only when they say so. It switches itself on whenever the Bot needs the person
to take over: a sign-in, a code, a CAPTCHA, a consent screen, a payment, a file picker.

It combines three references:

- **OpenClicky** — the base: a companion beside the screen, a pointer that is not the system cursor,
  secondary markers and captions, a structured control bridge (`cursor`, `cursors`, `caption`,
  `screenshot`, `clear`, `events`), local tools first and computer use as the last resort.
- **Bluey** — the phone as microphone and remote: press and hold to talk, release to send, wake and
  sleep, approve and stop from the phone, the same state on both screens.
- **Clicky / HeyClicky** — the teacher: "show me what to click", walkthroughs that remember where you
  are, calm approval cards, and help that appears by itself when it is needed.

## Current architecture (what this builds on)

- **The computer is a cloud Linux desktop.** `agent-computer/` runs XFCE on Xvfb with Chromium inside
  the subscriber's machine. The person watches it through the app's live viewer
  (`app/src/components/computer/screen-viewer.tsx`, `live-screen.tsx`): a WebSocket of JPEG frames
  (`{type:"frame"}`) and input messages, relayed by the server (`server/src/index.ts`). There is one
  viewer socket per Bot; a second one replaces the first.
- **Handing over.** `agent-computer/src/control.ts` holds who drives (`requestHelp`, `take`,
  `release`, `cancel`, `humanMayDrive`). The server's gateway (`server/src/computer/gateway.ts`)
  writes the `computer.help_requested / control_taken / control_released` audit events. In-run
  tools suspend through `HeadlessToolsMiddleware` and `onWaiting` (`server/src/index.ts`).
- **Safety already in place.** Every Bot action passes the gateway: target resolved from the server's
  own snapshot, CEL policy, approval gate, audit row. `approvals/policy.ts` keeps credentials,
  security settings and payments with the person (`safetyRequirement()`). Outside text is wrapped by
  `untrusted-content.ts`. Sensitive fields are masked by `agent-computer/src/secret-masking.ts`.
- **Voice.** Dictation (`POST /api/audio/transcriptions`, `TRANSCRIPTION_*`) and realtime calls
  (`/api/voice/*`). There is no standalone text-to-speech.
- **Model calls outside a run.** `server/src/routing/model.ts` (`createModelCompleter`) calls the
  deployment's own model with its own key: text only, no images.
- **Live events.** `server/src/channels/events.ts` fans events out through Postgres `NOTIFY`;
  `channels/socket.ts` is the shared Hono WebSocket adapter.
- **The app.** `attention.ts` already opens the Computer panel when the Bot needs the person;
  `QuestionCard`, `RecoveryCard` and the avatar director draw cards and status.
- **What is missing.** Nothing draws a pointer, a highlight or a caption anywhere. Snapshot refs carry
  no boxes. There is no pairing between a phone and an instance.
- **The mobile app.** The fork's `mobile/` is the upstream OpenBot app, with a build-time server URL
  and its own sign-in. Hosted Noë Bot instances sign in only through the HyperNoesis handoff, so Noë
  Bot's mobile app is the HyperNoesis app (`apps/mobile` in the HyperNoesisAI repository), which
  already has the account, billing, two-factor and passkeys. The fork's `mobile/` stays untouched.

## Target architecture

```
 person ──┬── web app (live viewer + Clicky overlay + Clicky bar) ──┐
          └── HyperNoesis app (Noë Bot › Clicky: hold to talk) ─────┤  HTTPS + WebSocket, cookie session
                                                                    ▼
                         server/src/clicky  (session, state machine, brain, guardrails, actions)
                           │            │                │                    │
                 vision model call   gateway observer   audit rows      agent-computer /elements
                 (deployment model)  (help requested,                  (element boxes, masked frame,
                                      taken, released)                   person's input in screen space)
```

- **Overlays are drawn by the viewer**, never on the desktop. Coordinates are normalized (0–1) to the
  computer's screen, so the same overlay fits the full viewer, the inline preview and the phone's
  thumbnail. The model never sees its own pointer in a screenshot.
- **One Clicky session per person and Bot**, kept in the database so it survives a reload and resumes
  within 30 minutes. Every change is a new `seq`; a client that misses one refetches the snapshot.
- **A pure state machine** (`shared/clicky-state.ts`): idle, listening, thinking, guiding,
  awaiting_permission, acting, paused, stopped. Stop is accepted from every state, and acting stays
  off after it until the person resumes.
- **Guide first.** The default mode only points and explains. "Do it for me" is opt-in per session,
  every action is a proposal the person approves (once, or for the rest of the task when the action
  is low risk), and some things are always the person's: passwords and codes, security settings,
  payments, CAPTCHAs.
- **Actions run as the person's own input**, after the person holds control, through the same path as
  their mouse and keyboard, and are audited.
- **Auto-activation** listens to the gateway's handover events and the in-run suspensions, so every
  way the Bot can ask for the person (a help request, a sign-in, a secret, a challenge) opens Clicky
  with a pointer on the place to act.
- **The phone** is linked through the HyperNoesis account: the HyperNoesis API mints a one-minute,
  single-use token for the person's instance, the instance trades it for a 24-hour session that does
  not slide, and records the phone as a device the person can revoke. Nothing listens on a local
  network; the computer is in the cloud.

## Modules

| Where | What |
| --- | --- |
| `shared/clicky.ts` | Protocol: states, modes, overlays, steps, proposals, triggers, commands, events (zod). |
| `shared/clicky-state.ts` | The pure reducer and its effects. |
| `shared/clicky-tools.ts` | `computer_guide_person` and the `point_at` field on `computer_request_help`. |
| `shared/mobile-link.ts` | The phone's link request and response. |
| `shared/user-preferences.ts` | `clickyAutoActivate`, `clickyActionPolicy`, `clickyGuidance`, `clickySpeakReplies`, `clickyOnboarded`. |
| `server/src/db/schema/clicky.ts` | `clicky_sessions`, `mobile_devices` (migration 0059). |
| `server/src/clicky/` | `service`, `hub`, `routes`, `brain`, `guardrails`, `actions`, `activation`, `notes`. |
| `server/src/mobile/` | Linked devices: list, revoke, attach a push device and a computer. |
| `server/src/auth/signin-handoff.ts` | `POST /api/auth/signin-handoff/mobile`. |
| `agent-computer/src/elements.ts` | Element boxes in screen space, the element at a point, a masked frame, screen-space input. |
| `app/src/lib/clicky/`, `app/src/components/clicky/` | Session hook, hold to talk, overlay, bar, cards, onboarding, stop pill, settings. |
| HyperNoesisAI `apps/mobile/src/modules/noebot/` | The fork's mobile screens, merged; the Clicky companion. |
| HyperNoesisAI `packages/api/src/modules/noebot/router.ts` | `POST /api/noebot/mobile/link`. |

## Risks

- **One viewer socket per Bot.** The phone's Clicky uses screenshot thumbnails, never the stream.
- **Two coordinate spaces.** Desktop frames are screen pixels; page frames are viewport pixels.
  Overlays are normalized; model points are snapped to real element boxes when there is one near.
- **Screenshots can hold secrets.** The model only ever sees a masked frame.
- **Prompt injection from the screen.** Screen text is untrusted data; every action needs approval;
  the guardrails do not depend on the model.
- **Latency and credits.** One downscaled frame per turn, a short prompt, a deterministic first frame
  on activation, and `CLICKY_MODEL` to choose a faster model.
- **Mobile sessions.** Single-use tokens tied to the phone, a non-sliding 24-hour session, revocation,
  TLS only. An instance that has not been updated answers 404 and the phone says "Update".
- **Upstream merges.** Mostly new files; small, marked seams in the files OpenBot also changes.

## Migration steps

1. Contract: protocol, reducer, preferences, schema and migration 0059, stubs wired into the server's
   hot files.
2. Server, web app and phone built in parallel against that contract.
3. Integration, documentation, code and security review.
4. Push; `publish-image` builds the image; each subscriber gets Clicky when they press **Update** on
   HyperNoesis. The phone needs a new app build (push notifications).

No data migrates: both tables are new and start empty. Preferences default in code.

## Testing plan

- `shared/clicky-state.test.ts`: every transition, stop from every state, a stale approval refused,
  walkthrough progress, the stuck nudge.
- `server/tests/clicky-*.test.ts`: pairing (audience, single use, expiry, the non-sliding cookie,
  revoked devices), guardrails, command routing and authorization, emergency stop aborting an action
  in flight, two subscribers kept in step, auto-activation from a handover, the model answer parser.
- `agent-computer/tests/elements*.test.ts`: page ↔ screen mapping.
- `app/tests/clicky-*.test.tsx`: overlay positions, hold to talk, stop, approval cards,
  auto-activation, onboarding once.
- HyperNoesisAI: the handoff audience, the link route, the machine environment, translation parity,
  typecheck.
- Manual and live steps: [clicky-mode-testing.md](clicky-mode-testing.md).
