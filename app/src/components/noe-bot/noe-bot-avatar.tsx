import { useReducedMotion } from "motion/react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import type { AvatarColor, AvatarExpression } from "../../../../shared/avatar";
import type { AnimationId } from "./anim/catalog";
import { THEMED_INK_CLASS, THEMED_PALETTE } from "./anim/palette";
import { useEyeShift } from "./anim/use-eye-shift";
import { hairlineClassName } from "./hairline";
import { NoeBotFace } from "./noe-bot-face";
import { avatarLook, type Face } from "./pixel-art";

/**
 * A Bot's avatar: the Noë Bot character in the Bot's colour, standing on the page — no disc behind it.
 *
 * The colour a person chose (or the seed's) paints the character; the eye holes show whatever the
 * avatar sits on. The two colours that nearly vanish into one theme's page get a one-pixel outline
 * there (`hairlineClassName(…, "outline")`). The character fills the avatar's box, the 14 × 12 body
 * in its 16-unit square, so a 32 px avatar is a 28 px Noë Bot.
 *
 * IT LOOKS AT YOU. While the pointer is on it, and for a moment after the pointer leaves, its eyes
 * follow the pointer a whole pixel at a time (`useEyeShift`, hover mode); touch and reduced motion
 * get none of it.
 *
 * Replaces the abstract generated avatars the app shipped with. The expression and the colour
 * are the ones a person chose for the Bot, where they chose one, and otherwise come from the Bot's
 * avatar seed, so a Bot looks the same everywhere it appears and two Bots usually look different,
 * which is what an avatar is for in a roster. A caller that has the profile passes all three; one
 * that only has a seed gets the seed's face, which is the face the Bot had before anybody chose.
 * The 16 grid at every size: the pixels simply get bigger, which is what a terminal drawing is
 * meant to do.
 *
 * ALIVE WHEN IT MATTERS. A roster of faces all blinking at once is a wall of motion, so a small
 * avatar holds still until the Bot is busy (`live`) or the pointer rests on it; from 48 px — the
 * bot panel, a card, the picker — it is big enough to be looked at and plays its idle whenever it
 * is on screen. `animation` plays something other than the Bot's own face (the thinking face while
 * it works, the unplugged state when it is offline).
 *
 * `name` makes it an image a screen reader announces; without one it is decorative, for a row that
 * already names the Bot beside it.
 */
export function NoeBotAvatar({
  seed,
  color,
  expression,
  name,
  size = 40,
  face,
  className,
  live,
  animation,
  then,
  props,
}: {
  seed: string;
  /** The colour a person chose, as the profile carries it. Null or absent draws the seed's. */
  color?: AvatarColor | null;
  /** The expression a person chose, as the profile carries it. Null or absent draws the seed's. */
  expression?: AvatarExpression | null;
  name?: string;
  size?: number;
  /** A face to show instead of the Bot's own, such as `offline`. */
  face?: Face;
  className?: string;
  /** Keep animating while shown; default from the size (48 px and up). */
  live?: boolean;
  /** Play this instead of the face's own idle. */
  animation?: AnimationId;
  /** What follows a finite `animation` (boot, rest). */
  then?: AnimationId;
  /**
   * Draw the face's props and effects (the sleepy face's Z's among them); default from the size,
   * from 48 px. Off for a caller that draws its own, like the sleeping computer's card.
   */
  props?: boolean;
}) {
  const look = avatarLook({ seed, color, expression });
  const [hovered, setHovered] = useState(false);
  const reduced = useReducedMotion() === true;
  const [eyeShift, eyeRef] = useEyeShift(reduced, { follow: "hover" });
  const large = size >= 48;
  const active = (live ?? large) || hovered;
  const shared = {
    className: cn(
      // Nothing to clip: a large face's props may reach past the box, and that is the drawing.
      "inline-flex shrink-0 items-center justify-center overflow-visible",
      THEMED_INK_CLASS,
      hairlineClassName(look.scheme.background, "outline"),
      className,
    ),
    style: {
      width: size,
      height: size,
      color: look.scheme.background,
    },
    onPointerEnter: () => setHovered(true),
    onPointerLeave: () => setHovered(false),
  };
  const drawing = (
    <NoeBotFace
      active={active}
      animation={animation}
      eyeShift={eyeShift}
      face={face ?? look.expression}
      mode={large ? "hd" : "terminal"}
      palette={THEMED_PALETTE}
      props={props ?? large}
      ref={eyeRef}
      size={size}
      stillBelow={16}
      then={then}
    />
  );
  return name ? (
    <span {...shared} role="img" aria-label={name}>
      {drawing}
    </span>
  ) : (
    <span {...shared} aria-hidden="true">
      {drawing}
    </span>
  );
}
