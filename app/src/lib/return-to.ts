/**
 * Where a modal goes back to when it closes.
 *
 * Settings and the Marketplace are routes (`/settings/*`, `/marketplace`) drawn as modals over the
 * app shell, so "close" is a navigation, and the only honest destination is wherever the person
 * was before the modal: the chat they were reading, not `/` and not whatever external page sent
 * them a deep link. The app shell is the one place that knows that, so it calls `rememberReturnTo`
 * for every resolved in-app location that is not itself a modal (any path not under `/settings` or
 * `/marketplace`), and the shells call `readReturnTo` when they close with nowhere else to go.
 *
 * Module memory, deliberately not storage. A remembered path is only meaningful within one page
 * load: after a reload the router already stands on the modal's own URL and the previous location
 * is gone, and the fallback (`/`, which redirects to the last used bot) is the right answer then.
 * Persisting it would also carry a stale chat across sign-outs and between tabs.
 */

/** A path a modal may close back to: in-app, absolute, never a modal of its own. */
export type ReturnTo = string;

let remembered: ReturnTo | null = null;

/** Whether a path is one of the modal surfaces, which must never become a return target. */
export function isModalPath(path: string): boolean {
  return path.startsWith("/settings") || path.startsWith("/marketplace");
}

/**
 * Records the location a modal should close back to.
 *
 * The caller (the app shell's router subscription) is expected to pass only non-modal locations,
 * but the check is repeated here so a modal can never remember itself as its own way out. Pass the
 * full href (`pathname` plus `search`), so closing restores the chat's panel state too.
 */
export function rememberReturnTo(path: ReturnTo): void {
  if (!path.startsWith("/") || isModalPath(path)) return;
  remembered = path;
}

/** The last remembered in-app location, or `fallback` when nothing has been recorded yet. */
export function readReturnTo(fallback: ReturnTo = "/"): ReturnTo {
  return remembered ?? fallback;
}

/** Forgets the remembered location. For tests, and for sign-out. */
export function clearReturnTo(): void {
  remembered = null;
}
