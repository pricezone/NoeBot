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
 */
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
 * Records `agentId` as the Bot to land on next time.
 *
 * A failed write is swallowed whole: the conversation that triggered it is already open, and the
 * only cost of the miss is landing somewhere else after the next reload.
 */
export function rememberLastBot(
  agentId: string,
  storage?: LastBotStorage,
): void {
  try {
    const store = storage ?? window.localStorage;
    store.setItem(LAST_BOT_STORAGE_KEY, agentId);
  } catch {
    // As above: this visit is unaffected, it just will not be remembered.
  }
}
