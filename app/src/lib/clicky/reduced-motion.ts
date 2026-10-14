import { useSyncExternalStore } from "react";

/**
 * Whether the person asked their system for less motion, read live.
 *
 * Asked of `matchMedia` on every subscription rather than once per page (as `motion`'s own hook
 * does), so turning the setting on mid-session is honoured at once, and a test can say what it
 * wants by replacing `matchMedia`.
 */
const QUERY = "(prefers-reduced-motion: reduce)";

function media(): MediaQueryList | null {
  return typeof window !== "undefined" &&
    typeof window.matchMedia === "function"
    ? window.matchMedia(QUERY)
    : null;
}

function subscribe(listener: () => void) {
  const list = media();
  list?.addEventListener?.("change", listener);
  return () => list?.removeEventListener?.("change", listener);
}

const read = () => media()?.matches === true;

export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, read, () => false);
}
