import { IconChevronRight } from "@tabler/icons-react";
import { Link, type LinkOptions } from "@tanstack/react-router";
import type * as React from "react";

import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { cn } from "@/lib/utils";

/**
 * The rows the Settings modal is built from: a small muted label, then a card of rows divided by
 * hairlines, each row a label (with an optional second line) on the left and its control on the
 * right. The same three pieces draw every section, so the modal reads as one surface instead of
 * eight pages that happen to share a frame.
 *
 * The row is the `Item` family from `item.tsx` with the spacing this layout asks for, rather than
 * a fresh flex box, so a row that needs media or an action strip can keep using those parts.
 */
function SettingsSection({
  label,
  className,
  children,
  ...props
}: React.ComponentProps<"section"> & { label: string }) {
  return (
    <section
      data-slot="settings-section"
      className={cn("flex flex-col", className)}
      {...props}
    >
      <h3 className="mb-2 ml-1 text-[13px] font-normal text-muted-foreground">
        {label}
      </h3>
      {children}
    </section>
  );
}

function SettingsCard({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="settings-card"
      className={cn(
        "flex flex-col divide-y divide-border overflow-hidden rounded-2xl bg-card",
        className,
      )}
      {...props}
    />
  );
}

type SettingsRowProps = {
  label: React.ReactNode;
  /** A second line under the label, in the muted colour. */
  description?: React.ReactNode;
  /** What sits on the right: a switch, a select, a button, a value. */
  control?: React.ReactNode;
  /**
   * Makes the whole row a link, with a chevron after whatever `control` shows. For a row that opens
   * another section or an external page rather than editing something in place.
   */
  href?: LinkOptions;
  className?: string;
};

function SettingsRow({
  label,
  description,
  control,
  href,
  className,
}: SettingsRowProps) {
  const body = (
    <>
      <ItemContent className="min-w-0 gap-0.5">
        <ItemTitle className="text-[15px] font-normal leading-5">
          {label}
        </ItemTitle>
        {description !== undefined && description !== null && (
          <ItemDescription className="text-[13px] leading-[18px]">
            {description}
          </ItemDescription>
        )}
      </ItemContent>
      {(control !== undefined || href !== undefined) && (
        <ItemActions className="shrink-0 gap-2 text-[15px] text-muted-foreground">
          {control}
          {href !== undefined && (
            <IconChevronRight
              aria-hidden
              className="size-4 text-muted-foreground"
            />
          )}
        </ItemActions>
      )}
    </>
  );
  const rowClassName = cn(
    "min-h-14 flex-nowrap justify-between gap-4 rounded-none border-0 px-4 py-2 text-[15px]",
    href !== undefined && "hover:bg-muted/50 focus-visible:ring-inset",
    className,
  );
  if (href !== undefined) {
    return (
      <Item
        data-slot="settings-row"
        className={rowClassName}
        render={<Link {...href} />}
      >
        {body}
      </Item>
    );
  }
  return (
    <Item data-slot="settings-row" className={rowClassName}>
      {body}
    </Item>
  );
}

export { SettingsCard, SettingsRow, SettingsSection };
export type { SettingsRowProps };
