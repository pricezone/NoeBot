import { createFileRoute, Outlet } from "@tanstack/react-router";
import { useSettingsNav } from "@/components/settings/settings-nav";
import { ModalShell } from "@/components/ui/modal-shell";

/**
 * Settings, drawn as a modal over the app shell.
 *
 * Under `_app` rather than beside it, so the roster stays mounted and the socket it opens stays
 * open while somebody edits a preference; the URLs are unchanged (`/settings/*`), which is what
 * the OAuth return on `/settings/connected-accounts/<id>` depends on. The column behind the modal
 * is this route's own outlet and shows nothing: the modal is the page. Closing is a navigation
 * back to wherever the shell last recorded the person being (`lib/return-to.ts`).
 *
 * The sections are `components/settings/settings-nav.ts`, which the sidebar's search shares.
 */
export const Route = createFileRoute("/_authed/_app/settings")({
  component: RouteComponent,
});

function RouteComponent() {
  const nav = useSettingsNav();

  return (
    <>
      {/* The main column under the modal: plain, so nothing half-drawn shows through the overlay. */}
      <div aria-hidden className="flex-1 bg-background" />
      <ModalShell nav={nav} title="Settings" width={1100}>
        <Outlet />
      </ModalShell>
    </>
  );
}
