import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { currentUserQueryOptions, needsOnboarding } from "../lib/auth/queries";
import { CopilotProvider } from "../lib/copilot/provider";
import { deploymentCapabilitiesQueryOptions } from "../lib/deployment/queries";
import { AppHotkeys } from "../lib/hotkeys/app-hotkeys";
import { settleSignedInLocale } from "../lib/i18n/sync";

export const Route = createFileRoute("/_authed")({
  beforeLoad: async ({ context, location }) => {
    // Alongside the user rather than after it: the language settled below needs both.
    void context.queryClient
      .prefetchQuery(deploymentCapabilitiesQueryOptions())
      .catch(() => {});
    const user = await context.queryClient.ensureQueryData(
      currentUserQueryOptions(),
    );
    if (!user) {
      throw redirect({ to: "/sign" });
    }
    // The person's own language before anything of theirs is drawn; once per page load.
    await settleSignedInLocale(context.queryClient, user);
    /*
     * Somebody who has not finished onboarding goes there and nowhere else. Here rather than in
     * `_app`, so admin and settings are behind the same gate; checked against the destination so
     * the onboarding route itself stays reachable.
     */
    if (needsOnboarding(user) && location.pathname !== "/onboarding") {
      throw redirect({ to: "/onboarding" });
    }
  },
  // Mounted INSIDE the authed boundary, not at the root: the runtime endpoint requires a session, so
  // a provider above the sign-in gate would open a run for a visitor who has not signed in yet.
  component: () => (
    <CopilotProvider>
      <AppHotkeys />
      <Outlet />
    </CopilotProvider>
  ),
});
