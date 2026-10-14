import { createFileRoute } from "@tanstack/react-router";
import {
  ClickyPhonesSection,
  ClickySettingsSection,
} from "@/components/clicky/clicky-settings";
import { SettingsPage } from "@/components/settings/settings-page";
import { CLICKY_NAME } from "@/lib/clicky/notices";
import { useClickyCapability } from "@/lib/clicky/queries";
import { useTranslation } from "@/lib/i18n";

export const Route = createFileRoute("/_authed/_app/settings/clicky")({
  component: RouteComponent,
});

/**
 * Clicky Mode's settings, and the phones that can talk to it. Listed in the nav only where the
 * deployment offers Clicky; reached by its address on one that does not, it says so.
 */
function RouteComponent() {
  const { t } = useTranslation("settings");
  const { enabled } = useClickyCapability();
  return (
    <SettingsPage
      description={t(
        "Clicky points at your Bot's screen, walks you through it step by step, and acts only when you say so.",
      )}
      title={CLICKY_NAME}
    >
      {enabled ? (
        <>
          <ClickySettingsSection />
          <ClickyPhonesSection />
        </>
      ) : (
        <p className="text-[13px] text-muted-foreground">
          {t("Clicky is not available on this deployment.")}
        </p>
      )}
    </SettingsPage>
  );
}
