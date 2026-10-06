import {
  IconBell,
  IconBrain,
  IconChecks,
  IconCreditCard,
  IconKey,
  IconPlug,
  IconRobot,
  IconSettings,
  IconShieldLock,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet } from "@tanstack/react-router";
import { ModalShell, type ModalNavItem } from "@/components/ui/modal-shell";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";

/**
 * Settings, drawn as a modal over the app shell.
 *
 * Under `_app` rather than beside it, so the roster stays mounted and the socket it opens stays
 * open while somebody edits a preference; the URLs are unchanged (`/settings/*`), which is what
 * the OAuth return on `/settings/connected-accounts/<id>` depends on. The column behind the modal
 * is this route's own outlet and shows nothing: the modal is the page. Closing is a navigation
 * back to wherever the shell last recorded the person being (`lib/return-to.ts`).
 */
export const Route = createFileRoute("/_authed/_app/settings")({
  component: RouteComponent,
});

const NAV: ModalNavItem[] = [
  /* `/settings` prefixes every other row here, and would otherwise light up on all of them. */
  {
    id: "general",
    label: "General",
    icon: IconSettings,
    to: "/settings",
    exact: true,
  },
  { id: "bots", label: "Bots", icon: IconRobot, to: "/settings/bots" },
  { id: "memory", label: "Memory", icon: IconBrain, to: "/settings/memory" },
  {
    id: "approvals",
    label: "Approvals",
    icon: IconChecks,
    to: "/settings/approvals",
  },
  {
    id: "notifications",
    label: "Notifications",
    icon: IconBell,
    to: "/settings/notifications",
  },
  /*
   * The same subject as Admin's Plugins, from the other side: there an administrator decides what
   * this deployment may reach at all, here you decide what it may reach as you.
   */
  {
    id: "apps",
    label: "Apps",
    icon: IconPlug,
    to: "/settings/connected-accounts",
  },
  {
    id: "usage",
    label: "Usage & Billing",
    icon: IconCreditCard,
    to: "/settings/usage",
  },
  /* Logins saved from a Bot's private sign-in form. */
  {
    id: "passwords",
    label: "Passwords",
    icon: IconKey,
    to: "/settings/passwords",
  },
  {
    id: "admin",
    label: "Admin",
    icon: IconShieldLock,
    to: "/admin",
    adminOnly: true,
  },
];

function RouteComponent() {
  const capabilities = useQuery(deploymentCapabilitiesQueryOptions());
  /*
   * Usage & Billing only where there is something to show: a metered deployment has a meter, and
   * one with a billing page has somewhere to send people. A bring-your-own-key deployment with
   * neither would get a row that could only say "nothing here".
   */
  const hasBilling =
    capabilities.data?.usage === true ||
    typeof capabilities.data?.billingUrl === "string";
  const nav = hasBilling ? NAV : NAV.filter((item) => item.id !== "usage");

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
