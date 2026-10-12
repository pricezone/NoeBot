import type { AnimationId } from "@/components/noe-bot/anim/catalog";
import type { Phase } from "@/components/noe-bot/anim/director";
import { NoeBotSprite } from "@/components/noe-bot/anim/noe-bot-sprite";
import { DESIGN_PALETTE } from "@/components/noe-bot/anim/palette";
import { NoeBotAvatar } from "@/components/noe-bot/noe-bot-avatar";
import type { AvatarChoice } from "@/components/noe-bot/pixel-art";

/**
 * Noë Bot at work, under the last message, while a reply is being prepared.
 *
 * The character as the design draws it — rose on near-black, 64 px, HD with its props — doing
 * whatever the director says the Bot is doing (searching, reading, typing, running commands,
 * waiting for the person…), with the label beside it so a screen reader and a glance are told the
 * same thing. The tile is wide enough for the props an action reaches for; the Bot's own small
 * avatar beside it says whose work this is.
 *
 * THE LABEL IS THE STATUS. The text alone is the `status` element, as the plain "Thinking" line was
 * before it, so what assistive technology announces is a sentence and not an SVG.
 */
export function ChatActivityIndicator({
  animation,
  label,
  phase,
  avatar,
  size = 64,
}: {
  animation: AnimationId;
  label: string;
  phase: Phase;
  avatar?: AvatarChoice;
  /** The character's box in pixels; the tile scales with it. */
  size?: number;
}) {
  const scale = size / 64;
  return (
    <div
      className="flex items-center gap-3"
      data-animation={animation}
      data-phase={phase}
      data-testid="activity-indicator"
    >
      <div
        className="relative shrink-0 overflow-hidden rounded-2xl"
        style={{
          backgroundColor: DESIGN_PALETTE.background,
          height: Math.round(80 * scale),
          width: Math.round(192 * scale),
        }}
      >
        <NoeBotSprite
          animation={animation}
          className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2"
          mode="hd"
          palette={DESIGN_PALETTE}
          props
          size={size}
        />
      </div>
      <div className="flex min-w-0 items-center gap-2">
        {avatar ? <NoeBotAvatar {...avatar} live={false} size={24} /> : null}
        <p className="text-muted-foreground text-sm" role="status">
          {label}
        </p>
      </div>
    </div>
  );
}
