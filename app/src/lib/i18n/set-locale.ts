import type { Locale } from "../../../../shared/i18n/locales";
import { bootLocale } from "./detect";
import { getLocale, i18n } from "./index";
import type { Namespace } from "./loaders";

/**
 * Switching languages, without React.
 *
 * `i18n.changeLanguage` loads every namespace already in use for the new language and only then
 * tells React, so a switch redraws once, in the new language, rather than in a mix of the two while
 * catalogs arrive.
 */

/** `<html lang>`: screen readers pick their voice from it, and CSS uppercases Greek correctly by it. */
export function applyDocumentLocale(locale: Locale): void {
  if (typeof document === "undefined") return;
  document.documentElement.lang = locale;
}

export async function ensureLocale(locale: Locale): Promise<void> {
  if (getLocale() !== locale) await i18n.changeLanguage(locale);
  applyDocumentLocale(locale);
}

export function ensureNamespaces(
  namespaces: readonly Namespace[],
): Promise<void> {
  return i18n.loadNamespaces([...namespaces]);
}

let boot: Promise<void> | undefined;

/**
 * Starts speaking the language this browser remembers, once per page load.
 *
 * Started by `main.tsx` before the first render and awaited by the root route, so nothing is drawn
 * in English and then redrawn in Greek. For English it resolves at once; for Greek it waits only
 * for the shell's catalog, fetched while the routes resolve.
 */
export function startI18nBoot(): Promise<void> {
  boot ??= ensureLocale(bootLocale()).catch(() => {
    // A catalog that could not be fetched leaves the interface in English, never blank.
  });
  return boot;
}

/** Back to a fresh page load, for tests. */
export async function resetI18nForTests(): Promise<void> {
  boot = undefined;
  await i18n.changeLanguage("en");
  applyDocumentLocale("en");
}
