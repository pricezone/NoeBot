import { z } from "zod";

/**
 * The bot panel beside a conversation: whether it is open, and which tab it shows.
 *
 * Two different facts, kept in two different places. Whether the panel is open is a preference —
 * somebody who closed it wants it to stay closed through a reload and the next conversation — so
 * it lives in storage, in the same shape as the sidebar preference next door (`lib/sidebar.ts`).
 * Which tab it shows is a navigation — a link can open a Bot on its screen, Back can leave it — so
 * that lives in the URL as `?panel=`. The URL never decides whether the panel is open: a link that
 * names a tab opens it for that visit, and nothing more.
 */
export const BOT_PANEL_STORAGE_KEY = "openbot.bot-panel";

export const BOT_PANEL_TABS = ["details", "library", "computer"] as const;
export type BotPanelTab = (typeof BOT_PANEL_TABS)[number];

/**
 * Only the exact stored `closed` starts the panel closed.
 *
 * Everything else opens it: a key never written, a value from an older build, a value somebody
 * else's script left behind. The panel is where the Bot's screen is, and the two mistakes do not
 * cost the same — opening a panel somebody wanted shut costs them one click, while shutting one on
 * a guess hides the screen they came to watch.
 */
export function parseStoredBotPanelOpen(value: string | null): boolean {
  return value !== "closed";
}

/** The slice of `Storage` this module touches, so a test can pass a plain object. */
type BotPanelStorage = Pick<Storage, "getItem" | "setItem">;

/**
 * The remembered preference, open unless somebody closed it.
 *
 * The storage is resolved inside the try as well as read there: a private window can throw on the
 * mere access of `window.localStorage`, not only on the read, and under test there is no `window`
 * at all unless a fake storage is passed.
 */
export function readBotPanelOpen(storage?: BotPanelStorage): boolean {
  try {
    const store = storage ?? window.localStorage;
    return parseStoredBotPanelOpen(store.getItem(BOT_PANEL_STORAGE_KEY));
  } catch {
    // Storage can be unavailable, blocked or full. Open is the default either way.
    return true;
  }
}

/**
 * Records the preference. Only an explicit choice — the close X, the pill, the header toggle —
 * calls this; a panel that opened itself because the Bot started using its computer never does,
 * so an explicit close survives the Bot's next run and a reload.
 */
export function applyBotPanelOpen(
  open: boolean,
  storage?: BotPanelStorage,
): void {
  try {
    const store = storage ?? window.localStorage;
    store.setItem(BOT_PANEL_STORAGE_KEY, open ? "open" : "closed");
  } catch {
    // As above: this visit is unaffected, it just will not be remembered.
  }
}

/**
 * The `?panel=` search parameter, with the two parameters it replaces.
 *
 * `?settings=true` used to open the coworker card and `?watch=true` the Bot's screen, in the same
 * pane. Links to both are still out there — sign-in hands off to `/bot?watch=true`, and a browser
 * history is full of them — so both still parse, and each becomes the tab it meant. A `panel` that
 * is named wins over either; the legacy keys never reach the route.
 */
export const botPanelSearchShape = {
  panel: z.enum(BOT_PANEL_TABS).optional(),
  settings: z.boolean().optional(),
  watch: z.boolean().optional(),
};

type LegacyPanelSearch = {
  panel?: BotPanelTab | undefined;
  settings?: boolean | undefined;
  watch?: boolean | undefined;
};

/**
 * The parsed search with the legacy keys folded into `panel` and dropped. Generic over the rest
 * of the search, so a route with parameters of its own (`/bot`'s `agent`) keeps them as they are.
 */
export function normalizeBotPanelSearch<T extends LegacyPanelSearch>({
  panel,
  settings,
  watch,
  ...rest
}: T): Omit<T, keyof LegacyPanelSearch> & { panel?: BotPanelTab } {
  const tab: BotPanelTab | undefined =
    panel ??
    (settings === true ? "details" : undefined) ??
    (watch === true ? "computer" : undefined);
  return tab === undefined ? rest : { ...rest, panel: tab };
}

export const botPanelSearchSchema = z
  .object(botPanelSearchShape)
  .transform(normalizeBotPanelSearch);

export type BotPanelSearch = z.output<typeof botPanelSearchSchema>;
