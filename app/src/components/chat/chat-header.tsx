import { IconLayoutSidebarRight } from "@tabler/icons-react";
import type { ReactNode } from "react";
import { ChannelAvatar } from "@/components/channels/avatar";
import { SidebarToggle } from "@/components/layout/sidebar-toggle";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The one row of chrome above a conversation: the sidebar toggle, the Bot's pill in the middle,
 * and the bot panel toggle on the right.
 *
 * Nothing else. The gear, the "Computer" toggle and the "Take control" button that used to crowd
 * the right side are gone: the pill opens the panel on the Bot's details, the toggle opens it on
 * whichever tab it was on, and the wheel lives in the screen card where the screen is. `extra` is
 * for a screen with one control of its own, such as `/bot`'s "New chat".
 */
export function ChatHeader({
  agentIds,
  name,
  panelOpen,
  onPill,
  onToggle,
  extra,
  className,
}: {
  /** The Bots in the conversation, drawn stacked in the pill for a group. */
  agentIds: string[];
  name: string;
  panelOpen: boolean;
  /** The pill was pressed: open the panel on the Bot's details. */
  onPill: () => void;
  /** The toggle was pressed: open or close the panel. */
  onToggle: () => void;
  extra?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn("flex h-12 shrink-0 items-center gap-2 px-3", className)}
    >
      <div className="flex flex-1 items-center justify-start">
        <SidebarToggle />
      </div>
      <BotPill agentIds={agentIds} name={name} onClick={onPill} />
      <div className="flex flex-1 items-center justify-end gap-1.5">
        {extra}
        <Button
          aria-expanded={panelOpen}
          aria-label={panelOpen ? "Hide details" : "Show details"}
          className="rounded-full text-muted-foreground"
          onClick={onToggle}
          size="icon"
          variant="ghost"
        >
          <IconLayoutSidebarRight className="size-4.5" />
        </Button>
      </div>
    </div>
  );
}

/** Who you are talking to, as a button: the avatar and the name on a card-coloured pill. */
function BotPill({
  agentIds,
  name,
  onClick,
}: {
  agentIds: string[];
  name: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-label={`Open ${name}`}
      className="flex h-9 max-w-[60%] shrink-0 items-center gap-2 rounded-full bg-card pl-1 pr-3 text-sm font-medium outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
      onClick={onClick}
      type="button"
    >
      <ChannelAvatar participantIds={agentIds} size={22} />
      <span className="min-w-0 truncate">{name}</span>
    </button>
  );
}
