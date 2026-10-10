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
import type { ModalNavItem } from "@/components/ui/modal-shell";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";

/**
 * The sections of Settings, in the order its nav draws them.
 *
 * One list for the two places that name them: the Settings modal's own column
 * (`routes/_authed/_app/settings/route.tsx`) and the search popup in the sidebar, which offers
 * each one as "Settings: <label>". Kept in one place so a section added to the modal is searchable
 * the moment it exists, and a renamed one is not still found under its old name.
 */
export const SETTINGS_NAV: ModalNavItem[] = [
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

/**
 * The sections this deployment has, before the per-person admin filter.
 *
 * Usage & Billing only where there is something to show: a metered deployment has a meter, and
 * one with a billing page has somewhere to send people. A bring-your-own-key deployment with
 * neither would get a row that could only say "nothing here". Admin stays in the list either way:
 * whether the signed-in person may see it is the caller's question (`ModalShell` asks it for the
 * modal, the search popup for itself).
 */
export function useSettingsNav(): ModalNavItem[] {
  const capabilities = useQuery(deploymentCapabilitiesQueryOptions());
  const hasBilling =
    capabilities.data?.usage === true ||
    typeof capabilities.data?.billingUrl === "string";
  return hasBilling
    ? SETTINGS_NAV
    : SETTINGS_NAV.filter((item) => item.id !== "usage");
}
