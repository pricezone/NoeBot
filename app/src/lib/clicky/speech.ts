import { useEffect, useRef } from "react";
import { useInterfaceLocale, useTranslation } from "@/lib/i18n";
import { intlLocale } from "@/lib/i18n/format";
import type { ClickySession } from "../../../../shared/clicky";
import type { Locale } from "../../../../shared/i18n/locales";
import { replyText } from "./notices";

/**
 * Clicky reading its replies aloud, when the person turned that on (`clickySpeakReplies`).
 *
 * The browser's own voice (`speechSynthesis`), in the interface's language: there is no
 * text-to-speech on the server, and a companion that answers out loud is worth the browser's voice.
 * Only a reply that is whole is read, once; "Say that again" (`repeat`) reads it again, which the
 * server signals by changing nothing but the session's `seq`.
 */

function speechAvailable(): boolean {
  return (
    typeof window !== "undefined" &&
    "speechSynthesis" in window &&
    typeof SpeechSynthesisUtterance !== "undefined"
  );
}

/** Says `text` now, cutting off whatever Clicky was saying before. */
export function speak(text: string, locale: Locale): void {
  if (!text.trim() || !speechAvailable()) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = intlLocale(locale);
  window.speechSynthesis.speak(utterance);
}

/** Stops Clicky mid-sentence. */
export function hush(): void {
  if (speechAvailable()) window.speechSynthesis.cancel();
}

/** The session without the two fields every change bumps, to tell "nothing changed" apart. */
function bodyOf(session: ClickySession): string {
  const { seq: _seq, updatedAt: _updatedAt, ...rest } = session;
  return JSON.stringify(rest);
}

export function useClickySpeech(
  session: ClickySession | undefined,
  enabled: boolean,
): void {
  const { t } = useTranslation();
  const locale = useInterfaceLocale();
  const last = useRef<{
    seq: number;
    reply: string | null;
    body: string;
  } | null>(null);

  useEffect(() => {
    if (!session) return;
    const reply = session.reply?.final ? JSON.stringify(session.reply) : null;
    const body = bodyOf(session);
    const previous = last.current;
    last.current = { seq: session.seq, reply, body };
    // What was already on screen when this started is not news.
    if (!previous || session.seq <= previous.seq) return;
    if (session.state === "stopped" && previous.body !== body) hush();
    if (!enabled || !reply) return;
    const repeated = previous.body === body;
    if (reply === previous.reply && !repeated) return;
    speak(replyText(session.reply, t), locale);
  }, [session, enabled, t, locale]);

  // Turned off, or the bar closed: stop talking.
  useEffect(() => {
    if (!enabled) return;
    return hush;
  }, [enabled]);
}
