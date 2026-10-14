import { useCallback, useEffect, useRef, useState } from "react";
import {
  type Recording,
  startRecording,
  transcribeRecording,
} from "@/lib/dictation/recording";
import { i18n } from "@/lib/i18n";

/**
 * Press and hold to talk to Clicky; release to send.
 *
 * Bluey's gesture, on the dictation recorder the composer already uses (`lib/dictation/recording.ts`:
 * MediaRecorder, then `POST /api/audio/transcriptions`). Pressing tells Clicky it is being listened
 * to (`listen: true`, so the phone and the viewer both say "Listening") and starts recording;
 * releasing stops, transcribes, tells Clicky the listening is over and asks with the words.
 *
 * A TAP IS NOT A QUESTION. Released within a quarter of a second, nothing is sent to be transcribed:
 * the recording is thrown away and only `listen: false` goes out, so a stray click on the microphone
 * costs nothing and asks nothing. A release that comes while the microphone is still being opened
 * is honoured as soon as it opens.
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
  const released = useRef(false);
  /** Bumped by every press and by unmounting, so a late answer for an old press is dropped. */
  const generation = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const callbacks = useRef({ onListen, onAsk });
  callbacks.current = { onListen, onAsk };

  const move = useCallback((next: HoldToTalkPhase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const finish = useCallback(
    async (mine: number) => {
      const held = recording.current;
      recording.current = null;
      if (!held) return;
      if (Date.now() - pressedAt.current < minHoldMs) {
        held.cancel();
        move("idle");
        callbacks.current.onListen(false);
        return;
      }
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
    [minHoldMs, move, transcribe],
  );

  const press = useCallback(async () => {
    if (phaseRef.current !== "idle") return;
    const mine = ++generation.current;
    released.current = false;
    pressedAt.current = Date.now();
    setError(null);
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
      move("recording");
      if (released.current) await finish(mine);
    } catch (failure) {
      if (mine !== generation.current) return;
      setError(plainMessage(failure));
      move("idle");
      callbacks.current.onListen(false);
    }
  }, [finish, move, record]);

  const release = useCallback(async () => {
    if (phaseRef.current === "starting") {
      // The microphone is still opening: let go is remembered and honoured when it opens.
      released.current = true;
      return;
    }
    if (phaseRef.current !== "recording") return;
    released.current = true;
    await finish(generation.current);
  }, [finish]);

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
    clearError: () => setError(null),
  };
}
