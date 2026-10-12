import { IconChevronLeft } from "@tabler/icons-react";
import {
  createFileRoute,
  Link,
  Outlet,
  redirect,
  useLocation,
} from "@tanstack/react-router";
import { PageFrame } from "@/components/layout/page-shell";
import { useSettingsNav } from "@/components/settings/settings-nav";
import { Button } from "@/components/ui/button";
import { ModalShell } from "@/components/ui/modal-shell";
import { currentUserQueryOptions } from "@/lib/auth/queries";

/**
 * Admin, drawn inside the Settings modal: the Admin row of its nav opens the deployment's
 * settings as a section of the same popup, the way every other row opens one.
 *
 * It used to be its own screen with its own sidebar, reached by leaving Settings. Under `_app`
 * now, beside `settings/`, for the same reasons that route gives: the roster stays mounted behind
 * the modal, and the URLs are unchanged (`/admin/*`), so every link into an admin screen keeps
 * working. The nav is the Settings nav, so the column on the left is the one the person just used
 * and Admin is the row that lights.
 *
 * The screens draw through `PageShell` as before; `PageFrame` tells it that it is inside a modal,
 * so it takes the Settings pages' measure and never draws the sidebar toggle. A screen one level
 * under `/admin` gets a Back to Admin above it, since its old way back was the sidebar this modal
 * does not have; deeper screens already carry a Back to their own parent.
 */
export const Route = createFileRoute("/_authed/_app/admin")({
  beforeLoad: async ({ context }) => {
    const user = await context.queryClient.ensureQueryData(
      currentUserQueryOptions(),
    );
    if (user?.role !== "admin") {
      throw redirect({ to: "/" });
    }
  },
  component: RouteComponent,
});

function RouteComponent() {
  const nav = useSettingsNav();
  const { pathname } = useLocation();
  const depth = pathname.split("/").filter(Boolean).length;

  return (
    <>
      {/* The main column under the modal: plain, so nothing half-drawn shows through the overlay. */}
      <div aria-hidden className="flex-1 bg-background" />
      <ModalShell nav={nav} title="Settings" width={1100}>
        <PageFrame.Provider value="modal">
          {depth === 2 ? (
            <div className="mx-auto w-full max-w-3xl px-4 pt-4 md:px-6">
              <Button
                aria-label="Back to Admin"
                render={(props) => <Link to="/admin" {...props} />}
                size="sm"
                variant="ghost"
              >
                <IconChevronLeft />
                Admin
              </Button>
            </div>
          ) : null}
          <Outlet />
        </PageFrame.Provider>
      </ModalShell>
    </>
  );
}
