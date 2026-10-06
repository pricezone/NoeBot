import type { AgentProfile } from "@/lib/agents/queries";
import type { ChannelSummary } from "@/lib/channels/queries";
import { type LandingTarget, landingTarget } from "@/lib/landing";

/**
 * Where a click on one Bot goes: its newest conversation, else a fresh one with it.
 *
 * `landingTarget` given only this Bot's conversations and only this Bot, so neither of its
 * fallbacks can wander off to another coworker. A Bot the roster does not list (an attention row
 * for a Bot since hidden, say) still gets the fresh-conversation target, named by id. Used by the
 * featured Bot and by the attention rows, which are the two places the sidebar names a Bot rather
 * than a conversation.
 */
export function botLandingTarget(
  agentId: string,
  channels: readonly ChannelSummary[] | undefined,
  agents: readonly AgentProfile[] | undefined,
): LandingTarget {
  const own = (channels ?? []).filter(
    (channel) =>
      channel.agentIds.length === 1 && channel.agentIds[0] === agentId,
  );
  const bot = agents?.find((agent) => agent.id === agentId);
  return (
    landingTarget({
      lastBotId: agentId,
      channels: own,
      agents: bot ? [bot] : undefined,
    }) ?? { to: "/channel/new", search: { agent: agentId } }
  );
}
