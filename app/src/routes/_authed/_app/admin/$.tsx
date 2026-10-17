import { createFileRoute, redirect } from "@tanstack/react-router";
import { advancedSettingsHref } from "@/lib/settings/advanced-path";

/**
 * The old Admin addresses. Admin is now Advanced Settings, a section of the Settings popup
 * (`settings/advanced/*`), so `/admin` and everything under it (a splat matches both) redirect to
 * the same screen there, search and hash kept.
 */
export const Route = createFileRoute("/_authed/_app/admin/$")({
  beforeLoad: ({ location }) => {
    throw redirect({
      href: advancedSettingsHref(location.href),
      replace: true,
    });
  },
});
