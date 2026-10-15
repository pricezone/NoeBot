import { useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";

/**
 * Types a conversation's name in as it arrives, so the line reads as learning something rather than
 * as a glitch. Only on arrival: otherwise opening the app sets the whole roster typing at once.
 */

/** Per character, not per title, so every length types at the same speed. Capped so none outstays. */
export const TYPING_SECONDS_PER_CHARACTER = 0.014;
export const TYPING_MAX_SECONDS = 0.45;

export function typingSeconds(length: number): number {
  return Math.min(length * TYPING_SECONDS_PER_CHARACTER, TYPING_MAX_SECONDS);
}

/** Naming is none-to-some. A name replacing another name is not this, and must not replay. */
export function isNaming(
  previous: string | undefined,
  next: string | undefined,
): boolean {
  return !previous && Boolean(next);
}

export type TypedReveal = {
  /** What to draw right now: the whole name, or as much of it as has landed. */
  text: string | undefined;
  /** Whether the characters are still arriving, so the caller can show a cursor. */
  typing: boolean;
};

export function useTypedReveal(summary: string | undefined): TypedReveal {
  const reduce = useReducedMotion();
  const previous = useRef(summary);
  const firstRun = useRef(true);
  const [typed, setTyped] = useState<number | null>(null);

  useEffect(() => {
    const from = previous.current;
    previous.current = summary;
    // A row that arrives already named is not a naming.
    const mounting = firstRun.current;
    firstRun.current = false;
    if (mounting || !summary || !isNaming(from, summary)) return;
    // The gentler version of a reveal made entirely of movement is no movement.
    if (reduce) return;

    let frame = 0;
    const started = performance.now();
    const total = typingSeconds(summary.length) * 1000;
    // Linear, because this is constant motion. An eased typewriter reads as a machine hesitating.
    const step = (now: number) => {
      const progress = Math.min((now - started) / total, 1);
      setTyped(Math.round(progress * summary.length));
      if (progress < 1) {
        frame = requestAnimationFrame(step);
        return;
      }
      // Null, not the full length, so later renders draw the string rather than re-slicing it.
      setTyped(null);
    };
    frame = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(frame);
      // A name that changes mid-reveal is drawn whole; the slice left behind would cut it short.
      setTyped(null);
    };
  }, [summary, reduce]);

  if (typed === null || !summary) return { text: summary, typing: false };
  return { text: summary.slice(0, typed), typing: true };
}

/**
 * "Show me how" (Clicky) typing its instruction in beside its pointer, a sentence at a time.
 *
 * About 20 ms a character, so a short line lands in a fraction of a second and reads as being said
 * rather than as a glitch; a long one speeds up so it is all there within four seconds.
 */
export const SENTENCE_MS_PER_CHARACTER = 20;
export const SENTENCE_MAX_MS = 4_000;

/** The pace for a sentence of `length` characters, in milliseconds a character. */
export function sentenceMsPerCharacter(length: number): number {
  if (length <= 0) return SENTENCE_MS_PER_CHARACTER;
  return Math.min(SENTENCE_MS_PER_CHARACTER, SENTENCE_MAX_MS / length);
}

type Typing = { text: string; replay: unknown; from: number };

/**
 * A sentence typing in: what of `text` to draw now.
 *
 * It starts again from nothing when the text becomes another sentence or `replay` changes ("Say
 * that again"), and carries on from where it was when the new text only adds to the old one (an
 * answer whose words are still arriving), so a streaming reply types on rather than restarting at
 * every word. With `reduce` (the person asked for less motion) the whole text is there at once.
 */
export function useTypedSentence(
  text: string,
  replay: unknown,
  reduce: boolean,
): TypedReveal & { text: string } {
  const [typing, setTyping] = useState<Typing>(() => ({
    text,
    replay,
    from: reduce ? text.length : 0,
  }));
  const [count, setCount] = useState(typing.from);
  // A new sentence is decided while drawing, so not even one frame shows it whole before it types.
  if (typing.text !== text || typing.replay !== replay) {
    const carriesOn =
      typing.replay === replay &&
      typing.text !== "" &&
      text.startsWith(typing.text);
    const from = reduce
      ? text.length
      : carriesOn
        ? Math.min(count, text.length)
        : 0;
    setTyping({ text, replay, from });
    setCount(from);
  }

  useEffect(() => {
    const total = typing.text.length;
    if (reduce || typing.from >= total) {
      setCount(total);
      return;
    }
    const pace = sentenceMsPerCharacter(total);
    const began = performance.now();
    let frame = 0;
    // Linear, as above: an eased typewriter reads as a machine hesitating.
    const step = (now: number) => {
      const next = Math.min(
        total,
        typing.from + Math.floor(Math.max(0, now - began) / pace),
      );
      setCount(next);
      if (next < total) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [typing, reduce]);

  const shown = reduce ? text.length : Math.min(count, text.length);
  return { text: text.slice(0, shown), typing: shown < text.length };
}
