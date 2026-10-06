import { createFileRoute, Outlet, useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import { AppSidebar } from "@/components/app-sidebar/app-sidebar";
import { SidebarShell } from "@/components/layout/sidebar-shell";
import { rememberReturnTo } from "@/lib/return-to";

export const Route = createFileRoute("/_authed/_app")({
  component: RouteComponent,
});

function RouteComponent() {
  const router = useRouter();
  /*
   * Where a modal closes back to. Settings and the Marketplace are routes drawn over this shell,
   * and closing one is a navigation to wherever the person was before it — which only the shell,
   * which outlives every route beneath it, is placed to remember. The current location first,
   * because the navigation that mounted this shell has already resolved; then every resolution
   * after it. `rememberReturnTo` ignores the modal paths itself, so a modal is never its own exit.
   */
  useEffect(() => {
    const { location } = router.state;
    rememberReturnTo(location.pathname + location.searchStr);
    return router.subscribe("onResolved", ({ toLocation }) => {
      rememberReturnTo(toLocation.pathname + toLocation.searchStr);
    });
  }, [router]);

  return (
    // One viewport, never scrolls: panes scroll inside it. A growable shell lets the transcript's
    // scroller size against the page, grow it, and grow again.
    <SidebarShell className="h-svh overflow-hidden" width="280px">
      <AppSidebar />
      <main className="flex-1 flex flex-col min-h-0 overflow-hidden">
        <Outlet />
      </main>
    </SidebarShell>
  );
}
