import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SettingsRow } from "@/components/ui/settings-rows";
import { useTranslation } from "@/lib/i18n";
import { useLocale } from "@/lib/i18n/use-locale";
import { isLocale, LOCALE_LABELS } from "../../../../shared/i18n/locales";

/**
 * The interface language, as one row of the Appearance card.
 *
 * The same choice as the account menu's Language row, here too because Settings is where somebody
 * looks for it. An account preference, unlike the theme beside it: saved to the person and followed
 * on every device they sign in on. Each language is named in itself. Not drawn where the deployment
 * offers one language.
 */
export function LanguagePreference() {
  const { t } = useTranslation("settings");
  const { locale, enabled, setLocale, pending, syncFailed } = useLocale();

  if (enabled.length < 2) return null;

  return (
    <>
      <SettingsRow
        label={t("Language")}
        description={t("Saved to your account.")}
        control={
          <Select
            value={locale}
            disabled={pending}
            onValueChange={(value) => {
              if (isLocale(value) && value !== locale) void setLocale(value);
            }}
          >
            <SelectTrigger aria-label={t("Language")}>
              <SelectValue>
                <span lang={locale}>{LOCALE_LABELS[locale]}</span>
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {enabled.map((option) => (
                <SelectItem key={option} value={option} lang={option}>
                  {LOCALE_LABELS[option]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
      {syncFailed ? (
        <p role="status" className="px-4 py-3 text-sm text-muted-foreground">
          {t("Saved on this browser only.")}
        </p>
      ) : null}
    </>
  );
}
