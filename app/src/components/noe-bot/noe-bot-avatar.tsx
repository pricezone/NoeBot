import type { AvatarColor, AvatarExpression } from "../../../../shared/avatar";
import { cn } from "@/lib/utils";
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
}) {
  const look = avatarLook({ seed, color, expression });
  const shared = {
    className: cn(
      "inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full",
      hairlineClassName(look.scheme.background, "ring"),
      className,
    ),
    style: {
      width: size,
      height: size,
      backgroundColor: look.scheme.background,
      color: look.scheme.ink,
    },
  };
  const drawing = (
    <NoeBotFace face={face ?? look.expression} size={Math.round(size * 0.7)} />
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
