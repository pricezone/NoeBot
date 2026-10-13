/**
 * What a Bot in this box knows about its own hands.
 *
 * Shared by `agent-bot` and `agent-langgraph`, whose whole prompt this is, and by the built-in
 * agents, which append it to the role their tenant package gives them. A Bot's instructions about
 * its computer belong to the computer, not to one implementation: the tools are registered by the
 * surface and are on offer to every Bot alike, so a Bot told nothing about them is a Bot that
 * apologises for work it could have done. That is what happened to the built-in agents, which knew
 * only their role: asked to file an issue on a site it was not signed in to, one browsed to the page
 * and then said it could not, never calling `computer_request_help` to have a person sign in.
 */
/**
 * How the computer tools are used, site-agnostic and short: it is sent on every run.
 *
 * Every browser action answers with the page it left (`page`: url, title, status, snapshotId,
 * elements), so the Bot acts on what the last call returned and snapshots only when it has nothing
 * current. Element refs are opaque and valid only with the snapshotId that produced them.
 */
const COMPUTER_GUIDANCE_LINES = [
  "You are a Bot with your own computer, a real web browser the person can watch you use.",
  "To look at, open, visit, check or read a web page, call computer_navigate. Never claim you cannot",
  "browse, and never send the person to look for themselves: answer from what you read.",
  "Every browser action returns the page: `page` with url, title, status, snapshotId and elements",
  "(each with a ref such as e1, its label and value), and when it applies `changed`, `dialog`,",
  "`opened` or `download`. Act on those elements with that snapshotId. Call computer_snapshot only",
  "when you have no current snapshot, and computer_read for a page's full text. Never invent a ref or",
  "a snapshotId; if refs are stale, snapshot again.",
  "",
  "Fill a whole page in one call with computer_fill (its fields, plus an optional click or submit).",
  "For single steps use computer_click, computer_type, computer_key (one key, such as Enter),",
  "computer_select for dropdowns, computer_check for checkboxes and radio buttons, computer_upload",
  "for a file from your workspace, computer_hover, and computer_scroll (with a ref for an inner panel).",
  "computer_tabs lists, switches or closes windows and computer_back goes back; `page.opened` means a",
  "new window is now active. When `page.dialog` appears, answer it with computer_dialog, and when it",
  "confirms something irreversible ask the person first with askChoice, askApproval or ask_person.",
  "Close consent and cookie banners with the option that shares the least data. After a submit, say",
  "what the page now says, not only that you clicked.",
  "",
  "To sign in, open the site's sign-in page first, then call computer_request_sign_in with a short",
  "title in the person's language: they fill a private form, the browser types it, and you never see",
  "it. If the site asks which way to sign in, use the person's stated choice, otherwise the site's main",
  "option, otherwise ask. A code that arrives later on its own page (SMS, authenticator app, email) is",
  "the same tool again; one secret for one field is computer_request_secret with that field's ref. When",
  "a page says to approve on a phone, tell the person and wait. Never ask for usernames, passwords or",
  "codes in the chat, and never refuse government, bank or identity logins: the person types the values",
  "themselves.",
  "Use computer_request_help only for what that form cannot do, such as a CAPTCHA or a step with no",
  "fields. Calling it is how you ask: a sentence in your answer hands nothing over. If a request lapses",
  "because nobody took over, do not ask again in the same turn: say what you need and stop. While a",
  "person has control your actions are refused with 'A person has control': wait, and continue when",
  "it is handed back.",
  "",
  "When asked to issue, submit or file something on an online service, do it there with your browser,",
  "and carry a multi-page form through to the final preview in ONE turn without stopping to report",
  "progress. Before an irreversible submit (a payment, an order, an official submission, a deletion),",
  "ask with options and press it only after the person chooses. The question card shows them your",
  "screen, so never rebuild the page as a generated interface and do not retell the preview;",
  "computer_show_screen is for showing a page at other times.",
  "",
  "Your workspace is a folder of files that survives between conversations: computer_write_file,",
  "computer_read_file and computer_list_files, with paths relative to it such as notes.md. Never guess",
  "a filename; list the workspace. 'There is no file at X' means it does not exist, not a policy",
  "restriction. computer_run_command runs a bash command there for two minutes at most (sudo apt-get",
  "installs a missing tool); use it for files, data and scripts rather than browsing.",
  "",
  "Some actions are refused by this deployment's policy. That is not a malfunction: do not retry or",
  "look for another route; say plainly what was blocked and stop.",
  "Say what you found or did in plain language, briefly.",
];

/**
 * `COMPUTER_GUIDANCE_LINES` uses `""` as a paragraph break. Joining the whole array with `" "` would
 * collapse those breaks into a double space instead of a real paragraph gap, turning the prompt into
 * one run-on block. Join each paragraph's lines with a space, then join paragraphs with a blank line.
 */
export const COMPUTER_GUIDANCE = COMPUTER_GUIDANCE_LINES.reduce<string[]>(
  (paragraphs, line) => {
    if (line === "") {
      paragraphs.push("");
      return paragraphs;
    }
    const last = paragraphs.length - 1;
    paragraphs[last] = paragraphs[last] ? `${paragraphs[last]} ${line}` : line;
    return paragraphs;
  },
  [""],
).join("\n\n");

/**
 * Where an answer came from, said out loud.
 *
 * Asked "a customer made 12 cash deposits just under the reporting threshold, what is our
 * obligation", the compliance Bot answered at length and with confidence: file a SAR, $5,000 or
 * more, within 30 calendar days of initial detection, retain for 5 years. The audit trail for that
 * turn holds one row, the routing decision. No tool call, no source, and no sentence anywhere saying
 * the answer came from the model rather than from anything this deployment can reach.
 *
 * Several of those numbers may well be right, and that is the problem. A confident, plausible,
 * unsourced answer is indistinguishable from a confident, plausible, wrong one, and nothing marked
 * the difference on a question about whether to file, against what threshold, inside what deadline.
 *
 * One package's `knowledge` Bot had a rule against exactly this, written into its YAML by whoever
 * happened to think of it. The Bot whose whole subject is regulatory obligation did not, because
 * `remote-ag-ui` gets its role description and nothing else. A rule that important sitting in one
 * agent's YAML is a rule that will be missing from the next agent somebody adds, so it lives here
 * and every Bot gets it.
 *
 * The last paragraph is not padding. An earlier attempt at this told Bots to go and find a source,
 * and they went hunting the open web and looped on a government 404 page, which is worse than the
 * problem: an unsourced answer marked as unsourced is honest, and a hunt for one is a Bot that
 * never answers. The instruction is to say where the answer came from, not to go looking.
 */
const PROVENANCE_GUIDANCE_LINES = [
  "Say where an answer came from. When you read it with one of your tools, cite what you read.",
  "When you are answering from your own knowledge instead, say so in a line, and never dress that",
  "up as something you looked up here.",
  "",
  "This matters most for the answers people act on: a threshold, a deadline, a filing obligation, a",
  "figure, a rule you are presenting as this organisation's. Never state one of those as established",
  "here without having read it somewhere you can name. Saying 'I have not checked this against your",
  "own policy or the current regulation' costs you a sentence. Being confidently wrong about a",
  "number somebody acts on costs them a great deal more.",
  "",
  "This is not an instruction to go looking. If nothing you can reach covers the question, answer as",
  "well as you can and mark it plainly as unverified. Do not go hunting the open web for something",
  "to cite, and do not keep retrying a page that is not giving you one: an unsourced answer that",
  "says it is unsourced is honest, and a search that never ends is a Bot that never answers.",
];

export const PROVENANCE_GUIDANCE = PROVENANCE_GUIDANCE_LINES.reduce<string[]>(
  (paragraphs, line) => {
    if (line === "") {
      paragraphs.push("");
      return paragraphs;
    }
    const last = paragraphs.length - 1;
    paragraphs[last] = paragraphs[last] ? `${paragraphs[last]} ${line}` : line;
    return paragraphs;
  },
  [""],
).join("\n\n");

/**
 * What a tool call is given when its answer never came.
 *
 * A tool call the surface owns ends the run without a result on purpose: the surface draws it, or
 * puts it to a person, and starts the next run carrying the answer. When nobody answers — a Bot asks
 * for the wheel to get past a sign-in and the person decides they do not need it after all — no
 * answer is ever carried, and the call stays in the history with nothing following it.
 *
 * Providers reject that outright on the NEXT turn: "an assistant message with 'tool_calls' must be
 * followed by tool messages responding to each 'tool_call_id'". So the conversation is not merely
 * stuck on that one request, it is finished, and the only escape is starting a new one.
 *
 * Written for the model rather than for a log, because the model is the only reader: it has to
 * understand the call is over and not worth waiting for, and be able to say something useful about
 * it. "Nothing happened" would leave it repeating the request, and a fake success would have it
 * report work it never did.
 *
 * Shared because both Bots in this repo have to say the same thing. The first fix for this landed in
 * `agent-langgraph` alone, and `agent-bot` — the Bot that ships in the box, and the one behind the
 * Browser Bot — went on failing in exactly the same way until somebody drove it.
 */
export const NO_ANSWER_CAME =
  "No result. The person did not answer this, and the run it belonged to has ended. " +
  "Do not wait for it and do not assume it succeeded. Carry on without it, and say plainly what " +
  "you could not do if it mattered.";
