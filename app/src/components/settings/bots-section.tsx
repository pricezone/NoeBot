import { IconChevronRight } from "@tabler/icons-react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  attentionSummary,
  needsInput,
} from "@/components/bot-profile/attention";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { SettingsCard } from "@/components/ui/settings-rows";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { botAttentionQueryOptions } from "@/lib/bot-lifecycle/queries";
import { brand } from "@/lib/brand";
import {
  type ChannelSummary,
  channelListQueryOptions,
} from "@/lib/channels/queries";
import { type LandingTarget, landingTarget } from "@/lib/landing";

/**
 * Where a Bot's row opens: its newest conversation, else a fresh one with it.
 *
 * The landing rule (`lib/landing.ts`) with the roster narrowed to this one Bot, so "the Bot you were
 * with last" is this Bot and nothing else can be picked instead. The agents are left undefined on
 * purpose: that is the rule's "cannot say" answer, which returns null rather than the deployment's
 * default coworker, and null here means a new conversation with this Bot — the one place the old
 * `/bots/$agentId` profile page used to go.
 */
export function conversationWith(
  agentId: string,
  channels: readonly ChannelSummary[] | undefined,
): LandingTarget {
  return (
    landingTarget({
      lastBotId: agentId,
      channels: channels?.filter((channel) => channel.agentIds[0] === agentId),
      agents: undefined,
    }) ?? { to: "/channel/new", search: { agent: agentId } }
  );
}

/**
 * Every Bot the person can reach, with what each needs from them, each opening its conversation.
 *
 * The first block of Settings › Bots. A row goes to the Bot's chat rather than to a profile page:
 * the profile is the chat's own panel now, and a list that opened a second place to read the same
 * facts would be one more screen between a person and the Bot that needs them.
 */
export function BotsSection() {
  const agents = useQuery(agentListQueryOptions());
  const attention = useQuery(botAttentionQueryOptions());
  const channels = useInfiniteQuery(channelListQueryOptions());
  const byId = new Map((attention.data ?? []).map((bot) => [bot.agentId, bot]));
  if (agents.isPending) return null;
  if (agents.error) {
    return (
      <p className="text-destructive text-sm" role="alert">
        Could not load your Bots.
      </p>
    );
  }
  if (agents.data.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">You have no Bots yet.</p>
    );
  }
  return (
    <SettingsCard>
      {agents.data.map((agent) => {
        const state = byId.get(agent.id);
        const summary = state
          ? [state.paused ? "Paused" : "", attentionSummary(state)]
              .filter(Boolean)
              .join(" · ")
          : "";
        return (
          <Item
            className="min-h-14 rounded-none border-0 px-4 py-2 hover:bg-muted/50 focus-visible:ring-inset"
            key={agent.id}
            render={<Link {...conversationWith(agent.id, channels.data)} />}
            size="sm"
          >
            <ItemMedia>
              <brand.Avatar
                color={agent.avatarColor}
                expression={agent.avatarExpression}
                name={agent.name}
                seed={agent.avatarSeed}
                size={34}
              />
            </ItemMedia>
            <ItemContent className="gap-0.5">
              <ItemTitle className="text-[15px] font-normal leading-5">
                {agent.name}
              </ItemTitle>
              <ItemDescription className="text-[13px] leading-[18px]">
                {summary || agent.title}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              {state && needsInput(state) > 0 ? (
                <span className="rounded-full bg-primary px-1.5 text-[11px] font-medium text-primary-foreground tabular-nums">
                  {needsInput(state)}
                </span>
              ) : null}
              <IconChevronRight className="size-4 text-muted-foreground" />
            </ItemActions>
          </Item>
        );
      })}
    </SettingsCard>
  );
}
