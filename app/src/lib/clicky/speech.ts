import { useEffect, useRef } from "react";
import { useInterfaceLocale, useTranslation } from "@/lib/i18n";
import { intlLocale } from "@/lib/i18n/format";
import { type ClickySession, currentStep } from "../../../../shared/clicky";
import type { Locale } from "../../../../shared/i18n/locales";
import { instructionText, replyText } from "./notices";
import { replayClickyLineFromServer, replayClickyLineNow } from "./replay";
import { useClickySessionView } from "./use-clicky-session";

/**
 * "Show me how" (Clicky) reading its replies aloud, when the person turned that on
 * (`clickySpeakReplies`), and "Say that again", which always speaks.
 *
 * The browser's own voice (`speechSynthesis`), in the interface's language: there is no
 * text-to-speech on the server, and a companion that answers out loud is worth the browser's voice.
 * Only a reply that is whole is read, once. "Say that again" is the person's own press, so it speaks
 * there and then whatever the setting says (`sayClickyLineAgain`); the server's answer to it, a
 * snapshot that changes nothing but `seq`, is then that press's echo and is not spoken twice. A
 * repeat asked for elsewhere (the phone) is spoken here only with the setting on.
 */

function speechAvailable(): boolean {
  return (
    typeof window !== "undefined" &&
    "speechSynthesis" in window &&
    typeof SpeechSynthesisUtterance !== "undefined"
  );
}

/**
 * How long after `cancel()` the next sentence is handed over. Chrome drops an utterance passed to
 * `speak()` in the same task as a `cancel()` that cut another one off, so "Say that again" over a
 * sentence still being read said nothing at all.
 */
const SPEAK_AFTER_CANCEL_MS = 80;
let pending: ReturnType<typeof setTimeout> | undefined;
/** Held until it is done: Chrome lets go of an utterance nothing refers to, mid-sentence. */
let speaking: SpeechSynthesisUtterance | null = null;

/** Says `text` now, cutting off whatever Clicky was saying before. */
export function speak(text: string, locale: Locale): void {
  if (!text.trim() || !speechAvailable()) return;
  const synth = window.speechSynthesis;
  clearTimeout(pending);
  pending = undefined;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = intlLocale(locale);
  utterance.onend = () => {
    if (speaking === utterance) speaking = null;
  };
  speaking = utterance;
  const say = () => {
    pending = undefined;
    // A voice left paused (Chrome, after the tab was in the background) says nothing until resumed.
    synth.resume?.();
    synth.speak(utterance);
  };
  if (synth.speaking || synth.pending) {
    synth.cancel();
    pending = setTimeout(say, SPEAK_AFTER_CANCEL_MS);
    return;
  }
  say();
}

/** Stops Clicky mid-sentence, and anything about to be said. */
export function hush(): void {
  clearTimeout(pending);
  pending = undefined;
  speaking = null;
  if (speechAvailable()) window.speechSynthesis.cancel();
}

/**
 * "Say that again", pressed here: speaks the line now (a press is the gesture a browser wants
 * before it talks) and types it in again beside the pointer at once.
 */
export function sayClickyLineAgain(
  botId: string,
  text: string,
  locale: Locale,
): void {
  replayClickyLineNow(botId);
  speak(text, locale);
}

/** What "Say that again" says: the instruction beside the pointer (`instructionText`). */
export function clickyLineOf(
  session: ClickySession,
  detailed: boolean,
  t: (key: string, params?: Record<string, string>) => string,
): string {
  const step = currentStep(session);
  return instructionText(
    {
      narrating: session.narrating === true,
      step: step
        ? { title: step.title, ...(step.detail ? { detail: step.detail } : {}) }
        : null,
      reply: session.reply?.final ? session.reply : null,
      detailed,
    },
    t,
  );
}

/**
 * What reading aloud needs from the session: its `seq`, the reply once it is whole, and everything
 * else (minus the two fields every change bumps, and minus words still arriving), to tell a `repeat`
 * (nothing changed but `seq`) from a session that moved on. Words arriving change none of it, so the
 * hook is not run for each one.
 */
function selectSpoken(session: ClickySession): {
  seq: number;
  reply: string | null;
  body: string;
  stopped: boolean;
  session: ClickySession;
} {
  const { seq, updatedAt: _updatedAt, ...rest } = session;
  const whole = session.reply?.final ? session.reply : null;
  return {
    seq,
    reply: whole ? JSON.stringify(whole) : null,
    body: JSON.stringify({ ...rest, reply: whole }),
    stopped: session.state === "stopped",
    session,
  };
}

/**
 * Reads new replies aloud while `enabled`, and notices a repeat: the line types in again beside the
 * pointer (unless it is the echo of this tab's own "Say that again") and, with `enabled`, is said.
 * Mounted once, by the bar.
 */
export function useClickySpeech(
  botId: string,
  enabled: boolean,
  detailed = false,
): void {
  const { t } = useTranslation();
  const locale = useInterfaceLocale();
  const spoken = useClickySessionView(botId, selectSpoken);
  const last = useRef<ReturnType<typeof selectSpoken> | null>(null);

  useEffect(() => {
    if (!spoken) return;
    const previous = last.current;
    last.current = spoken;
    // What was already on screen when this started is not news.
    if (!previous || spoken.seq <= previous.seq) return;
    if (spoken.stopped && previous.body !== spoken.body) hush();
    const translate = (key: string, params?: Record<string, string>) =>
      t(key, params);
    if (previous.body === spoken.body) {
      // Said again: from elsewhere, or the echo of this tab's own press, which already spoke.
      if (!spoken.reply || !replayClickyLineFromServer(botId) || !enabled)
        return;
      speak(clickyLineOf(spoken.session, detailed, translate), locale);
      return;
    }
    if (!enabled || !spoken.reply || spoken.reply === previous.reply) return;
    const reply = JSON.parse(spoken.reply) as ClickySession["reply"];
    speak(replyText(reply, translate), locale);
  }, [spoken, enabled, detailed, t, locale, botId]);

  // Turned off, or the bar closed: stop talking.
  useEffect(() => {
    if (!enabled) return;
    return hush;
  }, [enabled]);
}
