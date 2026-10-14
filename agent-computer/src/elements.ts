import type { Page } from "playwright";
import { parseAriaSnapshot } from "./aria-snapshot";
import {
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
 * - `/elements`: the visible controls, each with its ref and its box in SCREEN pixels. On a desktop
 *   the page is a window under the browser's toolbar, so its boxes are moved by where its viewport
 *   starts (`element-geometry.ts`); on a page-only computer the screen is the viewport.
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
/** How many of the snapshot's controls are measured to find those, in priority order. */
const CANDIDATE_LIMIT = 200;
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

export type ScreenElements = {
  screen: Size;
  mode: "desktop" | "page";
  /** Where the browser's window is, on a desktop. */
  window?: { x: number; y: number; innerOffsetX: number; innerOffsetY: number };
  /** The page the boxes belong to; empty when no browser is open. */
  url: string;
  elements: ScreenElement[];
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

/** The visible controls of the page, with their boxes on the screen. */
export async function listScreenElements(
  page: Page,
  desktop: Size | null,
): Promise<ScreenElements> {
  const placement = await placementOf(page, desktop);
  const parsed = parseAriaSnapshot(await page.ariaSnapshot({ mode: "ai" }));
  const candidates = parsed.elements.slice(0, CANDIDATE_LIMIT);
  const measured = await Promise.all(
    candidates.map(async (element) => {
      const locator = page.locator(`aria-ref=${element.ref}`);
      const [box, facts] = await Promise.all([
        locator.boundingBox({ timeout: PROBE_TIMEOUT_MS }).catch(() => null),
        locator
          .evaluate(elementFacts, SENSITIVE_FIELD_SELECTOR, {
            timeout: PROBE_TIMEOUT_MS,
          })
          .catch(() => null),
      ]);
      if (!box || !visibleIn(box, placement.viewport)) return null;
      const onScreen = clipRect(
        pageRectToScreen(clipRect(box, placement.viewport), placement.offset),
        placement.screen,
      );
      if (!(onScreen.width > 0 && onScreen.height > 0)) return null;
      return {
        ref: element.ref,
        role: element.role,
        name: element.name.slice(0, NAME_LIMIT),
        rect: onScreen,
        // A field that cannot be asked is treated as sensitive: see secret-masking.ts.
        sensitive: facts ? facts.sensitive : TYPED_ROLES.has(element.role),
        focused: facts?.focused ?? false,
      } satisfies ScreenElement;
    }),
  );
  return {
    screen: placement.screen,
    mode: placement.mode,
    ...(placement.window ? { window: placement.window } : {}),
    url: page.url(),
    elements: measured
      .filter((element): element is ScreenElement => element !== null)
      .slice(0, ELEMENT_LIMIT),
  };
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
  return {
    role: role.slice(0, 40),
    name: name || role,
    sensitive,
    submits,
    opaque: false,
    inDialog,
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
