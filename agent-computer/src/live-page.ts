// Its own file so a test can reach it without the Playwright import `profiles.ts` carries.

/** Enough of a page for the choice. Keeps this file independent of what else is on one. */
export type OpenPage = { isClosed(): boolean };

/**
 * The page a Bot is on: the open page opened or switched to most recently.
 *
 * The newest open page wins, so a window the site opens becomes the one being watched and driven,
 * and closing it falls back to whatever is still open rather than to a page that has gone.
 * `rankOf` is when a page was last opened or switched to (`computer_tabs`), so a tab the Bot chose
 * stays chosen until something newer opens; pages it does not rank keep their order in the list.
 */
export function chooseLivePage<T extends OpenPage>(
  opened: readonly T[],
  rankOf: (page: T) => number = () => 0,
): T | undefined {
  let best: T | undefined;
  let bestRank = Number.NEGATIVE_INFINITY;
  for (const page of opened) {
    if (page.isClosed()) continue;
    const rank = rankOf(page);
    // `>=`, so among pages of equal rank the later one in the list wins.
    if (rank >= bestRank) {
      best = page;
      bestRank = rank;
    }
  }
  return best;
}
