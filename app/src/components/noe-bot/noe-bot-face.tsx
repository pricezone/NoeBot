import type { CSSProperties } from "react";
import type { AnimationId } from "./anim/catalog";
import { NoeBotSprite } from "./anim/noe-bot-sprite";
import { CURRENT_COLOR_PALETTE } from "./anim/palette";
import { type Face, facePath } from "./pixel-art";

/** The animation a face name stands for: the mascot's own eyes are the neutral face, offline is unplugged. */
export const animationForFace = (face: Face): AnimationId =>
  face === "body"
    ? "face:neutral"
    : face === "offline"
      ? "state:unplugged"
      : `face:${face}`;

/**
 * Noë Bot's face, as the brand guide draws it for terminals, as an SVG.
 *
 * Takes the current text colour, like an icon, so it is black on the light theme and white on the
 * dark one unless a caller colours it. `crispEdges` keeps the pixels square at every size instead
 * of smearing them, which is what makes the drawing readable in a 16-pixel slot.
 *
 * Centred in a square with one pixel of margin, so it drops into any square icon slot the way the
 * brand's own `noe-bot` SVG does: 14 by 12 pixels in a 16 by 16 box. Always the 16 grid, at every
 * size; the guide's 24 grid is for terminal banners and the app does not use it, so Noë Bot is one
 * drawing wherever it appears.
 *
 * Animated by the design's rules: under 24 px a still of the face; from 24 px the face blinks and
 * its ears and idle motion follow the expression; from 48 px it is drawn in HD with its props.
 * `active` false holds the still (a roster at rest); `animation` plays something other than the
 * face itself (a state, an action, the boot).
 */
export function NoeBotFace({
  face = "body",
  size,
  title,
  className,
  style,
  animation,
  then,
  active = true,
  animate = true,
  mode,
  props,
}: {
  face?: Face;
  /** Pixels. Left out, the SVG takes its size from CSS, like any icon. */
  size?: number;
  /** Announced to a screen reader. Left out, the drawing is decorative and hidden from one. */
  title?: string;
  className?: string;
  style?: CSSProperties;
  /** Play this instead of the face's own idle. */
  animation?: AnimationId;
  /** What follows a finite `animation` (boot, rest). */
  then?: AnimationId;
  /** False holds the first frame still. */
  active?: boolean;
  /** False draws the still path, whatever the size. */
  animate?: boolean;
  mode?: "terminal" | "hd";
  /** Draw props and effects; default from the size. */
  props?: boolean;
}) {
  const still = !animate || (size !== undefined && size < 24);
  if (!still) {
    return (
      <NoeBotSprite
        active={active}
        animation={animation ?? animationForFace(face)}
        className={className}
        mode={mode}
        palette={CURRENT_COLOR_PALETTE}
        props={props}
        size={size}
        style={style}
        then={then}
        title={title}
      />
    );
  }
  const { width, height, path } = facePath(face);
  const side = Math.max(width, height) + 2;
  const x = -(side - width) / 2;
  const y = -(side - height) / 2;
  const shared = {
    viewBox: `${x} ${y} ${side} ${side}`,
    width: size,
    height: size,
    fill: "currentColor",
    shapeRendering: "crispEdges",
    className,
    style,
    "data-face": face,
  } as const;
  // Two elements rather than one with conditional attributes, so what a screen reader gets is
  // decided here and not by whichever attribute happened to be set.
  return title ? (
    <svg {...shared} role="img" aria-label={title}>
      <title>{title}</title>
      <path d={path} />
    </svg>
  ) : (
    <svg {...shared} aria-hidden="true">
      <path d={path} />
    </svg>
  );
}

/** The mascot itself, for places that stand for Bots in general rather than for one of them. */
export function NoeBotIcon({
  className,
  title,
  size,
  active = true,
}: {
  className?: string;
  title?: string;
  size?: number;
  active?: boolean;
}) {
  return (
    <NoeBotFace
      active={active}
      animate={size !== undefined}
      className={className}
      face="body"
      size={size}
      title={title}
    />
  );
}
