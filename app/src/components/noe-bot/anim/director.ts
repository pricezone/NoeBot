/**
 * The chat indicator's state machine (avatar-map.json §4), as a pure reducer over time.
 *
 * Fed what the conversation and the run can say — busy, waiting on the first token, which tool is
 * in flight, whether text is streaming, the person's last words, how the turn stopped — it decides
 * the phase, the animation for it and the label beside it, with the design's timing rules: a tone
 * reaction for 600 ms, thinking goes pensive after 4 s, every animation shows for at least 1.2 s,
 * tool flicker is debounced, a loop that runs past 12 s alternates with a breather and past 30 s
 * the bot is over-caffeinated, and a finished turn ends on a check badge and a smile.
 */

import { type AnimationId, type Lang, labelFor } from "./catalog";
import { classifyIntent, type Intent, languageOf, reactionFor } from "./intent";
import { TIMING } from "./rules";
import { animationForTool } from "./tool-map";

export type Phase =
  | "idle"
  | "thinking"
  | "working"
  | "streaming"
  | "waiting"
  | "done"
  | "error";

export type RunSignal = {
  busy: boolean;
  waitingOnFirstToken: boolean;
  /** The tool call in flight, by name; null when none. */
  runningTool: string | null;
  /** A browser step group is the last thing in the transcript while the turn runs. */
  browsing: boolean;
  /** Assistant text is the last thing in the transcript while the turn runs. */
  streaming: boolean;
  /** The person's last message this turn, for intent, tone and language. */
  pendingText: string | null;
  /** The reason the turn ended without an answer, when it did. */
  stopped: string | null;
};

export type DirectorState = {
  phase: Phase;
  animation: AnimationId;
  label: string;
  lang: Lang;
  visible: boolean;
  turnStartedAt: number | null;
  phaseSince: number;
  shownSince: number;
  candidate: { id: AnimationId; since: number } | null;
  workingId: AnimationId | null;
  workingSince: number | null;
  intent: Intent | null;
  reaction: AnimationId;
  /** The tool the machine believes in: a new name counts once it has stayed for the debounce. */
  stableTool: string | null;
  toolCandidate: { name: string | null; since: number } | null;
};

export const INITIAL_DIRECTOR: DirectorState = {
  phase: "idle",
  animation: "face:neutral",
  label: "",
  lang: "en",
  visible: false,
  turnStartedAt: null,
  phaseSince: 0,
  shownSince: 0,
  candidate: null,
  workingId: null,
  workingSince: null,
  intent: null,
  reaction: "face:attentive",
  stableTool: null,
  toolCandidate: null,
};

const MIN_S = TIMING.minDisplayMs / 1000;
const REACTION_S = TIMING.reactionMs / 1000;
const DEBOUNCE_S = TIMING.debounceMs / 1000;
const LONG_LOOP_S = TIMING.maxSameLoopBeforeSwitchMs / 1000;
const PENSIVE_AFTER_S = 4;
const CAFFEINATED_AFTER_S = 30;
const DONE_STEP_S = 1.2;
const ERROR_SHOWN_S = 3;

const ACTIVE: ReadonlySet<Phase> = new Set([
  "thinking",
  "working",
  "streaming",
  "waiting",
]);

/** How the turn ended → the outcome sequence (§4.5). */
export const outcomeFor = (reason: string): readonly AnimationId[] => {
  const r = reason.toLowerCase();
  if (
    /network|connection|offline|econn|unreachable|fetch failed|socket/.test(r)
  )
    return ["state:unplugged"];
  if (/timeout|timed out|rate limit|too many|429|overloaded/.test(r))
    return ["face:weary", "face:sleepy"];
  if (/refus|cannot help|can't help|not allowed|policy|declin/.test(r))
    return ["face:sad"];
  if (/stopped|cancel|abort|interrupt/.test(r))
    return ["face:unimpressed", "face:neutral"];
  return ["face:dizzy"];
};

const desiredPhase = (state: DirectorState, signal: RunSignal): Phase => {
  if (signal.stopped) return "error";
  if (!signal.busy)
    return ACTIVE.has(state.phase) || state.phase === "done" ? "done" : "idle";
  if (signal.runningTool && animationForTool(signal.runningTool) === "waiting")
    return "waiting";
  if (signal.runningTool || signal.browsing) return "working";
  if (signal.streaming) return "streaming";
  return "thinking";
};

const workingAnimation = (
  signal: RunSignal,
  intent: Intent | null,
): AnimationId => {
  if (signal.runningTool) {
    const verdict = animationForTool(signal.runningTool);
    if (verdict !== "waiting") return verdict;
  }
  if (signal.browsing) return "action:search";
  const action = intent?.sequence.find(
    (id) => id.startsWith("action:") || id.startsWith("state:"),
  );
  return action ?? "action:type";
};

const desiredAnimation = (
  state: DirectorState,
  signal: RunSignal,
  now: number,
  phase: Phase,
): AnimationId => {
  switch (phase) {
    case "idle":
      return "face:neutral";
    case "thinking": {
      const sinceTurn = now - (state.turnStartedAt ?? now);
      if (sinceTurn < REACTION_S) return state.reaction;
      const sincePhase = now - state.phaseSince;
      const step = Math.floor(sincePhase / MIN_S);
      const seq = state.intent?.sequence;
      if (seq && step < seq.length) return seq[step] ?? "face:curious";
      return sincePhase > PENSIVE_AFTER_S + (seq ? seq.length * MIN_S : 0)
        ? "face:pensive"
        : "face:curious";
    }
    case "working": {
      const id = workingAnimation(signal, state.intent);
      if (state.workingId !== id || state.workingSince === null) return id;
      const elapsed = now - state.workingSince;
      if (elapsed > CAFFEINATED_AFTER_S) return "state:caffeinated";
      if (elapsed > LONG_LOOP_S) {
        const slot = Math.floor((elapsed - LONG_LOOP_S) / 6);
        if (slot % 2 === 0)
          return slot % 4 === 0 ? "face:pensive" : "action:coffee";
      }
      return id;
    }
    case "streaming":
      return "action:type";
    case "waiting":
      return "face:pleading";
    case "done": {
      const elapsed = now - state.phaseSince;
      return elapsed < DONE_STEP_S ? "state:success" : "face:happy";
    }
    case "error": {
      const seq = outcomeFor(signal.stopped ?? "");
      const elapsed = now - state.phaseSince;
      return (
        seq[Math.min(seq.length - 1, Math.floor(elapsed / MIN_S))] ??
        "face:dizzy"
      );
    }
  }
};

const labelOf = (phase: Phase, animation: AnimationId, lang: Lang): string => {
  switch (phase) {
    case "idle":
      return "";
    case "thinking":
      return labelFor("phase:thinking", lang) ?? "Thinking";
    case "working":
      return (
        labelFor(animation, lang) ??
        labelFor("phase:working", lang) ??
        "Working…"
      );
    case "streaming":
      return labelFor("phase:streaming", lang) ?? "Replying…";
    case "waiting":
      return labelFor("phase:waiting", lang) ?? "Waiting for you";
    case "done":
      return labelFor("phase:done", lang) ?? "Done";
    case "error":
      return labelFor(animation, lang) ?? "";
  }
};

/** One step of the machine: the state for `raw` at time `now` (seconds). */
export const reduceDirector = (
  state: DirectorState,
  raw: RunSignal,
  now: number,
): DirectorState => {
  let next = state;
  // Tool flicker is debounced: a tool name has to stay for the debounce before it is believed,
  // except the first thing a turn shows, which should not wait.
  const toolCandidate =
    state.toolCandidate && state.toolCandidate.name === raw.runningTool
      ? state.toolCandidate
      : { name: raw.runningTool, since: now };
  const believed =
    !state.visible || now - toolCandidate.since >= DEBOUNCE_S
      ? raw.runningTool
      : state.stableTool;
  next = { ...next, toolCandidate, stableTool: believed };
  const signal: RunSignal = { ...raw, runningTool: believed };
  const phase = desiredPhase(state, signal);

  // A new turn: read the person's words once for intent, tone and language.
  if (
    phase !== "idle" &&
    phase !== "done" &&
    phase !== "error" &&
    state.turnStartedAt === null
  ) {
    const text = signal.pendingText ?? "";
    next = {
      ...next,
      turnStartedAt: now,
      intent: classifyIntent(text),
      reaction: reactionFor(text).face,
      lang: languageOf(text),
    };
  }

  if (phase !== next.phase) {
    next = { ...next, phase, phaseSince: now };
    if (phase === "idle") {
      next = {
        ...next,
        turnStartedAt: null,
        workingId: null,
        workingSince: null,
        candidate: null,
        stableTool: null,
        toolCandidate: null,
      };
    }
  }

  // Done and error run their course, then the indicator leaves.
  if (phase === "done" && now - next.phaseSince >= DONE_STEP_S * 2) {
    return { ...INITIAL_DIRECTOR, lang: next.lang };
  }
  if (phase === "error" && now - next.phaseSince >= ERROR_SHOWN_S) {
    return {
      ...INITIAL_DIRECTOR,
      phase: "error",
      visible: false,
      lang: next.lang,
      phaseSince: next.phaseSince,
    };
  }
  if (phase === "idle") {
    return next.visible || next.animation !== "face:neutral"
      ? { ...INITIAL_DIRECTOR, lang: next.lang }
      : next;
  }

  const desired = desiredAnimation(next, signal, now, phase);
  if (desired !== next.animation) {
    // Every animation shows for at least the minimum display time; the next one waits its turn.
    const shownLongEnough = !next.visible || now - next.shownSince >= MIN_S;
    if (shownLongEnough) {
      next = { ...next, animation: desired, shownSince: now, candidate: null };
      const loops =
        phase === "working" &&
        (desired.startsWith("action:") || desired.startsWith("state:")) &&
        desired !== "state:caffeinated" &&
        desired !== "action:coffee";
      if (loops && next.workingId !== desired) {
        next = { ...next, workingId: desired, workingSince: now };
      }
    } else {
      next = {
        ...next,
        candidate: {
          id: desired,
          since: next.candidate?.id === desired ? next.candidate.since : now,
        },
      };
    }
  }

  const label = labelOf(phase, next.animation, next.lang);
  if (next.label !== label || !next.visible) {
    next = { ...next, label, visible: true };
  }
  return next;
};
