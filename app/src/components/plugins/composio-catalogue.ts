import { msg } from "@/lib/i18n";
import { compareText } from "@/lib/i18n/format";
import type { ComposioApp } from "@/lib/plugins/queries";

/**
 * Composio's directory as the Marketplace's "Featured plugins" draws it, decided without a DOM:
 * grouped by the categories Composio files each app under, with pills like the Cursor sections'
 * (`marketplace-catalogue.ts`). Composio's categories are the keys ("developer tools", "crm"), and
 * `composioCategoryLabel` is how they read, capitalised like the Cursor sections beside them.
 */

/** Where an app Composio files under no category is listed. */
export const OTHER_CATEGORY = msg("Other");

/** How many rows a category shows before "View all". */
export const COMPOSIO_PREVIEW_ROWS = 4;

/**
 * How many categories the unfiltered view previews. The directory runs to well over a thousand
 * apps in dozens of categories; the biggest few are shown, the rest are a pill away.
 */
export const COMPOSIO_PREVIEW_SECTIONS = 6;

/** Words Composio writes in lower case that read as initials. */
const INITIALISMS = new Set([
  "ai",
  "api",
  "ats",
  "cdp",
  "cms",
  "crm",
  "erp",
  "hr",
  "hris",
  "it",
  "mcp",
  "seo",
  "sms",
  "ui",
  "ux",
]);

/**
 * A category as it reads: "developer tools" is "Developer Tools", "crm" is "CRM". A word already
 * written with capitals ("DevOps") is left as it is.
 */
export function composioCategoryLabel(category: string): string {
  return category
    .split(/(\s+|&|\/|-)/)
    .map((word) => {
      if (word !== word.toLowerCase()) return word;
      if (INITIALISMS.has(word)) return word.toUpperCase();
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join("");
}

/** An app's first category, which is the section it is listed under. */
export function composioCategoryOf(app: Pick<ComposioApp, "categories">) {
  return app.categories.find((category) => category.trim() !== "") ?? null;
}

type Counted = { key: string; count: number };

function countsOf(apps: readonly Pick<ComposioApp, "categories">[]) {
  const counts = new Map<string, number>();
  for (const app of apps) {
    const key = composioCategoryOf(app) ?? OTHER_CATEGORY;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts]
    .map(([key, count]): Counted => ({ key, count }))
    .sort(
      (left, right) =>
        Number(left.key === OTHER_CATEGORY) -
          Number(right.key === OTHER_CATEGORY) ||
        right.count - left.count ||
        compareText(left.key, right.key),
    );
}

/** The pills: every category holding an app, the biggest first, "Other" last. */
export function composioPills(
  apps: readonly Pick<ComposioApp, "categories">[],
): { key: string }[] {
  return countsOf(apps).map(({ key }) => ({ key }));
}

export type ComposioSection = {
  key: string;
  apps: ComposioApp[];
  /** Whether the section holds more than it shows, so "View all" has somewhere to go. */
  hasMore: boolean;
};

/**
 * The sections to draw: one category in full when `category` names one, else the biggest
 * `sections` categories (all of them while searching, where the matches are few), each previewing
 * its first rows. Rows inside a section are by name.
 */
export function composioSections(
  apps: readonly ComposioApp[],
  options: {
    category?: string | undefined;
    searching?: boolean;
    preview?: number;
    sections?: number;
  } = {},
): ComposioSection[] {
  const preview = options.preview ?? COMPOSIO_PREVIEW_ROWS;
  const byCategory = new Map<string, ComposioApp[]>();
  for (const app of apps) {
    const key = composioCategoryOf(app) ?? OTHER_CATEGORY;
    byCategory.set(key, [...(byCategory.get(key) ?? []), app]);
  }
  const ordered = countsOf(apps).map(({ key }) => key);
  const keys =
    options.category !== undefined
      ? ordered.filter((key) => key === options.category)
      : options.searching
        ? ordered
        : ordered.slice(0, options.sections ?? COMPOSIO_PREVIEW_SECTIONS);
  return keys.map((key) => {
    const bucket = [...(byCategory.get(key) ?? [])].sort((left, right) =>
      compareText(left.name, right.name),
    );
    const whole = options.category === key;
    return {
      key,
      apps: whole ? bucket : bucket.slice(0, preview),
      hasMore: !whole && bucket.length > preview,
    };
  });
}

/**
 * A tool's slug as a title: `GOOGLECALENDAR_CREATE_EVENT` of `googlecalendar` reads "Create
 * event". The app's own prefix is dropped, since the page is already that app's.
 */
export function composioToolTitle(slug: string, toolkit: string): string {
  const prefix = `${toolkit.toUpperCase()}_`;
  const bare = slug.startsWith(prefix) ? slug.slice(prefix.length) : slug;
  const words = bare.toLowerCase().split("_").filter(Boolean).join(" ");
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : slug;
}
