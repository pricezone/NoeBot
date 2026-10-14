import { useSyncExternalStore } from "react";

/**
 * Which Bots' Clicky sessions this tab is showing right now, and whether a full-window viewer is one
 * of the things showing it.
 *
 * Read by the app-wide stop pill and the Stop shortcut (`clicky-stop-pill.tsx`), which have to know
 * what "the Clicky session the person has open" means without being inside the viewer that opened
 * it. Counted, because a Bot's session can be on screen in several places at once.
 */

export type ShownClickySession = { botId: string; inViewer: boolean };

const counts = new Map<string, { viewer: number; preview: number }>();
const listeners = new Set<() => void>();
let snapshot: readonly ShownClickySession[] = [];

function publish() {
  snapshot = [...counts].map(([botId, count]) => ({
    botId,
    inViewer: count.viewer > 0,
  }));
  for (const listener of listeners) listener();
}

/** Marks a Bot's session as on screen; the returned function takes it off again. */
export function showClickySession(
  botId: string,
  surface: "viewer" | "preview",
): () => void {
  const count = counts.get(botId) ?? { viewer: 0, preview: 0 };
  count[surface] += 1;
  counts.set(botId, count);
  publish();
  let hidden = false;
  return () => {
    if (hidden) return;
    hidden = true;
    const current = counts.get(botId);
    if (!current) return;
    current[surface] -= 1;
    if (current.viewer + current.preview <= 0) counts.delete(botId);
    publish();
  };
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const read = () => snapshot;

export function useShownClickySessions(): readonly ShownClickySession[] {
  return useSyncExternalStore(subscribe, read, read);
}
