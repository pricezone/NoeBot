/**
 * Where things on the page are on the screen, as plain arithmetic.
 *
 * Clicky (the companion beside the screen, see `docs/clicky-mode-plan.md`) points at elements by their
 * boxes and acts at screen points, and on a desktop the page is one window among others: its
 * viewport starts below the browser's tab strip and toolbar, wherever the window sits. These are the
 * conversions between the two spaces, kept free of Playwright so the tests that check them run where
 * no browser is installed. `elements.ts` asks the page for the numbers and does the rest here.
 */

export type Size = { width: number; height: number };
export type Point = { x: number; y: number };
export type Rect = { x: number; y: number; width: number; height: number };

/** What the page says about its own window, read with `window.screenX` and friends. */
export type PageWindow = {
  screenX: number;
  screenY: number;
  outerWidth: number;
  outerHeight: number;
  innerWidth: number;
  innerHeight: number;
};

/**
 * Where the page's viewport starts on the screen.
 *
 * The window's position plus whatever of its outer size is not page, which on a maximized Chromium
 * is the tab strip and toolbar above it. The same reading `demonstration.ts` uses to place a person's
 * gesture in the page, so a box drawn here and a click recorded there agree.
 */
export function pageOffset(view: PageWindow): Point {
  return {
    x: finite(view.screenX) + Math.max(0, view.outerWidth - view.innerWidth),
    y: finite(view.screenY) + Math.max(0, view.outerHeight - view.innerHeight),
  };
}

/** The `window` field of `/elements`: the window's corner and how far in its viewport begins. */
export function windowPlacement(view: PageWindow): {
  x: number;
  y: number;
  innerOffsetX: number;
  innerOffsetY: number;
} {
  return {
    x: finite(view.screenX),
    y: finite(view.screenY),
    innerOffsetX: Math.max(0, view.outerWidth - view.innerWidth),
    innerOffsetY: Math.max(0, view.outerHeight - view.innerHeight),
  };
}

export function pageRectToScreen(rect: Rect, offset: Point): Rect {
  return { ...rect, x: rect.x + offset.x, y: rect.y + offset.y };
}

/**
 * A screen point in page coordinates, or null when it is not on the page: the browser's own toolbar,
 * another window, the dock. Nothing on the page can be asked about a point that is not on it.
 */
export function screenPointToPage(
  point: Point,
  offset: Point,
  viewport: Size,
): Point | null {
  const x = point.x - offset.x;
  const y = point.y - offset.y;
  if (x < 0 || y < 0 || x >= viewport.width || y >= viewport.height)
    return null;
  return { x, y };
}

/** Whether a box shows any area at all inside the bounds. */
export function visibleIn(rect: Rect, bounds: Size): boolean {
  if (!(rect.width > 0 && rect.height > 0)) return false;
  return (
    rect.x < bounds.width &&
    rect.y < bounds.height &&
    rect.x + rect.width > 0 &&
    rect.y + rect.height > 0
  );
}

/** The part of a box inside the bounds, so a highlight never runs off the screen. */
export function clipRect(rect: Rect, bounds: Size): Rect {
  const left = Math.max(0, rect.x);
  const top = Math.max(0, rect.y);
  const right = Math.min(bounds.width, rect.x + rect.width);
  const bottom = Math.min(bounds.height, rect.y + rect.height);
  return {
    x: round(left),
    y: round(top),
    width: round(Math.max(0, right - left)),
    height: round(Math.max(0, bottom - top)),
  };
}

export function contains(rect: Rect, point: Point): boolean {
  return (
    point.x >= rect.x &&
    point.y >= rect.y &&
    point.x <= rect.x + rect.width &&
    point.y <= rect.y + rect.height
  );
}

/**
 * The innermost element under a point: of every box that contains it, the smallest. A button inside
 * a card is what a person pointing at the button means, not the card.
 */
export function smallestContaining<T extends { rect: Rect }>(
  point: Point,
  elements: readonly T[],
): T | undefined {
  let best: T | undefined;
  for (const element of elements) {
    if (!contains(element.rect, point)) continue;
    if (
      !best ||
      element.rect.width * element.rect.height <
        best.rect.width * best.rect.height
    )
      best = element;
  }
  return best;
}

/**
 * The size a frame is drawn at for a model: never wider than asked, never larger than it is, and the
 * height scaled with it. `scale` is what to multiply a screen pixel by.
 */
export function fitWidth(size: Size, width: number): Size & { scale: number } {
  if (!(size.width > 0 && size.height > 0))
    return { width: 0, height: 0, scale: 1 };
  if (size.width <= width) return { ...size, scale: 1 };
  const scale = width / size.width;
  // Even dimensions, which the JPEG encoder on the desktop path asks for.
  const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);
  return {
    width: even(size.width * scale),
    height: even(size.height * scale),
    scale,
  };
}

/** `?width=` on a frame request: a whole number of pixels in range, or the default. */
export function frameWidthFrom(
  raw: string | null | undefined,
  { fallback, min, max }: { fallback: number; min: number; max: number },
): number {
  if (raw === null || raw === undefined || raw.trim() === "") return fallback;
  if (!/^\d{1,5}$/.test(raw.trim())) return fallback;
  return Math.min(max, Math.max(min, Number(raw.trim())));
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
