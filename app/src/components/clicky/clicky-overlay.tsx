import {
  type CSSProperties,
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { AnimationId } from "@/components/noe-bot/anim/catalog";
import { NoeBotSprite } from "@/components/noe-bot/anim/noe-bot-sprite";
import {
  THEMED_INK_CLASS,
  THEMED_PALETTE,
} from "@/components/noe-bot/anim/palette";
import {
  CLICKY_NOTICE_KEYS,
  CLICKY_NOTICES_BESIDE_STEP,
  replyText,
} from "@/lib/clicky/notices";
import { usePrefersReducedMotion } from "@/lib/clicky/reduced-motion";
import { useClickySessionView } from "@/lib/clicky/use-clicky-session";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  CLICKY_NARRATION_HIGHLIGHT_MS,
  type ClickyOverlay as Overlay,
  type ClickyPoint,
  type ClickySession,
  type ClickyState,
  clampUnit,
  visibleOverlays,
} from "../../../../shared/clicky";
import { ClickyInstruction } from "./clicky-instruction";
import { stepOf } from "./clicky-words";

/**
 * What "Show me how" (Clicky) draws over the Bot's screen in the full-window viewer: its pointer,
 * highlight boxes, numbered markers and captions, from the session's normalized overlays
 * (`visibleOverlays`), and beside the pointer the instruction typing in (`ClickyInstruction`): the
 * step to do, the answer, or what the Bot is doing. With nothing to point at, the instruction sits
 * along the bottom of the screen. Never on the panel's small preview, where it cannot be read.
 *
 * DRAWN HERE, NEVER ON THE DESKTOP. A point is a fraction of the computer's screen, so placing it is
 * a percentage of the element this layer fills, which must be exactly the frame as it is drawn: the
 * viewer wraps its canvas and this layer in one element; a picture letterboxed inside a card
 * (`object-contain`) would place this layer over the picture's own rectangle (`containedFrame`). It
 * is the inverse of `take-the-wheel.ts`'s click mapping. The model never sees this pointer in a
 * screenshot.
 *
 * NEVER STALE WITHOUT SAYING SO. While Clicky looks at the screen again after the person did
 * something (`overlaysStale`), what it points at may have moved: the boxes, markers and pointer are
 * drawn faded and still until the fresh look places them again.
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
/** Nearer than this to the right edge, words go to the left, when the screen's width is not known. */
const NEAR_RIGHT = 0.62;
/** The room the pointer's words need to its right: Noë Bot, the gap and the widest bubble (256 px). */
const POINTER_WORDS_ROOM = 304;
/** The room a marker's or a caption's words need beside it: the widest bubble (224 px) and the gap. */
const BUBBLE_ROOM = 236;
/** Noë Bot and the gaps between the pointer and its words. */
const POINTER_WORDS_OFFSET = 48;
/** The narrowest the pointer's words are made; past that they wrap rather than shrink further. */
const POINTER_WORDS_MIN = 140;

/**
 * How wide the pointer's words may be on the side they go (`left` or right of a point at `x`), so a
 * small viewer narrows them rather than cutting them off at its edge. Unknown without a width.
 */
export function wordsRoom(
  x: number,
  width: number | null,
  left: boolean,
): number | null {
  if (!width) return null;
  const side = left ? x * width : (1 - x) * width;
  return Math.max(POINTER_WORDS_MIN, Math.floor(side - POINTER_WORDS_OFFSET));
}

/**
 * Whether the words beside a point at `x` go to its left: when the screen, `width` pixels wide, has
 * less than `room` to the point's right and more to its left. Measured rather than a fixed share,
 * since the same point has room on a full-size viewer and none on a small one.
 */
export function wordsGoLeft(
  x: number,
  width: number | null,
  room: number,
): boolean {
  if (!width) return x > NEAR_RIGHT;
  const right = (1 - x) * width;
  return right < room && x * width > right;
}

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
  /**
   * Clicky is looking at the screen again after the person did something (`overlaysStale`): what it
   * points at may have moved, so it is drawn faded until the look is back.
   */
  stale: boolean;
  /** Showing what the Bot does: its boxes fade a moment after each action (`useFadedHighlights`). */
  narrating: boolean;
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
    stale: session.overlaysStale === true,
    narrating: session.narrating === true,
  };
}

/** How long a narration box takes to fade, once its time is up. */
const NARRATION_FADE = "opacity 600ms ease-out";

/**
 * The boxes narration drew that have been shown long enough. What the Bot acted on is boxed for a
 * moment and then fades, even if the Bot stays on the page; its next action draws a new box (a new
 * id), shown in full again.
 */
function useFadedHighlights(
  overlays: readonly Overlay[],
  narrating: boolean,
  afterMs: number,
): ReadonlySet<string> {
  const [faded, setFaded] = useState<ReadonlySet<string>>(() => new Set());
  const ids = overlays
    .filter((overlay) => overlay.kind === "highlight")
    .map((overlay) => overlay.id)
    .join(" ");
  useEffect(() => {
    if (!narrating || !ids) return;
    const timer = setTimeout(() => setFaded(new Set(ids.split(" "))), afterMs);
    return () => clearTimeout(timer);
  }, [narrating, ids, afterMs]);
  return faded;
}

/** How faded overlays are drawn while Clicky looks again. */
export const CLICKY_STALE_OPACITY = 0.4;

/**
 * Draws the instruction beside the pointer (or, with no pointer, along the bottom of the screen).
 * `label` is the pointer's own words, `approximate` whether its spot was guessed.
 */
export type ClickyInstructionSlot = (
  label: string | null,
  approximate: boolean,
) => ReactNode;

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
  instruction,
  narrationFadeAfterMs = CLICKY_NARRATION_HIGHLIGHT_MS,
}: {
  view: ClickyOverlayView;
  /** How long a narration box stays before it fades; shorter in a test. */
  narrationFadeAfterMs?: number;
  /** The Bot's own colour, for Noë Bot beside the pointer. */
  colour?: string;
  /**
   * The instruction, typing in, in place of the pointer's own label (`ClickyInstruction`). Absent,
   * the pointer shows its label as it is.
   */
  instruction?: ClickyInstructionSlot;
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
  const label = !main
    ? null
    : main.approximate
      ? given
        ? t("{{label}}, around here", { label: given })
        : t("Around here")
      : given || null;
  // The layer's width in pixels, for which side of a point its words fit on.
  const layer = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number | null>(null);
  useEffect(() => {
    const element = layer.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const flip = wordsGoLeft(at?.x ?? 0, width, POINTER_WORDS_ROOM);
  const room = wordsRoom(at?.x ?? 0, width, flip);
  const above = (at?.y ?? 0) > NEAR_BOTTOM;
  const glide = reduced ? "none" : `left ${GLIDE}, top ${GLIDE}, opacity 200ms`;
  const stale = view.stale;
  // Faded while Clicky looks again, and still: a pulse would say "here" about a place that may be gone.
  const fade = stale ? CLICKY_STALE_OPACITY : 1;
  // A narration box does not pulse: it is there for a moment, then fades.
  const pulse =
    reduced || stale || view.narrating ? undefined : "animate-pulse";
  const faded = useFadedHighlights(
    overlays,
    view.narrating,
    narrationFadeAfterMs,
  );
  /** A box's opacity: faded once narration's moment for it is over, dimmed while stale. */
  const boxStyle = (id: string): CSSProperties => {
    const gone = view.narrating && faded.has(id);
    return {
      opacity: gone ? 0 : fade,
      ...(view.narrating && !reduced ? { transition: NARRATION_FADE } : {}),
    };
  };
  /*
   * What a screen reader hears: the step being worked on, or else Clicky's last whole reply, with
   * what the Bot did put into a narration. A line that must not hide behind a step (it is yours, it
   * did not work) is said after the step.
   */
  const translate = (key: string, params?: Record<string, string>) =>
    t(key, params);
  const notice = view.reply?.notice;
  const announcement = !view.awake
    ? ""
    : view.step
      ? [
          t("Step {{number}} of {{total}} — {{title}}", view.step),
          notice && CLICKY_NOTICES_BESIDE_STEP.includes(notice)
            ? t(CLICKY_NOTICE_KEYS[notice], view.reply?.params ?? {})
            : "",
        ]
          .filter(Boolean)
          .join(" ")
      : replyText(view.reply, translate);

  return (
    <div
      className="pointer-events-none absolute inset-0 z-10 select-none"
      data-slot="clicky-overlay"
      ref={layer}
    >
      <div aria-hidden="true" className="absolute inset-0">
        <svg
          aria-hidden="true"
          className="absolute inset-0 h-full w-full overflow-visible"
        >
          {overlays.map((overlay) =>
            overlay.kind === "highlight" ? (
              <rect
                className={pulse}
                data-clicky="highlight"
                data-faded={
                  view.narrating && faded.has(overlay.id) ? "true" : undefined
                }
                data-stale={stale ? "true" : undefined}
                style={boxStyle(overlay.id)}
                fill={`${CLICKY_BLUE}1f`}
                height={percent(overlay.rect.height)}
                key={overlay.id}
                rx={6}
                stroke={CLICKY_BLUE}
                strokeWidth={2.5}
                width={percent(overlay.rect.width)}
                x={percent(overlay.rect.x)}
                y={percent(overlay.rect.y)}
              />
            ) : null,
          )}
        </svg>

        {overlays.map((overlay) => {
          // A box's own words sit just above its top-left corner, or under it near the top edge.
          if (overlay.kind === "highlight" && overlay.label) {
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
                  ...boxStyle(overlay.id),
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
                  opacity: fade,
                }}
              >
                <span
                  className="flex size-6 items-center justify-center rounded-full font-semibold text-white text-xs shadow-md ring-2 ring-white"
                  style={{ backgroundColor: CLICKY_BLUE }}
                >
                  {overlay.index}
                </span>
                {overlay.label ? (
                  <Bubble flip={wordsGoLeft(overlay.at.x, width, BUBBLE_ROOM)}>
                    {overlay.label}
                  </Bubble>
                ) : null}
              </span>
            );
          if (overlay.kind === "caption" && overlay.at)
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
                  flip={wordsGoLeft(overlay.at.x, width, BUBBLE_ROOM)}
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
            style={{
              left: percent(pointer.at.x),
              top: percent(pointer.at.y),
              opacity: fade,
            }}
          >
            <Arrow size={14} />
          </span>
        ))}

        {at ? (
          <span
            className="absolute"
            data-clicky="clicky-pointer"
            data-approximate={main?.approximate ? "true" : undefined}
            data-stale={stale ? "true" : undefined}
            style={{
              left: percent(at.x),
              top: percent(at.y),
              opacity: main ? 1 : 0,
              transition: glide,
            }}
          >
            <span className="block" style={{ opacity: fade }}>
              <Arrow size={18} />
            </span>
            <span
              className={cn(
                "absolute flex items-start",
                above ? "bottom-full mb-1" : "top-4",
                flip ? "right-1 flex-row-reverse" : "left-3",
              )}
              data-placement={above ? "above" : "below"}
              style={
                room === null
                  ? undefined
                  : ({ "--clicky-words-max": `${room}px` } as CSSProperties)
              }
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
              {/* The instruction typing in, in place of the label; only the pointer that is showing. */}
              {instruction && main ? (
                <span className="relative mt-1 block">
                  {instruction(label, main.approximate === true)}
                </span>
              ) : label ? (
                <span
                  className="relative mt-1 w-max max-w-[min(14rem,var(--clicky-words-max,14rem))] rounded-xl bg-white px-2.5 py-1.5 text-[13px] leading-snug text-zinc-900 shadow-lg ring-1 ring-black/10"
                  data-clicky="pointer-label"
                >
                  {label}
                </span>
              ) : null}
            </span>
          </span>
        ) : null}

        {/* With nothing to point at, the instruction sits along the bottom of the screen, centred. */}
        {instruction && !main ? (
          <span
            className="absolute bottom-3 left-1/2 flex max-w-[80%] -translate-x-1/2 justify-center"
            data-placement="bottom"
            data-slot="clicky-instruction-bottom"
          >
            {instruction(null, false)}
          </span>
        ) : null}

        {/* Captions with no place of their own sit along the bottom of the screen, centred. */}
        {overlays
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
              style={{
                bottom: `${(instruction && !main ? 60 : 12) + index * 40}px`,
              }}
            >
              {overlay.text}
            </span>
          ))}
      </div>
      <p aria-live="polite" className="sr-only" data-clicky="announcement">
        {announcement}
      </p>
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
}: {
  botId: string;
  colour?: string;
}) {
  const view = useClickySessionView(botId, selectClickyOverlay);
  const instruction = useCallback<ClickyInstructionSlot>(
    (label, approximate) => (
      <ClickyInstruction
        approximate={approximate}
        botId={botId}
        fallback={label}
      />
    ),
    [botId],
  );
  if (!view?.awake) return null;
  return (
    <ClickyOverlay
      instruction={instruction}
      view={view}
      {...(colour ? { colour } : {})}
    />
  );
});

ClickyScreenOverlay.displayName = "ClickyScreenOverlay";
