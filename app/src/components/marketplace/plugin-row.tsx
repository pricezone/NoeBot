import type * as React from "react";
import { RowMark } from "@/components/layout/row-mark";
import { cn } from "@/lib/utils";

/**
 * One row of the Marketplace: a 48px tile carrying the vendor's mark, the name, one line of
 * description, and the action on the right. Every tab draws its third parties with this so the
 * Apps rows and the Composio directory read as one list rather than two lists that happen to share
 * a modal.
 */
export function PluginRow({
  mark,
  title,
  summary,
  action,
  className,
  ...props
}: Omit<React.ComponentProps<"div">, "title"> & {
  mark: React.ReactNode;
  title: React.ReactNode;
  summary?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div
      className={cn("flex min-w-0 items-center gap-3 py-2", className)}
      {...props}
    >
      {/* The tile is a fixed 48px square, which is what keeps a column of mixed logos aligned. */}
      <RowMark className="size-12 shrink-0 self-center rounded-xl bg-muted/60 [&_img]:size-7 [&_svg:not([class*='size-'])]:size-5">
        {mark}
      </RowMark>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="truncate text-[15px] font-medium text-foreground">
          {title}
        </div>
        {summary ? (
          <p className="line-clamp-1 break-all text-[13px] text-muted-foreground">
            {summary}
          </p>
        ) : null}
      </div>
      {action ? (
        <div className="flex shrink-0 items-center">{action}</div>
      ) : null}
    </div>
  );
}

/** The heading over a group of rows, with room for an action on the right. */
export function MarketplaceSection({
  title,
  action,
  children,
  ...props
}: Omit<React.ComponentProps<"section">, "title"> & {
  title: string;
  action?: React.ReactNode;
}) {
  return (
    <section aria-label={title} className="mt-8 first:mt-0" {...props}>
      <div className="mb-2 flex items-center justify-between gap-4">
        <h2 className="text-[17px] font-semibold text-foreground">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/** Two columns of rows above md, one below, matching the reference layout. */
export function MarketplaceGrid({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-x-8 gap-y-1 md:grid-cols-2">
      {children}
    </div>
  );
}
