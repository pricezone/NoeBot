import { defaultAgentProfile } from "./agents/default-agent";
import type { AgentProfile } from "./agents/queries";
import type { ChannelSummary } from "./channels/queries";

/**
 * Where home sends somebody.
 *
 * Either an existing conversation, or a new one with a named coworker. The two shapes are the
 * arguments `redirect()` and `navigate()` take, so a caller spreads the result straight in.
 */
export type LandingTarget =
  | { to: "/channel/$channelId"; params: { channelId: string } }
  | { to: "/channel/new"; search: { agent: string } };

/**
 * Pick the conversation home opens on.
 *
 * `/` used to be a blank composer. The product now lands on a conversation, the way a messaging
 * app reopens on the thread you left, and this is the rule that picks which one. In order:
 *
 * 1. The newest conversation with the Bot this person was with last (`lib/agents/last-bot.ts`).
 * 2. Otherwise the newest conversation with any one Bot.
 * 3. Otherwise, once the roster has loaded and names a default coworker, a fresh conversation
 *    with that coworker — a brand-new workspace goes straight to Noë rather than to a composer
 *    with nobody behind it.
 * 4. Otherwise nothing, and the caller shows what it always showed.
 *
 * Only channels in the array given are candidates. The roster the sidebar loads is one page and
 * already in the server's order — pinned first, then by recency (`server/src/channels/routes.ts`,
 * `ROSTER_ORDER`) — so "newest" is "first that matches" and nothing is sorted again here. The
 * remembered id is a lookup key, never a destination on its own: an id that matches no open
 * channel — a stale value, an id from another workspace — falls through to the next rule instead
 * of opening a conversation that does not exist.
 *
 * Two kinds of channel are skipped at every step. Group conversations hold several Bots and live
 * under `/group/$channelId`; a landing that opened one would just bounce through the channel
 * route's own redirect. And a channel whose Bot has since been deleted (`active` false) stays in
 * the roster because its transcript is still readable, but nothing more can be said in it —
 * deleting a Bot is a soft delete that leaves its channels behind, and the remembered id is not
 * cleared when that happens, so without this rule home would reopen a conversation the person
 * cannot continue every time, rather than a fresh one with the default coworker.
 */
export function landingTarget(input: {
  lastBotId: string | null;
  channels: readonly ChannelSummary[] | undefined;
  agents: readonly AgentProfile[] | undefined;
}): LandingTarget | null {
  const singles = (input.channels ?? []).filter(isOpenWithOneBot);

  const remembered =
    input.lastBotId === null
      ? undefined
      : singles.find((channel) => channel.agentIds[0] === input.lastBotId);
  const channel = remembered ?? singles[0];
  if (channel) {
    return { to: "/channel/$channelId", params: { channelId: channel.id } };
  }

  // No roster yet is not the same as an empty roster: the first means "we cannot say", and the
  // caller keeps its own screen rather than being sent to a coworker that may not exist.
  if (input.agents === undefined) return null;
  const fallback = defaultAgentProfile(input.agents);
  return fallback
    ? { to: "/channel/new", search: { agent: fallback.id } }
    : null;
}

function isOpenWithOneBot(channel: ChannelSummary): boolean {
  return channel.active && channel.agentIds.length === 1;
}
