import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useLastBot } from "@/lib/agents/last-bot";
import { defaultAgentId } from "@/lib/agents/default-agent";
import { type AgentProfile, agentListQueryOptions } from "@/lib/agents/queries";
import { botAttentionQueryOptions } from "@/lib/bot-lifecycle/queries";
import { brand } from "@/lib/brand";
import { channelListQueryOptions } from "@/lib/channels/queries";
import { needsInput } from "../bot-profile/attention";
import { botLandingTarget } from "./bot-target";

/**
 * Which Bot sits at the top of the sidebar: the one this person was with last, if the roster
 * still knows it, else the default coworker. Exported so the rule is pinnable without a DOM.
 */
export function featuredAgent(
  agents: readonly AgentProfile[] | undefined,
  lastBotId: string | null,
): AgentProfile | undefined {
  const remembered =
    lastBotId === null
      ? undefined
      : agents?.find((agent) => agent.id === lastBotId);
  const id = remembered?.id ?? defaultAgentId(agents);
  return id === undefined
    ? undefined
    : agents?.find((agent) => agent.id === id);
}

/**
 * The Bot that is this person's own, drawn large under the sidebar's header.
 *
 * Grok Bot keeps its one Bot above the roster, where it reads as the person's coworker rather
 * than as one conversation among many; the rows beneath are the conversations. The dot is the
 * same question the roster asks per row, asked of the Bot: it lights while the Bot's newest
 * conversation is mid-turn or while the Bot has something waiting on the person (a question, an
 * approval, a stalled hand-off, an unread message), and is muted otherwise.
 *
 * Clicking goes where home would go for this Bot: its newest conversation, else a fresh one with
 * it (`botLandingTarget`). Nothing is drawn until the roster has named a Bot: a sidebar with no
 * agents has nothing to feature, and a placeholder would promise one.
 */
export function FeaturedBot() {
  const agents = useQuery(agentListQueryOptions()).data;
  const channels = useInfiniteQuery(channelListQueryOptions()).data;
  const attention = useQuery(botAttentionQueryOptions()).data;
  // Subscribed, not read bare: nothing else here re-renders when the person moves to another
  // Bot's conversation, and a storage read during render would keep showing the previous one
  // until some unrelated query happened to change.
  const lastBotId = useLastBot();

  const bot = featuredAgent(agents, lastBotId);
  if (!bot) return null;

  const target = botLandingTarget(bot.id, channels, agents);
  const newest = (channels ?? []).find(
    (channel) =>
      channel.agentIds.length === 1 && channel.agentIds[0] === bot.id,
  );
  const waiting = attention?.find((entry) => entry.agentId === bot.id);
  const active =
    newest?.busy === true ||
    (waiting !== undefined && (needsInput(waiting) > 0 || waiting.unread > 0));

  return (
    <Link
      {...target}
      aria-label={`Open ${bot.name}`}
      className="group/featured mx-auto flex w-fit flex-col items-center gap-2 rounded-2xl px-4 py-3 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      data-testid="featured-bot"
    >
      <span className="relative">
        <brand.Avatar
          color={bot.avatarColor}
          expression={bot.avatarExpression}
          seed={bot.avatarSeed ?? bot.id}
          size={54}
        />
        <span
          aria-hidden="true"
          data-active={active ? "true" : "false"}
          className={`absolute right-0 bottom-0 size-2.5 rounded-full ring-2 ring-sidebar ${active ? "bg-primary" : "bg-muted-foreground/40"}`}
        />
      </span>
      <span className="max-w-40 truncate text-[15px] font-semibold text-foreground">
        {bot.name}
      </span>
    </Link>
  );
}
