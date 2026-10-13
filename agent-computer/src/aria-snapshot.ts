/**
 * Turning Playwright's aria snapshot into the flat element list the tool contract publishes.
 *
 * Playwright's `mode: "ai"` output is YAML: each entry is a mapping whose key describes the element
 * and whose value is that control's contents. A YAML parser preserves quoted values, colons, escaped
 * quotes, multi-line values and deeper indentation.
 *
 * Parsed under the failsafe schema, which resolves every scalar as a string. What a control contains
 * is text, and nothing here wants it typed.
 *
 * What remains to parse by hand is one descriptor per element,
 * `textbox "Customer name:" [ref=e5] [checked]`, and that is scanned rather than matched, because the
 * parts can contain one another: an accessible name can hold a bracket and a flag can hold a quote.
 *
 * This module has no Playwright import, so parser tests do not need a browser.
 */

import { parse as parseYaml } from "yaml";

/**
 * How many elements a snapshot will describe. Bounded for the same reason the text extract is.
 *
 * 400 rather than 200, with the controls first (see `PRIORITY`): a long government form or a
 * results page ran past 200 entries, and the cut fell on the fields the Bot had come to fill in.
 */
const SNAPSHOT_ELEMENT_LIMIT = 400;

/**
 * How many candidates the walk collects before it stops looking.
 *
 * Above the limit so the priority sort has something to choose between, and bounded so a page with
 * a hundred thousand nodes does not cost a hundred thousand objects.
 */
const CANDIDATE_LIMIT = 4_000;

/** Options listed for one drop-down, so `computer_select` can be given one of them. */
const OPTION_LIMIT = 30;

/**
 * The roles worth handing to a Bot that wants to act.
 *
 * Role allow-list, not a CSS selector list. `mode: "ai"` returns the whole accessible tree, which on
 * a real page is mostly headings, paragraphs and generic containers. What a Bot needs in order to fill
 * in a form is the controls, and naming them by ARIA role is both shorter and more correct than
 * guessing at tag names: a `div[role=button]` is a button here, and Playwright has already worked out
 * which is which.
 */
const INTERACTIVE_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "link",
  "listbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
]);

/** The roles whose unchecked state is meaningful, so absence of `[checked]` means false, not unknown. */
const CHECKABLE_ROLES = new Set([
  "checkbox",
  "menuitemcheckbox",
  "menuitemradio",
  "radio",
  "switch",
]);

/**
 * One thing on the page a Bot can act on.
 *
 * Mirrors `SnapshotElement` in the server's published contract (`server/src/computer/schema.ts`), the
 * same way the workspace entry type does. Duplicated rather than shared because this process is a
 * separate deployable with no code in common with the server; the two must be changed together, and a
 * field added here and not there is invisible until a Bot asks for it.
 */
export type SnapshotElement = {
  ref: string;
  /**
   * The ARIA role, or `clickable` for a plain element the page made clickable (a card with
   * `cursor: pointer`, a `div` with an onclick handler or a tab stop), which Playwright reports as
   * `generic` and the Bot could not reach at all before.
   */
  role: string;
  name: string;
  /** Present for form controls, so the Bot can tell an empty field from a filled one. */
  value?: string;
  disabled?: boolean;
  checked?: boolean;
  /** A drop-down's choices, by label, so `computer_select` can be given one without guessing. */
  options?: string[];
};

/** The descriptor half of an entry: everything before the colon. */
type Descriptor = {
  role: string;
  name: string;
  flags: Map<string, string>;
};

/**
 * Read `textbox "Customer name:" [ref=e5] [checked]`.
 *
 * Scanned left to right rather than matched with a pattern, because the parts can contain each other:
 * an accessible name can contain a bracket, and a flag value can contain a quote. A single expression
 * that handles every page is not maintainable.
 */
export function parseDescriptor(text: string): Descriptor | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // The role runs up to the first space, quote or bracket.
  let index = 0;
  while (
    index < trimmed.length &&
    trimmed[index] !== " " &&
    trimmed[index] !== '"' &&
    trimmed[index] !== "["
  ) {
    index += 1;
  }
  const role = trimmed.slice(0, index);
  if (!role) return null;

  let name = "";
  const flags = new Map<string, string>();

  while (index < trimmed.length) {
    const char = trimmed[index];

    if (char === '"') {
      // The accessible name, consuming escapes so a name containing a quote survives intact.
      index += 1;
      let collected = "";
      while (index < trimmed.length && trimmed[index] !== '"') {
        if (trimmed[index] === "\\" && index + 1 < trimmed.length) {
          collected += trimmed[index + 1];
          index += 2;
          continue;
        }
        collected += trimmed[index];
        index += 1;
      }
      index += 1;
      name = collected;
      continue;
    }

    if (char === "[") {
      index += 1;
      let collected = "";
      while (index < trimmed.length && trimmed[index] !== "]") {
        collected += trimmed[index];
        index += 1;
      }
      index += 1;
      const equals = collected.indexOf("=");
      if (equals === -1) {
        flags.set(collected.trim(), "");
      } else {
        flags.set(
          collected.slice(0, equals).trim(),
          collected.slice(equals + 1).trim(),
        );
      }
      continue;
    }

    index += 1;
  }

  return { role, name, flags };
}

/**
 * The first `limit` UTF-16 code units of `text`, one fewer when the cut would split a character.
 *
 * `slice` counts code units and an emoji is two, so a limit landing between the halves leaves a lone
 * high surrogate last: JSON carries it as a bare `\ud83d` and UTF-8 as U+FFFD, and the Bot reads a
 * broken character that is not on the page. The server's `cutAtCodeUnits` is the same rule; this
 * process shares no code with the server, so it is repeated here rather than imported.
 *
 * Exported for `index.ts`, which cuts the readable page text the same way, and so that the rule has
 * its own tests. It lives here rather than beside that caller because this module imports no
 * Playwright: `index.ts` does, at load, so a helper declared there could not be tested at all.
 */
export function cutAtCodeUnits(text: string, limit: number): string {
  const sliced = text.slice(0, limit);
  const last = sliced.charCodeAt(sliced.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? sliced.slice(0, -1) : sliced;
}

/**
 * Which elements come first when there are more than the limit.
 *
 * Controls before anything else, because acting is what the list is for; then the plain elements a
 * page made clickable; then pictures with alt text, which say what a linked image or a challenge is.
 */
const PRIORITY = { control: 0, clickable: 1, image: 2 } as const;

type Candidate = {
  element: SnapshotElement;
  priority: number;
  order: number;
  /** A clickable wrapper whose own controls are listed already: dropped as a duplicate. */
  dropped?: boolean;
};

/** Hints read from the page alongside the snapshot. See `clickableHints` in page-text.ts. */
export type SnapshotHints = {
  /**
   * Text of plain elements with an onclick handler or a tab stop, collapsed and lower-cased.
   *
   * Playwright reports those as `generic` with nothing to say they react to a click (it marks
   * `cursor: pointer` but not handlers), so a `generic` whose text is in here is listed as
   * clickable.
   */
  clickableTexts?: ReadonlySet<string>;
};

/** Collapse whitespace and lower-case, the form both sides of a text comparison are put in. */
export function normaliseText(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/** The text a subtree shows, for naming a clickable wrapper whose label is in its children. */
function textOf(node: unknown, budget = 160): string {
  const parts: string[] = [];
  let used = 0;
  const visit = (value: unknown): void => {
    if (used >= budget) return;
    if (typeof value === "string") {
      const descriptor = parseDescriptor(value);
      // `- text: foo` arrives as a mapping, so a bare string is a valueless entry: use its name.
      const text = descriptor?.name || "";
      if (text) {
        parts.push(text);
        used += text.length;
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        if (key.startsWith("/")) continue; // `/url: ...` and friends are attributes, not text.
        const descriptor = parseDescriptor(key);
        if (descriptor?.role === "text" && typeof child === "string") {
          parts.push(child);
          used += child.length;
          continue;
        }
        if (descriptor?.name) {
          parts.push(descriptor.name);
          used += descriptor.name.length;
        }
        if (typeof child === "string") {
          parts.push(child);
          used += child.length;
        } else visit(child);
      }
    }
  };
  visit(node);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/** The options under a drop-down, by label, and which one is chosen. */
function optionsOf(value: unknown): { options: string[]; selected?: string } {
  const options: string[] = [];
  let selected: string | undefined;
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    const entries =
      typeof node === "string"
        ? [[node, undefined] as const]
        : node && typeof node === "object"
          ? Object.entries(node)
          : [];
    for (const [key, child] of entries) {
      const descriptor = parseDescriptor(key);
      if (descriptor?.role === "option") {
        const label =
          descriptor.name || (typeof child === "string" ? child : "");
        if (label && options.length < OPTION_LIMIT)
          options.push(cutAtCodeUnits(label, 80));
        if (descriptor.flags.has("selected") && selected === undefined)
          selected = label;
      } else if (child && typeof child === "object") visit(child);
    }
  };
  visit(value);
  return { options, ...(selected !== undefined ? { selected } : {}) };
}

const DROP_DOWN_ROLES = new Set(["combobox", "listbox"]);

/** Build a control from a descriptor and whatever YAML gave as its value, or null if not one. */
function toElement(
  descriptor: Descriptor,
  value: unknown,
): SnapshotElement | null {
  if (!INTERACTIVE_ROLES.has(descriptor.role)) return null;

  const ref = descriptor.flags.get("ref");
  // No ref means nothing can be done to it, so it is noise in a list whose entire purpose is acting.
  if (!ref) return null;

  const element: SnapshotElement = {
    ref,
    role: descriptor.role,
    name: cutAtCodeUnits(descriptor.name, 200),
  };

  // Values arrive as text, with quoting and escapes already resolved.
  if (typeof value === "string") {
    const text = value.trim();
    if (text) element.value = cutAtCodeUnits(text, 200);
  }

  // A native drop-down's choices sit under it with no refs of their own; the chosen one is its value.
  if (
    DROP_DOWN_ROLES.has(descriptor.role) &&
    value &&
    typeof value === "object"
  ) {
    const { options, selected } = optionsOf(value);
    if (options.length > 0) element.options = options;
    if (selected !== undefined && element.value === undefined)
      element.value = cutAtCodeUnits(selected, 200);
  }

  if (descriptor.flags.has("disabled")) element.disabled = true;

  // Playwright emits `[checked]` only when something is checked, so absence is ambiguous on its own: a
  // Bot cannot tell an unticked box from a control that does not tick. Reported as false for the roles
  // that can be checked, and left off entirely for the ones that cannot.
  //
  // `[checked=mixed]` is the third state and the one spelling Playwright gives the flag a value for:
  // `aria-checked="mixed"`, which is what the box above a partly-ticked list carries. It is not
  // ticked, and a Bot told it was left the rows underneath unselected and reported the job done. The
  // contract this fills in is `checked?: boolean`, so "neither" has to be said as false — which is
  // also the answer that gets the right action, since clicking a mixed box ticks it.
  if (descriptor.flags.has("checked")) {
    const state = descriptor.flags.get("checked");
    element.checked = state !== "mixed" && state !== "false";
  } else if (CHECKABLE_ROLES.has(descriptor.role)) {
    element.checked = false;
  }

  return element;
}

/**
 * A plain element the page made clickable, or a picture with alt text, or null.
 *
 * `[cursor=pointer]` is Playwright's own mark; `hints.clickableTexts` covers the handlers and tab
 * stops it does not mark. The name is the element's text, read from its children when it has none
 * of its own (a card whose title is a heading inside it).
 */
function toExtra(
  descriptor: Descriptor,
  value: unknown,
  hints: SnapshotHints,
): { element: SnapshotElement; priority: number } | null {
  const ref = descriptor.flags.get("ref");
  if (!ref || INTERACTIVE_ROLES.has(descriptor.role)) return null;
  const text =
    descriptor.name ||
    (typeof value === "string" ? value.trim() : textOf(value));
  const pointer = descriptor.flags.get("cursor") === "pointer";
  const handled =
    !pointer &&
    descriptor.role === "generic" &&
    text !== "" &&
    (hints.clickableTexts?.has(normaliseText(text)) ?? false);
  if (descriptor.role === "img") {
    if (!descriptor.name && !pointer) return null;
    return {
      element: { ref, role: "img", name: cutAtCodeUnits(text, 200) },
      priority: pointer ? PRIORITY.clickable : PRIORITY.image,
    };
  }
  if (!pointer && !handled) return null;
  // A clickable thing with nothing to read is not something a Bot can choose between.
  if (!text) return null;
  return {
    element: { ref, role: "clickable", name: cutAtCodeUnits(text, 200) },
    priority: PRIORITY.clickable,
  };
}

/**
 * Turn an aria snapshot into the flat element list the tool contract publishes.
 *
 * Controls first, then clickable plain elements, then pictures with alt text, each group in page
 * order; at most {@link SNAPSHOT_ELEMENT_LIMIT}, and `truncated` says when there were more.
 */
export function parseAriaSnapshot(
  yaml: string,
  hints: SnapshotHints = {},
): {
  elements: SnapshotElement[];
  truncated: boolean;
} {
  const candidates: Candidate[] = [];
  let order = 0;
  let overflow = false;

  const push = (
    element: SnapshotElement,
    priority: number,
  ): Candidate | null => {
    if (candidates.length >= CANDIDATE_LIMIT) {
      overflow = true;
      return null;
    }
    const candidate = { element, priority, order: order++ };
    candidates.push(candidate);
    return candidate;
  };

  let tree: unknown;
  try {
    tree = parseYaml(yaml, { schema: "failsafe" });
  } catch {
    // A snapshot that will not parse yields no elements rather than throwing. The caller's next move is
    // to take another one, and an exception here would reach the Bot as a broken computer.
    return { elements: [], truncated: false };
  }

  /**
   * Depth first: the tree nests by containment, and a flat list is what a Bot acts on. Answers
   * whether the subtree held a control, so a clickable wrapper around a link is not listed twice.
   */
  const visitEntry = (key: string, value: unknown): boolean => {
    const descriptor = parseDescriptor(key);
    if (!descriptor) return false;
    const control = toElement(descriptor, value);
    if (control) push(control, PRIORITY.control);
    const extra = control ? null : toExtra(descriptor, value, hints);
    const candidate = extra ? push(extra.element, extra.priority) : null;
    // Descend regardless of whether this entry was actionable: a `group "Pizza Size"` is not, and its
    // radios are.
    const inside = value && typeof value === "object" ? walk(value) : false;
    if (candidate && inside && candidate.element.role === "clickable")
      candidate.dropped = true;
    return Boolean(control) || inside;
  };

  const walk = (node: unknown): boolean => {
    if (overflow) return false;
    let found = false;
    if (Array.isArray(node)) {
      for (const child of node) found = walk(child) || found;
      return found;
    }
    if (typeof node === "string") {
      // An entry with no value: `- button "Submit order" [ref=e44]`.
      return visitEntry(node, undefined);
    }
    if (node && typeof node === "object") {
      for (const [key, value] of Object.entries(node)) {
        found = visitEntry(key, value) || found;
      }
    }
    return found;
  };

  walk(tree);
  const kept = candidates
    .filter((candidate) => !candidate.dropped)
    .sort((a, b) => a.priority - b.priority || a.order - b.order);
  return {
    elements: kept
      .slice(0, SNAPSHOT_ELEMENT_LIMIT)
      .map((candidate) => candidate.element),
    truncated: overflow || kept.length > SNAPSHOT_ELEMENT_LIMIT,
  };
}
