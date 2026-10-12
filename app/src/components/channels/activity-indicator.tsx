import { useReducedMotion } from "motion/react";
import type { AnimationId } from "@/components/noe-bot/anim/catalog";
import type { Phase } from "@/components/noe-bot/anim/director";
import { NoeBotSprite } from "@/components/noe-bot/anim/noe-bot-sprite";
import {
  THEMED_INK_CLASS,
  THEMED_PALETTE,
} from "@/components/noe-bot/anim/palette";
import { useEyeShift } from "@/components/noe-bot/anim/use-eye-shift";
import { hairlineClassName } from "@/components/noe-bot/hairline";
import { type AvatarChoice, avatarLook } from "@/components/noe-bot/pixel-art";
import { cn } from "@/lib/utils";

/** The design's rose, for a conversation whose Bot has no avatar to take a colour from. */
const DEFAULT_COLOUR = "#ff2056";

/** 2 px per cell: the 14 × 12 body is 28 × 24 px and its pixels stay square. */
const SPRITE = 32;

/**
 * The room a prop takes to the right of the body, in pixels: every action the director plays stays
 * within 12 cells of it (measured over every frame), so the label starts after them.
 */
const PROP_ROOM = 24;

/**
 * Noë Bot at work, under the last message, while a reply is being prepared: Grok's status row.
 *
 * The Bot's own character, in the Bot's colour, standing on the page with nothing behind it,
 * inline with the sentence that says what it is doing. The animation is the director's, unchanged —
 * searching, reading, typing, waiting for the person… in HD with its props — only small: a 32 px
 * box, about the size of the avatar in Grok's row. Props that reach left spill into the gutter; the
 * label starts after the room the ones on the right need, and is drawn above them.
 *
 * THE LABEL IS THE STATUS. The text alone is the `status` element, so what assistive technology
 * announces is a sentence and not an SVG. Hovering the character makes its eyes follow the pointer,
 * as every avatar's do.
 */
export function ChatActivityIndicator({
  animation,
  label,
  phase,
  avatar,
}: {
  animation: AnimationId;
  label: string;
  phase: Phase;
  /** Whose work this is: the character takes this Bot's colour. */
  avatar?: AvatarChoice;
}) {
  const colour = avatar ? avatarLook(avatar).scheme.background : DEFAULT_COLOUR;
  const reduced = useReducedMotion() === true;
  const [eyeShift, eyeRef] = useEyeShift(reduced, { follow: "hover" });
  return (
    <div
      className="flex items-center"
      data-animation={animation}
      data-phase={phase}
      data-testid="activity-indicator"
    >
      <div
        className={cn(
          "relative shrink-0",
          THEMED_INK_CLASS,
          hairlineClassName(colour, "outline"),
        )}
        style={{ color: colour, height: SPRITE, width: SPRITE }}
      >
        <NoeBotSprite
          animation={animation}
          eyeShift={eyeShift}
          mode="hd"
          palette={THEMED_PALETTE}
          props
          ref={eyeRef}
          size={SPRITE}
        />
      </div>
      <p
        className="relative text-muted-foreground"
        role="status"
        style={{ marginLeft: PROP_ROOM }}
      >
        {label}
      </p>
    </div>
  );
}
