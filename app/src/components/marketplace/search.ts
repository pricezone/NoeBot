import { z } from "zod";

/**
 * The Marketplace's address: which tab is showing, what is typed in the search, and the one
 * form or dialog open over the tab. Shared by the route (which validates it) and the lazy body
 * (which reads and writes it), so neither imports the other.
 *
 * `new`, `edit` and `agent` belong to a tab — `new` and `edit` to Skills, `new` and `agent` to
 * Agents — and the body drops them when the tab changes, the way the old `/skills` and `/agents`
 * pages dropped them on close. They are flat rather than nested under the tab so the redirects
 * from those pages are a spread of the old search over `{ tab }`.
 */
export const MARKETPLACE_TABS = ["apps", "skills", "agents"] as const;

export type MarketplaceTab = (typeof MARKETPLACE_TABS)[number];

export const marketplaceSearchSchema = z.object({
  tab: z.enum(MARKETPLACE_TABS).optional(),
  q: z.string().optional(),
  new: z.boolean().optional(),
  /** The skill slug being edited. Absent means nothing is. */
  edit: z.string().optional(),
  /** The coworker whose dialog is open. */
  agent: z.string().optional(),
  /** The Bot template whose page is open, on the Agents tab. */
  template: z.string().optional(),
  /**
   * One category of the tab, shown in full, in place of the preview of every category. The Apps
   * tab reads Cursor's category keys; the Agents tab, a template category. Absent is All.
   */
  category: z.string().optional(),
});

export type MarketplaceSearch = z.infer<typeof marketplaceSearchSchema>;

export function isMarketplaceTab(value: unknown): value is MarketplaceTab {
  return (
    typeof value === "string" &&
    (MARKETPLACE_TABS as readonly string[]).includes(value)
  );
}

/** What the body is handed to move the address: the whole next search, replacing the current one. */
export type SetMarketplaceSearch = (
  next: MarketplaceSearch,
  options?: { replace?: boolean },
) => void;
