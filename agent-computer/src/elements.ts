import type { Page } from "playwright";
import { parseAriaSnapshot, snapshotBoxes } from "./aria-snapshot";
import {
  addressBarRect,
  clipRect,
  fitWidth,
  type PageWindow,
  type Point,
  pageOffset,
  pageRectToScreen,
  type Rect,
  type Size,
  screenPointToPage,
  smallestContaining,
  visibleIn,
  windowPlacement,
} from "./element-geometry";
import { SECRET_ATTRIBUTE, SENSITIVE_FIELD_SELECTOR } from "./secret-masking";

/**
 * What is on the screen and where, for Clicky.
 *
 * Clicky is the companion beside a Bot's screen (`docs/clicky-mode-plan.md`): it points at the part
 * of the screen that matters, and its model reads a list of the controls with their boxes beside a
 * picture of the screen. Three questions, all read-only:
 *
 * - `/elements`: the visible controls, each with its ref and its box in SCREEN pixels, and the
 *   ones above or below the screen by their place in the page, with the scroll position and the
 *   title. On a desktop the page is a window under the browser's toolbar, so its boxes are moved by
 *   where its viewport starts (`element-geometry.ts`); on a page-only computer the screen is the
 *   viewport.
 * - `/elements/at`: what is under one screen point, asked of the page itself just before Clicky
 *   acts there, so a guardrail decides on what is really there rather than on what the model said.
 * - `/elements/frame`: the picture the model is shown, with every sensitive field masked first.
 *   The model never sees an unmasked frame: a one-time code shows no dots on its own, and a picture
 *   is read by a model as text.
 *
 * The aria snapshot taken here does not count as the Bot's look: it neither advances the Bot's
 * snapshot id nor marks a fresh look after a handback, and Playwright keeps an element's ref as long
 * as its role and name are unchanged, so the Bot's outstanding refs still resolve afterwards.
 */

/** How many boxes Clicky is handed: enough for a busy form, few enough for a short prompt. */
export const ELEMENT_LIMIT = 80;
/** How many controls off the screen are named beside those, the nearest to the screen first. */
export const OFFSCREEN_LIMIT = 40;
/**
 * How many of the snapshot's controls are looked at, in its order. All of them, not the first few:
 * on a page scrolled down, the first controls in the document are all above the screen, and
 * measuring only those once found nothing at all on it. Their boxes come with the snapshot, so a
 * long page costs no more calls than a short one.
 */
export const CANDIDATE_LIMIT = 4_000;
const PROBE_TIMEOUT_MS = 500;
const NAME_LIMIT = 120;

export type ScreenElement = {
  ref: string;
  role: string;
  name: string;
  /** Screen pixels, clipped to the screen. */
  rect: Rect;
  sensitive: boolean;
  focused: boolean;
};

/** A control the page has but the screen does not show: scrolled past, or further down. */
export type OffscreenElement = {
  ref: string;
  role: string;
  name: string;
  offscreen: "above" | "below";
  /** Where its top is in the page, in CSS pixels from the top of the document. */
  y: number;
  sensitive: boolean;
};

/** How far down the page is scrolled: CSS pixels, of how tall a page, with how tall a window. */
export type PageScroll = { y: number; height: number; viewport: number };

export type ScreenElements = {
  screen: Size;
  mode: "desktop" | "page";
  /** Where the browser's window is, on a desktop. */
  window?: { x: number; y: number; innerOffsetX: number; innerOffsetY: number };
  /** The page the boxes belong to; empty when no browser is open. */
  url: string;
  /** The page's title, when it could be read. */
  title?: string;
  /** The visible controls. */
  elements: ScreenElement[];
  /** Controls above or below the screen, so a step can say to scroll to them. */
  offscreen?: OffscreenElement[];
  scroll?: PageScroll;
};

export type ElementAt = PageTarget & {
  ref?: string;
  /** False for a point outside the page: the toolbar, another window, the dock. */
  inPage: boolean;
  url: string;
  /** On a desktop, which window would receive input there. */
  window?: "browser" | "other";
};

/** Where the page is: the screen it is on, its viewport, and the offset between the two. */
type Placement = {
  mode: "desktop" | "page";
  screen: Size;
  viewport: Size;
  offset: Point;
  window?: ScreenElements["window"];
  /** What the page says about its window, on a desktop. */
  view?: PageWindow;
};

async function viewportOf(page: Page): Promise<Size> {
  return (
    page.viewportSize() ??
    (await page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    })))
  );
}

async function placementOf(
  page: Page,
  desktop: Size | null,
): Promise<Placement> {
  const viewport = await viewportOf(page);
  if (!desktop) {
    return { mode: "page", screen: viewport, viewport, offset: { x: 0, y: 0 } };
  }
  const view: PageWindow = await page.evaluate(() => ({
    screenX: window.screenX,
    screenY: window.screenY,
    outerWidth: window.outerWidth,
    outerHeight: window.outerHeight,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
  }));
  return {
    mode: "desktop",
    screen: desktop,
    viewport,
    offset: pageOffset(view),
    window: windowPlacement(view),
    view,
  };
}

/** Where the page's whole browser window is on the screen, as the page itself reads it. */
export async function pageWindowRect(
  page: Page,
): Promise<{ x: number; y: number; width: number; height: number } | null> {
  return page
    .evaluate(() => ({
      x: window.screenX,
      y: window.screenY,
      width: window.outerWidth,
      height: window.outerHeight,
    }))
    .catch(() => null);
}

/** Where the page's viewport is on the screen, clipped to it. */
export async function pageRectOnScreen(
  page: Page,
  desktop: Size,
): Promise<Rect> {
  const placement = await placementOf(page, desktop);
  return clipRect(
    { ...placement.offset, ...placement.viewport },
    placement.screen,
  );
}

/** A desktop with no browser open: the screen is there, and nothing on it can be asked about. */
export function emptyScreen(desktop: Size): ScreenElements {
  return { screen: desktop, mode: "desktop", url: "", elements: [] };
}

/**
 * In the page, about one element: whether it may hold a secret, and whether it has the keyboard.
 * Runs in the page (Playwright serialises it), so it is self-contained.
 */
export function elementFacts(
  element: Element,
  selector: string,
): { sensitive: boolean; focused: boolean } {
  const field =
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement;
  const words = [
    element.getAttribute("aria-label"),
    element.getAttribute("name"),
    element.getAttribute("autocomplete"),
    element.getAttribute("placeholder"),
    element.id,
    ...(field
      ? Array.from(element.labels ?? []).map((l) => l.textContent)
      : []),
  ].join(" ");
  const sensitive =
    element.matches(selector) ||
    (field &&
      /password|secret|token|one.time|verification|credit.card|security.code|passcode|(?:^|[^a-z])(?:cc-|(?:cvc|cvv|pin|otp)(?![a-z]))/i.test(
        words,
      ));
  let active: Element | null = element.ownerDocument.activeElement;
  while (active?.shadowRoot?.activeElement)
    active = active.shadowRoot.activeElement;
  return { sensitive, focused: active === element };
}

/** Roles whose contents are typed: unreadable, they are treated as holding a secret. */
const TYPED_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton"]);

/**
 * In the page, the scroll position and the boxes of the fields whose ATTRIBUTES say they hold a
 * secret (a password, a one-time code, a card number), for an element whose own probe ran out of
 * time. Self-contained: Playwright serialises it.
 */
export function pageFacts(selector: string): {
  scroll: PageScroll;
  secrets: { x: number; y: number; width: number; height: number }[];
} {
  const scrolling = document.scrollingElement ?? document.documentElement;
  const secrets = Array.from(
    document.querySelectorAll(`${selector}, input[autocomplete^="cc-"]`),
  )
    .slice(0, 200)
    .map((element) => {
      const box = element.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    });
  return {
    scroll: {
      y: Math.round(window.scrollY),
      height: Math.round(scrolling?.scrollHeight ?? window.innerHeight),
      viewport: Math.round(window.innerHeight),
    },
    secrets,
  };
}

/** Whether two boxes are one field: either one's middle inside the other. */
function sameField(a: Rect, b: Rect): boolean {
  const inside = (outer: Rect, inner: Rect) => {
    const x = inner.x + inner.width / 2;
    const y = inner.y + inner.height / 2;
    return (
      x >= outer.x &&
      x <= outer.x + outer.width &&
      y >= outer.y &&
      y <= outer.y + outer.height
    );
  };
  return inside(a, b) || inside(b, a);
}

/** Where a measured control is: on the screen, above it, below it, or nowhere to show. */
export function classifyBox(
  box: Rect | null,
  viewport: Size,
): "visible" | "above" | "below" | null {
  if (!box || !(box.width > 0 && box.height > 0)) return null;
  if (visibleIn(box, viewport)) return "visible";
  // Beside the screen (a carousel's next card) is not somewhere scrolling down reaches.
  if (box.x + box.width <= 0 || box.x >= viewport.width) return null;
  if (box.y + box.height <= 0) return "above";
  if (box.y >= viewport.height) return "below";
  return null;
}

/**
 * Of the measured controls, what Clicky is handed: the visible ones in the snapshot's order (at
 * most {@link ELEMENT_LIMIT}), and the ones off the screen nearest to it first, from above and
 * below alike (at most {@link OFFSCREEN_LIMIT}). Pure, so the choice is a test.
 */
export function chooseElements<T extends { box: Rect | null }>(
  measured: readonly T[],
  viewport: Size,
): {
  visible: T[];
  offscreen: (T & { box: Rect; offscreen: "above" | "below" })[];
} {
  const visible: T[] = [];
  const offscreen: {
    element: T & { box: Rect; offscreen: "above" | "below" };
    distance: number;
  }[] = [];
  for (const element of measured) {
    const where = classifyBox(element.box, viewport);
    if (!where || !element.box) continue;
    if (where === "visible") {
      if (visible.length < ELEMENT_LIMIT) visible.push(element);
      continue;
    }
    offscreen.push({
      element: { ...element, box: element.box, offscreen: where },
      distance:
        where === "above"
          ? -(element.box.y + element.box.height)
          : element.box.y - viewport.height,
    });
  }
  /*
   * Half the room for each side, nearest first, so a page with a long list above the screen still
   * names what is below it (the next step is usually further down); then whatever is left over, by
   * how near it is.
   */
  offscreen.sort((a, b) => a.distance - b.distance);
  const half = Math.floor(OFFSCREEN_LIMIT / 2);
  const side = (where: "above" | "below") =>
    offscreen.filter((entry) => entry.element.offscreen === where);
  const chosen = new Set([
    ...side("above").slice(0, half),
    ...side("below").slice(0, half),
  ]);
  for (const entry of offscreen) {
    if (chosen.size >= OFFSCREEN_LIMIT) break;
    chosen.add(entry);
  }
  return {
    visible,
    offscreen: offscreen
      .filter((entry) => chosen.has(entry))
      .map((entry) => entry.element),
  };
}

/** How many typed fields are asked, one by one, whether they hold a secret and have the keyboard. */
export const FACTS_LIMIT = 30;
/** How many of those questions run at once, and how long they all may take together. */
const FACTS_CONCURRENCY = 16;
const FACTS_BUDGET_MS = 400;
/** The fallback when a snapshot carries no boxes: how many are measured, and for how long at most. */
const FALLBACK_MEASURE_LIMIT = 120;
const MEASURE_BUDGET_MS = 1_200;

/** Where the time of one `/elements` went, for the `[timing]` line its caller writes. */
export type ElementsTiming = {
  phases: Record<string, number>;
  candidates: number;
  visible: number;
  offscreen: number;
};

/**
 * The work `items` hand to `work`, at most `concurrency` at a time, stopped at `deadline`: what
 * finished is answered, what did not is null. A slow page costs the budget, never more.
 */
export async function measureWithin<T, R>(
  items: readonly T[],
  work: (item: T) => Promise<R>,
  options: { concurrency: number; deadline: number; now?: () => number },
): Promise<(R | null)[]> {
  const now = options.now ?? Date.now;
  const results: (R | null)[] = items.map(() => null);
  let next = 0;
  const late = () =>
    new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), Math.max(0, options.deadline - now())),
    );
  const worker = async () => {
    while (next < items.length && now() < options.deadline) {
      const index = next;
      next += 1;
      results[index] = await Promise.race([
        work(items[index] as T).catch(() => null),
        late(),
      ]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(options.concurrency, items.length) }, worker),
  );
  return results;
}

/**
 * The page's controls with their boxes on the screen, the ones off it named beside them, the
 * scroll position and the title. `dialogPending`: the page is paused on a JavaScript dialog, and
 * nothing that runs in it (the title, the scroll position) is asked.
 *
 * Fast on a heavy page: every box comes with the snapshot itself (`boxes: true`), one call to the
 * page rather than one per control, so the whole page is seen whatever its size. Only the typed
 * fields on the screen (at most {@link FACTS_LIMIT}) are then asked, one by one, whether they hold a
 * secret and have the keyboard, within a budget; everything else is judged by the page's own word
 * on its secret fields. On a desktop the browser's address bar, which the page cannot describe, is
 * listed as a control of its own (`addressbar`), placed by the window's geometry.
 */
export async function listScreenElements(
  page: Page,
  desktop: Size | null,
  options: {
    dialogPending?: boolean;
    timing?: (timing: ElementsTiming) => void;
  } = {},
): Promise<ScreenElements> {
  const phases: Record<string, number> = {};
  const since = (started: number, name: string) => {
    phases[name] = Math.round(performance.now() - started);
  };
  let started = performance.now();
  const placement = await placementOf(page, desktop);
  since(started, "placement");
  started = performance.now();
  const [yaml, facts, title] = await Promise.all([
    page.ariaSnapshot({ mode: "ai", boxes: true }),
    options.dialogPending
      ? Promise.resolve(null)
      : withinMs(
          page.evaluate(pageFacts, SENSITIVE_FIELD_SELECTOR).catch(() => null),
          PROBE_TIMEOUT_MS * 2,
          null,
        ),
    options.dialogPending
      ? Promise.resolve("")
      : withinMs(
          page.title().catch(() => ""),
          PROBE_TIMEOUT_MS,
          "",
        ),
  ]);
  since(started, "snapshot");
  const parsed = parseAriaSnapshot(yaml, {}, { limit: CANDIDATE_LIMIT });
  const candidates = parsed.elements;
  const boxes = snapshotBoxes(yaml);
  /*
   * A snapshot that carries no boxes at all (a Playwright before `boxes`) is measured the old way,
   * one by one, but only so many and only for so long.
   */
  if (boxes.size === 0 && candidates.length > 0) {
    started = performance.now();
    const measured = await measureWithin(
      candidates.slice(0, FALLBACK_MEASURE_LIMIT),
      (element) =>
        page
          .locator(`aria-ref=${element.ref}`)
          .boundingBox({ timeout: PROBE_TIMEOUT_MS }),
      {
        concurrency: FACTS_CONCURRENCY,
        deadline: Date.now() + MEASURE_BUDGET_MS,
      },
    );
    measured.forEach((box, index) => {
      const ref = candidates[index]?.ref;
      if (ref && box) boxes.set(ref, box);
    });
    since(started, "measure");
  }
  const chosen = chooseElements(
    candidates.map((element) => ({
      element,
      box: boxes.get(element.ref) ?? null,
    })),
    placement.viewport,
  );
  /*
   * Whether a field holds a secret: asked of the element itself for the typed fields on the screen;
   * for the rest, and for one that does not answer in time, judged by the attributes of the fields
   * the page itself marks as secret, not as "every text field": a search box that was slow to
   * answer is a search box. Only when the page answered neither question is every typed field
   * treated as a secret, as before.
   */
  const secretBoxes = facts?.secrets ?? [];
  const byPage = (role: string, box: Rect) =>
    facts
      ? secretBoxes.some((secret) => sameField(secret, box))
      : TYPED_ROLES.has(role);
  started = performance.now();
  const typed = chosen.visible
    .filter(({ element, box }) => box && TYPED_ROLES.has(element.role))
    .slice(0, FACTS_LIMIT);
  const asked = await measureWithin(
    typed,
    ({ element }) =>
      page
        .locator(`aria-ref=${element.ref}`)
        .evaluate(elementFacts, SENSITIVE_FIELD_SELECTOR, {
          timeout: PROBE_TIMEOUT_MS,
        }),
    {
      concurrency: FACTS_CONCURRENCY,
      deadline: Date.now() + FACTS_BUDGET_MS,
    },
  );
  const answered = new Map(
    typed.flatMap(({ element }, index) => {
      const read = asked[index];
      return read ? [[element.ref, read] as const] : [];
    }),
  );
  since(started, "facts");
  const visible = chosen.visible.flatMap(({ element, box }) => {
    if (!box) return [];
    const onScreen = clipRect(
      pageRectToScreen(clipRect(box, placement.viewport), placement.offset),
      placement.screen,
    );
    if (!(onScreen.width > 0 && onScreen.height > 0)) return [];
    const read = answered.get(element.ref);
    return [
      {
        ref: element.ref,
        role: element.role,
        name: element.name.slice(0, NAME_LIMIT),
        rect: onScreen,
        sensitive: read ? read.sensitive : byPage(element.role, box),
        focused: read?.focused ?? false,
      } satisfies ScreenElement,
    ];
  });
  const offscreen = chosen.offscreen.map(
    ({ element, box, offscreen: where }) =>
      ({
        ref: element.ref,
        role: element.role,
        name: element.name.slice(0, NAME_LIMIT),
        offscreen: where,
        y: Math.round(box.y + (facts?.scroll.y ?? 0)),
        sensitive: byPage(element.role, box),
      }) satisfies OffscreenElement,
  );
  // The browser's own address bar, which no snapshot of the page has, where a person would go.
  const bar =
    placement.mode === "desktop" && placement.view
      ? addressBarRect(placement.view)
      : null;
  const barOnScreen = bar ? clipRect(bar, placement.screen) : null;
  const addressBar: ScreenElement[] =
    barOnScreen && barOnScreen.width > 0 && barOnScreen.height > 0
      ? [
          {
            ref: ADDRESS_BAR_REF,
            role: "addressbar",
            name: "Address bar",
            rect: barOnScreen,
            sensitive: false,
            focused: false,
          },
        ]
      : [];
  options.timing?.({
    phases,
    candidates: candidates.length,
    visible: visible.length,
    offscreen: offscreen.length,
  });
  return {
    screen: placement.screen,
    mode: placement.mode,
    ...(placement.window ? { window: placement.window } : {}),
    url: page.url(),
    ...(title ? { title: title.slice(0, 200) } : {}),
    elements: [...addressBar, ...visible],
    offscreen,
    ...(facts ? { scroll: facts.scroll } : {}),
  };
}

/** The ref of the browser's address bar in `/elements`: not one of the page's own. */
export const ADDRESS_BAR_REF = "addressbar";

/** A promise's answer, or `fallback` once `ms` have passed. */
async function withinMs<T>(work: Promise<T>, ms: number, fallback: T) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Where one element the Bot named (an aria ref from its own snapshot) is on the screen now, for
 * narrating what it does. Null when it cannot be found or is not on the screen. It takes no snapshot
 * of its own, so the Bot's refs stay as they are.
 */
export async function refRectOnScreen(
  page: Page,
  desktop: Size | null,
  ref: string,
): Promise<{ screen: Size; rect: Rect } | null> {
  const box = await page
    .locator(`aria-ref=${ref}`)
    .boundingBox({ timeout: PROBE_TIMEOUT_MS })
    .catch(() => null);
  if (!box) return null;
  const placement = await placementOf(page, desktop);
  if (!visibleIn(box, placement.viewport)) return null;
  const rect = clipRect(
    pageRectToScreen(clipRect(box, placement.viewport), placement.offset),
    placement.screen,
  );
  if (!(rect.width > 0 && rect.height > 0)) return null;
  return { screen: placement.screen, rect };
}

/** A screen point in the page's own pixels, or null when it is not on the page. */
export async function screenPointInPage(
  page: Page,
  desktop: Size | null,
  point: Point,
): Promise<Point | null> {
  const placement = await placementOf(page, desktop);
  return screenPointToPage(point, placement.offset, placement.viewport);
}

/** What the page says about the element under a point, or the one with the keyboard. */
export type PageTarget = {
  role: string;
  name: string;
  sensitive: boolean;
  /** A submit button, or any button inside a form: pressing it sends the form. */
  submits: boolean;
  /** A frame: what is inside it (often another site's, such as a card field) cannot be read. */
  opaque: boolean;
  /** Inside a dialog: its buttons are the "Yes", "OK" and "Continue" of a confirmation. */
  inDialog: boolean;
  /** Inside a form: Enter in one of its fields sends it. */
  inForm: boolean;
  /**
   * A search field by what the page says it is: `type=search`, the searchbox role, or inside a
   * search landmark. Absent from older computers.
   */
  search?: boolean;
  /** Takes several lines (a textarea, a rich editor): Enter there may send what was written. */
  multiline?: boolean;
  /** Text can be typed into it, so Backspace and Delete edit the text rather than the page. */
  editable?: boolean;
  /** For a link: the host it leads to. */
  linkHost?: string;
};

/**
 * In the page, the control under a point (the way a person's click would find it), or, without a
 * point, the one with the keyboard; null when nothing has it. Into open shadow roots, which
 * `elementFromPoint` and `activeElement` stop at. Self-contained: Playwright serialises it.
 */
export function pageTarget(input: {
  point: { x: number; y: number } | null;
  selector: string;
}): PageTarget | null {
  let hit: Element | null = null;
  if (input.point) {
    hit = document.elementFromPoint(input.point.x, input.point.y);
    for (let depth = 0; hit?.shadowRoot && depth < 20; depth += 1) {
      const inner = hit.shadowRoot.elementFromPoint(
        input.point.x,
        input.point.y,
      );
      if (!inner || inner === hit) break;
      hit = inner;
    }
  } else {
    hit = document.activeElement;
    for (let depth = 0; hit?.shadowRoot?.activeElement && depth < 20; depth++)
      hit = hit.shadowRoot.activeElement;
    if (!hit || hit === document.body || hit === document.documentElement)
      return null;
  }
  const closest =
    hit?.closest(
      "button,a,input,textarea,select,label,iframe,frame,[role],[contenteditable=true]",
    ) ?? hit;
  const element =
    closest instanceof HTMLLabelElement
      ? (closest.control ?? closest)
      : closest;
  if (!element)
    return input.point
      ? {
          role: "page",
          name: "Page",
          sensitive: false,
          submits: false,
          opaque: false,
          inDialog: false,
          inForm: false,
        }
      : null;
  const tag = element.tagName.toLowerCase();
  if (tag === "iframe" || tag === "frame")
    return {
      role: "frame",
      name: (element.getAttribute("title") ?? "").slice(0, 120),
      sensitive: false,
      submits: false,
      opaque: true,
      inDialog: false,
      inForm: false,
    };
  const inputType =
    element instanceof HTMLInputElement ? element.type.toLowerCase() : "";
  const role =
    element.getAttribute("role") ||
    (
      {
        checkbox: "checkbox",
        radio: "radio",
        button: "button",
        submit: "button",
        reset: "button",
        image: "button",
        range: "slider",
        file: "button",
      } as Record<string, string>
    )[inputType] ||
    (
      {
        button: "button",
        a: "link",
        input: "textbox",
        textarea: "textbox",
        select: "combobox",
      } as Record<string, string>
    )[tag] ||
    tag;
  const field =
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement;
  const label =
    element.getAttribute("aria-label") ||
    (field
      ? Array.from(element.labels ?? [])
          .map((entry) => entry.textContent ?? "")
          .join(" ")
      : "") ||
    (tag === "button" || tag === "a" ? element.textContent : "") ||
    element.getAttribute("value") ||
    element.getAttribute("placeholder") ||
    role;
  const sensitive =
    element.matches(input.selector) ||
    ((element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement) &&
      /password|secret|token|one.time|verification|credit.card|security.code|passcode|(?:^|[^a-z])(?:cc-|(?:cvc|cvv|pin|otp)(?![a-z]))/i.test(
        [
          label,
          element.getAttribute("name"),
          element.getAttribute("autocomplete"),
        ].join(" "),
      ));
  const form = element.closest("form");
  const buttonType = (element.getAttribute("type") ?? "submit").toLowerCase();
  const submits =
    inputType === "submit" ||
    inputType === "image" ||
    (tag === "button" && buttonType === "submit" && Boolean(form)) ||
    (role === "button" && Boolean(form));
  const name = sensitive
    ? "[sensitive field]"
    : (label ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  const inDialog = Boolean(
    element.closest('dialog,[role="dialog"],[role="alertdialog"]'),
  );
  const search =
    inputType === "search" ||
    role === "searchbox" ||
    Boolean(element.closest('search,[role="search"]'));
  const htmlElement = element as HTMLElement;
  const multiline =
    tag === "textarea" ||
    htmlElement.isContentEditable === true ||
    element.getAttribute("aria-multiline") === "true";
  const textInputs = [
    "",
    "text",
    "search",
    "email",
    "url",
    "tel",
    "number",
    "password",
  ];
  const editable =
    !element.matches(":disabled") &&
    ((element instanceof HTMLInputElement &&
      textInputs.includes(inputType) &&
      !element.readOnly) ||
      (element instanceof HTMLTextAreaElement && !element.readOnly) ||
      htmlElement.isContentEditable === true);
  const link = element.closest("a[href]");
  let linkHost: string | undefined;
  if (link instanceof HTMLAnchorElement) {
    try {
      linkHost = new URL(link.href, document.baseURI).host || undefined;
    } catch {
      linkHost = undefined;
    }
  }
  return {
    role: role.slice(0, 40),
    name: name || role,
    sensitive,
    submits,
    opaque: false,
    inDialog,
    inForm: Boolean(form),
    search,
    multiline,
    editable,
    ...(linkHost ? { linkHost } : {}),
  };
}

/** What has the keyboard: whether that is the Bot's browser at all, and what in its page. */
export type FocusTarget = {
  window: "browser" | "other";
  element: PageTarget | null;
  url: string;
};

/** The page's element with the keyboard; `window` says whether the browser has the keyboard. */
export async function focusOn(
  page: Page | null,
  window: "browser" | "other",
): Promise<FocusTarget> {
  if (!page || window !== "browser")
    return { window, element: null, url: page?.url() ?? "" };
  const element = await page
    .evaluate(pageTarget, { point: null, selector: SENSITIVE_FIELD_SELECTOR })
    .catch(() => null);
  return { window, element, url: page.url() };
}

/**
 * What is under a screen point. `known` is the last `/elements` answer for this Bot, used only to
 * name the ref of the box under the point; the role, name and sensitivity come from the page now.
 */
export async function elementAtScreen(
  page: Page,
  desktop: Size | null,
  point: Point,
  known?: ScreenElements,
  /**
   * On a desktop, which window would receive input at this point: the Bot's page or something else,
   * against where the page says its window is. Asked only for a point on the page (a point off it
   * is outside the page already), and only just before acting: when Clicky proposes, the page
   * element under the point is what is rated, and which window is on top is checked when it would
   * actually act.
   */
  windowAt?: (pageWindow: {
    x: number;
    y: number;
    width: number;
    height: number;
  }) => Promise<"browser" | "other">,
): Promise<ElementAt> {
  const placement = await placementOf(page, desktop);
  const inPage = screenPointToPage(point, placement.offset, placement.viewport);
  const url = page.url();
  const outside: ElementAt = {
    role: "desktop",
    name: "",
    sensitive: false,
    submits: false,
    opaque: false,
    inDialog: false,
    inForm: false,
    inPage: false,
    url,
    ...(desktop ? { window: "other" as const } : {}),
  };
  if (!inPage) return outside;
  // Another window over the page (a terminal, a dialog of the desktop's) takes the input, not it.
  const view = placement.window;
  const window =
    desktop && windowAt && view
      ? await windowAt({
          x: view.x,
          y: view.y,
          width: placement.viewport.width + view.innerOffsetX,
          height: placement.viewport.height + view.innerOffsetY,
        })
      : undefined;
  if (window === "other") return outside;
  const target = (await page.evaluate(pageTarget, {
    point: inPage,
    selector: SENSITIVE_FIELD_SELECTOR,
  })) ?? {
    role: "page",
    name: "Page",
    sensitive: false,
    submits: false,
    opaque: false,
    inDialog: false,
    inForm: false,
  };
  const ref =
    known && known.url === url
      ? smallestContaining(point, known.elements)?.ref
      : undefined;
  return {
    ...target,
    ...(ref ? { ref } : {}),
    inPage: true,
    url,
    ...(window ? { window } : {}),
  };
}

/**
 * In each frame of the page, mark every field that may hold a secret the way `markElementSecret`
 * marks a field a secret was typed into: the attribute, and dots drawn over its text. Self-contained.
 */
export function markSensitiveFields(input: {
  selector: string;
  attribute: string;
}): number {
  let marked = 0;
  // The document and every open shadow root in it: a field inside a web component is a field.
  const roots: (Document | ShadowRoot)[] = [document];
  for (let index = 0; index < roots.length && index < 500; index += 1) {
    for (const host of Array.from(
      (roots[index] as Document | ShadowRoot).querySelectorAll("*"),
    ))
      if (host.shadowRoot) roots.push(host.shadowRoot);
  }
  const candidates = roots.flatMap((root) =>
    Array.from(root.querySelectorAll(`${input.selector}, input, textarea`)),
  );
  for (const element of candidates) {
    const field =
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement;
    const words = [
      element.getAttribute("aria-label"),
      element.getAttribute("name"),
      element.getAttribute("autocomplete"),
      element.getAttribute("placeholder"),
      element.id,
    ].join(" ");
    const sensitive =
      element.matches(input.selector) ||
      (field &&
        /password|secret|token|one.time|verification|credit.card|security.code|passcode|(?:^|[^a-z])(?:cc-|(?:cvc|cvv|pin|otp)(?![a-z]))/i.test(
          words,
        ));
    if (!sensitive) continue;
    element.setAttribute(input.attribute, "true");
    (element as HTMLElement).style?.setProperty(
      "-webkit-text-security",
      "disc",
      "important",
    );
    marked += 1;
  }
  return marked;
}

/** Every frame's sensitive fields masked, and a frame painted since, before any picture is taken. */
async function maskBeforeCapture(page: Page): Promise<void> {
  await Promise.all(
    page.frames().map((frame) =>
      frame
        .evaluate(markSensitiveFields, {
          selector: SENSITIVE_FIELD_SELECTOR,
          attribute: SECRET_ATTRIBUTE,
        })
        .catch(() => 0),
    ),
  );
  await page
    .evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    )
    .catch(() => undefined);
}

export type ClickyFrame = { image: string; width: number; height: number };

/**
 * The picture Clicky's model is shown, no wider than `width`, as a JPEG.
 *
 * Masked first, always: on a desktop the frame is the whole screen, so the browser's sensitive fields
 * are marked before the screen is grabbed; on a page-only computer the page's screenshot also masks
 * them the way the Bot's screenshot does. A desktop with no browser open has nothing to mask.
 */
export async function maskedFrame(input: {
  page: Page | null;
  desktop: Size | null;
  width: number;
  /** `keep`: the part of the screen left visible; everything else is drawn black. */
  captureDesktop: (scale: Size | null, keep: Rect | null) => Promise<Buffer>;
}): Promise<ClickyFrame> {
  const { page, desktop, width } = input;
  if (page) await maskBeforeCapture(page);
  if (desktop) {
    const fit = fitWidth(desktop, width);
    /*
     * Only the Bot's page is shown to the model; the rest of the desktop (a terminal, the files, a
     * notification) is blacked out before the frame leaves this process. With no browser open,
     * nothing is shown at all.
     */
    const keep = page ? await pageRectOnScreen(page, desktop) : null;
    const jpeg = await input.captureDesktop(
      fit.scale < 1 ? fit : null,
      keep ?? { x: 0, y: 0, width: 0, height: 0 },
    );
    return {
      image: jpeg.toString("base64"),
      width: fit.width,
      height: fit.height,
    };
  }
  if (!page)
    throw new Error("The browser is not open, so there is no page to show.");
  const viewport = await viewportOf(page);
  const fit = fitWidth(viewport, width);
  if (fit.scale >= 1) {
    const jpeg = await page.screenshot({
      type: "jpeg",
      quality: 70,
      mask: [page.locator(SENSITIVE_FIELD_SELECTOR)],
    });
    return {
      image: jpeg.toString("base64"),
      width: viewport.width,
      height: viewport.height,
    };
  }
  /*
   * Smaller than the viewport, which Playwright's screenshot cannot do: the protocol's own capture
   * takes a scale. Its clip is in page coordinates, so the scroll position is where the viewport is.
   */
  const scroll = await page.evaluate(() => ({
    x: window.visualViewport?.pageLeft ?? window.scrollX,
    y: window.visualViewport?.pageTop ?? window.scrollY,
  }));
  const session = await page.context().newCDPSession(page);
  try {
    const shot = (await session.send("Page.captureScreenshot", {
      format: "jpeg",
      quality: 70,
      clip: {
        x: scroll.x,
        y: scroll.y,
        width: viewport.width,
        height: viewport.height,
        scale: fit.scale,
      },
    })) as { data: string };
    return { image: shot.data, width: fit.width, height: fit.height };
  } finally {
    await session.detach().catch(() => undefined);
  }
}
