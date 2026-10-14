import { memo, useEffect, useState } from "react";
import type { AnimationId } from "@/components/noe-bot/anim/catalog";
import { NoeBotSprite } from "@/components/noe-bot/anim/noe-bot-sprite";
import {
  THEMED_INK_CLASS,
  THEMED_PALETTE,
} from "@/components/noe-bot/anim/palette";
import { replyText } from "@/lib/clicky/notices";
import { usePrefersReducedMotion } from "@/lib/clicky/reduced-motion";
import { useClickySessionView } from "@/lib/clicky/use-clicky-session";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  type ClickyOverlay as Overlay,
  type ClickyPoint,
  type ClickySession,
  type ClickyState,
  clampUnit,
  visibleOverlays,
} from "../../../../shared/clicky";
import { stepOf } from "./clicky-words";

/**
 * What Clicky draws over the Bot's screen: its pointer, highlight boxes, numbered markers and
 * captions, from the session's normalized overlays (`visibleOverlays`).
 *
 * DRAWN HERE, NEVER ON THE DESKTOP. A point is a fraction of the computer's screen, so placing it is
 * a percentage of the element this layer fills, which must be exactly the frame as it is drawn: the
 * viewer wraps its canvas and this layer in one element, and the preview, whose picture is letterboxed
 * inside its card (`object-contain`), places this layer over the picture's own rectangle
 * (`containedFrame`). It is the inverse of `take-the-wheel.ts`'s click mapping. The model never sees
 * this pointer in a screenshot.
 *
 * NOTHING HERE TAKES A CLICK (`pointer-events: none`), so the person's mouse reaches the screen
 * underneath exactly as it would without Clicky, and focus never lands in it.
 *
 * Clicky's own pointer is a small arrow, unlike the person's, with a soft glow and Noë Bot beside it
 * acting out what Clicky is doing. It glides from where it was to where it points in about a third
 * of a second; with reduced motion it simply appears there. A point Clicky guessed (`approximate`)
 * says "around here" rather than pretending to precision. Words that would run off the screen's top
 * or bottom edge are put on the other side of what they label.
 */

/** Clicky's colour: a blue that reads on light and dark pages, and is nobody's cursor. */
const CLICKY_BLUE = "#3b82f6";
const GLIDE = "350ms cubic-bezier(0.23, 1, 0.32, 1)";
/** Nearer than this to the top edge, a box's words go under it. */
const NEAR_TOP = 0.08;
/** Nearer than this to the bottom edge, the pointer's words and Noë Bot go above it. */
const NEAR_BOTTOM = 0.8;
/** Nearer than this to the right edge, words go to the left. */
const NEAR_RIGHT = 0.62;

/** Noë Bot beside the pointer, acting out the state (`docs/noe-bot-animations.md`). */
const SPRITE_FOR: Record<ClickyState, AnimationId> = {
  idle: "idle",
  listening: "face:attentive",
  thinking: "face:curious",
  guiding: "face:happy",
  awaiting_permission: "face:pleading",
  acting: "action:turbo",
  paused: "face:neutral",
  stopped: "face:neutral",
};

/** A fraction of the screen as a CSS percentage, rounded so 0.07 does not read 7.000000000000001%. */
export function percent(value: number): string {
  return `${Math.round(clampUnit(value) * 100_000) / 1000}%`;
}

/**
 * Where a frame of shape `frame` (width over height) is drawn inside a box of shape `box` when it is
 * fitted whole and centred (`object-contain`), as percentages of the box. A wider frame fills the
 * width with bands above and below; a taller one fills the height with bands either side.
 */
export function containedFrame(
  box: number,
  frame: number,
): { left: string; top: string; width: string; height: string } {
  const round = (value: number) => `${Math.round(value * 1000) / 1000}%`;
  if (!(box > 0) || !(frame > 0) || Math.abs(box - frame) < 1e-6)
    return { left: "0%", top: "0%", width: "100%", height: "100%" };
  if (frame > box) {
    const height = (box / frame) * 100;
    return {
      left: "0%",
      top: round((100 - height) / 2),
      width: "100%",
      height: round(height),
    };
  }
  const width = (frame / box) * 100;
  return {
    left: round((100 - width) / 2),
    top: "0%",
    width: round(width),
    height: "100%",
  };
}

type Pointer = Extract<Overlay, { kind: "pointer" }>;

/** What the overlay draws, picked from the session: words still arriving are not part of it. */
export type ClickyOverlayView = {
  awake: boolean;
  state: ClickyState;
  overlays: Overlay[];
  step: { number: number; total: number; title: string } | null;
  /** Clicky's last reply once it is whole, for the announcement. */
  reply: ClickySession["reply"];
};

export function selectClickyOverlay(session: ClickySession): ClickyOverlayView {
  const step = stepOf(session);
  return {
    awake: session.awake,
    state: session.state,
    overlays: session.awake ? visibleOverlays(session) : [],
    step: step
      ? { number: step.number, total: step.total, title: step.title }
      : null,
    reply: session.reply?.final ? session.reply : null,
  };
}

/** The arrow, tip at the origin. */
function Arrow({ size }: { size: number }) {
  return (
    <svg
      aria-hidden="true"
      className="block overflow-visible"
      height={size * 1.4}
      style={{ filter: `drop-shadow(0 0 6px ${CLICKY_BLUE}b3)` }}
      viewBox="0 0 14 20"
      width={size}
    >
      <path
        d="M0 0 L0 16.5 L4.4 12.6 L7.4 19.4 L10.2 18.2 L7.3 11.6 L12.8 11.6 Z"
        fill={CLICKY_BLUE}
        stroke="white"
        strokeLinejoin="round"
        strokeWidth={1.4}
      />
    </svg>
  );
}

function Bubble({
  children,
  flip,
  className,
}: {
  children: React.ReactNode;
  /** Put it to the left of its anchor, for a point near the right edge. */
  flip?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "absolute w-max max-w-56 rounded-xl bg-white px-2.5 py-1.5 text-left text-[13px] leading-snug text-zinc-900 shadow-lg ring-1 ring-black/10",
        flip ? "right-full mr-2" : "left-full ml-2",
        className,
      )}
    >
      {children}
    </span>
  );
}

export const ClickyOverlay = memo(function ClickyOverlay({
  view,
  colour = CLICKY_BLUE,
  compact = false,
}: {
  view: ClickyOverlayView;
  /** The Bot's own colour, for Noë Bot beside the pointer. */
  colour?: string;
  /** The panel's small preview: the pointer and boxes only, no words and no Noë Bot. */
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const reduced = usePrefersReducedMotion();
  const overlays = view.overlays;
  const pointers = overlays.filter(
    (overlay): overlay is Pointer => overlay.kind === "pointer",
  );
  // Clicky's own pointer is the last one: a step's comes after the free ones and is the more exact.
  const main = pointers.at(-1);
  const others = pointers.slice(0, -1);

  /*
   * Where the pointer last was, so it glides from there when it next points, even after a moment
   * with nothing to point at. Held hidden in the meantime rather than unmounted: a new element has
   * no "from", and would appear instead of moving.
   */
  const [rest, setRest] = useState<ClickyPoint | null>(null);
  const mainX = main?.at.x;
  const mainY = main?.at.y;
  useEffect(() => {
    if (mainX !== undefined && mainY !== undefined)
      setRest({ x: mainX, y: mainY });
  }, [mainX, mainY]);
  const at = main?.at ?? rest;
  const given = main?.label?.trim();
  // A guessed spot says so, rather than claiming a precision it does not have.
  const label =
    compact || !main
      ? null
      : main.approximate
        ? given
          ? t("{{label}}, around here", { label: given })
          : t("Around here")
        : given || null;
  const flip = (at?.x ?? 0) > NEAR_RIGHT;
  const above = (at?.y ?? 0) > NEAR_BOTTOM;
  const glide = reduced ? "none" : `left ${GLIDE}, top ${GLIDE}, opacity 200ms`;
  // What a screen reader hears: the step being worked on, or else Clicky's last whole reply.
  const announcement = !view.awake
    ? ""
    : view.step
      ? t("Step {{number}} of {{total}} — {{title}}", view.step)
      : replyText(view.reply, (key) => t(key));

  return (
    <div
      className="pointer-events-none absolute inset-0 z-10 select-none"
      data-slot="clicky-overlay"
    >
      <div aria-hidden="true" className="absolute inset-0">
        <svg
          aria-hidden="true"
          className="absolute inset-0 h-full w-full overflow-visible"
        >
          {overlays.map((overlay) =>
            overlay.kind === "highlight" ? (
              <rect
                className={reduced ? undefined : "animate-pulse"}
                data-clicky="highlight"
                fill={`${CLICKY_BLUE}1f`}
                height={percent(overlay.rect.height)}
                key={overlay.id}
                rx={compact ? 3 : 6}
                stroke={CLICKY_BLUE}
                strokeWidth={compact ? 1.5 : 2.5}
                width={percent(overlay.rect.width)}
                x={percent(overlay.rect.x)}
                y={percent(overlay.rect.y)}
              />
            ) : null,
          )}
        </svg>

        {overlays.map((overlay) => {
          // A box's own words sit just above its top-left corner, or under it near the top edge.
          if (overlay.kind === "highlight" && overlay.label && !compact) {
            const below = overlay.rect.y < NEAR_TOP;
            return (
              <span
                className={cn(
                  "absolute w-max max-w-56 rounded-lg bg-white px-2 py-1 text-[12px] leading-snug text-zinc-900 shadow-md ring-1 ring-black/10",
                  below ? "translate-y-1" : "-translate-y-full",
                )}
                data-clicky="highlight-label"
                data-placement={below ? "below" : "above"}
                key={`${overlay.id}-label`}
                style={{
                  left: percent(overlay.rect.x),
                  top: below
                    ? percent(overlay.rect.y + overlay.rect.height)
                    : `calc(${percent(overlay.rect.y)} - 4px)`,
                }}
              >
                {overlay.label}
              </span>
            );
          }
          if (overlay.kind === "marker")
            return (
              <span
                className="absolute flex -translate-x-1/2 -translate-y-1/2 items-center"
                data-clicky="marker"
                key={overlay.id}
                style={{
                  left: percent(overlay.at.x),
                  top: percent(overlay.at.y),
                }}
              >
                <span
                  className={cn(
                    "flex items-center justify-center rounded-full font-semibold text-white shadow-md ring-2 ring-white",
                    compact ? "size-4 text-[9px]" : "size-6 text-xs",
                  )}
                  style={{ backgroundColor: CLICKY_BLUE }}
                >
                  {overlay.index}
                </span>
                {overlay.label && !compact ? (
                  <Bubble flip={overlay.at.x > NEAR_RIGHT}>
                    {overlay.label}
                  </Bubble>
                ) : null}
              </span>
            );
          if (overlay.kind === "caption" && overlay.at && !compact)
            return (
              <span
                className="absolute"
                data-clicky="caption"
                key={overlay.id}
                style={{
                  left: percent(overlay.at.x),
                  top: percent(overlay.at.y),
                }}
              >
                <Bubble
                  className="-translate-y-1/2"
                  flip={overlay.at.x > NEAR_RIGHT}
                >
                  {overlay.text}
                </Bubble>
              </span>
            );
          return null;
        })}

        {others.map((pointer) => (
          <span
            className="absolute"
            data-clicky="pointer"
            key={pointer.id}
            style={{ left: percent(pointer.at.x), top: percent(pointer.at.y) }}
          >
            <Arrow size={compact ? 9 : 14} />
          </span>
        ))}

        {at ? (
          <span
            className="absolute"
            data-clicky="clicky-pointer"
            data-approximate={main?.approximate ? "true" : undefined}
            style={{
              left: percent(at.x),
              top: percent(at.y),
              opacity: main ? 1 : 0,
              transition: glide,
            }}
          >
            <Arrow size={compact ? 11 : 18} />
            {compact ? null : (
              <span
                className={cn(
                  "absolute flex items-start",
                  above ? "bottom-full mb-1" : "top-4",
                  flip ? "right-1 flex-row-reverse" : "left-3",
                )}
                data-placement={above ? "above" : "below"}
              >
                <span
                  className={cn(
                    "relative block size-7 shrink-0",
                    THEMED_INK_CLASS,
                  )}
                  style={{ color: colour }}
                >
                  <NoeBotSprite
                    animation={SPRITE_FOR[view.state]}
                    mode="terminal"
                    palette={THEMED_PALETTE}
                    props={false}
                    size={28}
                  />
                </span>
                {label ? (
                  <span
                    className="relative mt-1 w-max max-w-56 rounded-xl bg-white px-2.5 py-1.5 text-[13px] leading-snug text-zinc-900 shadow-lg ring-1 ring-black/10"
                    data-clicky="pointer-label"
                  >
                    {label}
                  </span>
                ) : null}
              </span>
            )}
          </span>
        ) : null}

        {/* Captions with no place of their own sit along the bottom of the screen, centred. */}
        {compact
          ? null
          : overlays
              .filter(
                (overlay): overlay is Extract<Overlay, { kind: "caption" }> =>
                  overlay.kind === "caption" && !overlay.at,
              )
              .slice(-2)
              .map((overlay, index) => (
                <span
                  className="absolute left-1/2 w-max max-w-[80%] -translate-x-1/2 rounded-xl bg-white/95 px-3 py-1.5 text-center text-[13px] text-zinc-900 shadow-lg ring-1 ring-black/10"
                  data-clicky="caption"
                  key={overlay.id}
                  style={{ bottom: `${12 + index * 40}px` }}
                >
                  {overlay.text}
                </span>
              ))}
      </div>
      {compact ? null : (
        <p aria-live="polite" className="sr-only" data-clicky="announcement">
          {announcement}
        </p>
      )}
    </div>
  );
});

ClickyOverlay.displayName = "ClickyOverlay";

/**
 * The overlay for a Bot, from the session the surface around it keeps current. Words arriving in a
 * reply do not draw it again: its view leaves them out.
 */
export const ClickyScreenOverlay = memo(function ClickyScreenOverlay({
  botId,
  colour,
  compact = false,
}: {
  botId: string;
  colour?: string;
  compact?: boolean;
}) {
  const view = useClickySessionView(botId, selectClickyOverlay);
  if (!view?.awake) return null;
  return (
    <ClickyOverlay
      compact={compact}
      view={view}
      {...(colour ? { colour } : {})}
    />
  );
});

ClickyScreenOverlay.displayName = "ClickyScreenOverlay";
