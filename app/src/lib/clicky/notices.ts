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
 * Clicky's latest line as a person reads it: the fixed line in the interface's language, then the
 * model's own words (already in the person's language), or either alone.
 */
export function replyText(
  reply: ClickySession["reply"],
  t: (key: string) => string,
): string {
  if (!reply) return "";
  const fixed = reply.notice ? t(CLICKY_NOTICE_KEYS[reply.notice]) : "";
  const words = reply.text.trim();
  // A saved note's `text` is the file's path: detail, not a second sentence worth reading out.
  if (reply.notice === "notes_saved") return fixed;
  if (!fixed) return words;
  if (!words || words === fixed) return fixed;
  return `${fixed} ${words}`;
}

/** The companion's name: a product name, kept as it is in every language, like Noë Bot. */
export const CLICKY_NAME = "Clicky";
