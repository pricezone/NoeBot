import { createFileRoute } from "@tanstack/react-router";
import { ApprovalInbox } from "@/components/approvals/inbox";
import { SettingsPage } from "@/components/settings/settings-page";
import { useTranslation } from "@/lib/i18n";

export const Route = createFileRoute("/_authed/_app/settings/approvals")({
  component: RouteComponent,
});

function RouteComponent() {
  const { t } = useTranslation("settings");
  return (
    <SettingsPage
      description={t(
        "Choose what your Bots may do, and review actions waiting for you.",
      )}
      title={t("Approvals")}
    >
      <ApprovalInbox />
    </SettingsPage>
  );
}
