import { useEffect, useRef } from "react";
import { useInterfaceLocale, useTranslation } from "@/lib/i18n";
import { intlLocale } from "@/lib/i18n/format";
import type { ClickySession } from "../../../../shared/clicky";
import type { Locale } from "../../../../shared/i18n/locales";
import { replyText } from "./notices";
import { useClickySessionView } from "./use-clicky-session";

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
} {
  const { seq, updatedAt: _updatedAt, ...rest } = session;
  const whole = session.reply?.final ? session.reply : null;
  return {
    seq,
    reply: whole ? JSON.stringify(whole) : null,
    body: JSON.stringify({ ...rest, reply: whole }),
    stopped: session.state === "stopped",
  };
}

export function useClickySpeech(botId: string, enabled: boolean): void {
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
    if (!enabled || !spoken.reply) return;
    const repeated = previous.body === spoken.body;
    if (spoken.reply === previous.reply && !repeated) return;
    const reply = JSON.parse(spoken.reply) as ClickySession["reply"];
    speak(replyText(reply, t), locale);
  }, [spoken, enabled, t, locale]);

  // Turned off, or the bar closed: stop talking.
  useEffect(() => {
    if (!enabled) return;
    return hush;
  }, [enabled]);
}
