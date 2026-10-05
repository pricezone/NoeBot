import { cn } from "@/lib/utils";
import { NoeBotFace } from "./noe-bot-face";
import { type Face, expressionFor, schemeFor } from "./pixel-art";

/**
 * A Bot's avatar: Noë Bot's terminal face on one of the brand's approved backgrounds.
 *
 * Replaces the abstract generated avatars the app shipped with. The expression and the background
 * come from the Bot's avatar seed, so a Bot looks the same everywhere it appears and two Bots
 * usually look different, which is what an avatar is for in a roster. The 24 grid is used from 48
 * pixels up, where its finer eyes read; below that the 16 grid's hand-set pixels are the ones the
 * guide drew for small sizes.
 *
 * `name` makes it an image a screen reader announces; without one it is decorative, for a row that
 * already names the Bot beside it.
 */
export function NoeBotAvatar({
  seed,
  name,
  size = 40,
  face,
  className,
}: {
  seed: string;
  name?: string;
  size?: number;
  /** A face to show instead of the Bot's own, such as `offline`. */
  face?: Face;
  className?: string;
}) {
  const scheme = schemeFor(seed);
  const grid = size >= 48 ? 24 : 16;
  const shared = {
    className: cn(
      "inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full",
      className,
    ),
    style: {
      width: size,
      height: size,
      backgroundColor: scheme.background,
      color: scheme.ink,
    },
  };
  const drawing = (
    <NoeBotFace
      face={face ?? expressionFor(seed)}
      grid={grid}
      size={Math.round(size * 0.7)}
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
