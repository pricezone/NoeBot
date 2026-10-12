import { useReducedMotion } from "motion/react";
import type { CSSProperties, Ref } from "react";
import { useEffect, useRef, useState } from "react";
import { type Mode, renderBotFrame } from "./bot-frame";
import {
  type Animation,
  type AnimationId,
  animationId,
  durationOf,
  parseAnimation,
} from "./catalog";
import { nowSeconds, useAnimationTime } from "./clock";
import { DESIGN_PALETTE, type Palette } from "./palette";
import type { Cell, Glyph } from "./sprites";

/**
 * HD mode redraws at 30 fps: the film's sub-cell motion reads as smooth well below the display's
 * rate, and a 64 px character has no business costing a frame of work every frame of the page.
 */
const HD_FPS = 30;

/**
 * The character, animated, as an SVG.
 *
 * The same 16-unit box as every static face (`viewBox="-1 -2 16 16"`), so it drops into any slot a
 * `NoeBotFace` fills, and `overflow: visible` so an action's props can reach past the body. Cells
 * are joined into one path per ink, which keeps a frame to a handful of elements however many
 * cells it has.
 *
 * Time is the clock's, not the component's: a frame is `renderBotFrame(animation, t)`, so pausing
 * is just not advancing `t`. Reduced motion shows the first settled frame (0.6 s in, so an action's
 * props are already in place) and never ticks.
 */
export function NoeBotSprite({
  animation,
  size,
  mode,
  palette = DESIGN_PALETTE,
  props,
  active = true,
  then,
  eyeShift,
  ref,
  title,
  className,
  style,
}: {
  animation: AnimationId | Animation;
  /** Pixels for the 16-unit box; the character is 14 × 12 inside it. */
  size?: number;
  /** Terminal mode moves by whole cells at 12 fps; HD by sub-cells every frame. Default by size. */
  mode?: Mode;
  palette?: Palette;
  /** Draw props and effects. Default: at 48 px and up. */
  props?: boolean;
  /** False holds the first frame still (a roster at rest). */
  active?: boolean;
  /** What plays once a finite animation (boot, rest) has ended. */
  then?: AnimationId;
  /** Where the eyes look, in whole cells (a mark whose eyes follow the pointer). */
  eyeShift?: readonly [number, number];
  ref?: Ref<SVGSVGElement>;
  title?: string;
  className?: string;
  style?: CSSProperties;
}) {
  const parsed =
    typeof animation === "string" ? parseAnimation(animation) : animation;
  const id = animationId(parsed);
  const resolvedMode: Mode =
    mode ?? (size !== undefined && size < 48 ? "terminal" : "hd");
  const showProps = props ?? (size === undefined || size >= 48);
  const reduced = useReducedMotion() === true;

  // The face shown before this animation began, for the change-glitch and the ears, and how many
  // holds came before it, for the blink pattern.
  const [run, setRun] = useState(() => ({
    requested: id,
    id,
    startedAt: nowSeconds(),
    prevFace: undefined as string | undefined,
    hold: 0,
  }));
  const lastFace = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (run.requested === id) return;
    setRun((previous) => ({
      requested: id,
      id,
      startedAt: nowSeconds(),
      prevFace: lastFace.current,
      hold: previous.hold + 1,
    }));
  }, [id, run.requested]);

  const live = active && !reduced;
  const t = useAnimationTime(
    live,
    resolvedMode === "terminal" ? 12 : HD_FPS,
    run.startedAt,
  );
  const playing = run.id === id ? parsed : parseAnimation(run.id);
  // A finite animation (boot, rest) hands over to `then` once it has run its course.
  const ended =
    then !== undefined && run.id !== then && t >= durationOf(playing);
  useEffect(() => {
    if (!ended || then === undefined) return;
    setRun((previous) => ({
      ...previous,
      id: then,
      startedAt: nowSeconds(),
      prevFace: lastFace.current,
      hold: previous.hold + 1,
    }));
  }, [ended, then]);
  const frame = renderBotFrame({
    animation: playing,
    t: live ? t : reduced ? 0.6 : 0,
    prevFace: run.prevFace,
    holdIndex: run.hold,
    mode: resolvedMode,
    props: showProps,
    reduced,
    eyeShift,
  });
  useEffect(() => {
    lastFace.current = frame.face;
  }, [frame.face]);

  const paths = toPaths(frame.cells, palette);
  const rotating = Math.abs(frame.rot) > 0.01;
  const shared = {
    viewBox: "-1 -2 16 16",
    width: size,
    height: size,
    shapeRendering: rotating ? "geometricPrecision" : "crispEdges",
    className,
    style: { display: "block", overflow: "visible", ...style },
    "data-face": frame.face,
    "data-animation": animationId(playing),
    "data-act": frame.act ?? undefined,
  } as const;
  const body = (
    <g
      transform={`translate(${round(frame.bx)} ${round(frame.by)}) rotate(${round(frame.rot)} 7 6)`}
    >
      <g
        transform={`translate(7 ${round(12 + frame.bob)}) scale(${round(frame.sx)} ${round(frame.sy)}) translate(-7 -12)`}
      >
        {paths.map((p) => (
          <path d={p.d} fill={p.fill} key={p.key} opacity={p.opacity} />
        ))}
        {frame.glyphs.map((g) => (
          <Text glyph={g} key={`${g.text}@${g.x},${g.y}`} palette={palette} />
        ))}
      </g>
    </g>
  );
  return title ? (
    <svg {...shared} aria-label={title} ref={ref} role="img">
      <title>{title}</title>
      {body}
    </svg>
  ) : (
    <svg {...shared} aria-hidden="true" ref={ref}>
      {body}
    </svg>
  );
}

const round = (n: number): number => Math.round(n * 1000) / 1000;

function Text({ glyph, palette }: { glyph: Glyph; palette: Palette }) {
  return (
    <text
      fill={palette[glyph.fill]}
      fontFamily="'IBM Plex Mono', ui-monospace, monospace"
      fontSize={glyph.fontSize}
      fontWeight={glyph.weight}
      lengthAdjust={glyph.textLength ? "spacingAndGlyphs" : undefined}
      textAnchor={glyph.anchor}
      textLength={glyph.textLength}
      x={glyph.x}
      y={glyph.y}
    >
      {glyph.text}
    </text>
  );
}

type Path = { key: string; fill: string; opacity?: number; d: string };

/**
 * Cells joined into paths: a run of neighbours in the same ink becomes one path, and a change of
 * ink starts the next, so paint order is kept exactly — a pink tick drawn after a white badge
 * lands on top of it, as it would cell by cell.
 */
export function toPaths(cells: readonly Cell[], palette: Palette): Path[] {
  const out: Path[] = [];
  let last: Path | null = null;
  cells.forEach((c, i) => {
    const fill = palette[c.fill];
    if (fill === "transparent") return;
    const key = `${fill}/${c.opacity ?? 1}`;
    const d = `M${round(c.x)} ${round(c.y)}h${round(c.w)}v${round(c.h)}h-${round(c.w)}z`;
    if (last?.key.startsWith(`${key}#`)) {
      last.d += d;
      return;
    }
    last = { key: `${key}#${i}`, fill, opacity: c.opacity, d };
    out.push(last);
  });
  return out;
}
