import { createFileRoute } from "@tanstack/react-router";
import { SettingsPage } from "@/components/settings/settings-page";
import { UsageSection } from "@/components/settings/usage-section";

/**
 * Reachable by URL on every deployment; the nav row for it shows only where there is a meter or a
 * billing page (`settings/route.tsx`). The page itself explains the other case rather than 404ing,
 * because a link to it may have been sent from a deployment that had one.
 */
export const Route = createFileRoute("/_authed/_app/settings/usage")({
  component: RouteComponent,
});

function RouteComponent() {
  return (
    <SettingsPage
      description="What this deployment has spent, and where its subscription is managed."
      title="Usage & Billing"
    >
      <UsageSection />
    </SettingsPage>
  );
}
