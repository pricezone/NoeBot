import { IconChevronLeft } from "@tabler/icons-react";
import {
  createFileRoute,
  Link,
  Outlet,
  redirect,
  useLocation,
} from "@tanstack/react-router";
import { PageFrame } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { useTranslation } from "@/lib/i18n";
import { ensureNamespaces } from "@/lib/i18n/set-locale";

/**
 * Advanced Settings: the deployment-wide settings, a section of the Settings popup.
 *
 * A child of `settings/`, so it draws in that route's `<Outlet/>` inside the one Settings modal:
 * moving between General and Advanced Settings swaps the section, it does not close the popup and
 * open a second one (which is what the old sibling `/admin` route did, with its own `ModalShell`).
 * The old `/admin/*` addresses redirect here (`routes/_authed/_app/admin/`).
 *
 * The screens draw through `PageShell`; `PageFrame` tells it that it is inside a modal, so it takes
 * the Settings pages' measure and never draws the sidebar toggle. A screen one level down gets a
 * Back to Advanced Settings above it; deeper screens already carry a Back to their own parent.
 */
export const Route = createFileRoute("/_authed/_app/settings/advanced")({
  beforeLoad: async ({ context }) => {
    const user = await context.queryClient.ensureQueryData(
      currentUserQueryOptions(),
    );
    if (user?.role !== "admin") {
      throw redirect({ to: "/settings" });
    }
    // Its own words arrive with it, before it draws; English has none to wait for.
    await ensureNamespaces(["admin"]);
  },
  component: RouteComponent,
});

/** Segments in `/settings/advanced/<screen>`: the depth that gets the Back link. */
const SCREEN_DEPTH = 3;

function RouteComponent() {
  const { t } = useTranslation("admin");
  const { pathname } = useLocation();
  const depth = pathname.split("/").filter(Boolean).length;

  return (
    <PageFrame.Provider value="modal">
      {depth === SCREEN_DEPTH ? (
        <div className="mx-auto w-full max-w-3xl px-4 pt-4 md:px-6">
          <Button
            aria-label={t("Back to Advanced Settings")}
            render={(props) => <Link to="/settings/advanced" {...props} />}
            size="sm"
            variant="ghost"
          >
            <IconChevronLeft />
            {t("Advanced Settings")}
          </Button>
        </div>
      ) : null}
      <Outlet />
    </PageFrame.Provider>
  );
}
