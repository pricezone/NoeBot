import { useEffect, useRef } from "react";

/**
 * "Open this Bot's screen for Clicky", asked by something that does not hold the viewer.
 *
 * When the Bot needs the person and Clicky opens by itself (`lib/computers/attention.ts`), the panel
 * opens on the Computer tab, and this asks the panel's card to open its full-window viewer, where
 * Clicky's pointer and bar are. A request is KEPT until a card takes it, because the panel may only
 * be mounting as it is made, and dropped after two minutes, so a card mounted much later does not
 * spring a viewer on somebody who has moved on.
 */

const REQUEST_TTL_MS = 2 * 60_000;
const requests = new Map<string, number>();
const listeners = new Set<() => void>();

export function requestClickyViewer(botId: string): void {
  requests.set(botId, Date.now());
  for (const listener of listeners) listener();
}

/** Takes a waiting request for this Bot, once; true when there was a fresh one. */
export function takeClickyViewerRequest(botId: string): boolean {
  const at = requests.get(botId);
  if (at === undefined) return false;
  requests.delete(botId);
  return Date.now() - at <= REQUEST_TTL_MS;
}

/** Calls `open` whenever a request for this Bot's viewer is waiting, while `enabled`. */
export function useClickyViewerRequest(
  botId: string,
  enabled: boolean,
  open: () => void,
): void {
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    if (!enabled) return;
    const check = () => {
      if (takeClickyViewerRequest(botId)) openRef.current();
    };
    check();
    listeners.add(check);
    return () => {
      listeners.delete(check);
    };
  }, [botId, enabled]);
}
