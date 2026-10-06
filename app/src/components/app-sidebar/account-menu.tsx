import {
  IconChecks,
  IconChevronRight,
  IconGauge,
  IconLogout,
  IconSettings,
  IconShieldLock,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import type * as React from "react";
import { useState } from "react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { approvalInboxOptions } from "@/lib/approvals";
import { signOutMutationOptions } from "@/lib/auth/mutations";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { clearReturnTo } from "@/lib/return-to";
import { formatCredits, usageQueryOptions } from "@/lib/usage/queries";
import { cn } from "@/lib/utils";

/*
 * Typed as plain strings on purpose. The Settings sections and the Marketplace are routes another
 * work package is still adding, and a literal path the route tree does not yet know is a type
 * error at every `Link`; a `string` is what `ModalShell` already navigates with. Narrow these back
 * to literals once the routes exist.
 */
const USAGE_PATH: string = "/settings/usage";
const APPROVALS_PATH: string = "/settings/approvals";
const SETTINGS_PATH: string = "/settings";
const ADMIN_PATH: string = "/admin";

const rowClassName =
  "flex h-11 w-full items-center gap-3 rounded-lg px-3 text-left text-[15px] text-foreground outline-none hover:bg-muted focus-visible:bg-muted data-popup-open:bg-muted [&_svg]:size-5 [&_svg]:shrink-0 [&_svg]:text-muted-foreground";

/** Initials from a name, or from the start of the address when there is no name to take them from. */
export function initialsOf(person: {
  name?: string | null;
  email: string;
}): string {
  const fromName = person.name
    ?.trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
  return fromName || person.email.slice(0, 2).toUpperCase();
}

/** The signed-in person's initials in a round card-coloured button: the account menu's trigger. */
function UserAvatar(props: React.ComponentPropsWithoutRef<"button">) {
  const { data: currentUser } = useQuery(currentUserQueryOptions());
  const initials = currentUser ? initialsOf(currentUser) : "";
  return (
    <button
      type="button"
      aria-label="Account menu"
      {...props}
      className={cn(
        "flex size-9 shrink-0 items-center justify-center rounded-full bg-card text-sm font-medium text-foreground outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 aria-expanded:bg-muted",
        props.className,
      )}
    >
      {initials}
    </button>
  );
}

/**
 * One row of the menu: a link that also closes the popover.
 *
 * A plain router `Link`, not `PopoverClose` with a link drawn through it: the primitive's close
 * is a button and stamps `role="button"` on whatever it renders, which turns a destination into
 * an action as far as a screen reader is told. Closing is the menu's own `open` state instead,
 * reset on the way out.
 */
function MenuLink({
  to,
  onNavigate,
  children,
}: {
  to: string;
  onNavigate: () => void;
  children: React.ReactNode;
}) {
  return (
    <Link to={to} className={rowClassName} onClick={onNavigate}>
      {children}
    </Link>
  );
}

/**
 * What the usage row says.
 *
 * "Usage" alone while the figure is still on its way or could not be had: the row is a doorway to
 * the usage tab either way, and a number that is not known is better left unsaid than drawn as
 * zero. Exported so the wording is pinned where it is decided.
 */
export function usageRowLabel(weekCredits: number | undefined): string {
  return weekCredits === undefined
    ? "Usage"
    : `Usage · ${formatCredits(weekCredits)} credits this week`;
}

/** The usage row, mounted only on a metered deployment so an own-key one never asks the server. */
function UsageRow({ onNavigate }: { onNavigate: () => void }) {
  const usage = useQuery(usageQueryOptions());
  return (
    <MenuLink to={USAGE_PATH} onNavigate={onNavigate}>
      <IconGauge />
      <span className="min-w-0 flex-1 truncate">
        {usageRowLabel(usage.data?.week.credits)}
      </span>
      <IconChevronRight className="size-4!" />
    </MenuLink>
  );
}

/** The Approvals row, with how many are waiting. Mounted with the menu, so a closed menu polls nothing. */
function ApprovalsRow({ onNavigate }: { onNavigate: () => void }) {
  const approvals = useQuery(approvalInboxOptions());
  const pending = (approvals.data?.requests ?? []).filter(
    (request) => request.status === "pending",
  ).length;
  return (
    <MenuLink to={APPROVALS_PATH} onNavigate={onNavigate}>
      <IconChecks />
      <span className="min-w-0 flex-1 truncate">Approvals</span>
      {pending > 0 ? (
        <span className="rounded-full bg-primary px-1.5 text-[11px] font-medium text-primary-foreground tabular-nums">
          {pending}
          <span className="sr-only"> pending</span>
        </span>
      ) : null}
    </MenuLink>
  );
}

/**
 * The account menu behind the sidebar's avatar.
 *
 * Grok Bot's: usage, then the places a person goes to look after their account, then the way out.
 * Rows are gated where the server gates them — usage only on a deployment the platform meters,
 * Admin only for an administrator — so a row that is here is a row that works. The pending
 * approvals count rides on the Approvals row, because an approval is the one thing in this menu
 * that is waiting on the person rather than the other way round.
 *
 * The usage figure and the approvals count are asked for by the rows, which exist only while the
 * menu is open: the sidebar is on screen all day, and a closed menu should cost the server nothing.
 *
 * Signing out forgets the remembered return location as well: the chat it named belongs to the
 * session that just ended, and the next sign-in must not close its first modal back into it.
 */
export function AccountMenu() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: currentUser } = useQuery(currentUserQueryOptions());
  const capabilities = useQuery(deploymentCapabilitiesQueryOptions());
  const signOut = useMutation(signOutMutationOptions(queryClient));
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  const handleSignOut = async () => {
    await signOut.mutateAsync();
    clearReturnTo();
    close();
    await navigate({ to: "/sign" });
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<UserAvatar />} nativeButton />
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-72"
        aria-label="Account"
      >
        {capabilities.data?.usage === true ? (
          <UsageRow onNavigate={close} />
        ) : null}
        <ApprovalsRow onNavigate={close} />
        <MenuLink to={SETTINGS_PATH} onNavigate={close}>
          <IconSettings />
          <span className="min-w-0 flex-1 truncate">Settings</span>
        </MenuLink>
        {/* Admin routes are server-guarded; hide the entry for people who cannot open them. */}
        {currentUser?.role === "admin" ? (
          <MenuLink to={ADMIN_PATH} onNavigate={close}>
            <IconShieldLock />
            <span className="min-w-0 flex-1 truncate">Admin</span>
          </MenuLink>
        ) : null}
        <Separator className="my-1.5" />
        <button
          type="button"
          className={rowClassName}
          disabled={signOut.isPending}
          onClick={() => {
            void handleSignOut();
          }}
        >
          <IconLogout />
          <span className="min-w-0 flex-1 truncate">Log out</span>
        </button>
      </PopoverContent>
    </Popover>
  );
}
