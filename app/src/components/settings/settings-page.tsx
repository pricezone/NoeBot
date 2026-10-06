import type * as React from "react";
import { cn } from "@/lib/utils";

/**
 * The frame every page inside the Settings modal sits in.
 *
 * The modal's body wrapper scrolls and carries no padding of its own, so the page brings it: the
 * same measure on every page, a title the column above md already names, and the sections stacked
 * with one gap. `PageShell` is not used here on purpose — it draws a sidebar toggle bar, a 2xl
 * heading and the spacing of a full page, none of which belong inside a card.
 */
export function SettingsPage({
  title,
  description,
  className,
  children,
}: {
  title: string;
  description?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-6 md:px-8",
        className,
      )}
    >
      <header className="flex flex-col gap-1">
        <h2 className="text-[17px] font-semibold">{title}</h2>
        {description ? (
          <p className="max-w-prose text-pretty text-[13px] leading-[18px] text-muted-foreground">
            {description}
          </p>
        ) : null}
      </header>
      {children}
    </div>
  );
}

/**
 * A titled block inside a page that holds several: Bots, Team Bots, Responsibilities and Routines
 * share one page, each reachable by its `id` as a hash. The title is a heading so the block reads
 * as its own thing when somebody lands on it mid-page.
 */
export function SettingsBlock({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section
      className="flex scroll-mt-6 flex-col gap-4"
      data-slot="settings-block"
      id={id}
    >
      <div className="flex flex-col gap-1">
        <h3 className="text-[15px] font-semibold">{title}</h3>
        {description ? (
          <p className="max-w-prose text-pretty text-[13px] leading-[18px] text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      {children}
    </section>
  );
}
