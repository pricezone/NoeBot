import { hashKey, QueryClientContext } from "@tanstack/react-query";
import { memo, useCallback, useContext, useSyncExternalStore } from "react";
import { NoeBotAvatar } from "@/components/noe-bot/noe-bot-avatar";
import type { AvatarChoice } from "@/components/noe-bot/pixel-art";
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";

/**
 * What a participant's face is drawn from: the Bot's avatar seed and the colour and expression a
 * person chose for it when the roster is in the cache, its id as the seed otherwise.
 *
 * A tenant package picks a coworker's face through `avatar_seed`, and the cards and the bot panel
 * draw from it. The roster, the chat pill and the featured bot used to draw from the id instead,
 * so one Bot wore two faces; the chosen colour and expression would be a third if this read the
 * seed alone. Read from the cache rather than through a query per row, but subscribed to it: this
 * component is memoized, and a face that only caught up when something else re-rendered the row
 * was the roster showing the wrong face until the next message — or, after a choice in the avatar
 * editor, the old face until then. Optional context, because the avatar is also drawn where no
 * client exists.
 */
const AGENT_LIST_KEY = agentKeys.list(false);
const AGENT_LIST_HASH = hashKey(AGENT_LIST_KEY);

function useAvatarLooks(): (id: string) => AvatarChoice {
  const client = useContext(QueryClientContext);
  const subscribe = useCallback(
    (notify: () => void) =>
      client
        ? client.getQueryCache().subscribe((event) => {
            if (event.query.queryHash === AGENT_LIST_HASH) notify();
          })
        : () => undefined,
    [client],
  );
  const agents = useSyncExternalStore(
    subscribe,
    () => client?.getQueryData<AgentProfile[]>(AGENT_LIST_KEY),
    () => undefined,
  );
  return (id) => {
    const agent = agents?.find((candidate) => candidate.id === id);
    return agent
      ? {
          seed: agent.avatarSeed,
          color: agent.avatarColor,
          expression: agent.avatarExpression,
        }
      : { seed: id };
  };
}

export const ChannelAvatar = memo(function ChannelAvatar({
  participantIds,
  size = 32,
  typing = false,
}: {
  participantIds: string[];
  size?: number;
  typing?: boolean;
}) {
  const channelSize = participantIds?.length;
  const lookOf = useAvatarLooks();

  /*
   * A BUSY BOT THINKS ON ITS FACE. The brand sheet's "thinking" state is the curious face, so a
   * Bot working on a reply wears it, ears up and blinking, instead of a badge of bouncing dots laid
   * over its avatar — the face is the indicator. Still announced to a screen reader as working.
   */
  const working = typing
    ? ({ live: true, animation: "face:curious" } as const)
    : {};
  const avatar =
    channelSize === 1 ? (
      <NoeBotAvatar
        {...lookOf(participantIds[0] ?? "")}
        {...working}
        size={size}
      />
    ) : (
      <div className="flex flex-row items-center size-full">
        {participantIds.slice(0, 3).map((c, i, shown) => (
          <div
            className="shrink-0 border-2 border-sidebar rounded-full flex items-center justify-center"
            key={c}
            style={{
              height: size / (shown.length / 2),
              width: size / (shown.length / 2),
              transform: `translateX(${i * -75}%)`,
            }}
          >
            <NoeBotAvatar
              {...lookOf(c)}
              {...working}
              size={size / (shown.length / 2)}
            />
          </div>
        ))}
      </div>
    );

  return (
    <div
      className="relative"
      data-working={typing ? "true" : undefined}
      style={{ height: size, width: size }}
    >
      {avatar}
      {typing ? <span className="sr-only">Working…</span> : null}
    </div>
  );
});
