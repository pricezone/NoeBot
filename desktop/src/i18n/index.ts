import { useSyncExternalStore } from "react";
import el from "./el.json";
import { DEFAULT_LOCALE, type Locale, pickLocale } from "./locales";
import nativeEl from "./native.el.json";

/**
 * The launcher's language, with the web app's conventions and API shape.
 *
 * THE KEY IS THE ENGLISH: `t("Start OpenBot")` looks the English up in Greek and answers it as it
 * is when there is no Greek, so nothing ever shows a key. Plurals carry their English singular,
 * `t("{{count}} files", { count, defaultValue_one: "{{count}} file" })`, and the Greek has `_one`
 * and `_other` entries. `useTranslation()` and `i18n.t` are shaped like react-i18next's, so the
 * same tools (`scripts/i18n/codemod.ts --project desktop/tsconfig.json`) rewrite this app too.
 *
 * The launcher is not signed in to anything, so the choice lives here: `openbot-launcher-locale`
 * in this window's storage, else the system's languages, else English. It is also told to the
 * native side, which names the tray menu in it.
 *
 * What the native side says (a failure's `Problem.said`, a step's detail, a harness's description)
 * is English, and is translated by exact match or by pattern against `native.el.json`, which
 * `scripts/i18n/desktop-scan.ts` reads out of the Rust source.
 */

const CATALOGS: Partial<Record<Locale, Record<string, string>>> = { el };
const NATIVE: Partial<Record<Locale, Record<string, string>>> = {
  el: nativeEl,
};
export const LOCALE_STORAGE_KEY = "openbot-launcher-locale";

function stored(): Locale | null {
  try {
    return pickLocale([globalThis.localStorage?.getItem(LOCALE_STORAGE_KEY)]);
  } catch {
    return null;
  }
}

function startingLocale(): Locale {
  return (
    stored() ??
    pickLocale(
      typeof navigator === "undefined" ? [] : [...(navigator.languages ?? [])],
    ) ??
    DEFAULT_LOCALE
  );
}

let current: Locale = startingLocale();
const listeners = new Set<() => void>();

export function getLocale(): Locale {
  return current;
}

/** Switches every screen at once and remembers the choice in this window's storage. */
export function setLocale(locale: Locale): void {
  try {
    globalThis.localStorage?.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Not remembered: the next launch starts from the system's language again.
  }
  if (typeof document !== "undefined") document.documentElement.lang = locale;
  if (locale === current) return;
  current = locale;
  for (const listener of listeners) listener();
}

/** Back to the starting language, for tests. */
export function resetLocaleForTests(): void {
  current = startingLocale();
  for (const listener of listeners) listener();
}

export function useLocale(): Locale {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getLocale,
    getLocale,
  );
}

function fill(template: string, values: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (whole, name: string) =>
    name in values ? String(values[name]) : whole,
  );
}

type Options = Record<string, unknown> & {
  count?: number;
  defaultValue_one?: string;
};

function translate(key: string, options: Options = {}): string {
  const catalog = CATALOGS[current];
  if (typeof options.count === "number") {
    let form: "one" | "other" = options.count === 1 ? "one" : "other";
    try {
      form =
        new Intl.PluralRules(current).select(options.count) === "one"
          ? "one"
          : "other";
    } catch {
      // The English rule above.
    }
    const translated = catalog?.[`${key}_${form}`];
    if (translated) return fill(translated, options);
    return fill(
      form === "one" && options.defaultValue_one
        ? options.defaultValue_one
        : key,
      options,
    );
  }
  return fill(catalog?.[key] || key, options);
}

/** Outside a component: a message thrown, a label built in a function. */
export const i18n = { t: translate };

/** In a component: re-renders it in the new language on a switch. */
export function useTranslation(_namespace?: string): { t: typeof translate } {
  useLocale();
  return { t: translate };
}

/** Marks an English constant as a key; translate it with `t(label)` where it is shown. */
export function msg<const T extends string>(text: T): T {
  return text;
}

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const VALUE = /\{\{\d+\}\}/;
const patterns = new Map<Locale, { key: string; match: RegExp }[]>();

/** A sentence the native side said, in the current language when the catalog knows it. */
export function localizeNative(english: string): string {
  const catalog = NATIVE[current];
  if (!catalog) return english;
  if (catalog[english]) return catalog[english];
  let compiled = patterns.get(current);
  if (!compiled) {
    compiled = Object.keys(catalog)
      .filter((key) => VALUE.test(key))
      .sort(
        (a, b) =>
          b.replace(/\{\{\d+\}\}/g, "").length -
          a.replace(/\{\{\d+\}\}/g, "").length,
      )
      .map((key) => ({
        key,
        match: new RegExp(
          `^${key.split(VALUE).map(escapeRegExp).join("([\\s\\S]+?)")}$`,
        ),
      }));
    patterns.set(current, compiled);
  }
  for (const { key, match } of compiled) {
    const found = match.exec(english);
    if (!found) continue;
    const values: Record<string, string> = {};
    found.slice(1).forEach((value, index) => {
      values[String(index)] = value;
    });
    return fill(catalog[key] as string, values);
  }
  return english;
}
