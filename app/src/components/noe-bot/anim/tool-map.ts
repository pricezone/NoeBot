/**
 * What the Bot is doing → which animation shows it (avatar-map.json §toolMap).
 *
 * The tool actually running is the most truthful signal, so this is asked before any guess from
 * the person's words. Names are the app's own frontend and host tools, the Drive and skill tools,
 * and whatever an MCP plugin calls its tools (`mcp__server__tool`), matched by what the name says.
 */

import type { AnimationId } from "./catalog";

export type ToolVerdict = AnimationId | "waiting";

type Rule = { test: RegExp; verdict: ToolVerdict };

/** The person-facing tools: the Bot waits on the person while they run. */
const WAITING =
  /ask_person|request_secret|request_help|request_sign_in|askapproval|askchoice|askform|approval/i;

/** A question put to the person (not a sign-in or a takeover): its card shows them the screen. */
export const isAskTool = (name: string): boolean =>
  /ask_?person|askapproval|askchoice|askform/i.test(name);

/**
 * A step on the Bot's browser, as the director draws it: by what it does to the page, not by its
 * name, so opening, reading, typing into it, filling a whole form and showing it each look different.
 */
export type BrowserLook = {
  animation: AnimationId;
  /** The label key (catalog `LABELS`) that names the step. */
  label: string;
  /** It writes into the page, so it counts towards a form-filling streak. */
  writes?: true;
  /** Repeats of it alternate between its loop and that loop's partner, for variety. */
  varies?: true;
  /** A sign-in, a code or a takeover: the person handed the browser back when it answers. */
  handback?: true;
};

const BROWSER_STEPS: readonly { test: RegExp; look: BrowserLook }[] = [
  {
    test: /^computer_request_(sign_in|secret|help)$/,
    look: {
      animation: "state:powered-up",
      label: "step:continue",
      handback: true,
    },
  },
  {
    test: /^computer_navigate$/,
    look: { animation: "action:search", label: "step:open-page", varies: true },
  },
  {
    test: /^computer_tabs$/,
    look: { animation: "action:search", label: "step:tabs" },
  },
  {
    test: /^computer_back$/,
    look: { animation: "action:search", label: "step:back" },
  },
  {
    test: /^computer_(snapshot|read)$/,
    look: { animation: "face:nerd", label: "step:read-page", varies: true },
  },
  {
    test: /^computer_fill$/,
    look: { animation: "action:turbo", label: "action:turbo", writes: true },
  },
  {
    test: /^computer_(type|key|click|select|check)$/,
    look: { animation: "action:type", label: "step:fill", writes: true },
  },
  {
    test: /^computer_(hover|scroll)$/,
    look: { animation: "action:type", label: "step:fill" },
  },
  {
    test: /^computer_upload$/,
    look: { animation: "action:writing", label: "step:upload", writes: true },
  },
  {
    test: /^computer_show_screen$/,
    look: { animation: "action:present", label: "step:show-screen" },
  },
  {
    test: /^computer_dialog$/,
    look: { animation: "face:curious", label: "step:dialog" },
  },
];

/** How a browser tool is drawn and named, or null for a tool that is not a browser step. */
export const browserLookFor = (name: string): BrowserLook | null =>
  BROWSER_STEPS.find((s) => s.test.test(name))?.look ?? null;

/** Workspace tools share the `computer_` prefix but are not the browser. */
const WORKSPACE = /^computer_(run_command|read_file|write_file|list_files)$/;

/** A call the transcript should hand the director as a browser step. */
export const isBrowserTool = (name: string): boolean =>
  name.startsWith("computer_") && !WORKSPACE.test(name);

/** First match wins; the person-facing tools are asked first so a prompt is never read as a search. */
const RULES: readonly Rule[] = [
  {
    test: /message_bot|handoff|subagent|sub_agent|delegate/i,
    verdict: "state:sub-agents",
  },
  {
    test: /deploy|infra|database|postgres|sql|migrate|server|kubernetes|docker|dns|api_key|provision/i,
    verdict: "state:servers",
  },
  {
    test: /debug|diagnos|investigat|inspect|stack_?trace|incident/i,
    verdict: "action:search",
  },
  {
    test: /fix|repair|patch|maintenance|heal|restart/i,
    verdict: "state:repair",
  },
  {
    test: /run_command|shell|terminal|exec|bash|npm|pnpm|bun_|pytest|run_tests?/i,
    verdict: "action:terminal",
  },
  {
    test: /transcri|audio|music|speech|(^|_)voice|podcast|sound/i,
    verdict: "action:music",
  },
  {
    test: /image|photo|picture|draw|generate_?(video|art)|midjourney|dall|creative|design_?(gen|image)/i,
    verdict: "action:sparkler",
  },
  {
    test: /pay|invoice|price|pricing|stripe|billing|budget|finance|expense|cash|bank/i,
    verdict: "action:cash",
  },
  { test: /translat|localis|localiz|i18n/i, verdict: "action:greeting" },
  {
    test: /sandboxed_?ui|generate_?ui|a2ui|slide|present|landing|page_?build|design|figma|canvas|chart|show_?(bar|line|pie)/i,
    verdict: "action:present",
  },
  {
    test: /log|audit|checklist|metric|analytic|report|stats|dashboard|csv|spreadsheet|sheet/i,
    verdict: "action:logs",
  },
  {
    test: /write_file|save_|create_(doc|note|page|issue|ticket|draft)|send_(mail|email|message)|gmail|email|notion|docs?_|notes?_|compose|draft|update_(doc|page|issue)/i,
    verdict: "action:writing",
  },
  {
    test: /navigate|browse|snapshot|screenshot|search|web|google|fetch|crawl|scrape|lookup|find/i,
    verdict: "action:search",
  },
  {
    test: /read_file|read_|load_skill|list_files|list_|get_|retriev|rag|document|pdf|open_/i,
    verdict: "action:study",
  },
  {
    test: /code|edit|refactor|implement|typescript|python|function|commit|git|pull_request|pr_/i,
    verdict: "action:type",
  },
];

/** The animation for a tool in flight; unknown tools are read as generating something. */
export const animationForTool = (name: string): ToolVerdict => {
  if (WAITING.test(name)) return "waiting";
  const look = browserLookFor(name);
  if (look) return look.animation;
  const rule = RULES.find((r) => r.test.test(name));
  return rule ? rule.verdict : "action:type";
};

/**
 * Whether a rule names this tool. An unknown tool is drawn typing, but its label must not claim
 * "Writing code…" for a step that is nothing of the kind (a connector's tool, a server tool): it says
 * "Working…" instead.
 */
export const toolIsKnown = (name: string): boolean =>
  WAITING.test(name) ||
  browserLookFor(name) !== null ||
  RULES.some((r) => r.test.test(name));
