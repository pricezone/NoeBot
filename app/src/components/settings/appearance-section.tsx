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
import type { ThemePreference } from "@/lib/theme";

const THEME_LABEL: Record<ThemePreference, string> = {
  system: "Follow system",
  light: "Light",
  dark: "Dark",
};

const THEME_CHOICES: ThemePreference[] = ["system", "light", "dark"];

function isThemePreference(value: unknown): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

/**
 * How the app looks on this browser, and how the roster reads.
 *
 * Theme is a browser preference: it is stored in `localStorage` (`lib/theme.ts`) and never
 * synced, because the same person may well want dark on a laptop and light on a phone. The
 * message list emphasis is the opposite, an account preference that follows them, which is why
 * the two rows sit in one card with different owners.
 */
export function AppearanceSection() {
  const { theme, setTheme } = useTheme();
  return (
    <SettingsSection label="Appearance">
      <SettingsCard>
        <SettingsRow
          label="Theme"
          description="Saved in this browser."
          control={
            <Select
              value={theme}
              onValueChange={(value) => {
                if (isThemePreference(value)) setTheme(value);
              }}
            >
              <SelectTrigger aria-label="Theme">
                <SelectValue>{THEME_LABEL[theme]}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {THEME_CHOICES.map((choice) => (
                  <SelectItem key={choice} value={choice}>
                    {THEME_LABEL[choice]}
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
