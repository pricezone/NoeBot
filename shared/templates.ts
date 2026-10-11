/**
 * Bot templates: the categories a template may be filed under, and who ships them.
 *
 * Shared because two sides have to agree on it. The tenant package refuses a template filed under
 * a category this list does not name, and the Agents tab draws its pills from the same list in the
 * same order — Grok Bot's own categories, with "From Noë Bot Team" in front for the templates this
 * deployment ships. Nothing here knows about React or the database.
 */
export const TEMPLATE_CATEGORIES = [
  "From Noë Bot Team",
  "Engineering",
  "Sales",
  "Marketing",
  "Design",
  "Personal",
  "Recruiting & People",
  "Product",
  "Operations",
] as const;

export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];

export function isTemplateCategory(value: unknown): value is TemplateCategory {
  return (
    typeof value === "string" &&
    (TEMPLATE_CATEGORIES as readonly string[]).includes(value)
  );
}

/** How many templates the Marketplace features at the top; the package may mark no more. */
export const FEATURED_TEMPLATES = 4;
