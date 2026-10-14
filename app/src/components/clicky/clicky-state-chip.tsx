import { memo } from "react";
import { chipStateOf } from "@/lib/clicky/notices";
import { cn } from "@/lib/utils";
import type { ClickySession } from "../../../../shared/clicky";
import { useClickyStateLabel } from "./clicky-words";

/** The dot's colour per state: calm blue while helping, amber when it needs a yes, red when acting. */
const DOT: Record<ReturnType<typeof chipStateOf>, string> = {
  asleep: "bg-zinc-400",
  idle: "bg-emerald-400",
  listening: "bg-sky-400 animate-pulse",
  thinking: "bg-sky-400 animate-pulse",
  guiding: "bg-sky-400",
  awaiting_permission: "bg-amber-400",
  acting: "bg-red-500 animate-pulse",
  paused: "bg-zinc-400",
  stopped: "bg-zinc-400",
};

/**
 * Where Clicky is, in a word or two: Asleep, Ready, Listening, Thinking, Showing you, Needs your OK,
 * Doing it, Paused, Stopped. Drawn in the viewer's bar and on the panel's preview.
 */
export const ClickyStateChip = memo(function ClickyStateChip({
  session,
  className,
}: {
  session: ClickySession | undefined;
  className?: string;
}) {
  const label = useClickyStateLabel(session);
  const state = chipStateOf(session);
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 font-medium text-xs",
        className,
      )}
      data-clicky-state={state}
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 rounded-full motion-reduce:animate-none",
          DOT[state],
        )}
      />
      {label}
    </span>
  );
});

ClickyStateChip.displayName = "ClickyStateChip";
