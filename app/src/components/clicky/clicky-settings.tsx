import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
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
import { Switch } from "@/components/ui/switch";
import { revokeMobileDeviceMutationOptions } from "@/lib/clicky/mutations";
import { CLICKY_NAME } from "@/lib/clicky/notices";
import { mobileDevicesQueryOptions } from "@/lib/clicky/queries";
import { msg, useTranslation } from "@/lib/i18n";
import { dateTimeFormat } from "@/lib/i18n/format";
import {
  saveUserPreferencesMutationOptions,
  useUserPreferences,
} from "@/lib/settings/message-list";
import { queryClient } from "@/query-client";
import type { MobilePlatform } from "../../../../shared/mobile-link";
import {
  type ClickyActionPolicy,
  type ClickyGuidance,
  clickyPreferencesOf,
} from "../../../../shared/user-preferences";

const POLICY_LABEL: Record<ClickyActionPolicy, string> = {
  ask_each: msg("Ask every time"),
  ask_once_per_session: msg("Ask once per session"),
  ask_once_per_task: msg("Ask once per session"),
  never: msg("Guide only"),
};

const GUIDANCE_LABEL: Record<ClickyGuidance, string> = {
  brief: msg("Brief"),
  detailed: msg("Detailed"),
};

/** Platform names, as their makers spell them in every language. */
const PLATFORM_NAME: Record<MobilePlatform, string> = {
  ios: "iOS",
  android: "Android",
};

/**
 * Clicky's settings, as rows of the Settings modal: whether it opens by itself when the Bot needs
 * the person, how far it may go on the computer, how much it says, and whether it reads its replies
 * aloud. Each takes effect when changed; the save is a merge of one flat key
 * (`shared/user-preferences.ts`), so changing one never resets another.
 */
export function ClickySettingsSection() {
  const { t } = useTranslation("settings");
  const preferences = useUserPreferences();
  const save = useMutation(
    saveUserPreferencesMutationOptions(queryClient, preferences.userId),
  );
  // What was just chosen shows straight away, while it is being saved.
  const values = clickyPreferencesOf({
    ...preferences.data,
    ...(save.isPending ? save.variables : {}),
  });
  const disabled = !preferences.data || save.isPending;
  return (
    <SettingsSection label={CLICKY_NAME}>
      <SettingsCard>
        <SettingsRow
          control={
            <Switch
              aria-label={t("Open when Noë Bot needs you")}
              checked={values.clickyAutoActivate}
              disabled={disabled}
              onCheckedChange={(checked) =>
                save.mutate({ clickyAutoActivate: checked })
              }
            />
          }
          description={t(
            "When a Bot needs you on its screen, the screen opens with Clicky pointing at where to act.",
          )}
          label={t("Open when Noë Bot needs you")}
        />
        <SettingsRow
          control={
            <Select
              disabled={disabled}
              onValueChange={(value) => {
                if (
                  value === "ask_each" ||
                  value === "ask_once_per_task" ||
                  value === "never"
                )
                  save.mutate({ clickyActionPolicy: value });
              }}
              value={values.clickyActionPolicy}
            >
              <SelectTrigger aria-label={t("How far Clicky may go")}>
                <SelectValue>
                  {t(POLICY_LABEL[values.clickyActionPolicy])}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ask_each">
                  {t(POLICY_LABEL.ask_each)}
                </SelectItem>
                <SelectItem value="ask_once_per_task">
                  {t(POLICY_LABEL.ask_once_per_task)}
                </SelectItem>
                <SelectItem value="never">{t(POLICY_LABEL.never)}</SelectItem>
              </SelectContent>
            </Select>
          }
          description={
            values.clickyActionPolicy === "never"
              ? t("Clicky points and explains, and never clicks or types.")
              : values.clickyActionPolicy === "ask_once_per_task"
                ? t(
                    "With Do it for me on, one yes covers the rest of a task. Anything hard to undo is still asked about.",
                  )
                : t("With Do it for me on, Clicky asks before every action.")
          }
          label={t("How far Clicky may go")}
        />
        <SettingsRow
          control={
            <Select
              disabled={disabled}
              onValueChange={(value) => {
                if (value === "brief" || value === "detailed")
                  save.mutate({ clickyGuidance: value });
              }}
              value={values.clickyGuidance}
            >
              <SelectTrigger aria-label={t("How much Clicky says")}>
                <SelectValue>
                  {t(GUIDANCE_LABEL[values.clickyGuidance])}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="brief">{t(GUIDANCE_LABEL.brief)}</SelectItem>
                <SelectItem value="detailed">
                  {t(GUIDANCE_LABEL.detailed)}
                </SelectItem>
              </SelectContent>
            </Select>
          }
          description={t("Brief is one short line a step. Detailed adds why.")}
          label={t("How much Clicky says")}
        />
        <SettingsRow
          control={
            <Switch
              aria-label={t("Read replies aloud")}
              checked={values.clickySpeakReplies}
              disabled={disabled}
              onCheckedChange={(checked) =>
                save.mutate({ clickySpeakReplies: checked })
              }
            />
          }
          description={t(
            "Clicky says its replies out loud on the device you are using, in your interface language.",
          )}
          label={t("Read replies aloud")}
        />
      </SettingsCard>
      {preferences.isError ? (
        <p className="mt-2 px-1 text-destructive text-sm" role="alert">
          {preferences.error.message}
        </p>
      ) : null}
      {save.isError ? (
        <p className="mt-2 px-1 text-destructive text-sm" role="alert">
          {save.error.message}
        </p>
      ) : null}
    </SettingsSection>
  );
}

/**
 * The phones linked to this account through the HyperNoesis app, where Clicky can be asked by
 * holding to talk. Revoke signs that phone out at once. On a server too old to keep the list, the
 * section is not drawn at all.
 */
export function ClickyPhonesSection() {
  const { t } = useTranslation("settings");
  const devices = useQuery(mobileDevicesQueryOptions());
  const revoke = useMutation(revokeMobileDeviceMutationOptions(queryClient));
  if (devices.isPending || devices.data === null) return null;
  const when = (iso: string) => {
    const date = new Date(iso);
    return Number.isNaN(date.getTime())
      ? ""
      : dateTimeFormat({ dateStyle: "medium" }).format(date);
  };
  return (
    <SettingsSection label={t("Phones")}>
      {devices.error ? (
        <div className="px-1">
          <p className="text-destructive text-sm" role="alert">
            {devices.error.message}
          </p>
          <Button
            onClick={() => void devices.refetch()}
            size="sm"
            variant="ghost"
          >
            {t("Retry")}
          </Button>
        </div>
      ) : devices.data.length === 0 ? (
        <SettingsCard>
          <p className="px-4 py-3 text-[13px] text-muted-foreground">
            {t(
              "No phones are linked. Sign in to the HyperNoesis app on your phone to talk to Clicky from it.",
            )}
          </p>
        </SettingsCard>
      ) : (
        <SettingsCard>
          {devices.data.map((device) => (
            <SettingsRow
              control={
                <Button
                  disabled={revoke.isPending && revoke.variables === device.id}
                  onClick={() => revoke.mutate(device.id)}
                  size="sm"
                  variant="ghost"
                >
                  {revoke.isPending && revoke.variables === device.id
                    ? t("Revoking…")
                    : t("Revoke")}
                </Button>
              }
              description={t("{{platform}} · last used {{date}}", {
                platform: PLATFORM_NAME[device.platform] ?? device.platform,
                date: when(device.lastSeenAt),
              })}
              key={device.id}
              label={device.name}
            />
          ))}
        </SettingsCard>
      )}
      {revoke.isError ? (
        <p className="mt-2 px-1 text-destructive text-sm" role="alert">
          {revoke.error.message}
        </p>
      ) : null}
    </SettingsSection>
  );
}
