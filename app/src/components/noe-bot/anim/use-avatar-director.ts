import { useEffect, useRef, useState } from "react";
import { nowSeconds } from "./clock";
import {
  type DirectorState,
  INITIAL_DIRECTOR,
  type RunSignal,
  reduceDirector,
} from "./director";

/** What the indicator draws: the part of the machine's state a screen can see. */
export type DirectorView = Pick<
  DirectorState,
  "phase" | "animation" | "label" | "lang" | "visible"
>;

const viewOf = (state: DirectorState): DirectorView => ({
  phase: state.phase,
  animation: state.animation,
  label: state.label,
  lang: state.lang,
  visible: state.visible,
});

const sameView = (a: DirectorView, b: DirectorView) =>
  a.phase === b.phase &&
  a.animation === b.animation &&
  a.label === b.label &&
  a.lang === b.lang &&
  a.visible === b.visible;

/**
 * The director, driven: the first view is computed on the spot (a turn that is running shows its
 * indicator on the first paint, not a tick later), then the machine steps every 200 ms while there
 * is anything to show, and whenever a signal changes.
 *
 * THE MACHINE LIVES IN A REF AND ONLY THE VIEW IN STATE. Every step advances the machine (a tool
 * candidate's age, a hold's start), but only a step that changes what is drawn re-renders the
 * transcript it sits in; five re-renders a second of the whole conversation were starving slower
 * machines (and the transcript tests) for nothing to look at.
 */
export function useAvatarDirector(signal: RunSignal): DirectorView {
  const latest = useRef(signal);
  latest.current = signal;
  const machine = useRef<DirectorState | null>(null);
  if (machine.current === null) {
    machine.current = reduceDirector(INITIAL_DIRECTOR, signal, nowSeconds());
  }
  const [view, setView] = useState<DirectorView>(() =>
    viewOf(machine.current ?? INITIAL_DIRECTOR),
  );
  const running = signal.busy || signal.stopped !== null || view.visible;
  const step = signal.browserSteps.at(-1);
  const key = `${signal.busy}|${signal.waitingOnFirstToken}|${signal.runningTool ?? ""}|${signal.browsing}|${signal.browserSteps.length}:${step?.id ?? ""}:${step?.running}:${step?.ok}|${signal.streaming}|${signal.replied}|${signal.stopped ?? ""}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a changed signal steps the machine at once, so the key is a dependency on purpose
  useEffect(() => {
    const step = () => {
      const next = reduceDirector(
        machine.current ?? INITIAL_DIRECTOR,
        latest.current,
        nowSeconds(),
      );
      machine.current = next;
      const seen = viewOf(next);
      setView((previous) => (sameView(previous, seen) ? previous : seen));
    };
    step();
    if (!running) return undefined;
    const id = window.setInterval(step, 200);
    return () => window.clearInterval(id);
  }, [running, key]);
  return view;
}
