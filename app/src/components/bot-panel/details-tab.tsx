import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { AgentDialog } from "@/components/agents/agent-dialog";
import { ForYouSection } from "@/components/bot-profile/for-you-section";
import { ChannelAvatar } from "@/components/channels/avatar";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { agentQueryOptions } from "@/lib/agents/queries";
import type { BotPanelParticipant } from "./bot-panel";

function Tag({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border border-border bg-muted/40 px-2 py-0.5 text-xs text-muted-foreground">
      {children}
    </span>
  );
}

function DetailsSkeleton() {
  return (
    <div className="flex w-full flex-col gap-4">
      <div className="flex gap-1.5">
        <Skeleton className="h-5 w-16 rounded-full" />
        <Skeleton className="h-5 w-24 rounded-full" />
      </div>
      <div className="grid gap-2">
        <Skeleton className="h-3 w-10" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-2/3" />
      </div>
      <Skeleton className="h-9 w-full" />
    </div>
  );
}

/**
 * Who this Bot is and what it does for you.
 *
 * The role and visibility that the old coworker card showed, then the lifecycle rows from the
 * Bot's own page — Paused, Notifications, Reset — and one button into the full dialog for
 * everything that changes the Bot. A card beside a conversation, not a control panel: what
 * changes the Bot lives in the dialog, opened from the one button here.
 */
export function DetailsTab({ agentId }: { agentId: string }) {
  /** The full dialog, opened over the chat rather than navigating away from it. */
  const [managing, setManaging] = useState(false);
  const agent = useQuery(agentQueryOptions(agentId));

  if (agent.isPending) return <DetailsSkeleton />;
  if (agent.error || !agent.data) {
    return (
      <p className="text-sm text-destructive" role="alert">
        Could not load this coworker.
      </p>
    );
  }
  const profile = agent.data;

  return (
    <div className="flex w-full flex-col gap-5">
      <div className="flex flex-wrap gap-1.5">
        <Tag>{profile.visibility === "private" ? "Private" : "Public"}</Tag>
        {profile.systemOwned ? <Tag>System owned</Tag> : null}
      </div>

      <section className="grid gap-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Role
        </h2>
        <p className="whitespace-pre-wrap text-pretty text-sm">
          {profile.roleDescription}
        </p>
      </section>

      <section className="grid gap-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          For you
        </h2>
        {/* The rows carry their own top margin for the page; none is wanted under a heading here. */}
        <div className="[&>div]:mt-0">
          <ForYouSection agent={profile} includeMessage={false} />
        </div>
      </section>

      <Button
        className="w-full text-sm!"
        onClick={() => setManaging(true)}
        variant="outline"
      >
        Manage…
      </Button>

      <AgentDialog
        agentId={agentId}
        onClose={() => setManaging(false)}
        open={managing}
      />
    </div>
  );
}

/** The Bots in a group, one row each. A group has no single role to describe. */
export function ParticipantsTab({
  participants,
}: {
  participants: BotPanelParticipant[];
}) {
  return (
    <section className="grid gap-2">
      <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Bots
      </h2>
      <ul className="flex flex-col gap-1">
        {participants.map((participant) => (
          <li
            className="flex h-11 items-center gap-3 rounded-xl px-2 text-[15px]"
            key={participant.id}
          >
            <ChannelAvatar participantIds={[participant.id]} size={28} />
            <span className="min-w-0 truncate">{participant.name}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
