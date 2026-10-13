import { useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
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
import {
  formatElapsed,
  type UiStrings,
  useUiStrings,
  type WaitingKind,
} from "@/lib/i18n/strings";
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

/** How long a wait runs before the row says what it is waiting for and for how long. */
export const WAIT_DETAIL_AFTER_S = 10;

/**
 * What the person is being waited on for, from the tool the turn is held on. The same names the
 * director reads as "waiting" (`anim/tool-map.ts`), sorted into what the person has to do.
 */
export function waitingKindOf(
  tool: string | null | undefined,
): WaitingKind | null {
  if (!tool) return null;
  if (/request_sign_in/i.test(tool)) return "sign-in";
  if (/request_secret/i.test(tool)) return "code";
  if (/request_help/i.test(tool)) return "takeover";
  if (/approval/i.test(tool)) return "approval";
  if (/ask_person|askchoice/i.test(tool)) return "choice";
  return null;
}

/** "Waiting for you to sign in · 2:15" once a wait is long enough to be worth timing. */
export function waitingLabel(
  kind: WaitingKind,
  seconds: number,
  ui: UiStrings,
): string {
  return `${ui.waitingFor[kind]} · ${formatElapsed(seconds)}`;
}

/**
 * Seconds since `key` started being true, ticking once a second while it is; null while it is not.
 * A new key (another tool to wait on) starts the clock again.
 */
function useWaitClock(key: string | null): number | null {
  const since = useRef<{ key: string; at: number } | null>(null);
  const [, tick] = useState(0);
  if (key === null) since.current = null;
  else if (since.current?.key !== key) since.current = { key, at: Date.now() };
  useEffect(() => {
    if (key === null) return undefined;
    const id = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [key]);
  return since.current ? (Date.now() - since.current.at) / 1000 : null;
}

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
 *
 * A LONG WAIT SAYS WHAT IT IS FOR. Past ten seconds of waiting on the person, the director's
 * "Waiting for you" becomes what they are needed for and how long it has been ("Waiting for you to
 * sign in · 2:15"), in the conversation's language: a person who looked away comes back to a row
 * that says what to do. The character is untouched; only the words change.
 */
export function ChatActivityIndicator({
  animation,
  label,
  phase,
  avatar,
  waitingFor,
}: {
  animation: AnimationId;
  label: string;
  phase: Phase;
  /** Whose work this is: the character takes this Bot's colour. */
  avatar?: AvatarChoice;
  /** What the person is being waited on for, while the phase is "waiting" (`waitingKindOf`). */
  waitingFor?: WaitingKind | null;
}) {
  const ui = useUiStrings();
  const waitKind = phase === "waiting" ? (waitingFor ?? "other") : null;
  const waited = useWaitClock(waitKind);
  const shown =
    waitKind !== null && waited !== null && waited >= WAIT_DETAIL_AFTER_S
      ? waitingLabel(waitKind, waited, ui)
      : label;
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
        {shown}
      </p>
    </div>
  );
}
