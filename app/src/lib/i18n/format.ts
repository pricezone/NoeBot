import type { Locale } from "../../../../shared/i18n/locales";
import { browserLanguages } from "./detect";
import { getLocale } from "./index";

/**
 * Numbers, dates and times in the interface's language, not the browser's.
 *
 * Before languages existed these followed the browser, so a Greek browser drew "πριν από 5 λεπτά"
 * inside an English sentence. Now the interface language decides; within English, the browser's own
 * English (en-GB, en-AU…) still decides the date order, as it always did.
 *
 * Formatters are built once per language and options, not once per module: one built when the
 * module loaded would keep the language the page started in after the person switched.
 */
export function intlLocale(locale: Locale = getLocale()): string {
  if (locale === "el") return "el-GR";
  return browserLanguages().find((tag) => /^en(?:-|$)/i.test(tag)) ?? "en-US";
}

/**
 * For the few places that always drew US English before languages existed (the transcript's date
 * line, credit figures): Greek in Greek, and exactly `en-US` otherwise, so English is unchanged.
 */
export function fixedIntlLocale(locale: Locale = getLocale()): string {
  return locale === "el" ? "el-GR" : "en-US";
}

const cache = new Map<string, unknown>();

function cached<T>(key: string, build: () => T): T {
  const hit = cache.get(key) as T | undefined;
  if (hit) return hit;
  const built = build();
  cache.set(key, built);
  return built;
}

export function numberFormat(
  options: Intl.NumberFormatOptions = {},
  locale: Locale = getLocale(),
  tagFor: (locale: Locale) => string = intlLocale,
): Intl.NumberFormat {
  const tag = tagFor(locale);
  return cached(
    `number|${tag}|${JSON.stringify(options)}`,
    () => new Intl.NumberFormat(tag, options),
  );
}

export function dateTimeFormat(
  options: Intl.DateTimeFormatOptions = {},
  locale: Locale = getLocale(),
): Intl.DateTimeFormat {
  const tag = intlLocale(locale);
  return cached(
    `date|${tag}|${JSON.stringify(options)}`,
    () => new Intl.DateTimeFormat(tag, options),
  );
}

export function relativeTimeFormat(
  options: Intl.RelativeTimeFormatOptions = { numeric: "auto" },
  locale: Locale = getLocale(),
): Intl.RelativeTimeFormat {
  const tag = intlLocale(locale);
  return cached(
    `relative|${tag}|${JSON.stringify(options)}`,
    () => new Intl.RelativeTimeFormat(tag, options),
  );
}

export function listFormat(
  options: Intl.ListFormatOptions = { type: "conjunction" },
  locale: Locale = getLocale(),
): Intl.ListFormat {
  const tag = intlLocale(locale);
  return cached(
    `list|${tag}|${JSON.stringify(options)}`,
    () => new Intl.ListFormat(tag, options),
  );
}

/** "A, B and C" in English, "A, B και C" in Greek. */
export function formatList(
  items: readonly string[],
  type: Intl.ListFormatType = "conjunction",
): string {
  return listFormat({ type }).format(items);
}

/** Order two labels as a person reading this language would, ignoring case and accents. */
export function compareText(left: string, right: string): number {
  const tag = intlLocale();
  return cached(
    `collator|${tag}`,
    () => new Intl.Collator(tag, { sensitivity: "base", numeric: true }),
  ).compare(left, right);
}
