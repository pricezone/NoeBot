import { useEffect, useRef, useState } from "react";
import { nowSeconds } from "./clock";
import {
  type DirectorState,
  INITIAL_DIRECTOR,
  type RunSignal,
  reduceDirector,
} from "./director";

/**
 * The director, driven: the first state is computed on the spot (a turn that is running shows its
 * indicator on the first paint, not a tick later), then the machine steps every 200 ms while there
 * is anything to show, and whenever a signal changes.
 */
export function useAvatarDirector(signal: RunSignal): DirectorState {
  const latest = useRef(signal);
  latest.current = signal;
  const [state, setState] = useState<DirectorState>(() =>
    reduceDirector(INITIAL_DIRECTOR, signal, nowSeconds()),
  );
  const running = signal.busy || signal.stopped !== null || state.visible;
  const key = `${signal.busy}|${signal.waitingOnFirstToken}|${signal.runningTool ?? ""}|${signal.browsing}|${signal.streaming}|${signal.stopped ?? ""}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a changed signal steps the machine at once, so the key is a dependency on purpose
  useEffect(() => {
    const step = () =>
      setState((s) => reduceDirector(s, latest.current, nowSeconds()));
    step();
    if (!running) return undefined;
    const id = window.setInterval(step, 200);
    return () => window.clearInterval(id);
  }, [running, key]);
  return state;
}
