# The gov.gr declaration run: Noë Bot against the reference screenshots

On 2026-10-13 we ran the workflow from five reference screenshots with a real Noë Bot. The workflow
issues a "υπεύθυνη δήλωση" to ΔΕΔΔΗΕ on gov.gr. The run used instance `s3a8cac305e5` on Contabo
and the Noë Bot "Noë". It sent the same request text. The person types the Taxisnet login and the
SMS code into the secure form themselves, and the Bot never sees them.

This page records every difference we found. Each entry has its cause and its fix, split into UI,
backend, browser automation and security. Earlier test conversations ran on 2026-10-12 and appear
in the person's screenshots 7–8; they are included too.

## The workflow, step by step

| # | Reference screenshots | Noë Bot (before the fixes) |
|---|---|---|
| 1 | Opens the declaration service, reaches the Taxisnet login, and posts "Σύνδεση Taxisnet · Secure Form · Open". | Drafted a printable declaration instead (O8). Asked again to issue it, it walked gov.gr: two wrong URL guesses (404), one click refused (O7), a cookie banner, and the "Είσοδος με ΓΓΠΣΨΔ" choice. It then asked for the private sign-in on `oauth2.gsis.gr` with a shimmer line and an "Open private sign-in" button. That button only existed in the tab running the turn (O12). |
| 2 | A modal with the favicon, "Χρήστης*", "Κωδικός*" with an eye toggle, "Never shown to your Bot. Filled directly to oauth2.gsis.gr", and Continue. | A dialog titled with the raw URL. It had fixed English fields, no eye toggle, and "Save to Passwords". The error was printed twice (O1). |
| 3 | "Submitted". A preview screenshot, then the question "Να την εκδώσω;" with A/B rows and "Type your own answer". | Not reached in the live run. The person did not complete the sign-in before the 15-minute request expired. The code review says the question card had no collapsed answered state. |
| 4 | The answered question collapses to the chosen row with a check, then a second secure form, "Κωδικός SMS", with the gov.gr icon. | By code review: a code-only page was refused by the sign-in (it needed a password, G2). The one-value secret tool had no card in the conversation. |
| 5 | A single "Κωδικός Επιβεβαίωσης*" field, "Filled directly to dilosi.services.gov.gr", and Continue disabled until filled. | As 4. |
| — | The computer panel shows "Computer is asleep" with Wake. | No sleep state. An open panel kept the browser awake for good (G7). |

## The second run, after the fixes (build 7e8699e, 2026-10-13 17:00 UTC)

| # | Reference screenshots | Noë Bot (second run) |
|---|---|---|
| 1 | Opens the service and posts "Σύνδεση Taxisnet · Secure Form · Open". | Went straight to the declaration service on gov.gr and posted "Σύνδεση Taxisnet · Secure Form" with the gsis icon, for the login on oauth2.gsis.gr. At the sign-in choice it first handed over the whole browser instead (O15). The card did not appear in the person's own tab until O14 was fixed. |
| 2 | The modal: Χρήστης*, Κωδικός* with an eye toggle, the lock note, Continue. | The same modal. The person signed in; the row turned "Submitted". Chrome then offered "Save password?" in the Bot's browser, with the username in it (O17). |
| 3 | A screenshot of the preview, then "Να την εκδώσω;" with A/B rows. | Filled the data review, the declaration text and the recipient "ΔΕΔΔΗΕ", and reached gov.gr's preview. It showed the preview as a generated interface (raw JSON, a loading skeleton) rather than a picture, and asked only when prompted (O19). The question card then had A–D rows and "Type your own answer", but only in the tab running the turn (O20). Two turns ended silently and one message failed with "Thread is locked" (O16, O18). |
| — | "Computer is asleep" with Wake. | The panel slept after 10 minutes of inactivity and showed "Computer is asleep" with Wake. The tabs came back after the browser restarted. |

## Issues and remediation

Status: **fixed** means in this branch, tested and shipped with it. **open** means not fixed here,
with the plan given.

| # | What happened | Cause | Remediation | Status |
|---|---|---|---|---|
| O1 | The private sign-in opened on gov.gr's description page. The person typed a password and got "There is no sign-in form on the page the Bot has open". The same error showed twice. | The Bot asked before clicking Είσοδος. Nothing checked for a form before showing one, and the form printed both the stored outcome and the mutation error. | **Backend + automation:** `probeSignIn` reads the page (main frame and frames) when the request is made. No form, and the Bot is told to open the sign-in page and ask again; no person sees a form. **UI:** one error line, above Continue; typed values stay. **Prompt:** open the login page first. | fixed |
| G1 | The Taxisnet login is on `oauth2.gsis.gr`, reached by redirect from gov.gr. | Sign-in needed the exact origin the Bot named. | **Backend:** the request is for the origin where the probe found the form. The dialog names that host and notes the site the Bot was on. **Security:** the person sees the real destination before typing. The fill is still refused anywhere else. | fixed |
| G2 | The SMS code page has a code field alone. | Sign-in required a password at every layer. | **Automation:** a code-only fill finds the code field (frames included), types it masked and submits. **Backend/UI:** a probe that finds a code field shows a single code field, labelled by the Bot. | fixed |
| G3 | The one-value secret tool said "The person has entered…" when the field had gone, when nobody answered in 10 minutes, or (with no way to decline) never. | It treated `secretWanted` clearing as success. | **Automation:** the control state records how each request ended: supplied, cancelled, expired or field gone. **Backend:** a `human/secret/cancel` route, audited as `computer.secret_cancelled` without a value. **UI:** the tool reports the true outcome and has a Decline. | fixed |
| G4 | The username was typed unmarked, so the next snapshot could read it. | Only password and code fields were masked. | **Automation/security:** every filled value is marked `data-openbot-secret`, the username included, so snapshots, screenshots and the live screen mask it. Covered by a browser test. | fixed |
| G5 | No favicon, no eye toggle, no host named, and a shimmer line instead of a card. | — | **UI:** `components/chat-cards/secure-form.tsx` is the secure form row and dialog. **Automation:** the icon is read by the Bot's own browser (32 KB cap, images only) and handed over as a data URL. **Security:** the server never fetches arbitrary URLs. | fixed |
| G6 | A login inside a frame was never found. | Only the main frame was scanned. | **Automation:** every frame is scanned and filled in place. A browser test uses a frame from another origin. | fixed |
| O12 | "Waiting for you to sign in" showed no Open button in the person's own tab. | The request id was known only to the tab running the tool call. | **UI:** a card without the id finds its request among the owner's open requests by the tool call's id. A test draws the card in a tab that never ran the call. | fixed |
| O2 | In another chat the Bot refused: Taxisnet codes are personal and it "cannot and should not handle them". It then listed manual steps. | The model generalised "never ask for credentials" into refusing the login itself. | **Prompt and tool description:** government, tax and bank logins go through the private form like any other. The Bot never sees the values, so it must not refuse or answer with manual steps. | fixed (prompt), to verify live |
| O8 | Asked to "issue" a declaration, the Bot drafted a printable document. | No guidance to complete an online service with the browser. | **Prompt:** issue, submit or file on the service with the browser, not a draft. Show the preview and ask before the irreversible submit. | fixed (prompt), to verify live |
| O9 | A turn died silently ("Opened page · Not completed") when the tab that sent the message closed. **Fixed:** computer tools now run on the server inside the run (`COMPUTER_TOOLS_IN_RUN`, on by default); a turn whose tab closed 7 s in finished on the server (2026-10-14, see `docs/browser-workflows.md`). | Chat turns run their computer tools in the tab that started them, as frontend tools. In the reference, work continues in the cloud when the app closes. | **Backend:** when the starting tab goes away mid-turn, hand the turn to the headless tools that unattended turns already use (`server/src/computer/headless-tools.ts`). The plan: the run keeps a server-side lease and the tab heartbeats it. On a missed heartbeat the server resumes from the last saved tool call with the headless tool set. | open |
| O7 | Clicking "Είσοδος στην υπηρεσία" was refused with "That unanswered tool call is not saved in this conversation" (twice in two runs). | Every write action is checked against the saved conversation (`approvals/saved-call.ts`: 11 reads, 0.5 s apart). The conversation service saved the call later than that, and logs show it returning 404/502 that hour. | **Backend:** the check now backs off over about 24 s (16 reads, 0.5 s growing to 2 s) instead of 5.5 s. A call that never appears is still refused, which is the anti-forgery property. **Next:** report the conversation service's save latency, so a slow hour is visible. | fixed (wait); latency report open |
| O3 | "Browsed 1 page · 1 issue" hid what went wrong. | The issue line is collapsed. | Recorded by the run: the issues were O7, a navigation that did not complete (O9), and a 404 from a guessed URL. **UI:** the folded line now reads "1 issue: <its sentence>". | fixed |
| O4 | The Bot's browser browses from Germany, in English. | VPS location; `--lang=en-US`. | **Automation:** `COMPUTER_BROWSER_LANG` (e.g. `el-GR`) sets the browser's language per deployment. gsis served the login normally from Germany in this run, so no Greek egress is needed. | fixed (language), egress not needed |
| O5 | The Activity panel said "Nothing yet" after browsing. | It listed commands and files only. | **UI:** browsing steps are listed too. | fixed |
| O10 | "Take a fresh browser snapshot after handback before acting" showed as an issue after an earlier takeover. | Expected safety behaviour after a handback, surfaced as an error. | **UI:** shown as a step, no longer counted as an issue. | fixed |
| O11 | The status row said "Γράφω κώδικα…" while the Bot was browsing. | A tool no rule in the director's map names fell back to the typing animation and its "Writing code…" label. | **UI:** a tool no rule names is still drawn typing, but labelled "Working…" / "Δουλεύω…", never "Writing code…". | fixed |
| G7 | No sleep state, and an open panel kept the browser awake. | The panel polled a screenshot every second, and every read touches the browser. | **UI:** after 10 minutes without activity the panel stops polling and shows "Computer is asleep" with Wake. It wakes on chat, panel interaction or Bot activity. **Automation:** the browser keeps running, so the computer keeps its state. If the 30-minute idle sweep closes it, its tabs are saved and reopened on the next launch, and logins persist in the profile. | fixed |
| O13 | With nobody answering, the Bot asked for a takeover every 10 minutes, again and again (05:18, 05:28, …) for as long as its tab stayed open. | Each help request expires after 10 minutes, and the Bot simply asks again. | **Prompt and tool result:** after a second unanswered request, the Bot stops, says what it is waiting for, and ends the turn. The person is notified once. **Backend:** the expired request's result says so in words the Bot can act on ("nobody took over; stop and tell the person"). Shipped: a lapsed request now tells the Bot not to ask again, to say what it needs and where it stopped, and to end its turn; the prompt says the same. | fixed |
| O14 | In the second run the person's own tab showed no "Σύνδεση Taxisnet" card at all. | That tab could not load the conversation's history (the conversation service answered `THREAD_NOT_FOUND` while another tab's run was in flight), so no transcript card existed to draw. | **UI:** `components/chat-cards/pending-requests.tsx` draws, under the transcript, every open sign-in, secret and takeover request of this Bot that the transcript is not already drawing, from the server's own list. A test draws it in a tab with no history. | fixed, verified live |
| O15 | At gov.gr's "Taxisnet or bank" choice the Bot handed over the whole browser instead of picking Taxisnet and asking with the form. | The prompt did not say who makes that choice. | **Prompt:** pick the provider the person named, or Taxisnet, click it, and ask with the private form once its fields show. A whole-browser handover is only for what the form cannot do. | fixed (prompt), to verify live |
| O16 | Two of the Bot's turns ended without a word. | The run's first request, taking the conversation's lock, got a 502 from the conversation service. The runtime asks once and fails the run. | **Backend:** `withPlatformRetry` in `server/src/copilot.ts` asks again through 429, 502, 503, 504 and network failures, rising from 0.25 s to 5 s over about 16 s, for the lock and for history reads. Tests cover the retries and the statuses never retried (401, 404, 500). | fixed |
| O17 | After the sign-in, Chrome offered "Save password?" in the Bot's browser, with the username showing. | The browser's own password manager was on in the Bot's profile. | **Automation:** the profile preferences turn the password manager, leak detection and autofill off, so the Bot's browser never offers to keep what the person typed. | fixed |
| O18 | A message failed with "Thread … is locked" and had to be sent again. | The previous run's lock was still being released when the next message arrived. | **Backend:** taking the lock also waits out a 409 within the same retry window as O16. | fixed |
| O19 | The preview appeared as a generated interface: raw JSON ("status: rendered"), a "Building interface" skeleton, and stray letters down its left edge. The reference posts a screenshot. The Bot asked whether to issue only when told to. | The prompt said "show the preview (a screenshot)", but no tool could put a screenshot in the chat, so the model rebuilt the page with `render_a2ui`. | **Backend + UI:** a new tool, `computer_show_screen`, keeps a picture of the Bot's screen under its tool call (the page-frame store the navigation already uses) and draws it in the chat with its caption and host, full size on click. The Bot gets back only where the picture was taken, never the image. **Prompt:** before an irreversible submit, show the screen, then ask with options, and press only after the person chooses; never rebuild the preview as a generated interface. | fixed, to verify live |
| O20 | In any tab but the one running the turn, the question card showed its title and subtitle only: no options, no own answer, nothing to answer with. A reload of the running tab does the same. | A question card waits on the run in the tab that started it. Elsewhere the call has no result and nothing executing it, which the runtime reports as "in progress" for good, and the card hid its options as if still being written. | **UI:** where this tab has no turn going, the choice and approval cards show their rows and own answer and send the answer as the person's next message, the way a Bot's `ask_person` question is answered. The history repair tells the Bot that message is the answer, and the card collapses to it. Tests cover both cards. | fixed |
| Q | Question and confirmation cards did not collapse once answered and each had its own look. | — | **UI:** `components/chat-cards/question-card.tsx` gives every question, approval and confirmation one look: lettered rows, an own answer, X, and a collapse to the chosen row with a check. | fixed |

## The third run (2026-10-14 01:01 UTC, in-run tools, build 66d190d to 0c34a87)

The run reached the "Κωδικός SMS επιβεβαίωσης" secure form, where the test stops.
- The person submitted the Taxisnet form 33 s after it opened, and the Bot carried on by itself:
  the consent page, the data review, the text and the recipient.
- It showed the preview as a picture.
- The approval question and the "SMS or Wallet" choice were answered from the person's own tab.
- An automatic server update restarted the instance mid-turn at 01:14. The person's tab
  recovered, and the run continued to the SMS form.

| # | What happened | Cause | Fix | Status |
|---|---|---|---|---|
| O21 | The Bot answered "issue a declaration" with a draft to print again. | The site-agnostic prompt rewrite dropped "rather than drafting a document". | The rule names what online services provide (declarations, certificates, forms, bookings) and says to do it there. It has a prompt test. | fixed (f9e2e9e) |
| O22 | It asked "submit?" at the text page, then pressed Issue on a later final preview without asking again. | The approval was asked at the wrong step and reused. | Ask at the step that commits it, after its last preview. An earlier yes covers nothing later. | fixed (ad3d9ca) |
| O23 | In the watching tab some replies lost their last letters ("ΔΕΔΔ", "ελέγ") until a refresh. | A history read mid-write returned a half-written message. The merge kept the local copy for a known id, so later complete reads were ignored. | The merge takes the stored copy when it continues the local one (text and tool arguments), never while this tab streams its own turn. | fixed (1d8d4c9) |
| O24 | The "SMS or Wallet" card showed only "Type your own answer" until a refresh. | Same stale merge, with the card answerable as soon as it had a title. | A waiting card needs all its options. Until they arrive it reads the server's decision record or shows "Preparing the question…". | fixed (8f797f3) |
| O25 | "Waiting for the assistant…", "Preparing the request…" and "Your Bot needs …" appeared in English in a Greek conversation. | The cards and the computer panel were outside the strings table. | The strings table covers them, and the panel follows the conversation's language. | fixed (8f797f3) |
| O26 | During the restart a tab showed "Could not load this channel." and stayed there. | One retry, then the error, even with the channel on screen. | The channel query retries no answer or 502/503/504 for about 2 minutes, showing "Reconnecting…", then offers Retry. A loaded channel stays on screen. | fixed (ed9fc18) |
| O27 | The generated draft was white on white, and its print button did nothing. | The SDK's sandbox iframe lacked `allow-modals` (print ignored). The frame got the app's dark color-scheme while the document stayed light. | The frame's options gain `allow-modals` (never `allow-same-origin`), plus a base stylesheet so text and background share one scheme, light while printing. | fixed (70295ef) |
| O28 | On the Bot's desktop a visited page opened behind the front window. | Nothing brought the live page forward when it changed. | The live page comes to the front, restored and maximized on the desktop, on every change, navigate, back and tab switch. | fixed (4bb3720) |
| O29 | The hourly automatic update restarted the instance in the middle of a turn. | The server agent switches images without checking for running turns. | **App (9b42db0):** while a run is going, and for a minute after, each process keeps `.hypernoesis/busy-<pid>` fresh in the data folder. **Platform (HyperNoesisAI 06254aa7):** the agent holds an hourly switch while a marker is younger than about two minutes, up to 45 minutes; a boot never waits. The agent also updates itself from the agent API's `/agent`, so later fixes reach running servers. The owner's server got the new agent by hand on 2026-10-14, and the marker was seen live during a turn. | fixed |

Separately, settled Bot follow-ups lost their outcome and dropped out of the listing (a jsonb
merge bound as text). That is fixed in 5688aa0, and migration 0058 repairs existing rows.

## What is still to verify with the person

1. **The full run, together, after the fixes are deployed.** The person enters the Taxisnet login
   and the SMS code in the secure form and decides whether to issue.
2. **Whether the Bot reaches the issue question unprompted** (O8, O19), shows the preview as a
   picture, and uses the private form without refusing (O2) or handing over the browser (O15).
3. **The SMS step:** the second secure form, "Κωδικός SMS", appears after the person chooses to
   issue. The run stops there; the declaration is not issued as part of the test.

## The Show me how run (2026-10-15 to 2026-10-17)

The same task with the person driving and Show me how guiding: «Θέλω να εκδώσω υπεύθυνη δήλωση στο
gov.gr», asked in Guide mode on instance `s3a8cac305e5`, with the person's clicks, typing and scrolling
sent through the live screen. The Taxisnet login uses the login saved in Noë Bot, through the Bot's
private sign-in form. The run stops at the SMS code form; nothing is issued.

The path it guided: the address bar (gov.gr), gov.gr's search or its "Υπεύθυνη Δήλωση" quick link,
the "Έκδοση υπεύθυνης δήλωσης" service page, "Scroll down" to «Είσοδος στην υπηρεσία», dilosi's
«Πρόσβαση στην υπηρεσία» and «Συνέχεια», the choice of provider («ΓΓΠΣΨΔ (Κωδικοί Taxisnet)»), and
the Taxisnet form, where it pointed at «Χρήστης» and left the password to the person.

| # | What happened | Cause | Fix | Status |
|---|---|---|---|---|
| S1 | A look said "I couldn't look at the screen just now", even on a small page. | Every control's box was measured one by one; the reads ran one after another with no time limit. | One snapshot call for every box; the controls, the picture and the text read side by side with their own time limits; a look fails only without both controls and picture; `[timing] clicky.look` lines. | fixed (e86ec0b, f9edde6) |
| S2 | A check took 12–22 s to its first word, and half the looks were broken JSON. | qwen3.7-plus thinks by default. | `reasoning_effort: "none"` on the vision call (2.1 s to the first word, measured), retried without it where refused. | fixed (5d87a64) |
| S3 | The instruction beside the address bar ran off the screen's right edge. | Its side was a fixed share of the width; the bubble was 256 px whatever the room. | The layer measures itself; the words go where they fit and narrow to the room. | fixed (dacd785) |
| S4 | The click on the address bar finished "Click the address bar and type gov.gr" before anything was typed. | A click on a step's control always finished it. | A step the model marks `typing` on a control that takes text is finished by the look after the typing. | fixed (fdcac7f, dc54b7c) |
| S5 | Three steps took the person to gov.gr, then "That's everything. Nice work." | The steps were only what the model could see from the start. | Finishing the last step looks again and shows the next steps (up to the auto-step limit). | fixed (d99ac6f) |
| S6 | "Scroll down" stayed after the person scrolled; a field typed into and left never finished. | Only clicks, Enter and Tab were watched. | The wheel and plain typing start the same watch, once they pause. | fixed (77d54b4) |
| S7 | The person clicked, typed and pressed Enter in one go; the guide then asked them to type what they had typed. | The check judged one step. | The check reports `stepsDone`, and the walkthrough moves past all of them. | fixed (dc54b7c) |
| S8 | The guide answered "done" on finding the declaration's link. | The look carrying on had only its own goal (the way there); the person's words were in the "earlier conversation". | The person's request is said on its own line; "done" is only when the thing asked for has happened. | fixed (126c0e4, fcd6b53) |
| S9 | A click on a link or button focused it and opened nothing, more than once. | The press finished the step; the bar lost Back and Next, the screen above it grew, and the release landed elsewhere. | A click counts on release; the bar's room only grows while awake, so the screen holds still. | fixed (6cbb767, e9e693b) |
| S10 | Typing Greek through an on-screen keyboard ended the live screen ("A key message needs a code."). | A key with no `code` was sent as a key message, which the computer refuses. | A character with no key behind it is sent as text. | fixed (126c0e4) |
| S11 | After «Είσοδος στην υπηρεσία» the guide made a step "Wait for page load", which nothing finishes. | The look ran while dilosi's page was still drawing itself. | The model answers `loading` instead of a waiting step; the server waits, lets the page settle and looks again (up to 3 times). | fixed (6b278587) |
| S12 | After the private Taxisnet sign-in was filled from a saved login, "Noë Bot needs you here" stayed. | Nothing closed a trigger opened by an in-run wait when the run picked up again. | A thread's wait is remembered and resolved when the thread runs again. | fixed (112f5e8b) |
| S13 | Reopened, the guide showed its pre-sign-in step ("Enter username") over the consent page. | The trigger's steps outlived the page (S12); waking never re-checked a walkthrough. | Resolved with S12; waking on a walkthrough step runs a check first. | fixed (112f5e8b) |
| S14 | "Scroll down to see more fields" boxed an unrelated link. | The step's point snapped onto the nearest control, as a click step's does. | A step the model marks `scroll` has no target: a pointer where it said, marked a guess, and no box. | fixed |
| S15 | "Type the declaration text" first boxed an empty box above the fixed wording, not the text area. | The look saw an element that the page, still drawing itself, removed a moment later. | 1.2 s after a look its first step's control is asked for again (`/elements/ref`); moved or gone, the step is looked at again and placed where it is now. | fixed |

**Where the run stands (2026-10-17 04:50 UTC, build e9e693b2).** Guided by Show me how, the person went
from Google to gov.gr (address bar), searched «υπεύθυνη δήλωση» (click, type, Enter in one go; the
check moved past all three steps), opened "Έκδοση υπεύθυνης δήλωσης" (first click lands now),
scrolled to and pressed «Είσοδος στην υπηρεσία», «Συνέχεια», and «ΓΓΠΣΨΔ (Κωδικοί Taxisnet)». At
the Taxisnet form the person minimized the screen and asked Noë Bot to sign in; its private form
was answered with the login saved in Noë Bot (Use), and the Bot reported the sign-in done without
going further. Show me how then guided the consent page («Αποστολή»), the data review, the
declarant's details (a scroll and «Συνέχεια») and the declaration text, which the person typed. The
next click, «Συνέχεια» to the preview, was stopped by the operator's own safety rule for real-world
transactions; the run continues from there with the person's go-ahead. Nothing was issued.
