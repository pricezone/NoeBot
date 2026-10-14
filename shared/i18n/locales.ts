/**
 * The interface languages, as the server, the app and the clients agree on them.
 *
 * One list, so a language cannot be offered by the switcher, refused by the preferences route and
 * half-translated by the catalogs all at once. The mobile app and the desktop launcher are separate
 * packages that cannot import this file; each keeps a byte copy that `tests/i18n-copies.test.ts`
 * holds to this one.
 */
export const LOCALES = ["en", "el"] as const;

export type Locale = (typeof LOCALES)[number];

/** What a person sees before anything else is known: no choice, no deployment default, no match. */
export const DEFAULT_LOCALE: Locale = "en";

/**
 * Each language's name in its own language, so a person who cannot read the current interface can
 * still find theirs. Never translated.
 */
export const LOCALE_LABELS: Record<Locale, string> = {
  en: "English",
  el: "Ελληνικά",
};

export function isLocale(value: unknown): value is Locale {
  return (
    typeof value === "string" && (LOCALES as readonly string[]).includes(value)
  );
}

/**
 * The interface language a tag names, or null: `"el-GR"`, `"EL"` and `"el_CY"` all mean Greek.
 * Anything else, a non-string included, is not a language this deployment speaks.
 */
export function normalizeLocale(value: unknown): Locale | null {
  if (typeof value !== "string") return null;
  const primary = value.trim().toLowerCase().split(/[-_]/)[0];
  return isLocale(primary) ? primary : null;
}

/** The first candidate that names a language in `enabled`, or null when none does. */
export function pickLocale(
  candidates: readonly unknown[],
  enabled: readonly Locale[] = LOCALES,
): Locale | null {
  for (const candidate of candidates) {
    const locale = normalizeLocale(candidate);
    if (locale && enabled.includes(locale)) return locale;
  }
  return null;
}

/**
 * The languages a deployment offers, from a comma-separated setting such as `"en,el"`.
 *
 * English is always among them: it is the language every string is written in, so it is the one
 * that can never be missing. Unknown entries are ignored rather than refused, so a deployment that
 * names a language this build does not have yet still starts.
 */
export function parseLocales(value: string | null | undefined): Locale[] {
  const named = (value ?? "")
    .split(",")
    .map((entry) => normalizeLocale(entry))
    .filter((locale): locale is Locale => locale !== null);
  return LOCALES.filter(
    (locale) => locale === DEFAULT_LOCALE || named.includes(locale),
  );
}
