/**
 * Where "back" would go, asked of the browser before going there.
 *
 * `computer_back` is a navigation, and a navigation is decided on where it goes: a rule about a
 * site has to see that site, not the page being left. Playwright has no history API, so the tab's
 * own list is read over the DevTools protocol, which every browser here speaks (Chromium only).
 */
import type { Page } from "playwright";

export type HistoryEntry = { url: string; title: string };

export async function previousEntry(
  page: Pick<Page, "context">,
): Promise<HistoryEntry | undefined> {
  const session = await page
    .context()
    .newCDPSession(page as Page)
    .catch(() => undefined);
  if (!session) return undefined;
  try {
    const { currentIndex, entries } = await session.send(
      "Page.getNavigationHistory",
    );
    const entry = entries[currentIndex - 1];
    return entry ? { url: entry.url, title: entry.title } : undefined;
  } catch {
    return undefined;
  } finally {
    await session.detach().catch(() => undefined);
  }
}
