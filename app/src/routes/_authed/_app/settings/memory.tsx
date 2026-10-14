import { createFileRoute } from "@tanstack/react-router";
import { MemorySection } from "@/components/settings/memory-section";
import { SettingsPage } from "@/components/settings/settings-page";
import { useTranslation } from "@/lib/i18n";

export const Route = createFileRoute("/_authed/_app/settings/memory")({
  component: RouteComponent,
});

function RouteComponent() {
  const { t } = useTranslation("settings");
  return (
    <SettingsPage
      description={t(
        "Review what your Bots remember, and choose which connected apps can contribute facts.",
      )}
      title={t("Memory")}
    >
      <MemorySection />
    </SettingsPage>
  );
}
