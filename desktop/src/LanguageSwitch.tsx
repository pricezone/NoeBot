import { invoke } from "@tauri-apps/api/core";
import { useEffect } from "react";
import { setLocale, useLocale, useTranslation } from "./i18n";
import { LOCALE_LABELS, LOCALES } from "./i18n/locales";

/**
 * The launcher's language, in a corner of every screen: each language named in itself, so somebody
 * who cannot read the current one can still find theirs.
 *
 * The native side is told on every change and once at start, so the tray menu speaks the same
 * language as the window. A launcher too old to know the command ignores it.
 */
export function LanguageSwitch() {
  const { t } = useTranslation();
  const locale = useLocale();
  useEffect(() => {
    document.documentElement.lang = locale;
    void invoke("set_ui_locale", { locale }).catch(() => {
      // The tray keeps its language until the next start; the window has switched either way.
    });
  }, [locale]);
  return (
    <div
      aria-label={t("Language")}
      className="language-switch"
      role="radiogroup"
    >
      {LOCALES.map((option) => (
        // biome-ignore lint/a11y/useSemanticElements: a radio group of buttons, as on the web app's switcher: an <input type="radio"> cannot be styled as the launcher's quiet buttons.
        <button
          aria-checked={option === locale}
          className="quiet"
          key={option}
          lang={option}
          onClick={() => setLocale(option)}
          role="radio"
          type="button"
        >
          {LOCALE_LABELS[option]}
        </button>
      ))}
    </div>
  );
}
