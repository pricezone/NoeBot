import type { CSSProperties } from "react";
import { type Face, facePath } from "./pixel-art";

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
 */
export function NoeBotFace({
  face = "body",
  size,
  title,
  className,
  style,
}: {
  face?: Face;
  /** Pixels. Left out, the SVG takes its size from CSS, like any icon. */
  size?: number;
  /** Announced to a screen reader. Left out, the drawing is decorative and hidden from one. */
  title?: string;
  className?: string;
  style?: CSSProperties;
}) {
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
}: {
  className?: string;
  title?: string;
}) {
  return <NoeBotFace face="body" className={className} title={title} />;
}
