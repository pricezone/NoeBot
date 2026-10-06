import { createFileRoute } from "@tanstack/react-router";
import { ApprovalInbox } from "@/components/approvals/inbox";
import { SettingsPage } from "@/components/settings/settings-page";

export const Route = createFileRoute("/_authed/_app/settings/approvals")({
  component: RouteComponent,
});

function RouteComponent() {
  return (
    <SettingsPage
      description="Choose what your Bots may do, and review actions waiting for you."
      title="Approvals"
    >
      <ApprovalInbox />
    </SettingsPage>
  );
}
