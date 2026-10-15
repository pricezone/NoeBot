import { useSyncExternalStore } from "react";

/**
 * "Say that again": the instruction beside "Show me how"'s pointer types in once more.
 *
 * A count per Bot that the tooltip keys its typing on. The person's own press replays at once (and is
 * spoken at once, in the same press); the server's answer to it, a snapshot that changes nothing but
 * `seq`, arrives a moment later and must not replay it a second time, so a repeat that follows a
 * press here within a few seconds is that press's echo. A repeat asked for somewhere else (the
 * person's phone) replays here too.
 */

const ECHO_MS = 3_000;
const counts = new Map<string, number>();
const pressedAt = new Map<string, number>();
const listeners = new Set<() => void>();

function bump(botId: string) {
  counts.set(botId, (counts.get(botId) ?? 0) + 1);
  for (const listener of listeners) listener();
}

/** The person pressed "Say that again" here. */
export function replayClickyLineNow(botId: string): void {
  pressedAt.set(botId, Date.now());
  bump(botId);
}

/**
 * The session said its line again (a `repeat`, from here or elsewhere). Answers whether it counts as
 * a new replay: false when it is the echo of this tab's own press, which already replayed.
 */
export function replayClickyLineFromServer(botId: string): boolean {
  const pressed = pressedAt.get(botId);
  if (pressed !== undefined && Date.now() - pressed < ECHO_MS) {
    pressedAt.delete(botId);
    return false;
  }
  bump(botId);
  return true;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** How many times this Bot's line has been said again, for keying the tooltip's typing on. */
export function useClickyReplays(botId: string): number {
  return useSyncExternalStore(
    subscribe,
    () => counts.get(botId) ?? 0,
    () => 0,
  );
}

/** Forgets every replay. For tests. */
export function resetClickyReplays(): void {
  counts.clear();
  pressedAt.clear();
  for (const listener of listeners) listener();
}
