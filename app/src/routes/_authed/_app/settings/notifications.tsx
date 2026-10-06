import { createFileRoute } from "@tanstack/react-router";
import { NotificationsSection } from "@/components/settings/notifications-section";
import { SettingsPage } from "@/components/settings/settings-page";

export const Route = createFileRoute("/_authed/_app/settings/notifications")({
  component: RouteComponent,
});

/**
 * Called Notifications, where it used to be called Reachability: what people come here for is to
 * be told about a question or an approval where they already are, and that is a notification to
 * them, whatever the transport is called on the way.
 */
function RouteComponent() {
  return (
    <SettingsPage
      description="Continue a conversation in Slack, Microsoft Teams, by text message, or on your phone. Questions and approval requests reach the same person who owns the conversation, wherever they are."
      title="Notifications"
    >
      <NotificationsSection />
    </SettingsPage>
  );
}
