import {
  DEFAULT_LOCALE,
  isLocale,
  LOCALES,
  type Locale,
  parseLocales,
  pickLocale,
} from "../../../../shared/i18n/locales";

/*
 * Which interface language to speak, decided without React so it can run before anything renders
 * and be tested as plain data.
 *
 * Four keys in localStorage, each with one owner:
 * - `openbot-locale` is a language somebody CHOSE, never one this code guessed. A guess written here
 *   would outrank the server's answer on the next visit and freeze whatever the browser said once.
 * - `openbot-locale-unsynced` marks a choice the server has not stored yet (the save failed), so the
 *   next signed-in boot sends it again instead of letting the server's older answer win.
 * - `openbot-locales` and `openbot-locale-default` cache what the deployment offers, so the first
 *   paint of the next visit can already be right before `/api/capabilities` has answered.
 * - `openbot-i18n-preview` shows every language in this browser before the deployment offers them.
 *
 * `app/index.html` repeats `bootLocale` as an inline script, so `<html lang>` is right before the
 * first paint; `app/tests/i18n-detect.test.ts` runs that script against this function.
 */
export const LOCALE_STORAGE_KEY = "openbot-locale";
export const LOCALE_UNSYNCED_KEY = "openbot-locale-unsynced";
export const LOCALES_ENABLED_KEY = "openbot-locales";
export const LOCALE_DEFAULT_KEY = "openbot-locale-default";
export const I18N_PREVIEW_KEY = "openbot-i18n-preview";

// localStorage throws in some privacy modes; a language is not worth taking the app down for.
function readStorage(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string | null): void {
  try {
    if (value === null) globalThis.localStorage?.removeItem(key);
    else globalThis.localStorage?.setItem(key, value);
  } catch {}
}

/** The browser's languages, most preferred first. Empty where there is no browser. */
export function browserLanguages(): readonly string[] {
  const navigator = globalThis.navigator as
    | { languages?: readonly string[]; language?: string }
    | undefined;
  if (navigator?.languages?.length) return navigator.languages;
  return navigator?.language ? [navigator.language] : [];
}

export function storedLocale(): Locale | null {
  const value = readStorage(LOCALE_STORAGE_KEY);
  return isLocale(value) ? value : null;
}

export function storeLocale(locale: Locale): void {
  writeStorage(LOCALE_STORAGE_KEY, locale);
}

export function isUnsynced(): boolean {
  return readStorage(LOCALE_UNSYNCED_KEY) === "1";
}

export function markUnsynced(unsynced: boolean): void {
  writeStorage(LOCALE_UNSYNCED_KEY, unsynced ? "1" : null);
}

export function isPreviewing(): boolean {
  return readStorage(I18N_PREVIEW_KEY) === "1";
}

export function setPreviewing(previewing: boolean): void {
  writeStorage(I18N_PREVIEW_KEY, previewing ? "1" : null);
}

/** What the deployment offered last time, so this visit can start in it. */
export function cachedDeployment(): {
  locales: Locale[];
  defaultLocale: Locale | null;
} {
  const locales = parseLocales(readStorage(LOCALES_ENABLED_KEY));
  const preferred = readStorage(LOCALE_DEFAULT_KEY);
  return {
    locales,
    defaultLocale:
      isLocale(preferred) && locales.includes(preferred) ? preferred : null,
  };
}

export function cacheDeployment(deployment: {
  locales: readonly Locale[];
  defaultLocale: Locale | null;
}): void {
  writeStorage(LOCALES_ENABLED_KEY, deployment.locales.join(","));
  writeStorage(LOCALE_DEFAULT_KEY, deployment.defaultLocale);
}

/** The languages this browser may speak: what the deployment offers, or all of them in preview. */
export function enabledLocales(
  offered: readonly Locale[],
  previewing: boolean = isPreviewing(),
): Locale[] {
  return previewing ? [...LOCALES] : [...offered];
}

export type LocaleInputs = {
  /** What the signed-in person chose, as the server stores it. Undefined when nobody is signed in. */
  server?: Locale | null;
  /** A choice made in this browser. */
  stored?: Locale | null;
  /** Whether the stored choice is one the server has not been told about yet. */
  unsynced?: boolean;
  deploymentDefault?: Locale | null;
  browser?: readonly string[];
  enabled: readonly Locale[];
};

/**
 * The language to speak, in order of who decided it:
 *
 * 1. A choice in this browser the server has not stored yet: the person's newest word.
 * 2. The signed-in person's choice, as the server stores it, so it follows them between devices.
 * 3. A choice in this browser, for somebody not signed in (or whose server knows no choice).
 * 4. The deployment's default.
 * 5. The browser's languages.
 * 6. English.
 *
 * Only languages in `enabled` count at every step, so a choice of a language the deployment has
 * stopped offering quietly falls through rather than drawing a half-translated screen.
 */
export function resolveLocale(input: LocaleInputs): Locale {
  const { enabled } = input;
  const allowed = (locale: Locale | null | undefined): locale is Locale =>
    locale !== null && locale !== undefined && enabled.includes(locale);
  if (input.unsynced && allowed(input.stored)) return input.stored;
  if (allowed(input.server)) return input.server;
  if (allowed(input.stored)) return input.stored;
  if (allowed(input.deploymentDefault)) return input.deploymentDefault;
  return (
    pickLocale(input.browser ?? [], enabled) ??
    (enabled.includes(DEFAULT_LOCALE)
      ? DEFAULT_LOCALE
      : (enabled[0] ?? DEFAULT_LOCALE))
  );
}

/** The best guess before the server has answered: everything this browser remembers. */
export function bootLocale(): Locale {
  const deployment = cachedDeployment();
  return resolveLocale({
    stored: storedLocale(),
    deploymentDefault: deployment.defaultLocale,
    browser: browserLanguages(),
    enabled: enabledLocales(deployment.locales),
  });
}
