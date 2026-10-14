import {
  CLICKY_PERSON_ONLY_TRIGGERS,
  type ClickyAction,
  type ClickyRisk,
  type ClickyTriggerKind,
} from "../../../shared/clicky";
import type { ClickyActionPolicy } from "../../../shared/user-preferences";
import { safetyRequirement } from "../approvals/policy";
import type { ElementAtResult, FocusResult } from "../computer/schema";

/**
 * How risky one of Clicky's actions is, decided here and never by the model.
 *
 * The model proposes "click Pay now" and may well call it harmless; what decides is what is really
 * there (probed from the page, and on a desktop from the X server, just before), the keys involved,
 * the reason the Bot needed the person, and this person's setting. Four answers (see `ClickyRisk`):
 *
 * - `blocked`: never done. Guide-only, any key that is not an ordinary editing or browsing key,
 *   typing into a password or code field, or typing a wall of text.
 * - `yours`: only the person does this. A password, a code, a payment, a security setting, a
 *   CAPTCHA, a sign-in the Bot asked them for, typing into a part of the page that cannot be read.
 *   Clicky points and they act.
 * - `confirm`: hard to undo, or not known. A submit, a send, a delete, a form's button, closing a
 *   tab, Enter in a form, a paste, anything off the page or where nothing could be read. Asked about
 *   every time, never covered by a task grant.
 * - `low`: everything else.
 *
 * It fails closed: whatever cannot be read (what has the keyboard, what is under the point, which
 * window would take the input) is `confirm` at least, never `low`. Pure, so every rule is a test.
 */

export type GuardTarget = {
  role: string;
  name: string;
  sensitive: boolean;
  /** False for a place outside the Bot's page: the toolbar, another window, the dock. */
  inPage?: boolean;
  /** A submit button, or a button inside a form. */
  submits?: boolean;
  /** A frame whose inside cannot be read. */
  opaque?: boolean;
};

export type GuardContext = {
  actionPolicy: ClickyActionPolicy;
  /** What is under the action's point, read just now. */
  target?: GuardTarget;
  /** What has the keyboard, read just now; absent when it could not be told. */
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
 * English words that commit something, whole, with the endings they take ("Sending", "Payment",
 * "Saved"), so "Address" is not "add" and "Postcode" not "post".
 */
const COMMITTING_EN = [
  "submit",
  "submission",
  "send",
  "pay",
  "buy",
  "purchase",
  "order",
  "checkout",
  "delete",
  "remove",
  "confirm",
  "sign",
  "signature",
  "publish",
  "transfer",
  "share",
  "invite",
  "add",
  "allow",
  "authorize",
  "authorise",
  "authorization",
  "grant",
  "accept",
  "approve",
  "install",
  "connect",
  "save",
  "post",
  "reply",
  "forward",
  "merge",
  "enable",
  "disable",
  "subscribe",
  "upgrade",
];

/**
 * The same in Greek, as stems: Greek has no ASCII word boundary and its words inflect, so a stem
 * anywhere in the name counts. Matched without accents ("Αποστολή", "ΑΠΟΣΤΟΛΗ", "αποστολη").
 */
const COMMITTING_EL = [
  "αποστολ",
  "αποστειλ",
  "πληρωμ",
  "πληρωσ",
  "αγορ",
  "διαγραφ",
  "διαγραψ",
  "υποβολ",
  "υποβαλ",
  "επιβεβαιω",
  "εκδοσ",
  "εκδοση",
  "κοινοποι",
  "κοινη χρηση",
  "προσκλ",
  "προσθηκ",
  "προσθεσ",
  "αποδοχ",
  "αποδεξ",
  "εγκρι",
  "εγκαταστ",
  "συνδεσ",
  "συνδεθ",
  "αποθηκευ",
  "δημοσιευ",
  "απαντ",
  "προωθ",
  "ενεργοποι",
  "εγγραφ",
  "αναβαθμ",
];

const COMMITTING = new RegExp(
  `\\b(?:${COMMITTING_EN.join("|")})(?:s|es|ed|d|ing|ion|ions|ment|ments|al)?\\b|${COMMITTING_EL.join("|")}`,
  "i",
);

/** A name without its accents and capitals, so Greek reads one way however it is written. */
function plain(name: string): string {
  return name.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

export function commits(name: string): boolean {
  return COMMITTING.test(plain(name));
}

const MODIFIER_ORDER = ["Control", "Alt", "Shift", "Meta"] as const;
type Modifier = (typeof MODIFIER_ORDER)[number];
const MODIFIER_ALIASES: Record<string, Modifier> = {
  control: "Control",
  ctrl: "Control",
  controlormeta: "Control",
  alt: "Alt",
  option: "Alt",
  altgraph: "Alt",
  shift: "Shift",
  meta: "Meta",
  super: "Meta",
  win: "Meta",
  cmd: "Meta",
  command: "Meta",
  os: "Meta",
  hyper: "Meta",
};
const KEY_ALIASES: Record<string, string> = {
  enter: "Enter",
  return: "Enter",
  numpadenter: "Enter",
  tab: "Tab",
  escape: "Escape",
  esc: "Escape",
  arrowup: "ArrowUp",
  up: "ArrowUp",
  arrowdown: "ArrowDown",
  down: "ArrowDown",
  arrowleft: "ArrowLeft",
  left: "ArrowLeft",
  arrowright: "ArrowRight",
  right: "ArrowRight",
  backspace: "Backspace",
  delete: "Delete",
  del: "Delete",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  space: "Space",
  insert: "Insert",
};

/**
 * A key or combination in one spelling: modifiers in a fixed order (`Control+Shift+t`), named keys
 * in Playwright's names, a letter in lower case with any Shift written out. What the guardrails rate
 * is exactly what is pressed, so a proposal's keys are rewritten to this before it is shown. Null
 * for anything that does not read as a key.
 */
export function canonicalKeys(keys: string): string | null {
  if (keys === " ") return "Space";
  const trimmed = keys.trim();
  if (!trimmed) return null;
  const parts =
    trimmed === "+"
      ? ["+"]
      : trimmed.endsWith("++")
        ? [...trimmed.slice(0, -2).split("+"), "+"]
        : trimmed.split("+");
  if (parts.some((part) => part.trim() === "")) return null;
  const modifiers = new Set<Modifier>();
  for (const part of parts.slice(0, -1)) {
    const modifier = MODIFIER_ALIASES[part.trim().toLowerCase()];
    if (!modifier) return null;
    modifiers.add(modifier);
  }
  const last = (parts.at(-1) as string).trim();
  const lower = last.toLowerCase();
  // A modifier on its own is not a key Clicky presses.
  if (MODIFIER_ALIASES[lower]) return null;
  let key: string;
  const alias = KEY_ALIASES[lower];
  if (alias) key = alias;
  else if (/^f\d{1,2}$/.test(lower)) key = last.toUpperCase();
  else if (/^Key[A-Z]$/.test(last)) key = (last[3] as string).toLowerCase();
  else if (/^Digit\d$/.test(last)) key = last[5] as string;
  // "Control+A" presses a with Control; only a written-out Shift makes it a capital.
  else if ([...last].length === 1)
    key = /^[A-Z]$/.test(last) ? last.toLowerCase() : last;
  else return null;
  return [
    ...MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier)),
    key,
  ].join("+");
}

/** The keys Clicky may press for a person, and nothing else: editing, moving, browsing. */
const ALLOWED_KEYS = new Set([
  "Enter",
  "Tab",
  "Shift+Tab",
  "Escape",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Backspace",
  "Delete",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Space",
  "Control+a",
  "Control+c",
  "Control+x",
  "Control+z",
  "Control+y",
  "Control+f",
  "Control+l",
  "Control+t",
  "Control+r",
  "Control+w",
  "Control+Shift+t",
  "Control+Shift+z",
]);

/** A paste puts in whatever is on the clipboard, which nobody here has read. */
const PASTE_KEYS = new Set(["Control+v", "Control+Shift+v", "Shift+Insert"]);

const SEARCH = /search|αναζητ/i;

/** `keys` in its one spelling when it is a key Clicky may press at all, else null. */
export function allowedKeys(keys: string): string | null {
  const canonical = canonicalKeys(keys);
  if (!canonical) return null;
  return ALLOWED_KEYS.has(canonical) || PASTE_KEYS.has(canonical)
    ? canonical
    : null;
}

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

  const keys = action.kind === "key" ? allowedKeys(action.keys) : null;
  if (action.kind === "key" && !keys)
    return {
      risk: "blocked",
      reason:
        "Clicky only presses everyday keys, such as Enter, Tab and the arrows. That one is yours to press.",
    };

  if (action.kind === "type" && action.text.length > CLICKY_TYPE_LIMIT)
    return {
      risk: "blocked",
      reason: `Clicky types at most ${CLICKY_TYPE_LIMIT} characters at a time.`,
    };

  // What receives the input: under the point, or what has the keyboard.
  const pointed =
    action.kind === "click" ||
    action.kind === "scroll" ||
    (action.kind === "type" && Boolean(action.at));
  const receiver = pointed ? context.target : context.focused;

  if (receiver?.sensitive && action.kind !== "scroll") {
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

  if (receiver?.opaque && (action.kind === "type" || action.kind === "key"))
    return {
      risk: "yours",
      reason:
        "That part of the page belongs to another site, and Clicky cannot see into it. That one is yours.",
    };

  if (context.trigger && CLICKY_PERSON_ONLY_TRIGGERS.includes(context.trigger))
    return {
      risk: "yours",
      reason:
        "Noë Bot handed this to you: a sign-in, a code or a check only you can do.",
    };

  if (action.kind !== "scroll") {
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
  }

  if (!receiver)
    return {
      risk: "confirm",
      reason: pointed
        ? "Clicky could not read what is there."
        : "Clicky could not tell what has the keyboard.",
    };

  if (receiver.inPage === false)
    return {
      risk: "confirm",
      reason:
        "That is outside the page, where Clicky cannot read what it does.",
    };

  if (keys) {
    if (PASTE_KEYS.has(keys))
      return {
        risk: "confirm",
        reason: "A paste puts in whatever is on the clipboard.",
      };
    if (keys === "Control+w")
      return { risk: "confirm", reason: "That closes the tab." };
    if (keys === "Control+r")
      return {
        risk: "confirm",
        reason: "That reloads the page, and anything typed on it may be lost.",
      };
    if (keys === "Enter") {
      if (receiver.role === "searchbox" || SEARCH.test(plain(receiver.name)))
        return { risk: "low" };
      return { risk: "confirm", reason: "Enter can send the form it is in." };
    }
    if (keys === "Space" && (receiver.submits || commits(receiver.name)))
      return { risk: "confirm", reason: `That presses “${receiver.name}”.` };
    return { risk: "low" };
  }

  if (action.kind === "click") {
    if (receiver.submits)
      return {
        risk: "confirm",
        reason: "That button sends the form it is in.",
      };
    if (receiver.opaque)
      return {
        risk: "confirm",
        reason: "Clicky cannot see into that part of the page.",
      };
    // Typing puts text in a field and sends nothing; a click on a committing control does.
    if (commits(receiver.name))
      return { risk: "confirm", reason: `“${receiver.name}” is hard to undo.` };
  }
  return { risk: "low" };
}

/** What the page said is under a point, as the guardrails read it. */
export function guardTargetOf(probe: ElementAtResult): GuardTarget {
  return {
    role: probe.role,
    name: probe.name,
    sensitive: probe.sensitive,
    // Another window over the page takes the input: that is off the page too.
    inPage: probe.inPage && probe.window !== "other",
    ...(probe.submits ? { submits: true } : {}),
    ...(probe.opaque ? { opaque: true } : {}),
  };
}

/** What has the keyboard, as the guardrails read it; undefined when nothing on the page has it. */
export function guardFocusOf(focus: FocusResult): GuardTarget | undefined {
  if (focus.window !== "browser")
    return { role: "desktop", name: "", sensitive: false, inPage: false };
  if (!focus.element) return undefined;
  return {
    role: focus.element.role,
    name: focus.element.name,
    sensitive: focus.element.sensitive,
    inPage: true,
    ...(focus.element.submits ? { submits: true } : {}),
    ...(focus.element.opaque ? { opaque: true } : {}),
  };
}
