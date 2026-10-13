# The gov.gr declaration run: Noë Bot against Grok Bot

On 2026-10-13 we ran the workflow from five Grok Bot screenshots with a real Noë Bot. The workflow
issues a "υπεύθυνη δήλωση" to ΔΕΔΔΗΕ on gov.gr. The run used instance `s3a8cac305e5` on Contabo
and the Noë Bot "Noë". It sent the same request text. The person types the Taxisnet login and the
SMS code into the secure form themselves, and the Bot never sees them.

This page records every difference we found. Each entry has its cause and its fix, split into UI,
backend, browser automation and security. Earlier test conversations ran on 2026-10-12 and appear
in the person's screenshots 7–8; they are included too.

## The workflow, step by step

| # | Grok Bot | Noë Bot (before the fixes) |
|---|---|---|
| 1 | Opens the declaration service, reaches the Taxisnet login, and posts "Σύνδεση Taxisnet · Secure Form · Open". | Drafted a printable declaration instead (O8). Asked again to issue it, it walked gov.gr: two wrong URL guesses (404), one click refused (O7), a cookie banner, and the "Είσοδος με ΓΓΠΣΨΔ" choice. It then asked for the private sign-in on `oauth2.gsis.gr` with a shimmer line and an "Open private sign-in" button. That button only existed in the tab running the turn (O12). |
| 2 | A modal with the favicon, "Χρήστης*", "Κωδικός*" with an eye toggle, "Never shown to your Bot. Filled directly to oauth2.gsis.gr", and Continue. | A dialog titled with the raw URL. It had fixed English fields, no eye toggle, and "Save to Passwords". The error was printed twice (O1). |
| 3 | "Submitted". A preview screenshot, then the question "Να την εκδώσω;" with A/B rows and "Type your own answer". | Not reached in the live run. The person did not complete the sign-in before the 15-minute request expired. The code review says the question card had no collapsed answered state. |
| 4 | The answered question collapses to the chosen row with a check, then a second secure form, "Κωδικός SMS", with the gov.gr icon. | By code review: a code-only page was refused by the sign-in (it needed a password, G2). The one-value secret tool had no card in the conversation. |
| 5 | A single "Κωδικός Επιβεβαίωσης*" field, "Filled directly to dilosi.services.gov.gr", and Continue disabled until filled. | As 4. |
| — | The computer panel shows "Computer is asleep" with Wake. | No sleep state. An open panel kept the browser awake for good (G7). |

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
| G5 | No favicon, no eye toggle, no host named, and a shimmer line instead of a card. | — | **UI:** `components/chat-cards/secure-form.tsx` is the Grok row and dialog. **Automation:** the icon is read by the Bot's own browser (32 KB cap, images only) and handed over as a data URL. **Security:** the server never fetches arbitrary URLs. | fixed |
| G6 | A login inside a frame was never found. | Only the main frame was scanned. | **Automation:** every frame is scanned and filled in place. A browser test uses a frame from another origin. | fixed |
| O12 | "Waiting for you to sign in" showed no Open button in the person's own tab. | The request id was known only to the tab running the tool call. | **UI:** a card without the id finds its request among the owner's open requests by the tool call's id. A test draws the card in a tab that never ran the call. | fixed |
| O2 | In another chat the Bot refused: Taxisnet codes are personal and it "cannot and should not handle them". It then listed manual steps. | The model generalised "never ask for credentials" into refusing the login itself. | **Prompt and tool description:** government, tax and bank logins go through the private form like any other. The Bot never sees the values, so it must not refuse or answer with manual steps. | fixed (prompt), to verify live |
| O8 | Asked to "issue" a declaration, the Bot drafted a printable document. | No guidance to complete an online service with the browser. | **Prompt:** issue, submit or file on the service with the browser, not a draft. Show the preview and ask before the irreversible submit. | fixed (prompt), to verify live |
| O9 | A turn died silently ("Opened page · Not completed") when the tab that sent the message closed. | Chat turns run their computer tools in the tab that started them, as frontend tools. Grok's work continues in the cloud when the app closes. | **Backend:** when the starting tab goes away mid-turn, hand the turn to the headless tools that unattended turns already use (`server/src/computer/headless-tools.ts`). The plan: the run keeps a server-side lease and the tab heartbeats it. On a missed heartbeat the server resumes from the last saved tool call with the headless tool set. | open |
| O7 | Clicking "Είσοδος στην υπηρεσία" was refused with "That unanswered tool call is not saved in this conversation" (twice in two runs). | Every write action is checked against the saved conversation (`approvals/saved-call.ts`: 11 reads, 0.5 s apart). The conversation service saved the call later than that, and logs show it returning 404/502 that hour. | **Backend:** the check now backs off over about 24 s (16 reads, 0.5 s growing to 2 s) instead of 5.5 s. A call that never appears is still refused, which is the anti-forgery property. **Next:** report the conversation service's save latency, so a slow hour is visible. | fixed (wait); latency report open |
| O3 | "Browsed 1 page · 1 issue" hid what went wrong. | The issue line is collapsed. | Recorded by the run: the issues were O7, a navigation that did not complete (O9), and a 404 from a guessed URL. **UI:** the folded line now reads "1 issue: <its sentence>". | fixed |
| O4 | The Bot's browser browses from Germany, in English. | VPS location; `--lang=en-US`. | **Automation:** `COMPUTER_BROWSER_LANG` (e.g. `el-GR`) sets the browser's language per deployment. gsis served the login normally from Germany in this run, so no Greek egress is needed. | fixed (language), egress not needed |
| O5 | The Activity panel said "Nothing yet" after browsing. | It listed commands and files only. | **UI:** browsing steps are listed too. | fixed |
| O10 | "Take a fresh browser snapshot after handback before acting" showed as an issue after an earlier takeover. | Expected safety behaviour after a handback, surfaced as an error. | **UI:** shown as a step, no longer counted as an issue. | fixed |
| O11 | The status row said "Γράφω κώδικα…" while the Bot was browsing. | A tool no rule in the director's map names fell back to the typing animation and its "Writing code…" label. | **UI:** a tool no rule names is still drawn typing, but labelled "Working…" / "Δουλεύω…", never "Writing code…". | fixed |
| G7 | No sleep state, and an open panel kept the browser awake. | The panel polled a screenshot every second, and every read touches the browser. | **UI:** after 10 minutes without activity the panel stops polling and shows "Computer is asleep" with Wake. It wakes on chat, panel interaction or Bot activity. **Automation:** the browser keeps running, as Grok's computer keeps its state. If the 30-minute idle sweep closes it, its tabs are saved and reopened on the next launch, and logins persist in the profile. | fixed |
| O13 | With nobody answering, the Bot asked for a takeover every 10 minutes, again and again (05:18, 05:28, …) for as long as its tab stayed open. | Each help request expires after 10 minutes, and the Bot simply asks again. | **Prompt and tool result:** after a second unanswered request, the Bot stops, says what it is waiting for, and ends the turn. The person is notified once. **Backend:** the expired request's result says so in words the Bot can act on ("nobody took over; stop and tell the person"). | open |
| Q | Question and confirmation cards did not collapse once answered and each had its own look. | — | **UI:** `components/chat-cards/question-card.tsx` gives every question, approval and confirmation the Grok rows, own answer, X, and a collapse to the chosen row with a check. | fixed |

## What is still to verify with the person

1. **The full run, together, after the fixes are deployed.** The person enters the Taxisnet login
   and the SMS code in the secure form and decides whether to issue.
2. **Whether the Bot reaches the issue question unprompted** (O8) and uses the private form
   without refusing (O2).
