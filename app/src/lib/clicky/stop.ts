import type { QueryClient } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";
import type { ClickySession } from "../../../../shared/clicky";
import { keepClickySession, sendClickyCommand } from "./mutations";
import { clickyKeys } from "./queries";

/**
 * Stop, now, from wherever the person pressed it: the bar, the shortcut, the live screen's Escape,
 * the app-wide pill.
 *
 * NEVER QUEUED BEHIND ANYTHING, and never silent. It goes straight out, is tried once more if it
 * fails, and if the second try fails too, the Bot is marked here as one whose Stop did not get
 * through (`useClickyStopFailed`): the bar and the stop pill then say "Couldn't stop" beside a Stop
 * to press again. The mark clears as soon as a stop gets through.
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

const sleeping = new Set<string>();

/**
 * "Show me how" goes to sleep: its pointer, its instruction and anything it was doing or asking go
 * away (`sleep` in `shared/clicky-state.ts`; the server also hands back control it took to guide).
 * For the viewer being minimized or closed. Sent only for a session this tab holds awake (or still
 * showing Stop), and once at a time per Bot, so minimizing and the viewer closing after it do not
 * send it twice. Fails quietly: the session is left as the server has it.
 */
export async function sleepClickyNow(
  queryClient: QueryClient,
  botId: string,
): Promise<void> {
  const session = queryClient.getQueryData<ClickySession>(
    clickyKeys.session(botId),
  );
  if (!session || (!session.awake && session.state === "idle")) return;
  if (sleeping.has(botId)) return;
  sleeping.add(botId);
  try {
    const result = await sendClickyCommand(botId, { type: "sleep" });
    keepClickySession(queryClient, botId, result.session);
  } catch {
    // Nothing to tell anybody: the viewer has gone. The server's own idle rules still apply.
  } finally {
    sleeping.delete(botId);
  }
}

const closing = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Puts "Show me how" to sleep when the surface showing it goes away, while `enabled`.
 *
 * A moment after, not at once: React mounts a component twice in development (StrictMode) and the
 * second mount, straight after the first one's cleanup, would otherwise wake to a session it had
 * just put to sleep. A mount within that moment keeps it awake.
 */
export function useClickySleepOnClose(
  queryClient: QueryClient,
  botId: string,
  enabled: boolean,
): void {
  useEffect(() => {
    if (!enabled) return;
    const pending = closing.get(botId);
    if (pending !== undefined) {
      clearTimeout(pending);
      closing.delete(botId);
    }
    return () => {
      closing.set(
        botId,
        setTimeout(() => {
          closing.delete(botId);
          void sleepClickyNow(queryClient, botId);
        }, 0),
      );
    };
  }, [queryClient, botId, enabled]);
}
