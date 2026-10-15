import { msg } from "@/lib/i18n";
import type {
  ClickyNotice,
  ClickySession,
  ClickyState,
} from "../../../../shared/clicky";

/**
 * Clicky's own fixed lines and state names, as translation keys.
 *
 * The server sends a notice by name and each client says it in its own language
 * (`shared/clicky.ts`, `CLICKY_NOTICE_TEXT`). That table lives outside `app/src`, where the i18n
 * scanner does not look, so the same English is spelled here again inside `msg()`: that is what puts
 * each line in the Greek catalog's manifest. `clicky-session.test.tsx` holds the two tables to each
 * other, so a line changed on one side and not the other fails there rather than showing English.
 */
export const CLICKY_NOTICE_KEYS: Record<ClickyNotice, string> = {
  awake: msg("Hi! Ask me anything about the screen."),
  takeover: msg("Noë Bot needs you here."),
  yours: msg("This one's yours. I'll show you where."),
  blocked: msg("I can't do that one, but I'll show you where it is."),
  denied: msg(
    "Okay, I won't. It's right here if you'd like to do it yourself.",
  ),
  stopped: msg("Stopped. Nothing else will happen until you say so."),
  paused: msg("Paused."),
  expired: msg("That request timed out. Ask again when you're ready."),
  nudge: msg("Stuck? Ask me anything, or tap Show me again."),
  walkthrough_done: msg("That's everything. Nice work."),
  takeover_resolved: msg("Thanks! Noë Bot is carrying on."),
  action_done: msg("Done."),
  action_failed: msg("That didn't work. Try again, or do it yourself."),
  think_failed: msg("I couldn't look at the screen just now. Try again."),
  guide_only: msg("I'm set to guide only. You can change that in Settings."),
  busy: msg("One moment, I'm still working on the last thing."),
  nothing_to_retry: msg("There's nothing to try again yet."),
  no_step: msg("There's no step to move to."),
  follow_up: msg("Noë Bot finished."),
  notes_saved: msg("Notes saved."),
  watching: msg("I'll show you what Noë Bot is doing."),
  narrate_click: msg("Noë Bot is clicking “{{label}}”."),
  narrate_type: msg("Noë Bot is typing in “{{label}}”."),
  narrate_navigate: msg("Noë Bot is opening {{host}}."),
  narrate_scroll: msg("Noë Bot is scrolling the page."),
  narrate_select: msg("Noë Bot is choosing in “{{label}}”."),
  narrate_key: msg("Noë Bot is pressing {{key}}."),
  narrate_working: msg("Noë Bot is working on the page."),
};

/** What the state chip says. `asleep` is a session that is not awake, whatever its state. */
export type ClickyChipState = ClickyState | "asleep";

export const CLICKY_STATE_LABEL: Record<ClickyChipState, string> = {
  asleep: msg("Asleep"),
  idle: msg("Ready"),
  listening: msg("Listening"),
  thinking: msg("Thinking"),
  guiding: msg("Showing you"),
  awaiting_permission: msg("Needs your OK"),
  acting: msg("Doing it"),
  paused: msg("Paused"),
  stopped: msg("Stopped"),
};

export function chipStateOf(
  session: Pick<ClickySession, "awake" | "state"> | null | undefined,
): ClickyChipState {
  if (!session) return "asleep";
  // Stopped stays on screen until the person resumes: that is the point of saying it.
  if (!session.awake && session.state !== "stopped") return "asleep";
  return session.state;
}

/**
 * Clicky's latest line as a person reads it: the fixed line in the interface's language, with the
 * words it names put in (`reply.params`: what the Bot clicked, the site it opened), then the model's
 * own words (already in the person's language), or either alone.
 */
export function replyText(
  reply: ClickySession["reply"],
  t: (key: string, params?: Record<string, string>) => string,
): string {
  if (!reply) return "";
  const fixed = reply.notice
    ? t(CLICKY_NOTICE_KEYS[reply.notice], reply.params ?? {})
    : "";
  const words = reply.text.trim();
  // A saved note's `text` is the file's path: detail, not a second sentence worth reading out.
  if (reply.notice === "notes_saved") return fixed;
  if (!fixed) return words;
  if (!words || words === fixed) return fixed;
  return `${fixed} ${words}`;
}

/**
 * Clicky's own lines that stay in view beside a step's instruction, rather than behind it: something
 * went wrong, the action is the person's, or Clicky stopped.
 */
export const CLICKY_NOTICES_BESIDE_STEP: readonly ClickyNotice[] = [
  "yours",
  "blocked",
  "denied",
  "expired",
  "action_failed",
  "think_failed",
  "nudge",
  "guide_only",
  "busy",
  "stopped",
  "paused",
];

/**
 * What the instruction beside Clicky's pointer says, and what "Say that again" says aloud.
 *
 * - Narrating the Bot: what the Bot is doing ("Noë Bot is clicking “Search”.").
 * - A walkthrough under way: the current step's title, with its detail when the person asked for
 *   detailed guidance, and under it any of Clicky's lines that must not hide behind the step. The
 *   model's own words are left out: they were said when the plan was made, and after Next or a click
 *   they would describe a step that is over.
 * - Words still arriving: those, since they answer what the person just asked.
 * - Otherwise: the reply.
 */
export function instructionText(
  input: {
    narrating: boolean;
    step: { title: string; detail?: string } | null;
    reply: ClickySession["reply"];
    detailed: boolean;
  },
  t: (key: string, params?: Record<string, string>) => string,
): string {
  const said = replyText(input.reply, t);
  if (input.narrating || !input.step) return said;
  if (input.reply && !input.reply.final) return said;
  const step =
    input.detailed && input.step.detail
      ? `${input.step.title}\n${input.step.detail}`
      : input.step.title;
  const notice = input.reply?.notice;
  return notice && CLICKY_NOTICES_BESIDE_STEP.includes(notice) && said
    ? `${step}\n${said}`
    : step;
}

/**
 * The companion's name as people know it, "Show me how" («Δείξε μου πώς»), drawn with `t()`. The
 * code calls it Clicky; nothing a person reads does. In its own sentences the guide speaks in the
 * first person ("Stopped.", "I'll show you where.") rather than naming itself.
 */
export const CLICKY_NAME = msg("Show me how");
