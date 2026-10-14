import i18next, { type BackendModule, type ResourceKey } from "i18next";
import { initReactI18next, Trans, useTranslation } from "react-i18next";
import {
  DEFAULT_LOCALE,
  LOCALES,
  type Locale,
  normalizeLocale,
} from "../../../../shared/i18n/locales";
import { EL_CATALOGS, type Namespace } from "./loaders";

/**
 * The app's one translation instance.
 *
 * THE KEY IS THE ENGLISH. `t("Settings")` looks "Settings" up in the Greek catalog and, when it is
 * not there, answers "Settings": English needs no catalog, a missing translation reads as English
 * rather than as a key, and an upstream change to the English text shows up as a new key instead of
 * a stale translation. That is also why the separators are off: an English sentence has dots and
 * colons in it.
 *
 * Plurals carry their English singular at the call site, since English has no catalog to hold it:
 *
 *     t("{{count}} credits", { count, defaultValue_one: "{{count}} credit" })
 *
 * The Greek catalog has `_one` and `_other` entries for the same key. Two words that are the same in
 * English and different in Greek take a `context` ("Open" the verb, "Open" the state).
 *
 * Starts in English and stays there until `startI18nBoot` decides otherwise, so a test, or anything
 * imported before the app boots, reads exactly the English it was written in.
 */
const catalogs: BackendModule = {
  type: "backend",
  init: () => {},
  read(language, namespace, callback) {
    const load =
      language === "el" ? EL_CATALOGS[namespace as Namespace] : undefined;
    if (!load) {
      callback(null, {});
      return;
    }
    load().then(
      (catalog) => callback(null, catalog.default as ResourceKey),
      (error: unknown) =>
        callback(
          error instanceof Error ? error : new Error(String(error)),
          false,
        ),
    );
  },
};

export const i18n = i18next.createInstance();

void i18n
  .use(catalogs)
  .use(initReactI18next)
  .init({
    lng: DEFAULT_LOCALE,
    // A key missing in Greek answers its own English; there is no English catalog to fall back to.
    fallbackLng: false,
    supportedLngs: [...LOCALES],
    load: "languageOnly",
    ns: ["common"],
    defaultNS: "common",
    // A word in a route's own namespace may be one the shell already translated.
    fallbackNS: "common",
    keySeparator: false,
    nsSeparator: false,
    returnNull: false,
    // An empty Greek value is an unfinished translation, never a deliberate blank.
    returnEmptyString: false,
    // React escapes what it renders; escaping here as well would show `&amp;` in the interface.
    interpolation: { escapeValue: false },
    initAsync: false,
    react: {
      useSuspense: false,
      // A switch re-renders once; a namespace arriving later re-renders only what asked for it.
      bindI18n: "languageChanged",
      bindI18nStore: "",
    },
  });

/** The language the interface speaks right now. */
export function getLocale(): Locale {
  return (
    normalizeLocale(i18n.resolvedLanguage ?? i18n.language) ?? DEFAULT_LOCALE
  );
}

/** The interface language, re-rendering whoever reads it when it changes. */
export function useInterfaceLocale(): Locale {
  const { i18n: instance } = useTranslation();
  return (
    normalizeLocale(instance.resolvedLanguage ?? instance.language) ??
    DEFAULT_LOCALE
  );
}

/**
 * Marks an English string as a key without translating it yet: for constants built when a module
 * loads, before anybody knows the language. Translate it where it is drawn, with `t(label)`.
 */
export function msg<const T extends string>(text: T): T {
  return text;
}

/**
 * The hook components translate with. Imported from here rather than from react-i18next directly,
 * so the instance above always exists before the first component asks for it.
 */
export { Trans, useTranslation };
