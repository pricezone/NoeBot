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

/** First match wins; the person-facing tools come first so a prompt is never read as a search. */
const RULES: readonly Rule[] = [
  {
    test: /ask_person|request_secret|request_help|request_sign_in|askapproval|askchoice|approval/i,
    verdict: "waiting",
  },
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
    test: /sandboxed_?ui|generate_?ui|slide|present|landing|page_?build|design|figma|canvas|chart|show_?(bar|line|pie)/i,
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
    test: /navigate|browse|snapshot|screenshot|search|web|google|fetch|crawl|scrape|lookup|find|computer_(click|type|key|scroll|read|show_screen)\b/i,
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
  const rule = RULES.find((r) => r.test.test(name));
  return rule ? rule.verdict : "action:type";
};

/**
 * Whether a rule names this tool. An unknown tool is drawn typing, but its label must not claim
 * "Writing code…" for a step that is nothing of the kind (a connector's tool, a server tool): it says
 * "Working…" instead.
 */
export const toolIsKnown = (name: string): boolean =>
  RULES.some((r) => r.test.test(name));
