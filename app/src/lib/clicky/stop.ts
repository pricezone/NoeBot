import type { QueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { keepClickySession, sendClickyCommand } from "./mutations";

/**
 * Stop, now, from wherever the person pressed it: the bar, the shortcut, the live screen's Escape,
 * the app-wide pill.
 *
 * NEVER QUEUED BEHIND ANYTHING, and never silent. It goes straight out, is tried once more if it
 * fails, and if the second try fails too, the Bot is marked here as one whose Stop did not get
 * through (`useClickyStopFailed`): the bar and the stop pill then say "Clicky couldn't be stopped"
 * beside a Stop to press again. The mark clears as soon as a stop gets through.
 */

const RETRY_AFTER_MS = 400;

const failed = new Set<string>();
const listeners = new Set<() => void>();

function mark(botId: string, failing: boolean) {
  if (failed.has(botId) === failing) return;
  if (failing) failed.add(botId);
  else failed.delete(botId);
  for (const listener of listeners) listener();
}

/** Resolves true once the server took the stop, false when it could not be reached twice. */
export async function stopClickyNow(
  queryClient: QueryClient,
  botId: string,
): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await sendClickyCommand(botId, { type: "stop" });
      keepClickySession(queryClient, botId, result.session);
      mark(botId, false);
      return true;
    } catch {
      if (attempt === 0)
        await new Promise((resolve) => setTimeout(resolve, RETRY_AFTER_MS));
    }
  }
  mark(botId, true);
  return false;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Whether the last Stop sent for this Bot failed, twice. */
export function useClickyStopFailed(botId: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => failed.has(botId),
    () => false,
  );
}

/** Forgets every failed stop. For tests. */
export function resetClickyStopFailures(): void {
  failed.clear();
  for (const listener of listeners) listener();
}
