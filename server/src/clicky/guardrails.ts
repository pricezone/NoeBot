import {
  CLICKY_PERSON_ONLY_TRIGGERS,
  type ClickyAction,
  type ClickyRisk,
  type ClickyTriggerKind,
} from "../../../shared/clicky";
import type { ClickyActionPolicy } from "../../../shared/user-preferences";
import { safetyRequirement } from "../approvals/policy";

/**
 * How risky one of Clicky's actions is, decided here and never by the model.
 *
 * The model proposes "click Pay now" and may well call it harmless; what decides is what is really
 * at that point on the page (probed from the page itself just before), the keys involved, the reason
 * the Bot needed the person, and this person's setting. Four answers (see `ClickyRisk`):
 *
 * - `blocked`: never done. Guide-only, a lock or log-out shortcut, typing into a password or code
 *   field, or typing a wall of text.
 * - `yours`: only the person does this. A password, a code, a payment, a security setting, a
 *   CAPTCHA, a sign-in the Bot asked them for. Clicky points and they act.
 * - `confirm`: hard to undo. A submit, a send, a delete, closing a window, Enter in a form, a click
 *   off the page where nothing can be read. Asked about every time, never covered by a task grant.
 * - `low`: everything else.
 *
 * Pure, so every rule is a test.
 */

export type GuardTarget = {
  role: string;
  name: string;
  sensitive: boolean;
  /** False for a point on the desktop outside the page, where nothing can be read. */
  inPage?: boolean;
};

export type GuardContext = {
  actionPolicy: ClickyActionPolicy;
  /** What is under the action's point, read from the page just now. */
  target?: GuardTarget;
  /** The element with the keyboard, for a key press or for typing with no point. */
  focused?: GuardTarget;
  /** Why Clicky is showing: a sign-in, a secret or a challenge the Bot handed over is the person's. */
  trigger?: ClickyTriggerKind | null;
  botId: string;
  actorId: string;
  /** The page's host, which the safety requirements read with the rest of the action. */
  pageHost?: string;
};

export type Assessment = { risk: ClickyRisk; reason?: string };

/** The most text Clicky types in one action. A longer one is not a step, it is a document. */
export const CLICKY_TYPE_LIMIT = 500;

export const RISK_RANK: Record<ClickyRisk, number> = {
  low: 0,
  confirm: 1,
  yours: 2,
  blocked: 3,
};

/**
 * Names that commit something, in English and Greek. Accents are stripped before matching, so
 * "Αποστολή", "ΑΠΟΣΤΟΛΗ" and "αποστολή" are one word. A prefix at a word's start, so "Payment" and
 * "Sending" count; Greek has no ASCII word boundary, so its stems are matched anywhere.
 */
const COMMITTING =
  /\b(submit|send|pay|buy|purchase|order|delete|remove|confirm|sign|publish|transfer)|αποστολ|πληρωμ|αγορ|διαγραφ|υποβολ|επιβεβαιω|εκδοσ|εκδοση/i;

/** A name without its accents and capitals, so Greek reads one way however it is written. */
function plain(name: string): string {
  return name.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

export function commits(name: string): boolean {
  return COMMITTING.test(plain(name));
}

/** Keys and combinations as a set of lower-case names, with the aliases folded together. */
function comboOf(keys: string): { modifiers: Set<string>; key: string } {
  const trimmed = keys.trim();
  const parts = trimmed.endsWith("++")
    ? [...trimmed.slice(0, -2).split("+"), "+"]
    : trimmed === "+"
      ? ["+"]
      : trimmed.split("+");
  const alias: Record<string, string> = {
    control: "ctrl",
    controlormeta: "ctrl",
    ctl: "ctrl",
    meta: "meta",
    super: "meta",
    win: "meta",
    windows: "meta",
    os: "meta",
    cmd: "meta",
    command: "meta",
    option: "alt",
    altgraph: "alt",
    del: "delete",
    return: "enter",
    numpadenter: "enter",
    kp_enter: "enter",
    esc: "escape",
  };
  const names = parts.map((part) => {
    const lower = part.trim().toLowerCase();
    return alias[lower] ?? lower;
  });
  const key = names.at(-1) ?? "";
  const modifiers = new Set(names.slice(0, -1));
  // A modifier pressed on its own, or named last, still counts as held.
  if (["ctrl", "alt", "shift", "meta"].includes(key)) modifiers.add(key);
  return { modifiers, key };
}

/** Keys that end the session, lock the screen or turn the machine off. */
const POWER_KEYS = new Set([
  "power",
  "poweroff",
  "xf86poweroff",
  "powerdown",
  "sleep",
  "xf86sleep",
  "suspend",
  "xf86suspend",
  "hibernate",
  "xf86hibernate",
  "standby",
  "xf86standby",
  "logoff",
  "logout",
  "xf86logoff",
  "shutdown",
  "wakeup",
  "xf86wakeup",
  "xf86screensaver",
  "screensaver",
]);

function keyRisk(keys: string): Assessment | null {
  const { modifiers, key } = comboOf(keys);
  const ctrl = modifiers.has("ctrl");
  const alt = modifiers.has("alt");
  const shift = modifiers.has("shift");
  const meta = modifiers.has("meta");
  if (POWER_KEYS.has(key))
    return {
      risk: "blocked",
      reason: "That key turns the computer off, locks it or signs out.",
    };
  if (ctrl && alt && (key === "delete" || key === "backspace"))
    return {
      risk: "blocked",
      reason: "That shortcut restarts or signs out of the computer.",
    };
  if ((meta && key === "l") || (ctrl && alt && key === "l"))
    return { risk: "blocked", reason: "That shortcut locks the screen." };
  if (
    (alt && key === "f4") ||
    (ctrl && !alt && !meta && key === "q") ||
    (ctrl && !alt && !meta && key === "w")
  )
    return {
      risk: "confirm",
      reason: shift
        ? "That shortcut closes the browser window."
        : "That shortcut closes a window or tab.",
    };
  return null;
}

const SEARCH = /search|αναζητ/i;

/**
 * Rate one action. The order is the severity: the first rule that applies decides, and a later,
 * milder one never softens it.
 */
export function assessAction(
  action: ClickyAction,
  context: GuardContext,
): Assessment {
  if (context.actionPolicy === "never")
    return {
      risk: "blocked",
      reason: "Clicky is set to guide only, so it never clicks or types.",
    };
  if (action.kind === "scroll") return { risk: "low" };

  if (action.kind === "type" && action.text.length > CLICKY_TYPE_LIMIT)
    return {
      risk: "blocked",
      reason: `Clicky types at most ${CLICKY_TYPE_LIMIT} characters at a time.`,
    };

  if (action.kind === "key") {
    const keyed = keyRisk(action.keys);
    if (keyed?.risk === "blocked") return keyed;
  }

  // The element that receives the input: under the point, or with the keyboard.
  const receiver =
    action.kind === "click" || (action.kind === "type" && action.at)
      ? context.target
      : context.focused;

  if (receiver?.sensitive) {
    if (action.kind === "type" || action.kind === "key")
      return {
        risk: "blocked",
        reason:
          "Clicky never types into a password, code or card field. That one is yours.",
      };
    return {
      risk: "yours",
      reason: "That field holds a password, a code or a card number.",
    };
  }

  if (context.trigger && CLICKY_PERSON_ONLY_TRIGGERS.includes(context.trigger))
    return {
      risk: "yours",
      reason:
        "Noë Bot handed this to you: a sign-in, a code or a check only you can do.",
    };

  const safety = safetyRequirement({
    actorId: context.actorId,
    botId: context.botId,
    toolRef: `computer_${action.kind}`,
    effect: "write",
    scope: context.pageHost || "browser",
    args: {
      label: action.label,
      ...(action.kind === "type" ? { text: action.text } : {}),
      ...(action.kind === "key" ? { key: action.keys } : {}),
    },
    target: receiver ? { role: receiver.role, name: receiver.name } : {},
  });
  if (safety) return { risk: "yours", reason: safety.reason };

  if (action.kind === "key") {
    const keyed = keyRisk(action.keys);
    if (keyed) return keyed;
    const { key } = comboOf(action.keys);
    if (key === "enter") {
      if (
        receiver &&
        (receiver.role === "searchbox" || SEARCH.test(plain(receiver.name)))
      )
        return { risk: "low" };
      return { risk: "confirm", reason: "Enter can send the form it is in." };
    }
    if ((key === "space" || key === " ") && receiver && commits(receiver.name))
      return { risk: "confirm", reason: `That presses “${receiver.name}”.` };
    return { risk: "low" };
  }

  if (receiver && receiver.inPage === false)
    return {
      risk: "confirm",
      reason:
        "That is outside the page, where Clicky cannot read what it does.",
    };

  // Typing puts text in a field and sends nothing; a click on a committing control does.
  if (action.kind === "click" && receiver && commits(receiver.name))
    return { risk: "confirm", reason: `“${receiver.name}” is hard to undo.` };
  if (action.kind === "click" && !receiver)
    return {
      risk: "confirm",
      reason: "Clicky could not read what is there.",
    };
  return { risk: "low" };
}
