import { hashKey, QueryClientContext } from "@tanstack/react-query";
import { memo, useCallback, useContext, useSyncExternalStore } from "react";
import { NoeBotAvatar } from "@/components/noe-bot/noe-bot-avatar";
import type { AvatarChoice } from "@/components/noe-bot/pixel-art";
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";
import { cn } from "@/lib/utils";

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

  const avatar =
    channelSize === 1 ? (
      <NoeBotAvatar {...lookOf(participantIds[0] ?? "")} size={size} />
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
            <NoeBotAvatar {...lookOf(c)} size={size / (shown.length / 2)} />
          </div>
        ))}
      </div>
    );

  return (
    <div className="relative" style={{ height: size, width: size }}>
      {avatar}
      {typing ? <TypingBadge /> : null}
    </div>
  );
});

/**
 * Three bouncing dots in a small badge, ringed in the sidebar's own colour so it sits on the
 * avatar as a badge rather than floating over it. The staggered negative delays start each dot at
 * a different point in the same bounce, which is what makes the three read as one wave.
 */
function TypingBadge() {
  return (
    <div className="absolute -bottom-0.5 -right-0.5 flex items-center gap-0.5 rounded-full bg-sidebar p-0.5 ring-2 ring-sidebar">
      <span className="sr-only">Working…</span>
      <Dot className="[animation-delay:-0.3s]" />
      <Dot className="[animation-delay:-0.15s]" />
      <Dot />
    </div>
  );
}

function Dot({ className }: { className?: string }) {
  return (
    <span
      className={cn("size-1 rounded-full bg-primary animate-bounce", className)}
    />
  );
}
