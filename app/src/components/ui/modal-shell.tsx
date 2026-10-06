import { IconX } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import type * as React from "react";
import { useRef } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { readReturnTo } from "@/lib/return-to";
import { cn } from "@/lib/utils";

/**
 * A route drawn as a centred modal over the app shell: Settings and the Marketplace.
 *
 * WHY A ROUTE AND NOT A DIALOG WITH STATE. Settings has eight sections and the Marketplace three
 * tabs, each worth a URL you can send somebody, and the OAuth return lands on
 * `/settings/connected-accounts/<id>` with nothing in React state to restore. So the modal is
 * always open while its route is mounted, and closing it is a navigation: `onClose` when the
 * caller wants to decide, else `closeTo`, else wherever the app shell last recorded the person
 * being (`readReturnTo`, which falls back to `/`). Escape and the X button are the same close.
 *
 * The left column is the shell's own, not the sidebar primitive: `Sidebar collapsible="none"`
 * brings a provider, a rail and cookie-backed width state that a 220px list of links inside a
 * dialog has no use for. Rows are router `Link`s, so the active one lights from the URL, with the
 * `exact` flag the General row needs, since `/settings` prefixes every other row.
 *
 * Below `md` the dialog is the whole screen and the column becomes a scrollable row along the
 * top, the pattern `agent-dialog.tsx` arrived at when its sidebar hid on a phone and left the
 * sections unreachable.
 */
type ModalNavItem = {
  id: string;
  label: string;
  icon?: React.ComponentType<{ className?: string }>;
  to: string;
  /** Light this row only on its own path, not on paths beneath it. */
  exact?: boolean;
  /** Hidden unless the signed-in person is an administrator. */
  adminOnly?: boolean;
};

type ModalShellProps = {
  title?: string;
  nav?: ModalNavItem[];
  width: 1000 | 1100;
  closeTo?: string;
  onClose?: () => void;
  children: React.ReactNode;
  /** Restyles the popup, for a shell whose body wants a different surface colour. */
  className?: string;
};

const WIDTH_CLASS: Record<ModalShellProps["width"], string> = {
  1000: "md:max-w-[1000px]",
  1100: "md:max-w-[1100px]",
};

function ModalShell({
  title,
  nav,
  width,
  closeTo,
  onClose,
  children,
  className,
}: ModalShellProps) {
  const navigate = useNavigate();
  const user = useQuery(currentUserQueryOptions());
  const isAdmin = user.data?.role === "admin";
  const rows = (nav ?? []).filter((item) => !item.adminOnly || isAdmin);
  const hasNav = rows.length > 0;
  /*
   * Where focus lands when the modal opens: the body, not the first row of the nav. Base UI moves
   * focus to the first tabbable element by default, which drew a focus ring around "General" on
   * every visit as if the person had tabbed to it. The body takes focus without a ring, and Tab
   * still reaches the nav from there.
   */
  const bodyRef = useRef<HTMLDivElement>(null);

  const close = () => {
    if (onClose) {
      onClose();
      return;
    }
    void navigate({ to: closeTo ?? readReturnTo() });
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent
        initialFocus={bodyRef}
        showCloseButton={false}
        className={cn(
          /*
           * Full-screen below md, a fixed-height card above it. `h-[85svh]` rather than the base
           * dialog's `max-h`: the nav column has to be the same height whichever section is showing,
           * or the modal would jump as somebody moves between a short section and a long one.
           */
          "inset-0 h-svh max-h-none w-full max-w-none translate-x-0 translate-y-0 flex-row gap-0 overflow-hidden rounded-none border-0 bg-card p-0 text-popover-foreground",
          "md:inset-auto md:top-1/2 md:left-1/2 md:h-[85svh] md:w-[calc(100%-2rem)] md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-2xl",
          WIDTH_CLASS[width],
          className,
        )}
      >
        {/*
         * The dialog's accessible name, said once. The visible title is drawn in two places (the
         * column above md, the strip below it) and only one of them is displayed at a time, so
         * neither is a heading; this one carries the name and the visible copies are plain text.
         */}
        <DialogTitle className="sr-only">
          {title ?? rows[0]?.label ?? "Dialog"}
        </DialogTitle>
        {hasNav && (
          <nav
            aria-label={title ?? "Sections"}
            className="hidden w-[220px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border bg-card p-3 md:flex"
          >
            {title !== undefined && (
              <div className="mb-3 px-3 pt-2 text-[17px] font-semibold text-foreground">
                {title}
              </div>
            )}
            {rows.map((item) => (
              <NavRow key={item.id} item={item} />
            ))}
          </nav>
        )}
        {/*
         * With a nav, the sections sit on the page colour beside a raised nav column, the way Grok
         * Bot's settings do: black in the dark theme, so the section cards read as cards. Without
         * one (the Marketplace) the whole modal is the one raised surface.
         */}
        <div
          className={cn(
            "flex min-w-0 flex-1 flex-col",
            hasNav && "bg-background",
          )}
        >
          {/*
           * The phone-width top strip: the title and the same rows as the column, scrolling
           * sideways. Room is kept on the right for the close button, which floats over it. Above
           * md it hides, unless there is no column at all, in which case it is the header the
           * title needs.
           */}
          {(title !== undefined || hasNav) && (
            <div
              className={cn(
                "flex shrink-0 flex-col gap-2 border-b border-border p-3 pr-14",
                hasNav ? "md:hidden" : "md:h-14 md:justify-center md:px-6",
              )}
            >
              {title !== undefined && (
                <div className="px-1 text-[17px] font-semibold text-foreground md:px-0">
                  {title}
                </div>
              )}
              {hasNav && (
                <div className="flex gap-1 overflow-x-auto">
                  {rows.map((item) => (
                    <NavRow key={item.id} item={item} compact />
                  ))}
                </div>
              )}
            </div>
          )}
          <div
            className="flex min-h-0 flex-1 flex-col overflow-y-auto outline-none"
            ref={bodyRef}
            tabIndex={-1}
          >
            {children}
          </div>
        </div>
        <Button
          aria-label="Close"
          className="absolute top-3 right-3 z-10 rounded-full"
          onClick={close}
          size="icon-lg"
          variant="ghost"
        >
          <IconX />
        </Button>
      </DialogContent>
    </Dialog>
  );
}

function NavRow({ item, compact }: { item: ModalNavItem; compact?: boolean }) {
  return (
    <Link
      to={item.to}
      activeOptions={{ exact: item.exact ?? false }}
      activeProps={{
        className: "bg-foreground/5 text-foreground",
        "aria-current": "page",
      }}
      className={cn(
        "flex h-10 shrink-0 items-center gap-2.5 rounded-lg px-3 text-[15px] text-foreground/80 outline-none transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50",
        compact ? "whitespace-nowrap" : "w-full",
      )}
    >
      {item.icon && <item.icon className="size-[18px] shrink-0" />}
      <span className="truncate">{item.label}</span>
    </Link>
  );
}

export { ModalShell };
export type { ModalNavItem, ModalShellProps };
