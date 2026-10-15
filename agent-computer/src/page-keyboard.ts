import type { Page } from "playwright";
import { requestError } from "./action-errors";
import type { Point, Size } from "./element-geometry";
import { screenPointInPage } from "./elements";

/**
 * Clicky's keyboard on the Bot's page: typing and the page's own keys (Enter, Tab, the arrows),
 * through the browser's protocol rather than the desktop's.
 *
 * On a desktop the X keyboard goes to whichever window the window manager says has the focus, so
 * Clicky asked the X server which one that was and compared its geometry with the page's own idea of
 * its window. Under XFCE that comparison can fail on a page that plainly has the keyboard: the
 * window's decoration offsets it by more than the tolerance, `getwindowfocus` answers the frame
 * window rather than Chrome's, and the focus is read before the window manager has moved it after
 * the click. Playwright's keyboard cannot reach another window at all, so the question it needs
 * answered is a page one: does this page have the focus, and is what has it the field Clicky meant?
 * That is asked in the page itself, just before each press. The pointer (clicks, the wheel) stays on
 * XTEST, where the window under it is still checked.
 *
 * Nothing typed is returned: a length, never the text.
 */

/** Said when the field Clicky meant does not have the keyboard when it would type. */
export const KEYBOARD_ELSEWHERE =
  "The field to type in does not have the keyboard, so nothing was typed.";

/** Said when a point Clicky would type at is not on the Bot's page. */
export const KEYBOARD_OFF_PAGE =
  "That place is not on the Bot's page, so nothing was typed.";

export type KeyboardReadiness = {
  ready: boolean;
  /** Why not: the page lacks the focus, nothing on it has it, or something else does. */
  reason: "no-focus" | "nothing" | "elsewhere" | null;
};

/**
 * In the page: whether it has the focus, and whether what has it is the field under `point` (the
 * field the person approved, which was just clicked), or, without a point, anything at all on the
 * page; with `page`, the page itself will do (a key such as Page Down, which the page takes when no
 * field has the keyboard). Into open shadow roots, which `activeElement` and `elementFromPoint` stop
 * at. Self-contained: Playwright serialises it.
 */
export function keyboardReady(input: {
  point: { x: number; y: number } | null;
  page?: boolean;
}): KeyboardReadiness {
  if (!document.hasFocus()) return { ready: false, reason: "no-focus" };
  let active: Element | null = document.activeElement;
  for (let depth = 0; active?.shadowRoot?.activeElement && depth < 20; depth++)
    active = active.shadowRoot.activeElement;
  if (
    !active ||
    active === document.body ||
    active === document.documentElement
  )
    return input.page && !input.point
      ? { ready: true, reason: null }
      : { ready: false, reason: "nothing" };
  if (!input.point) return { ready: true, reason: null };
  let hit: Element | null = document.elementFromPoint(
    input.point.x,
    input.point.y,
  );
  for (let depth = 0; hit?.shadowRoot && depth < 20; depth += 1) {
    const inner = hit.shadowRoot.elementFromPoint(input.point.x, input.point.y);
    if (!inner || inner === hit) break;
    hit = inner;
  }
  if (!hit) return { ready: false, reason: "elsewhere" };
  // The field the point is on: the control itself, its label's control, or the editable box around it.
  const field = hit.closest(
    'input,textarea,select,label,iframe,frame,[contenteditable=""],[contenteditable=true],[role=textbox],[role=searchbox],[role=combobox],[role=spinbutton]',
  );
  const target =
    field instanceof HTMLLabelElement ? (field.control ?? field) : field;
  const same =
    active === hit ||
    active.contains(hit) ||
    (target !== null && (active === target || target.contains(active)));
  return same
    ? { ready: true, reason: null }
    : { ready: false, reason: "elsewhere" };
}

const READY_ATTEMPTS = 8;
const READY_WAIT_MS = 75;

/**
 * Type, or press one of the page's keys, on the Bot's page once the field has the keyboard. `at`
 * is the screen point of the field when Clicky clicked it first; the focus can take a moment to
 * arrive after a click through the desktop, so it is asked again a few times before giving up.
 */
export async function performPageKeyboard(
  page: Page,
  action: "/human/type" | "/human/key",
  body: Record<string, unknown>,
  desktop: Size | null,
  wait: (ms: number) => Promise<unknown> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<Record<string, unknown>> {
  if (action === "/human/type" && typeof body.text !== "string")
    throw keyboardError("Typing needs text.");
  if (action === "/human/key" && (typeof body.key !== "string" || !body.key))
    throw keyboardError("A key press needs a key name.");
  const at = pointOf(body.at);
  const point = at ? await screenPointInPage(page, desktop, at) : null;
  if (at && !point) throw keyboardError(KEYBOARD_OFF_PAGE);
  let readiness: KeyboardReadiness = { ready: false, reason: null };
  for (let attempt = 0; attempt < READY_ATTEMPTS; attempt += 1) {
    readiness = await page
      .evaluate(keyboardReady, { point, page: action === "/human/key" })
      .catch((): KeyboardReadiness => ({ ready: false, reason: null }));
    if (readiness.ready) break;
    await wait(READY_WAIT_MS);
  }
  if (!readiness.ready)
    throw keyboardError(
      action === "/human/type"
        ? KEYBOARD_ELSEWHERE
        : "What would take that key does not have the keyboard, so nothing was pressed.",
    );
  if (action === "/human/type") {
    const text = body.text as string;
    // As one insertion, like the person's own paste: a field that reformats as you go gets it whole.
    await page.keyboard.insertText(text);
    return { action: "human_type", characters: text.length, url: page.url() };
  }
  const key = body.key as string;
  await page.keyboard.press(key);
  return { action: "human_key", key, url: page.url() };
}

function pointOf(value: unknown): Point | null {
  if (!value || typeof value !== "object") return null;
  const { x, y } = value as { x?: unknown; y?: unknown };
  return typeof x === "number" &&
    Number.isFinite(x) &&
    typeof y === "number" &&
    Number.isFinite(y)
    ? { x, y }
    : null;
}

/** A refusal the caller answers with a 400 (`isRequestError`): understood, and declined. */
const keyboardError = requestError;
