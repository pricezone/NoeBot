import { useState } from "react";
import { cn } from "@/lib/utils";
import type { AvatarColor, AvatarExpression } from "../../../../shared/avatar";
import type { AnimationId } from "./anim/catalog";
import { hairlineClassName } from "./hairline";
import { NoeBotFace } from "./noe-bot-face";
import { avatarLook, type Face } from "./pixel-art";

/**
 * A Bot's avatar: Noë Bot's terminal face on one of the brand's approved backgrounds.
 *
 * Replaces the abstract generated avatars the app shipped with. The expression and the background
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
 * The same colours in both themes. The two that nearly vanish into one theme's page get a hairline
 * there (`hairlineClassName`).
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
}) {
  const look = avatarLook({ seed, color, expression });
  const [hovered, setHovered] = useState(false);
  const large = size >= 48;
  const active = (live ?? large) || hovered;
  const shared = {
    className: cn(
      "inline-flex shrink-0 items-center justify-center rounded-full",
      // Props of a large face may reach past the disc; a small one has none to clip.
      large ? "overflow-visible" : "overflow-hidden",
      hairlineClassName(look.scheme.background, "ring"),
      className,
    ),
    style: {
      width: size,
      height: size,
      backgroundColor: look.scheme.background,
      color: look.scheme.ink,
    },
    onPointerEnter: () => setHovered(true),
    onPointerLeave: () => setHovered(false),
  };
  const drawing = (
    <NoeBotFace
      active={active}
      animation={animation}
      face={face ?? look.expression}
      mode={large ? "hd" : "terminal"}
      props={large}
      size={Math.round(size * 0.7)}
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
