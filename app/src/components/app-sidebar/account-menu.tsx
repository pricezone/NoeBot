import {
  IconChevronRight,
  IconCreditCard,
  IconLogout,
  IconSettings,
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
import { signOutMutationOptions } from "@/lib/auth/mutations";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { i18n, msg, useTranslation } from "@/lib/i18n";
import { clearReturnTo } from "@/lib/return-to";
import { formatCredits, usageQueryOptions } from "@/lib/usage/queries";
import { cn } from "@/lib/utils";
import { rowClassName } from "./account-menu-row";
import { LanguageRow } from "./language-row";

/*
 * Typed as plain strings on purpose. The Settings sections and the Marketplace are routes another
 * work package is still adding, and a literal path the route tree does not yet know is a type
 * error at every `Link`; a `string` is what `ModalShell` already navigates with. Narrow these back
 * to literals once the routes exist.
 */
const USAGE_PATH: string = "/settings/usage";
const SETTINGS_PATH: string = "/settings";

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
  const { t } = useTranslation();
  const { data: currentUser } = useQuery(currentUserQueryOptions());
  const initials = currentUser ? initialsOf(currentUser) : "";
  return (
    <button
      type="button"
      aria-label={t("Account menu")}
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
 * What the usage row says, laid out as Grok Bot's "Weekly usage   3%  ›": the label on the left,
 * the week's figure on the right in muted type. A 288px menu could not hold the figure inside
 * the label. Named after the Settings section it opens, so the menu and the nav agree.
 *
 * No figure while it is still on its way or could not be had: the row is a doorway to the usage
 * tab either way, and a number that is not known is better left unsaid than drawn as zero.
 * Exported so the wording is pinned where it is decided.
 */
export const USAGE_ROW_LABEL = msg("Usage & Billing");

export function usageRowValue(weekCredits: number | undefined): string | null {
  if (weekCredits === undefined) return null;
  return i18n.t("{{credits}} credits", {
    credits: formatCredits(weekCredits),
    count: Number.isFinite(weekCredits) ? Math.round(weekCredits) : 0,
    defaultValue_one: "{{credits}} credit",
  });
}

/** The usage row, mounted only on a metered deployment so an own-key one never asks the server. */
function UsageRow({ onNavigate }: { onNavigate: () => void }) {
  const { t } = useTranslation();
  const usage = useQuery(usageQueryOptions());
  return (
    <MenuLink to={USAGE_PATH} onNavigate={onNavigate}>
      <IconCreditCard />
      <span className="min-w-0 flex-1 truncate">{t(USAGE_ROW_LABEL)}</span>
      {usageRowValue(usage.data?.week.credits) ? (
        <span className="shrink-0 text-muted-foreground tabular-nums">
          {usageRowValue(usage.data?.week.credits)}
        </span>
      ) : null}
      <IconChevronRight className="size-4!" />
    </MenuLink>
  );
}

/**
 * The account menu behind the sidebar's avatar.
 *
 * Grok Bot's: usage, then Settings, then the interface language (only where the deployment offers
 * more than one; see `language-row.tsx`), then the way out. Approvals and Admin are not rows here any
 * more: both are sections of Settings, where the nav names them, and a menu that repeated them
 * was two ways to the same place. The usage row is gated where the server gates it — only on a
 * deployment the platform meters — so a row that is here is a row that works.
 *
 * The usage figure is asked for by the row, which exists only while the menu is open: the
 * sidebar is on screen all day, and a closed menu should cost the server nothing.
 *
 * Signing out forgets the remembered return location as well: the chat it named belongs to the
 * session that just ended, and the next sign-in must not close its first modal back into it.
 */
export function AccountMenu() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
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
        aria-label={t("Account")}
      >
        {capabilities.data?.usage === true ? (
          <UsageRow onNavigate={close} />
        ) : null}
        <MenuLink to={SETTINGS_PATH} onNavigate={close}>
          <IconSettings />
          <span className="min-w-0 flex-1 truncate">{t("Settings")}</span>
        </MenuLink>
        <LanguageRow />
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
          <span className="min-w-0 flex-1 truncate">{t("Log out")}</span>
        </button>
      </PopoverContent>
    </Popover>
  );
}
