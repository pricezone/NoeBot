/**
 * A Bot naming itself: the tool's name, the answer it gives, and the rule for a whole name.
 *
 * ONE DECLARATION, READ FROM BOTH SIDES, for the reason `handoff-markers.ts` gives. The server writes
 * the answer (`server/src/agents/self-profile.ts`), the model reads it, and the conversation screen
 * reads it again to draw "Named itself …" with an Undo that puts the previous name and role back.
 */

/** What the model is offered. */
export const SELF_PROFILE_TOOL = "update_my_profile";

/** The longest name a Bot may have: the profile form's own limit. */
export const SELF_PROFILE_NAME_MAX = 80;

/** The longest role a Bot may give itself: the title's limit, since the role is its title too. */
export const SELF_PROFILE_ROLE_MAX = 120;

/** What the tool answers with when the profile changed. */
export type SelfProfileChange = {
  updated: true;
  /** The Bot that renamed itself, which in a group conversation is not always the one in view. */
  bot: string;
  name: string;
  /** The one-line role, written as both the role description and the title the roster shows. */
  role: string;
  title: string;
  /** What Undo puts back. */
  previous: { name: string; role: string; title: string };
  /** The sentence for the model. */
  note: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The change a result says was made, or null for a refusal or anything unreadable.
 *
 * A server tool's answer reaches the transcript as a JSON string, sometimes encoded a second time,
 * so it is unwrapped until it is an object or plainly is not one.
 */
export function readSelfProfileChange(
  result: unknown,
): SelfProfileChange | null {
  let value = result;
  for (let depth = 0; depth < 3 && typeof value === "string"; depth++) {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!isRecord(value) || value.updated !== true) return null;
  const { bot, name, role, title, previous, note } = value;
  if (
    typeof bot !== "string" ||
    typeof name !== "string" ||
    typeof role !== "string" ||
    typeof title !== "string" ||
    !isRecord(previous) ||
    typeof previous.name !== "string" ||
    typeof previous.role !== "string" ||
    typeof previous.title !== "string"
  )
    return null;
  return {
    updated: true,
    bot,
    name,
    role,
    title,
    previous: {
      name: previous.name,
      role: previous.role,
      title: previous.title,
    },
    note: typeof note === "string" ? note : "",
  };
}

/**
 * The shortened word a name ends in, or null when it ends in a whole one.
 *
 * "Διεκπ." for "Διεκπεραιωτής" is a word cut off to fit, and a Bot's name is read in a sidebar,
 * where a cut-off word looks like a fault. So a final word that ends in an ellipsis, or in a full
 * stop with no other stop in it (an initialism like "J.A.R.V.I.S." is whole), is refused.
 */
export function shortenedWordIn(name: string): string | null {
  const last = name.trim().split(/\s+/).at(-1) ?? "";
  if (!last) return null;
  if (last.endsWith("…") || last.endsWith("...")) return last;
  if (
    last.endsWith(".") &&
    last.indexOf(".") === last.length - 1 &&
    /\p{L}/u.test(last)
  )
    return last;
  return null;
}
