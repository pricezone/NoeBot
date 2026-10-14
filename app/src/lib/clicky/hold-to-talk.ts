import { useCallback, useEffect, useRef, useState } from "react";
import {
  type Recording,
  startRecording,
  transcribeRecording,
} from "@/lib/dictation/recording";
import { i18n } from "@/lib/i18n";
import { hush } from "./speech";

/**
 * Press and hold to talk to Clicky; release to send.
 *
 * Bluey's gesture, on the dictation recorder the composer already uses (`lib/dictation/recording.ts`:
 * MediaRecorder, then `POST /api/audio/transcriptions`). Pressing quiets Clicky if it was speaking,
 * tells it it is being listened to (`listen: true`, so the phone and the viewer both say
 * "Listening") and starts recording; releasing stops, transcribes, tells Clicky the listening is over
 * and asks with the words.
 *
 * NOTHING IS ASKED BY ACCIDENT. Only `listen: false` goes out, and nothing is transcribed, when:
 * - the press was a tap: released within a quarter of a second, measured from press to release;
 * - it was let go while the microphone was still opening (the browser's permission prompt, say):
 *   whatever is recorded after somebody let go is not something they meant to say;
 * - it was cancelled: the pointer was cancelled by the system (`cancel`).
 * Losing the pointer capture or the window's focus counts as letting go.
 *
 * Whatever goes wrong ends as one plain sentence in `error`, and the listening is always ended, so
 * Clicky is never left showing "Listening" to somebody who has let go.
 */

export const HOLD_MIN_MS = 250;

export type HoldToTalkPhase = "idle" | "starting" | "recording" | "sending";

export type HoldToTalkOptions = {
  onListen: (active: boolean) => void;
  onAsk: (text: string) => void;
  /** The recorder and the transcriber, replaceable in tests. */
  record?: (onError: (error: Error) => void) => Promise<Recording>;
  transcribe?: (audio: Blob, signal: AbortSignal) => Promise<string>;
  minHoldMs?: number;
};

/** The sentence a person reads for a failure: the recorder's own when it wrote one, else a plain one. */
function plainMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === "NotAllowedError")
    return i18n.t(
      "Clicky can't hear you. Allow the microphone for this site, then try again.",
    );
  if (error instanceof DOMException && error.name === "NotFoundError")
    return i18n.t("No microphone was found. You can type instead.");
  if (
    error instanceof Error &&
    error.message &&
    !(error instanceof DOMException)
  )
    return error.message;
  return i18n.t("I couldn't hear that. Try again, or type instead.");
}

export function useHoldToTalk({
  onListen,
  onAsk,
  record = startRecording,
  transcribe = transcribeRecording,
  minHoldMs = HOLD_MIN_MS,
}: HoldToTalkOptions) {
  const [phase, setPhase] = useState<HoldToTalkPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  /** Read at event time, so a press during a send is refused by what is true now. */
  const phaseRef = useRef<HoldToTalkPhase>("idle");
  const recording = useRef<Recording | null>(null);
  const pressedAt = useRef(0);
  /** Let go while the microphone was still opening: whatever it records is dropped. */
  const droppedEarly = useRef(false);
  /** Bumped by every press, cancel and unmount, so a late answer for an old press is dropped. */
  const generation = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const callbacks = useRef({ onListen, onAsk });
  callbacks.current = { onListen, onAsk };

  const move = useCallback((next: HoldToTalkPhase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  /** Drops the recording and ends the listening, asking nothing. */
  const drop = useCallback(() => {
    recording.current?.cancel();
    recording.current = null;
    move("idle");
    callbacks.current.onListen(false);
  }, [move]);

  const send = useCallback(
    async (mine: number) => {
      const held = recording.current;
      recording.current = null;
      if (!held) return;
      move("sending");
      const controller = new AbortController();
      abort.current = controller;
      try {
        const audio = await held.finish();
        const text = await transcribe(audio, controller.signal);
        if (mine !== generation.current) return;
        callbacks.current.onListen(false);
        callbacks.current.onAsk(text);
      } catch (failure) {
        if (mine !== generation.current || controller.signal.aborted) return;
        setError(plainMessage(failure));
        callbacks.current.onListen(false);
      } finally {
        if (mine === generation.current) move("idle");
      }
    },
    [move, transcribe],
  );

  const press = useCallback(async () => {
    if (phaseRef.current !== "idle") return;
    const mine = ++generation.current;
    droppedEarly.current = false;
    pressedAt.current = Date.now();
    setError(null);
    hush();
    move("starting");
    callbacks.current.onListen(true);
    try {
      const started = await record((failure) => {
        if (mine !== generation.current) return;
        recording.current = null;
        setError(plainMessage(failure));
        move("idle");
        callbacks.current.onListen(false);
      });
      if (mine !== generation.current) {
        started.cancel();
        return;
      }
      recording.current = started;
      if (droppedEarly.current) {
        drop();
        return;
      }
      move("recording");
    } catch (failure) {
      if (mine !== generation.current) return;
      setError(plainMessage(failure));
      move("idle");
      callbacks.current.onListen(false);
    }
  }, [drop, move, record]);

  const release = useCallback(async () => {
    const releasedAt = Date.now();
    if (phaseRef.current === "starting") {
      droppedEarly.current = true;
      return;
    }
    if (phaseRef.current !== "recording") return;
    if (releasedAt - pressedAt.current < minHoldMs) {
      generation.current += 1;
      drop();
      return;
    }
    await send(generation.current);
  }, [drop, minHoldMs, send]);

  /** The press was cancelled (by the system, not let go): nothing is asked. */
  const cancel = useCallback(() => {
    if (phaseRef.current === "starting") {
      droppedEarly.current = true;
      return;
    }
    if (phaseRef.current !== "recording") return;
    generation.current += 1;
    drop();
  }, [drop]);

  // Leaving the window while holding (another app, a dialog) is letting go.
  const holding = phase === "starting" || phase === "recording";
  useEffect(() => {
    if (!holding) return;
    const onBlur = () => void release();
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [holding, release]);

  // Unmounted mid-recording: drop the microphone and anything in flight, and stop listening.
  useEffect(
    () => () => {
      const wasActive = phaseRef.current !== "idle";
      generation.current += 1;
      recording.current?.cancel();
      recording.current = null;
      abort.current?.abort();
      if (wasActive) callbacks.current.onListen(false);
    },
    [],
  );

  return {
    phase,
    error,
    press,
    release,
    cancel,
    clearError: () => setError(null),
  };
}
