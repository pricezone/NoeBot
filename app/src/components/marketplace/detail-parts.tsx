import type * as React from "react";

/**
 * The pieces a Marketplace page is laid out from — a plugin's page and a Bot template's page are
 * the same shape: groups of rows under a counted heading, and a card of facts.
 * One set here so the two pages cannot drift apart over a padding.
 */

/** "Apps 1" over a card of rows; nothing at all when there are none. */
export function Group({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  if (count === 0) return null;
  return (
    <section aria-label={title} className="mt-8">
      <h2 className="mb-3 text-[15px] font-medium">
        {title}{" "}
        <span className="font-normal text-muted-foreground">{count}</span>
      </h2>
      <div className="flex flex-col divide-y divide-border/60 rounded-2xl bg-muted/40 px-5">
        {children}
      </div>
    </section>
  );
}

/** A row of a group: a mark, a title, a line under it, and whatever stands at the right edge. */
export function Row({
  mark,
  title,
  summary,
  action,
}: {
  mark: React.ReactNode;
  title: string;
  summary?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 py-3">
      <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center text-muted-foreground [&_img]:size-5 [&_svg]:size-5">
        {mark}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[15px] font-medium">{title}</span>
        {summary ? (
          <span className="line-clamp-2 text-sm text-muted-foreground">
            {summary}
          </span>
        ) : null}
      </span>
      {action ? <span className="shrink-0 self-center">{action}</span> : null}
    </div>
  );
}

export function Fact({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-6 border-b border-border/60 py-3 last:border-b-0">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-right text-sm">{children}</dd>
    </div>
  );
}

export function countOf(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
