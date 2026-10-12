import { useEffect, useRef, useState } from "react";

/**
 * One clock for every sprite on the page.
 *
 * A roster can show twenty faces; twenty `requestAnimationFrame` loops would each wake the main
 * thread for the same frame. One loop runs while anybody is subscribed, hands every subscriber the
 * same `now`, and stops when the tab is hidden or the last subscriber leaves. A subscriber decides
 * for itself whether this `now` changes what it draws (terminal mode only re-renders on a new
 * 12 fps frame), so the clock itself never re-renders anything.
 */

type Listener = (now: number) => void;

const listeners = new Set<Listener>();
let handle = 0;
let watchingVisibility = false;

const nowSeconds = (): number =>
  (typeof performance !== "undefined" ? performance.now() : Date.now()) / 1000;

const tick = () => {
  handle = 0;
  const now = nowSeconds();
  for (const listener of listeners) listener(now);
  if (listeners.size) handle = requestAnimationFrame(tick);
};

const start = () => {
  if (handle || !listeners.size) return;
  if (typeof document !== "undefined" && document.hidden) return;
  handle = requestAnimationFrame(tick);
};

const stop = () => {
  if (!handle) return;
  cancelAnimationFrame(handle);
  handle = 0;
};

const watchVisibility = () => {
  if (watchingVisibility || typeof document === "undefined") return;
  watchingVisibility = true;
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stop();
    else start();
  });
};

export const subscribeClock = (listener: Listener): (() => void) => {
  watchVisibility();
  listeners.add(listener);
  start();
  return () => {
    listeners.delete(listener);
    if (!listeners.size) stop();
  };
};

export { nowSeconds };

/**
 * Seconds since `startedAt`, re-rendering only when the frame changes: at `fps` frames a second,
 * or every animation frame when `fps` is null. Inactive, it holds still at `t = 0`.
 */
export function useAnimationTime(
  active: boolean,
  fps: number | null,
  startedAt: number,
): number {
  const [time, setTime] = useState(0);
  const frame = useRef(-1);
  useEffect(() => {
    if (!active) {
      frame.current = -1;
      return undefined;
    }
    return subscribeClock((now) => {
      const t = Math.max(0, now - startedAt);
      const key = Math.floor(t * (fps ?? 120));
      if (key === frame.current) return;
      frame.current = key;
      setTime(t);
    });
  }, [active, fps, startedAt]);
  return active ? time : 0;
}
