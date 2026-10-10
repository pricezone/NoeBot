import { useCallback, useState } from "react";

/**
 * Which sidebar sections are folded shut, remembered in this browser.
 *
 * Local on purpose: folding a heading is about the screen in front of you, the way the sidebar's
 * own open state is (`lib/sidebar.ts`), and a phone with less room can reasonably keep different
 * ones shut from the laptop. The sections themselves, and which chats are in them, are the
 * server's.
 */
export const COLLAPSED_SECTIONS_STORAGE_KEY =
  "openbot.sidebar.collapsed-sections";

/**
 * Only an array of strings is a list of folded sections. Anything else — a key never written, a
 * value from another build, a stray string — folds nothing, because a heading shut by mistake hides
 * conversations behind it while one left open costs a click.
 */
export function parseCollapsedSections(value: string | null): Set<string> {
  if (!value) return new Set();
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? new Set(parsed.filter((id): id is string => typeof id === "string"))
      : new Set();
  } catch {
    return new Set();
  }
}

function readCollapsed(): Set<string> {
  try {
    return parseCollapsedSections(
      window.localStorage.getItem(COLLAPSED_SECTIONS_STORAGE_KEY),
    );
  } catch {
    // Storage blocked or unavailable: everything open is the honest default.
    return new Set();
  }
}

function writeCollapsed(collapsed: Set<string>) {
  try {
    window.localStorage.setItem(
      COLLAPSED_SECTIONS_STORAGE_KEY,
      JSON.stringify([...collapsed]),
    );
  } catch {
    // Remembering is a courtesy; the fold still applies for as long as this page is open.
  }
}

/**
 * The folded set and a toggle for one section. Read once, when the sidebar mounts; written on every
 * toggle. A deleted section's id stays in the stored list until it is toggled, which costs a few
 * bytes and nothing else: no heading carries that id any more.
 */
export function useCollapsedSections(): {
  isCollapsed: (sectionId: string) => boolean;
  toggle: (sectionId: string) => void;
} {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const toggle = useCallback((sectionId: string) => {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(sectionId)) next.delete(sectionId);
      else next.add(sectionId);
      writeCollapsed(next);
      return next;
    });
  }, []);
  const isCollapsed = useCallback(
    (sectionId: string) => collapsed.has(sectionId),
    [collapsed],
  );
  return { isCollapsed, toggle };
}
