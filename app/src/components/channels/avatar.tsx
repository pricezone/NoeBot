import { hashKey, QueryClientContext } from "@tanstack/react-query";
import { memo, useCallback, useContext, useSyncExternalStore } from "react";
import { NoeBotAvatar } from "@/components/noe-bot/noe-bot-avatar";
import type { AvatarChoice } from "@/components/noe-bot/pixel-art";
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";
import { useTranslation } from "@/lib/i18n";

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

export function useAvatarLooks(): (id: string) => AvatarChoice {
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
  const { t } = useTranslation();
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
      <div className="relative size-full">
        {participantIds.slice(0, 3).map((c, i, shown) => {
          /*
           * SIDE BY SIDE, NOT STACKED. Overlapping faces were told apart by a ring of the sidebar's
           * colour round each disc; without discs, one character's see-through eyes would show the
           * other behind it. So two sit on the diagonal and three in a triangle, each in its own
           * corner of the square. The 14 × 12 body leaves the corners of its box empty, so the
           * boxes may touch without the characters doing so.
           */
          const part = Math.round(size * (shown.length === 2 ? 0.56 : 0.5));
          const far = size - part;
          const [left, top] =
            shown.length === 2
              ? i === 0
                ? [0, 0]
                : [far, far]
              : i === 0
                ? [0, 0]
                : i === 1
                  ? [far, 0]
                  : [far / 2, far];
          return (
            <div className="absolute" key={c} style={{ left, top }}>
              <NoeBotAvatar {...lookOf(c)} {...working} size={part} />
            </div>
          );
        })}
      </div>
    );

  return (
    <div
      className="relative"
      data-working={typing ? "true" : undefined}
      style={{ height: size, width: size }}
    >
      {avatar}
      {typing ? <span className="sr-only">{t("Working…")}</span> : null}
    </div>
  );
});
