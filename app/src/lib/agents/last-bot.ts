/**
 * The Bot somebody talked to last, remembered across reloads.
 *
 * Home no longer shows a blank composer: it lands on a conversation, and the one it picks is the
 * Bot this person was with most recently (see `lib/landing.ts`). That choice has to survive a
 * reload and a closed tab, so it lives in storage in the same shape as the sidebar preference next
 * door — one key, a reader that distrusts what it finds, a writer that cannot throw.
 *
 * Written from two places: the channel route, when a conversation with one Bot is open, and
 * `lib/channels/start.ts`, when a brand-new channel is created — the second so a conversation that
 * was just started counts before its route has even mounted.
 *
 * Read from a component through `useLastBot`, never `readLastBot` during render: storage is not
 * something React watches, so a value read bare only looks fresh until the next unrelated
 * re-render. The writer notifies, and the hook subscribes, so the sidebar's featured Bot changes
 * in the commit after the channel route records a new one.
 */
import { useSyncExternalStore } from "react";

export const LAST_BOT_STORAGE_KEY = "openbot.last-bot";

/** The slice of `Storage` this module touches, so a test can pass a plain object. */
type LastBotStorage = Pick<Storage, "getItem" | "setItem">;

/**
 * Only a non-blank stored value names a Bot.
 *
 * The id is used as a lookup key against the loaded roster, never trusted on its own: a stale id
 * from a deleted Bot simply matches nothing and the landing falls back. What this guards against
 * is the value that is not an id at all — an empty string, whitespace, a key somebody else's
 * script cleared — which would otherwise read as "a Bot called ''".
 */
export function parseStoredLastBot(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * The remembered Bot id, or null when nothing usable is stored.
 *
 * The storage is resolved inside the try as well as read there: a private window can throw on the
 * mere access of `window.localStorage`, not only on the read, and under test there is no `window`
 * at all unless a fake storage is passed.
 */
export function readLastBot(storage?: LastBotStorage): string | null {
  try {
    const store = storage ?? window.localStorage;
    return parseStoredLastBot(store.getItem(LAST_BOT_STORAGE_KEY));
  } catch {
    // Storage can be unavailable, blocked or full. Nothing remembered is the honest answer.
    return null;
  }
}

/**
 * Who wants to know when the remembered Bot changes.
 *
 * Module-level, like the key: there is one storage slot and so one set of watchers for it. Only
 * writes to the real `window.localStorage` are announced — a test's fake storage is not what the
 * hook below reads, so a write there would wake subscribers to a value that has not changed.
 */
const listeners = new Set<() => void>();

function notifyLastBotListeners(): void {
  for (const listener of listeners) listener();
}

/**
 * Watch the remembered Bot. Returns the function that stops watching.
 *
 * Two sources: this tab's own writes, through `rememberLastBot`, and other tabs' writes, through
 * the window's `storage` event — which fires only in the tabs that did not write, so the two
 * never double up. The event wiring is guarded the way the reads are: under test there may be no
 * `window`, and a page with storage blocked must still get the in-process half.
 */
export function subscribeLastBot(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === LAST_BOT_STORAGE_KEY) listener();
  };
  let watchingWindow = false;
  try {
    if (typeof window !== "undefined") {
      window.addEventListener("storage", onStorage);
      watchingWindow = true;
    }
  } catch {
    // No window to watch. This tab's own writes still arrive through the set above.
  }
  return () => {
    listeners.delete(listener);
    if (watchingWindow) window.removeEventListener("storage", onStorage);
  };
}

/**
 * The remembered Bot id as React state: null when nothing usable is stored, and re-read whenever
 * `rememberLastBot` records a different one.
 *
 * The snapshot is a string or null, so `useSyncExternalStore` compares it by value and a
 * notification that changed nothing does not re-render. The server snapshot is null because
 * there is no storage to read on a server, and this app does not render there anyway.
 */
export function useLastBot(): string | null {
  return useSyncExternalStore(
    subscribeLastBot,
    () => readLastBot(),
    () => null,
  );
}

/**
 * Records `agentId` as the Bot to land on next time.
 *
 * A failed write is swallowed whole: the conversation that triggered it is already open, and the
 * only cost of the miss is landing somewhere else after the next reload.
 *
 * Subscribers hear about it only when the stored value actually changed, and only for the real
 * storage: re-opening the same conversation writes the same id, and waking the sidebar for that
 * would re-run its reads for nothing.
 */
export function rememberLastBot(
  agentId: string,
  storage?: LastBotStorage,
): void {
  try {
    const store = storage ?? window.localStorage;
    const previous = parseStoredLastBot(store.getItem(LAST_BOT_STORAGE_KEY));
    store.setItem(LAST_BOT_STORAGE_KEY, agentId);
    if (!storage && previous !== agentId) notifyLastBotListeners();
  } catch {
    // As above: this visit is unaffected, it just will not be remembered.
  }
}
