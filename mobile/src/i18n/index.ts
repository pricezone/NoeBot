import * as SecureStore from "expo-secure-store";
import { useSyncExternalStore } from "react";
import contentEl from "./content.el.json";
import el from "./el.json";
import { DEFAULT_LOCALE, type Locale, normalizeLocale } from "./locales";
import { scheduleInGreek } from "./schedule-words";
import serverEl from "./server.el.json";

/**
 * The mobile app's language, the same way the web app has it.
 *
 * THE KEY IS THE ENGLISH: `t("Sign out")` looks "Sign out" up in Greek and answers the English
 * when there is none, so nothing ever shows a key. Plurals carry their English singular at the
 * call site, `t("{{count}} files", { count, one: "{{count}} file" })`, and the Greek has `_one`
 * and `_other` entries. No i18next and no native module: a table lookup needs neither, and a native
 * module would need a new build of the app before anybody could see a word of Greek.
 *
 * The server's sentences are translated the way the web app translates them
 * (`app/src/lib/i18n/server-messages.ts`): exactly, then by pattern. `server.el.json` is a copy of
 * the web app's catalog, which a test holds to the original.
 *
 * The choice is saved on this phone and in the person's preferences on the server, so it follows
 * them to the web app and back.
 */

const CATALOGS: Partial<Record<Locale, Record<string, string>>> = { el };
const SERVER: Partial<Record<Locale, Record<string, string>>> = {
  el: serverEl,
};
const STORAGE_KEY = "openbot-locale";

let current: Locale = deviceLocale();
const listeners = new Set<() => void>();

function deviceLocale(): Locale {
  try {
    return (
      normalizeLocale(Intl.DateTimeFormat().resolvedOptions().locale) ??
      DEFAULT_LOCALE
    );
  } catch {
    return DEFAULT_LOCALE;
  }
}

export function getLocale(): Locale {
  return current;
}

/** Switches the language for every screen at once. Saving it anywhere is the caller's business. */
export function applyLocale(locale: Locale): void {
  if (locale === current) return;
  current = locale;
  for (const listener of listeners) listener();
}

/** The language, re-rendering whoever reads it when it changes. */
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

function plural(locale: Locale, count: number): "one" | "other" {
  try {
    return new Intl.PluralRules(locale).select(count) === "one"
      ? "one"
      : "other";
  } catch {
    return count === 1 ? "one" : "other";
  }
}

function fill(template: string, values: Record<string, unknown>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, name: string) =>
    name in values ? String(values[name]) : whole,
  );
}

type Values = Record<string, unknown> & { count?: number; one?: string };

/**
 * Marks an English string as a key without translating it yet: for constants built when a module
 * loads, translated with `t(label)` where they are shown.
 */
export function msg<const T extends string>(text: T): T {
  return text;
}

/** Translates an English key into the current language, filling in its values. */
export function t(key: string, values: Values = {}): string {
  const catalog = CATALOGS[current];
  const { one, ...rest } = values;
  if (typeof values.count === "number") {
    const form = plural(current, values.count);
    const translated = catalog?.[`${key}_${form}`];
    if (translated) return fill(translated, rest);
    return fill(form === "one" && one ? one : key, rest);
  }
  return fill(catalog?.[key] || key, rest);
}

/** For a component: `const t = useT();` re-renders it in the new language on a switch. */
export function useT(): typeof t {
  useLocale();
  return t;
}

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const VALUE = /\{\{\d+\}\}/;
const patterns = new Map<Locale, { key: string; match: RegExp }[]>();

/** A sentence the server sent, in the current language when the catalog knows it. */
export function localizeServerMessage(english: string): string {
  const catalog = SERVER[current];
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
      values[String(index)] = localizeServerMessage(value);
    });
    return fill(catalog[key] as string, values);
  }
  return english;
}

/** The language saved on this phone, if anybody chose one here. */
export async function storedLocale(): Promise<Locale | null> {
  try {
    return normalizeLocale(await SecureStore.getItemAsync(STORAGE_KEY));
  } catch {
    return null;
  }
}

export async function storeLocale(locale: Locale): Promise<void> {
  try {
    await SecureStore.setItemAsync(STORAGE_KEY, locale);
  } catch {
    // Not saved on this phone: the server still has it once the save there succeeds.
  }
}

/** Speak the saved language from the start, before anybody has signed in. */
export async function bootLocale(): Promise<void> {
  const stored = await storedLocale();
  if (stored) applyLocale(stored);
}

/** A routine's schedule, in the server's words or, for a Greek reader, in Greek. */
export function schedule(words: string): string {
  return current === "el" ? (scheduleInGreek(words) ?? words) : words;
}

/**
 * The locale dates and numbers are written in: Greek for a Greek reader, otherwise the phone's own
 * English (so an English phone set to British English keeps its day-first dates), else US English.
 */
export function intlLocale(): string {
  if (current === "el") return "el-GR";
  try {
    const device = Intl.DateTimeFormat().resolvedOptions().locale;
    if (normalizeLocale(device) === "en") return device;
  } catch {
    // No Intl: the US English default below.
  }
  return "en-US";
}

const CONTENT: Partial<Record<Locale, Record<string, string>>> = {
  el: contentEl,
};

/**
 * This deployment's own content (skill titles, Bot titles…) in the current language, from a copy of
 * the web app's `content` catalog. Anything else — a skill somebody wrote — is shown as written.
 */
export function content(text: string): string {
  return (text && CONTENT[current]?.[text]) || text;
}
