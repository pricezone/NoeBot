import { useCallback, useEffect, useState } from "react";

type Point = { x: number; y: number };

export type EyeShiftOptions = {
  /**
   * `page`: the eyes follow the pointer anywhere on the page, for as long as it is on the page (the
   * deploy form's mascot). `hover`: they start following when the pointer comes onto the face, and
   * keep following for `lingerMs` after it leaves, then look ahead again (every avatar).
   */
  follow?: "page" | "hover";
  /** How long a hovered face keeps watching the pointer after it has left. */
  lingerMs?: number;
  /** Farthest the eyes travel from their rest, in viewBox units (whole cells once rounded). */
  maxShift?: number;
  /** Pointer distance, in viewBox units, at which the eyes have travelled half of `maxShift`. */
  softRadius?: number;
  /** The face's centre in viewBox units, where the eyes rest. */
  centreX?: number;
  centreY?: number;
};

const REST: readonly [number, number] = [0, 0];
const EASE = 0.22;
const EPSILON = 0.005;

const toward = (
  centre: Point,
  target: Point,
  maxShift: number,
  softRadius: number,
): Point => {
  const dx = target.x - centre.x;
  const dy = target.y - centre.y;
  const distance = Math.hypot(dx, dy);
  if (distance === 0) return { x: 0, y: 0 };
  const shift = (maxShift * distance) / (distance + softRadius);
  return { x: (dx / distance) * shift, y: (dy / distance) * shift };
};

/**
 * Where a pixel face looks: the pointer's pull on its eyes, eased, as whole cells left/right and
 * up/down for `NoeBotSprite`'s `eyeShift`, which moves the eye holes inside the face.
 *
 * Returns the shift and a ref for the face's `<svg>`; the pointer is measured against that svg's
 * box and its viewBox. Re-renders only when the whole-cell answer changes. Rests dead centre when
 * the pointer leaves (after the linger, on hover), when the tab is hidden, under reduced motion,
 * and for touch, which has no pointer to follow.
 *
 * A face being hovered is small and the pointer is on it, so `hover` pulls hard from close by (a
 * soft radius of a few cells); the deploy form's mascot watches a pointer that is usually far away,
 * so `page` pulls gently over the whole page.
 */
export const useEyeShift = (
  isReducedMotion: boolean,
  {
    follow = "hover",
    lingerMs = 1500,
    maxShift = 1.4,
    softRadius = follow === "page" ? 24 : 4,
    centreX = 7,
    centreY = 6,
  }: EyeShiftOptions = {},
): readonly [
  readonly [number, number],
  (element: SVGSVGElement | null) => void,
] => {
  const [element, setElement] = useState<SVGSVGElement | null>(null);
  const [shift, setShift] = useState<readonly [number, number]>([0, 0]);
  const ref = useCallback((node: SVGSVGElement | null) => setElement(node), []);

  useEffect(() => {
    if (!element || isReducedMotion) return undefined;
    const centre = { x: centreX, y: centreY };
    const controller = new AbortController();
    const { signal } = controller;
    let watching: AbortController | null = null;
    let frame = 0;
    let linger: ReturnType<typeof setTimeout> | undefined;
    let isDisposed = false;
    let following = follow === "page";
    let pointer: Point | null = null;
    const offset: Point = { x: 0, y: 0 };
    let shown: readonly [number, number] = [0, 0];

    const stop = () => {
      cancelAnimationFrame(frame);
      frame = 0;
    };

    const step = () => {
      frame = 0;
      if (isDisposed) return;
      const rect = element.getBoundingClientRect();
      const viewBox = element.viewBox.baseVal;
      if (
        rect.width === 0 ||
        rect.height === 0 ||
        !viewBox ||
        viewBox.width === 0
      )
        return;
      const goal =
        following && pointer
          ? toward(
              centre,
              {
                x:
                  viewBox.x +
                  ((pointer.x - rect.left) / rect.width) * viewBox.width,
                y:
                  viewBox.y +
                  ((pointer.y - rect.top) / rect.height) * viewBox.height,
              },
              maxShift,
              softRadius,
            )
          : { x: 0, y: 0 };
      offset.x += (goal.x - offset.x) * EASE;
      offset.y += (goal.y - offset.y) * EASE;
      const isSettled =
        Math.abs(goal.x - offset.x) <= EPSILON &&
        Math.abs(goal.y - offset.y) <= EPSILON;
      if (isSettled) {
        offset.x = goal.x;
        offset.y = goal.y;
      }
      const next: readonly [number, number] = [
        Math.round(offset.x),
        Math.round(offset.y),
      ];
      if (next[0] !== shown[0] || next[1] !== shown[1]) {
        shown = next;
        setShift(next);
      }
      if (!isSettled) frame = requestAnimationFrame(step);
    };

    const start = () => {
      if (frame || isDisposed || document.hidden) return;
      frame = requestAnimationFrame(step);
    };

    const onMove = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      pointer = { x: event.clientX, y: event.clientY };
      start();
    };

    // The window is only listened to while the eyes are following: a roster of idle avatars adds
    // nothing to every pointer move on the page.
    const watch = () => {
      if (watching) return;
      watching = new AbortController();
      window.addEventListener("pointermove", onMove, {
        passive: true,
        signal: watching.signal,
      });
    };
    const unwatch = () => {
      watching?.abort();
      watching = null;
    };

    if (follow === "page") {
      watch();
      document.documentElement.addEventListener(
        "pointerleave",
        (event) => {
          if (event.pointerType === "touch") return;
          pointer = null;
          start();
        },
        { signal },
      );
    } else {
      element.addEventListener(
        "pointerenter",
        (event) => {
          if (event.pointerType === "touch") return;
          clearTimeout(linger);
          following = true;
          pointer = { x: event.clientX, y: event.clientY };
          watch();
          start();
        },
        { signal },
      );
      element.addEventListener(
        "pointerleave",
        (event) => {
          if (event.pointerType === "touch") return;
          clearTimeout(linger);
          linger = setTimeout(() => {
            following = false;
            pointer = null;
            unwatch();
            start();
          }, lingerMs);
        },
        { signal },
      );
    }

    document.addEventListener(
      "visibilitychange",
      () => {
        if (document.hidden) {
          pointer = null;
          stop();
        } else {
          start();
        }
      },
      { signal },
    );

    return () => {
      isDisposed = true;
      clearTimeout(linger);
      stop();
      unwatch();
      controller.abort();
      // The next subscription starts from rest, so the shift it reports must too.
      setShift(REST);
    };
  }, [
    element,
    isReducedMotion,
    follow,
    lingerMs,
    maxShift,
    softRadius,
    centreX,
    centreY,
  ]);

  // Without a face to measure, or under reduced motion, the eyes rest, whatever was last seen.
  return [element && !isReducedMotion ? shift : REST, ref] as const;
};
