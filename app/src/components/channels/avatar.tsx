import { memo } from "react";
import { NoeBotAvatar } from "@/components/noe-bot/noe-bot-avatar";
import { cn } from "@/lib/utils";

/**
 * Memoized roster avatar. Row updates usually change preview/timestamp only, and
 * `use-channel-events` preserves participant id arrays for unchanged rows.
 *
 * Each participant is drawn as Noë Bot's terminal face on a brand background, picked from the
 * participant's id, so the same Bot has the same face in every row.
 *
 * `typing` overlays a working indicator at the bottom-right — three bouncing dots, so a channel
 * whose agent is mid-turn reads as busy from the roster without moving the row's layout.
 */
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

  const avatar =
    channelSize === 1 ? (
      <NoeBotAvatar seed={participantIds[0] ?? ""} size={size} />
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
            <NoeBotAvatar seed={c} size={size / (shown.length / 2)} />
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
