/**
 * The page an action left behind, as the few lines a model reads.
 *
 * Every acting call answers with the page it produced, so the Bot does not spend a second round trip
 * on a snapshot to find out what its click did. That only pays if the answer is small: a full
 * element list as JSON objects is several thousand tokens on an ordinary form, and most of it is
 * the same as last time. So the elements become one line each (`e5 textbox "Email" = "a@b.c"`),
 * labels are capped, identical controls are merged into one line that still names every ref, and
 * when the page did not move (same URL as the snapshot before) only what is new or different is
 * listed, marked `changed`.
 *
 * Refs stay usable across that diff: Playwright keeps an element's ref while its role and name are
 * unchanged, and the new snapshot (stored by the gateway in full) includes the unchanged ones.
 *
 * No Playwright import, so this is tested without a browser.
 */
import { cutAtCodeUnits, type SnapshotElement } from "./aria-snapshot";

/** How long a label or value may be on a line. The full text is in the stored snapshot. */
const LABEL_LIMIT = 80;

/** How many extra refs a merged line names before it counts the rest. */
const MERGED_REFS_SHOWN = 8;

/** How long a drop-down's option list may run on its line. */
const OPTIONS_LIMIT = 320;

/**
 * Past this share of the page changing, the whole list is cheaper to read than a diff of it, and
 * a diff that big usually means the page was replaced in place (a single-page app's route change).
 */
const DIFF_SHARE = 0.5;

const cut = (text: string): string => {
  const short = cutAtCodeUnits(text, LABEL_LIMIT);
  return short.length < text.length ? `${short}…` : short;
};

function optionsText(options: readonly string[]): string {
  let text = "";
  let shown = 0;
  for (const option of options) {
    const next = text ? `${text} | ${cut(option)}` : cut(option);
    if (next.length > OPTIONS_LIMIT) break;
    text = next;
    shown += 1;
  }
  return shown < options.length
    ? `${text} | +${options.length - shown} more`
    : text;
}

/** Everything on a line except the ref, which is what two identical controls share. */
function describe(element: SnapshotElement): string {
  let line = element.role;
  if (element.name) line += ` ${JSON.stringify(cut(element.name))}`;
  if (element.value !== undefined)
    line += ` = ${JSON.stringify(cut(element.value))}`;
  if (element.checked !== undefined)
    line += element.checked ? " [checked]" : " [unchecked]";
  if (element.disabled) line += " [disabled]";
  if (element.options?.length)
    line += ` options: ${optionsText(element.options)}`;
  return line;
}

/** One element as one line: `e5 textbox "Email" = "a@b.c" [disabled]`. */
export function elementLine(element: SnapshotElement): string {
  return `${element.ref} ${describe(element)}`;
}

/**
 * The elements as lines, with identical ones merged.
 *
 * Twenty "Read more" links are one line naming all twenty refs rather than twenty lines, which is
 * most of what a results page costs. Merged in the position of the first, so the order still
 * follows the page.
 */
export function compactLines(elements: readonly SnapshotElement[]): string[] {
  const groups = new Map<string, string[]>();
  for (const element of elements) {
    const key = describe(element);
    const refs = groups.get(key);
    if (refs) refs.push(element.ref);
    else groups.set(key, [element.ref]);
  }
  const lines: string[] = [];
  for (const [key, refs] of groups) {
    const [first, ...rest] = refs;
    if (rest.length === 0) {
      lines.push(`${first} ${key}`);
      continue;
    }
    const shown = rest.slice(0, MERGED_REFS_SHOWN).join(", ");
    const more =
      rest.length > MERGED_REFS_SHOWN
        ? ` and ${rest.length - MERGED_REFS_SHOWN} more`
        : "";
    lines.push(`${first} ${key} (also ${shown}${more})`);
  }
  return lines;
}

/** What two snapshots of one element have to agree on for it to count as unchanged. */
function sameElement(a: SnapshotElement, b: SnapshotElement): boolean {
  return describe(a) === describe(b);
}

/** The elements of `next` that `previous` did not have, or had differently. */
export function changedElements(
  previous: readonly SnapshotElement[],
  next: readonly SnapshotElement[],
): SnapshotElement[] {
  const before = new Map(previous.map((element) => [element.ref, element]));
  return next.filter((element) => {
    const held = before.get(element.ref);
    return !held || !sameElement(held, element);
  });
}

export type PageSnapshot = {
  url: string;
  elements: readonly SnapshotElement[];
};

/**
 * The lines an acting result carries for the page it produced.
 *
 * A diff when the URL is the one the previous snapshot was taken on and the change is small;
 * otherwise every element.
 */
export function pageLines(
  previous: PageSnapshot | undefined,
  next: PageSnapshot,
): { elements: string[]; changed?: true } {
  if (previous && previous.url === next.url && previous.elements.length > 0) {
    const changed = changedElements(previous.elements, next.elements);
    if (changed.length <= next.elements.length * DIFF_SHARE)
      return { elements: compactLines(changed), changed: true };
  }
  return { elements: compactLines(next.elements) };
}
