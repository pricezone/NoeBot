import {
  type ClickyOverlay,
  type ClickyPoint,
  type ClickyRect,
  clampUnit,
} from "../../../shared/clicky";
import type { ScreenElements } from "../computer/schema";

/**
 * Between the computer's screen pixels and Clicky's normalized screen.
 *
 * Overlays are fractions of the screen (0–1 from the top-left) so the same pointer fits the full
 * viewer, the inline preview and a phone's thumbnail. The computer measures elements in screen pixels
 * (`/elements`), the model answers on a 1000×1000 grid, and an action is carried out in screen pixels
 * again; these are the conversions, and the rule that puts a model's guess on a real element when
 * one is close.
 */

/** An element on the normalized screen. */
export type PlacedElement = {
  ref: string;
  role: string;
  name: string;
  rect: ClickyRect;
  sensitive: boolean;
  focused: boolean;
};

/** Where Clicky points: a box when there is an element, always a point, and how sure it is. */
export type PlacedTarget = {
  point: ClickyPoint;
  rect?: ClickyRect;
  ref?: string;
  /** No element was found at or near the spot the model named: "around here". */
  approximate: boolean;
};

/** How close a guessed point must be to an element, as a fraction of the screen, to snap onto it. */
export const SNAP_DISTANCE = 0.04;

/** The size of the model's grid. */
export const GRID = 1000;

export function normalizedRect(
  rect: { x: number; y: number; width: number; height: number },
  screen: { width: number; height: number },
): ClickyRect {
  if (!(screen.width > 0 && screen.height > 0))
    return { x: 0, y: 0, width: 0, height: 0 };
  const x = clampUnit(rect.x / screen.width);
  const y = clampUnit(rect.y / screen.height);
  return {
    x,
    y,
    width: Math.min(1 - x, clampUnit(rect.width / screen.width)),
    height: Math.min(1 - y, clampUnit(rect.height / screen.height)),
  };
}

export function placeElements(found: ScreenElements): PlacedElement[] {
  return found.elements.map((element) => ({
    ref: element.ref,
    role: element.role,
    name: element.name,
    rect: normalizedRect(element.rect, found.screen),
    sensitive: element.sensitive,
    focused: element.focused,
  }));
}

export function centerOf(rect: ClickyRect): ClickyPoint {
  return {
    x: clampUnit(rect.x + rect.width / 2),
    y: clampUnit(rect.y + rect.height / 2),
  };
}

/** A normalized point as screen pixels, inside the screen. */
export function toScreenPixels(
  point: ClickyPoint,
  screen: { width: number; height: number },
): { x: number; y: number } {
  return {
    x: Math.min(
      Math.max(0, Math.round(clampUnit(point.x) * screen.width)),
      Math.max(0, screen.width - 1),
    ),
    y: Math.min(
      Math.max(0, Math.round(clampUnit(point.y) * screen.height)),
      Math.max(0, screen.height - 1),
    ),
  };
}

/** A number on the model's grid as a fraction of the screen; anything unreadable is null. */
export function fromGrid(value: unknown): number | null {
  const number = typeof value === "string" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isFinite(number)) return null;
  return clampUnit(number / GRID);
}

/** A rect as the model's grid numbers, for the element list it reads. */
export function toGrid(rect: ClickyRect): [number, number, number, number] {
  return [
    Math.round(rect.x * GRID),
    Math.round(rect.y * GRID),
    Math.round(rect.width * GRID),
    Math.round(rect.height * GRID),
  ];
}

function contains(rect: ClickyRect, point: ClickyPoint): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

/** Distance from a point to the nearest edge of a box; zero inside it. */
function distanceTo(rect: ClickyRect, point: ClickyPoint): number {
  const dx = Math.max(rect.x - point.x, 0, point.x - (rect.x + rect.width));
  const dy = Math.max(rect.y - point.y, 0, point.y - (rect.y + rect.height));
  return Math.hypot(dx, dy);
}

const area = (rect: ClickyRect) => rect.width * rect.height;

/** The element a ref names, if it is on the screen now. */
export function elementByRef(
  elements: readonly PlacedElement[],
  ref: string | undefined,
): PlacedElement | undefined {
  return ref ? elements.find((element) => element.ref === ref) : undefined;
}

/**
 * The element a point means: the innermost box containing it, or else the nearest one within
 * {@link SNAP_DISTANCE}. A model's coordinates are a guess at a picture; an element's box is where
 * the control really is.
 */
export function elementNear(
  elements: readonly PlacedElement[],
  point: ClickyPoint,
): PlacedElement | undefined {
  let inside: PlacedElement | undefined;
  for (const element of elements)
    if (
      contains(element.rect, point) &&
      (!inside || area(element.rect) < area(inside.rect))
    )
      inside = element;
  if (inside) return inside;
  let nearest: { element: PlacedElement; distance: number } | undefined;
  for (const element of elements) {
    const distance = distanceTo(element.rect, point);
    if (distance <= SNAP_DISTANCE && (!nearest || distance < nearest.distance))
      nearest = { element, distance };
  }
  return nearest?.element;
}

/** A placed element as a target. */
export function targetOf(element: PlacedElement): PlacedTarget {
  return {
    point: centerOf(element.rect),
    rect: element.rect,
    ref: element.ref,
    approximate: false,
  };
}

/**
 * Where to point for a model's answer: its ref if that element is on screen, else its box or point
 * snapped onto an element near it, else the spot it named marked approximate. Null when it named
 * nothing usable at all.
 */
export function placeTarget(
  elements: readonly PlacedElement[],
  spec: { ref?: string; point?: ClickyPoint; box?: ClickyRect },
): PlacedTarget | null {
  const named = elementByRef(elements, spec.ref);
  if (named) return targetOf(named);
  const point = spec.box ? centerOf(spec.box) : spec.point;
  if (!point) return null;
  const near = elementNear(elements, point);
  if (near) return targetOf(near);
  return {
    point,
    ...(spec.box ? { rect: spec.box } : {}),
    approximate: true,
  };
}

/** What Clicky draws for a target: a box around the element and its pointer beside it. */
export function overlaysFor(
  target: PlacedTarget,
  newId: () => string,
  label?: string,
): ClickyOverlay[] {
  const short = label?.trim().slice(0, 200);
  return [
    ...(target.rect && target.rect.width > 0 && target.rect.height > 0
      ? [{ kind: "highlight" as const, id: newId(), rect: target.rect }]
      : []),
    {
      kind: "pointer" as const,
      id: newId(),
      at: target.point,
      ...(short ? { label: short } : {}),
      ...(target.approximate ? { approximate: true } : {}),
    },
  ];
}
