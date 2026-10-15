import { useCallback, useEffect, useRef, useState } from "react";
import {
  latestComputerControl,
  useComputerControl,
} from "@/lib/computers/use-control";
import { lastActivityFor } from "@/lib/copilot/computer-activity";
import { queryClient } from "@/query-client";
import {
  CLICKY_HELP_REASON,
  type ClickySession,
  type ClickyState,
  type ClickyTriggerKind,
  currentStep,
} from "../../../../shared/clicky";
import { keepClickySession, sendClickyCommand } from "./mutations";
import { useClickySessionView } from "./use-clicky-session";

/**
 * "Show me how" and who holds the Bot's computer, in the full-window viewer.
 *
 * GUIDING THE PERSON, THE PERSON HOLDS THE COMPUTER (`useClickyAutoControl`). Showing somebody where
 * to click is no use if their click cannot reach the page, so while it is awake and guiding them, and
 * the Bot holds the computer, the viewer takes control for them, with Clicky's own reason
 * (`CLICKY_HELP_REASON`), which the server knows never to answer by opening Clicky as though the Bot
 * needed somebody. Never while it only narrates the Bot at work: watching takes nothing. Once per
 * session, however often the control poll (every two seconds) draws it again. Never for a secret or
 * a sign-in, which the person answers in the conversation's form while the Bot keeps its wheel. A
 * take that fails is tried again later, each wait twice the last, up to half a minute. What it took
 * it gives back when
 * Clicky sleeps or stops, when the walkthrough is done, and when the viewer closes, unless the person
 * switched on Keep control. Control the person took themselves, or the Bot's own request for help,
 * is theirs and is never handed back from here.
 *
 * OPENED WHILE THE BOT WORKS, IT NARRATES (`useClickyWatchOnOpen`). When the viewer opens and the Bot
 * reached its computer in the last ten seconds, or the turn this screen belongs to is still running,
 * Clicky is asked to `watch`: it points at what the Bot acts on and says what it does. Only over a
 * session that is asleep or idle on nobody's need; a person's walkthrough, a question in flight or
 * the Bot asking for help is never replaced by it. A question asked while narrating is the server's
 * to answer: the session turns to guiding the person, and the take above follows.
 */

/** Retries of a take that failed: two seconds, then twice as long each time, up to thirty. */
const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 30_000;

/** How recently the Bot must have used its computer for opening the screen to narrate it. */
export const CLICKY_WATCH_RECENT_MS = 10_000;

/** What deciding to take or give back control needs from the session. */
type Guidance = {
  id: string;
  /**
   * Awake, guiding the person (not narrating), with something on the screen to do: a step, or a
   * pointer or a box. An awake session with nothing drawn (narration just ended, a plain answer)
   * guides nobody, and takes nothing.
   */
  guiding: boolean;
  /** Asleep, stopped, or the walkthrough is done: what was taken to guide goes back. */
  ended: boolean;
  /**
   * The Bot waits on a form in the conversation (a secret, a sign-in), not on the screen: the person
   * answers there, and the Bot carries on at its own wheel.
   */
  inForm: boolean;
};

export function selectGuidance(session: ClickySession): Guidance {
  return {
    id: session.id,
    guiding:
      session.awake &&
      session.narrating !== true &&
      session.state === "guiding" &&
      (currentStep(session) !== null || session.overlays.length > 0),
    ended:
      !session.awake ||
      session.state === "stopped" ||
      (session.reply?.notice === "walkthrough_done" && !currentStep(session)),
    inForm:
      session.trigger?.kind === "secret" || session.trigger?.kind === "sign_in",
  };
}

type Latch = {
  sessionId: string;
  took: boolean;
  inFlight: boolean;
  failures: number;
  retryAt: number;
};

export function useClickyAutoControl(
  botId: string,
  enabled: boolean,
  keepControl: boolean,
): void {
  const view = useClickySessionView(botId, selectGuidance);
  const { control, busy, change } = useComputerControl(botId, enabled);
  const latch = useRef<Latch | null>(null);
  const [retry, setRetry] = useState(0);
  const changeRef = useRef(change);
  changeRef.current = change;
  const keepRef = useRef(keepControl);
  keepRef.current = keepControl;
  /** The last control drawn, for a release after the shared store has gone with the screen. */
  const controlRef = useRef(control);
  controlRef.current = control;

  /** Hands the computer back, if the person still holds it under Clicky's own reason. */
  const release = useCallback(() => {
    if (keepRef.current) return;
    /*
     * Asked of the store rather than of what was drawn, which may be a poll behind as the viewer
     * closes. (The server also hands it back when Clicky sleeps or stops, should this not get there.)
     */
    const now = latestComputerControl(botId) ?? controlRef.current;
    if (now?.holder !== "human" || now.request?.reason !== CLICKY_HELP_REASON)
      return;
    void changeRef.current?.("release");
  }, [botId]);

  /** Gives back what Clicky took, if it took anything. */
  const giveBack = useCallback(() => {
    const held = latch.current;
    latch.current = null;
    if (held?.took) release();
  }, [release]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `retry` is read by nothing inside; bumping it is what tries a failed take again.
  useEffect(() => {
    if (!enabled || !view) return;
    if (view.ended) {
      giveBack();
      return;
    }
    if (!view.guiding || view.inForm || !control || busy) return;
    if (
      control.holder !== "bot" ||
      control.transitioning ||
      control.secretWanted !== undefined
    )
      return;
    let held = latch.current;
    // One take at a time, whichever session asked for it.
    if (held?.inFlight) return;
    if (held && held.sessionId !== view.id) {
      latch.current = null;
      held = null;
    }
    if (held?.took) return;
    const wait = held ? held.retryAt - Date.now() : 0;
    if (wait > 0) {
      const timer = setTimeout(() => setRetry((count) => count + 1), wait);
      return () => clearTimeout(timer);
    }
    const failures = held?.failures ?? 0;
    const mine: Latch = {
      sessionId: view.id,
      took: false,
      inFlight: true,
      failures,
      retryAt: 0,
    };
    latch.current = mine;
    void change?.("take", { reason: CLICKY_HELP_REASON }).then((took) => {
      if (latch.current !== mine) {
        // Clicky slept, stopped or the viewer closed while the take was on its way: give it back.
        if (took) release();
        return;
      }
      if (took) {
        latch.current = { ...mine, took: true, inFlight: false };
        return;
      }
      latch.current = {
        ...mine,
        inFlight: false,
        failures: failures + 1,
        retryAt:
          Date.now() + Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** failures),
      };
      setRetry((count) => count + 1);
    });
  }, [enabled, view, control, busy, change, giveBack, release, retry]);

  /*
   * The viewer closing gives back what Clicky took for it. A moment after, so React's second mount
   * in development (StrictMode), straight after the first one's cleanup, does not count as closing.
   */
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Nothing taken or on its way: nothing to give back.
      if (!latch.current) return;
      setTimeout(() => {
        if (!mounted.current) giveBack();
      }, 0);
    };
  }, [giveBack]);
}

/** What deciding to narrate needs from the session. */
type Watchable = {
  awake: boolean;
  narrating: boolean;
  state: ClickyState;
  trigger: ClickyTriggerKind | null;
};

function selectWatchable(session: ClickySession): Watchable {
  return {
    awake: session.awake,
    narrating: session.narrating === true,
    state: session.state,
    trigger: session.trigger?.kind ?? null,
  };
}

/** Whether `watch` would only add narration, never replace something the person is in. */
export function mayWatch(view: Watchable): boolean {
  if (!view.awake) return true;
  if (view.narrating) return false;
  return (
    view.state === "idle" &&
    (view.trigger === null ||
      view.trigger === "person" ||
      view.trigger === "follow_up")
  );
}

export function useClickyWatchOnOpen(
  botId: string,
  enabled: boolean,
  /** The turn this screen belongs to is still running. */
  turnRunning: boolean,
): void {
  // Decided as the viewer opens, not later: this is about what was happening when it was opened.
  const [botAtWork] = useState(() => {
    const last = lastActivityFor(botId);
    return (
      turnRunning ||
      (last !== null && Date.now() - last <= CLICKY_WATCH_RECENT_MS)
    );
  });
  const view = useClickySessionView(botId, selectWatchable);
  const { control } = useComputerControl(botId, enabled);
  const decided = useRef(false);

  useEffect(() => {
    if (decided.current || !enabled || !view || !control) return;
    decided.current = true;
    if (!botAtWork || !mayWatch(view)) return;
    // The person drives, or the Bot is waiting on them: it is not working, there is nothing to narrate.
    if (
      control.holder === "human" ||
      control.requested ||
      control.secretWanted !== undefined
    )
      return;
    void sendClickyCommand(botId, { type: "watch" })
      .then((result) => keepClickySession(queryClient, botId, result.session))
      .catch(() => {
        // Narration is a courtesy; the screen is there either way.
      });
  }, [enabled, view, control, botAtWork, botId]);
}
