import { LanguagePreference } from "@/components/settings/language-preference";
import { MessageListPreference } from "@/components/settings/message-list-preference";
import { useTheme } from "@/components/theme-provider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  SettingsCard,
  SettingsRow,
  SettingsSection,
} from "@/components/ui/settings-rows";
import { msg, useTranslation } from "@/lib/i18n";
import type { ThemePreference } from "@/lib/theme";

const THEME_LABEL: Record<ThemePreference, string> = {
  system: msg("Follow system"),
  light: msg("Light"),
  dark: msg("Dark"),
};

const THEME_CHOICES: ThemePreference[] = ["system", "light", "dark"];

function isThemePreference(value: unknown): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

/**
 * How the app looks on this browser, how the roster reads, and which language it speaks.
 *
 * Theme is a browser preference: it is stored in `localStorage` (`lib/theme.ts`) and never
 * synced, because the same person may well want dark on a laptop and light on a phone. The
 * message list emphasis is the opposite, an account preference that follows them, which is why
 * the two rows sit in one card with different owners.
 */
export function AppearanceSection() {
  const { t } = useTranslation("settings");
  const { theme, setTheme } = useTheme();
  return (
    <SettingsSection label={t("Appearance")}>
      <SettingsCard>
        <LanguagePreference />
        <SettingsRow
          label={t("Theme")}
          description={t("Saved in this browser.")}
          control={
            <Select
              value={theme}
              onValueChange={(value) => {
                if (isThemePreference(value)) setTheme(value);
              }}
            >
              <SelectTrigger aria-label={t("Theme")}>
                <SelectValue>{t(THEME_LABEL[theme])}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {THEME_CHOICES.map((choice) => (
                  <SelectItem key={choice} value={choice}>
                    {t(THEME_LABEL[choice])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
        <MessageListPreference />
      </SettingsCard>
    </SettingsSection>
  );
}
