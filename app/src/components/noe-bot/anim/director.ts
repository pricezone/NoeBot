/**
 * The chat indicator's state machine (avatar-map.json §4), as a pure reducer over time.
 *
 * Fed what the conversation and the run can say — busy, waiting on the first token, which tool is
 * in flight, which browser step came last, whether text is streaming, the person's last words, how
 * the turn stopped — it decides the phase, the animation for it and the label beside it, with the
 * design's timing rules: a tone reaction for 600 ms, thinking goes pensive after 4 s, every
 * animation shows for at least 1.2 s (a browser step 0.8 s), flicker is debounced, a loop that runs
 * past 12 s alternates with a partner loop or a breather and past 30 s the bot is over-caffeinated,
 * and a turn that ends with an answer ends on a check badge and a smile.
 *
 * NO RANDOMNESS. Variety comes from what the Bot does (each kind of browser step has its own loop)
 * and from counters (how many steps of a kind came before, how many 6 s slots a step has run), so
 * the same inputs at the same times always draw the same thing.
 */

import { type AnimationId, type Lang, labelFor } from "./catalog";
import { classifyIntent, type Intent, languageOf, reactionFor } from "./intent";
import { TIMING } from "./rules";
import {
  animationForTool,
  type BrowserLook,
  browserLookFor,
  isAskTool,
  toolIsKnown,
} from "./tool-map";

export type Phase =
  | "idle"
  | "thinking"
  | "working"
  | "streaming"
  | "waiting"
  | "done"
  | "error";

/** One browser call of the turn (a `computer_*` step, sign-in requests included). */
export type BrowserStep = {
  /** The call's id: a new id is a new step. */
  id: string;
  tool: string;
  /** No result yet. */
  running: boolean;
  /** The result says it worked (`ok: true`). */
  ok: boolean;
};

export type RunSignal = {
  busy: boolean;
  waitingOnFirstToken: boolean;
  /** The tool call in flight, by name; null when none. */
  runningTool: string | null;
  /** A browser step is the last thing in the transcript while the turn runs. */
  browsing: boolean;
  /** This turn's browser steps so far, newest last (the transcript passes the last few). */
  browserSteps: readonly BrowserStep[];
  /** Assistant text is the last thing in the transcript while the turn runs. */
  streaming: boolean;
  /** The Bot's own answer (its words, or an interface it drew) is the last thing in the transcript. */
  replied: boolean;
  /** The person's last message this turn, for intent, tone and language. */
  pendingText: string | null;
  /** The reason the turn ended without an answer, when it did. */
  stopped: string | null;
};

/** What the machine believes is happening: the debounced part of a signal. */
type Focus = {
  runningTool: string | null;
  browsing: boolean;
  step: BrowserStep | null;
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
  /** How long the animation on screen holds before another may replace it. */
  shownMin: number;
  /** The label key of what is on screen, for the working phase. */
  labelKey: string;
  candidate: { id: AnimationId; since: number } | null;
  /** The sub-task being drawn (a step, a tool) and since when: a new one restarts the long clock. */
  workKey: string | null;
  workSince: number | null;
  intent: Intent | null;
  reaction: AnimationId;
  /** A change of focus counts once it has stayed for the debounce. */
  focus: Focus;
  focusCandidate: { key: string; since: number } | null;
  /** The turn's browser steps in the order first seen, with when, for streaks and repeats. */
  seenSteps: readonly { id: string; tool: string; at: number }[];
};

const NO_FOCUS: Focus = { runningTool: null, browsing: false, step: null };

export const INITIAL_DIRECTOR: DirectorState = {
  phase: "idle",
  animation: "face:original",
  label: "",
  lang: "en",
  visible: false,
  turnStartedAt: null,
  phaseSince: 0,
  shownSince: 0,
  shownMin: 0,
  labelKey: "",
  candidate: null,
  workKey: null,
  workSince: null,
  intent: null,
  reaction: "face:attentive",
  focus: NO_FOCUS,
  focusCandidate: null,
  seenSteps: [],
};

const MIN_S = TIMING.minDisplayMs / 1000;
const BROWSER_MIN_S = TIMING.browserMinDisplayMs / 1000;
const REACTION_S = TIMING.reactionMs / 1000;
const DEBOUNCE_S = TIMING.debounceMs / 1000;
const LONG_LOOP_S = TIMING.maxSameLoopBeforeSwitchMs / 1000;
const PENSIVE_AFTER_S = 4;
const CAFFEINATED_AFTER_S = 30;
const ALTERNATE_EVERY_S = 6;
const DONE_STEP_S = 1.2;
const ERROR_SHOWN_S = 3;
/** The burst after a person hands the browser back. */
const HANDBACK_S = 1.5;
/** A question asked mid-browsing shows the screen before it pleads. */
const ASK_PRESENT_S = 3;
/** This many writes into a page within the window is filling a form. */
const STREAK_STEPS = 3;
const STREAK_WINDOW_S = 30;
const SEEN_KEPT = 64;

const ACTIVE: ReadonlySet<Phase> = new Set([
  "thinking",
  "working",
  "streaming",
  "waiting",
]);

/**
 * Two loops that suit the same work. A long step takes turns between them instead of a breather,
 * and the second of two like browser steps starts on the partner. `label` renames the step while
 * the partner shows; without it the step keeps its own name.
 */
const PAIRS: Readonly<
  Record<string, { with: AnimationId; after: number; label?: string }>
> = {
  "action:search": { with: "action:detective", after: LONG_LOOP_S },
  "action:detective": { with: "action:search", after: LONG_LOOP_S },
  "face:nerd": { with: "action:study", after: LONG_LOOP_S },
  "action:study": { with: "face:nerd", after: LONG_LOOP_S },
  "action:type": { with: "action:turbo", after: LONG_LOOP_S },
  "action:turbo": { with: "action:type", after: LONG_LOOP_S },
  // A command that runs on is working the machine: the server rack from 10 s.
  "action:terminal": { with: "state:servers", after: 10, label: "step:server" },
  "state:servers": { with: "action:terminal", after: LONG_LOOP_S },
};

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
    return ["face:unimpressed", "face:original"];
  return ["face:dizzy"];
};

const focusOf = (signal: RunSignal): Focus => ({
  runningTool: signal.runningTool,
  browsing: signal.browsing,
  step: signal.browsing ? (signal.browserSteps.at(-1) ?? null) : null,
});

const focusKey = (f: Focus): string =>
  `${f.runningTool ?? ""}|${
    f.step
      ? `${f.step.id}:${f.step.running}:${f.step.ok}`
      : f.browsing
        ? "browsing"
        : ""
  }`;

const desiredPhase = (state: DirectorState, signal: RunSignal): Phase => {
  if (signal.stopped) return "error";
  if (!signal.busy) {
    if (state.phase === "done") return "done";
    // Only an answer earns the check: a turn that ended on a tool result said nothing, and the
    // indicator leaves without claiming it succeeded.
    return ACTIVE.has(state.phase) && signal.replied ? "done" : "idle";
  }
  if (signal.runningTool && animationForTool(signal.runningTool) === "waiting")
    return "waiting";
  if (signal.runningTool || signal.browsing) return "working";
  if (signal.streaming) return "streaming";
  return "thinking";
};

/** What the working phase draws: the sub-task, its loop, its label and how long it holds. */
type Work = {
  key: string;
  base: AnimationId;
  label: string;
  min: number;
  /** A hand-back: the burst for its moment, then this. */
  after?: AnimationId;
};

/** Whether `id` is the third write (or later) into the page within the streak window. */
const inStreak = (seen: DirectorState["seenSteps"], id: string): boolean => {
  const own = seen.find((s) => s.id === id);
  if (!own) return false;
  const writes = seen.filter(
    (s) =>
      s.at <= own.at &&
      s.at >= own.at - STREAK_WINDOW_S &&
      browserLookFor(s.tool)?.writes,
  );
  return writes.length >= STREAK_STEPS;
};

/** How many steps that look like `look` came before `id` this turn. */
const repeatsBefore = (
  seen: DirectorState["seenSteps"],
  id: string,
  look: BrowserLook,
): number => {
  const at = seen.findIndex((s) => s.id === id);
  return seen
    .slice(0, at < 0 ? seen.length : at)
    .filter((s) => browserLookFor(s.tool) === look).length;
};

const browserWork = (state: DirectorState, step: BrowserStep): Work => {
  const key = `step:${step.id}`;
  const look = browserLookFor(step.tool);
  if (!look)
    return {
      key,
      base: "action:search",
      label: "phase:working",
      min: BROWSER_MIN_S,
    };
  if (look.handback) {
    // The person signed in or gave the code, and the Bot carries on: a burst of energy, held.
    return step.ok && !step.running
      ? {
          key,
          base: look.animation,
          label: look.label,
          min: HANDBACK_S,
          after: "action:search",
        }
      : { key, base: "face:pensive", label: "phase:working", min: MIN_S };
  }
  if (
    look.writes &&
    look.animation !== "action:turbo" &&
    inStreak(state.seenSteps, step.id)
  )
    return {
      key,
      base: "action:turbo",
      label: "action:turbo",
      min: BROWSER_MIN_S,
    };
  const partner = PAIRS[look.animation]?.with;
  const base =
    look.varies &&
    partner &&
    repeatsBefore(state.seenSteps, step.id, look) % 2 === 1
      ? partner
      : look.animation;
  return { key, base, label: look.label, min: BROWSER_MIN_S };
};

const workOf = (state: DirectorState, focus: Focus): Work => {
  if (focus.browsing && focus.step) return browserWork(state, focus.step);
  if (focus.browsing)
    return {
      key: "browsing",
      base: "action:search",
      label: "action:search",
      min: BROWSER_MIN_S,
    };
  const tool = focus.runningTool;
  if (tool) {
    const look = browserLookFor(tool);
    if (look && !look.handback)
      return {
        key: `tool:${tool}`,
        base: look.animation,
        label: look.label,
        min: BROWSER_MIN_S,
      };
    const verdict = animationForTool(tool);
    if (verdict !== "waiting")
      return {
        key: `tool:${tool}`,
        base: verdict,
        // An unknown tool is drawn typing, but its label must not claim "Writing code…" for a step
        // that is nothing of the kind (a connector's tool, a server tool): it says "Working…".
        label: toolIsKnown(tool) ? verdict : "phase:working",
        min: MIN_S,
      };
  }
  const action =
    state.intent?.sequence.find(
      (id) => id.startsWith("action:") || id.startsWith("state:"),
    ) ?? "action:type";
  return {
    key: `intent:${action}`,
    base: action,
    label: "phase:working",
    min: MIN_S,
  };
};

/** One animation to show, the label key that goes with it and how long it holds once shown. */
type Look = { id: AnimationId; label: string; min: number };

const working = (state: DirectorState, work: Work, now: number): Look => {
  const elapsed = now - (state.workSince ?? now);
  const base = work.after && elapsed >= HANDBACK_S ? work.after : work.base;
  const min = base === work.base ? work.min : BROWSER_MIN_S;
  if (elapsed > CAFFEINATED_AFTER_S)
    return { id: "state:caffeinated", label: "state:caffeinated", min: MIN_S };
  const pair = PAIRS[base];
  if (pair) {
    // A long step takes turns with its partner every 6 s, the partner first.
    if (
      elapsed > pair.after &&
      Math.floor((elapsed - pair.after) / ALTERNATE_EVERY_S) % 2 === 0
    )
      return { id: pair.with, label: pair.label ?? work.label, min };
    return { id: base, label: work.label, min };
  }
  if (elapsed > LONG_LOOP_S) {
    const slot = Math.floor((elapsed - LONG_LOOP_S) / ALTERNATE_EVERY_S);
    if (slot % 2 === 0) {
      const id = slot % 4 === 0 ? "face:pensive" : "action:coffee";
      return { id, label: id, min: MIN_S };
    }
  }
  return { id: base, label: work.label, min };
};

const desiredLook = (
  state: DirectorState,
  signal: RunSignal,
  now: number,
  phase: Phase,
  work: Work | null,
): Look => {
  switch (phase) {
    case "idle":
      return { id: "face:original", label: "", min: MIN_S };
    case "thinking": {
      const label = "phase:thinking";
      const sinceTurn = now - (state.turnStartedAt ?? now);
      if (sinceTurn < REACTION_S)
        return { id: state.reaction, label, min: MIN_S };
      const sincePhase = now - state.phaseSince;
      const step = Math.floor(sincePhase / MIN_S);
      const seq = state.intent?.sequence;
      if (seq && step < seq.length)
        return { id: seq[step] ?? "face:curious", label, min: MIN_S };
      return {
        id:
          sincePhase > PENSIVE_AFTER_S + (seq ? seq.length * MIN_S : 0)
            ? "face:pensive"
            : "face:curious",
        label,
        min: MIN_S,
      };
    }
    case "working":
      return work
        ? working(state, work, now)
        : { id: "action:type", label: "phase:working", min: MIN_S };
    case "streaming":
      return { id: "action:type", label: "phase:streaming", min: MIN_S };
    case "waiting": {
      // A question asked mid-browsing comes with the screen in its card: present it, then plead.
      const asked =
        signal.runningTool !== null &&
        isAskTool(signal.runningTool) &&
        signal.browserSteps.length > 0;
      return asked && now - state.phaseSince < ASK_PRESENT_S
        ? { id: "action:present", label: "step:show-screen", min: MIN_S }
        : { id: "face:pleading", label: "phase:waiting", min: MIN_S };
    }
    case "done": {
      const elapsed = now - state.phaseSince;
      return {
        id: elapsed < DONE_STEP_S ? "state:success" : "face:happy",
        label: "phase:done",
        min: MIN_S,
      };
    }
    case "error": {
      const seq = outcomeFor(signal.stopped ?? "");
      const elapsed = now - state.phaseSince;
      const id =
        seq[Math.min(seq.length - 1, Math.floor(elapsed / MIN_S))] ??
        "face:dizzy";
      return { id, label: id, min: MIN_S };
    }
  }
};

const labelOf = (
  phase: Phase,
  animation: AnimationId,
  labelKey: string,
  lang: Lang,
): string => {
  switch (phase) {
    case "idle":
      return "";
    case "thinking":
      return labelFor("phase:thinking", lang) ?? "Thinking";
    case "working":
      // The name of what is on screen: an animation still held from thinking keeps "Thinking", so
      // a guess from the person's words never shows as a claim ("Writing code…").
      return (
        labelFor(labelKey, lang) ??
        labelFor("phase:working", lang) ??
        "Working…"
      );
    case "streaming":
      return labelFor("phase:streaming", lang) ?? "Replying…";
    case "waiting":
      return animation === "action:present"
        ? (labelFor("step:show-screen", lang) ?? "Showing you the screen…")
        : (labelFor("phase:waiting", lang) ?? "Waiting for you");
    case "done":
      return labelFor("phase:done", lang) ?? "Done";
    case "error":
      return labelFor(animation, lang) ?? "";
  }
};

/** Steps seen for the first time are stamped `now`; the log is the turn's, oldest first. */
const logSteps = (
  seen: DirectorState["seenSteps"],
  steps: readonly BrowserStep[],
  now: number,
): DirectorState["seenSteps"] => {
  const known = new Set(seen.map((s) => s.id));
  const added = steps
    .filter((s) => !known.has(s.id))
    .map((s) => ({ id: s.id, tool: s.tool, at: now }));
  return added.length ? [...seen, ...added].slice(-SEEN_KEPT) : seen;
};

/** One step of the machine: the state for `raw` at time `now` (seconds). */
export const reduceDirector = (
  state: DirectorState,
  raw: RunSignal,
  now: number,
): DirectorState => {
  let next = state;
  // Flicker is debounced: what the Bot is doing (the tool, the newest browser step and its result)
  // has to stay for the debounce before it is believed, except the first thing a turn shows,
  // which should not wait.
  const rawFocus = focusOf(raw);
  const key = focusKey(rawFocus);
  const focusCandidate =
    state.focusCandidate && state.focusCandidate.key === key
      ? state.focusCandidate
      : { key, since: now };
  const focus =
    !state.visible || now - focusCandidate.since >= DEBOUNCE_S
      ? rawFocus
      : state.focus;
  next = {
    ...next,
    focusCandidate,
    focus,
    seenSteps: raw.busy
      ? logSteps(state.seenSteps, raw.browserSteps, now)
      : state.seenSteps,
  };
  const signal: RunSignal = {
    ...raw,
    runningTool: focus.runningTool,
    browsing: focus.browsing,
  };
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
    next = { ...next, phase, phaseSince: now, workKey: null, workSince: null };
    if (phase === "idle") {
      next = {
        ...next,
        turnStartedAt: null,
        candidate: null,
        focus: NO_FOCUS,
        focusCandidate: null,
        seenSteps: [],
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
    return next.visible || next.animation !== "face:original"
      ? { ...INITIAL_DIRECTOR, lang: next.lang }
      : next;
  }

  // The working clock runs per sub-task: a new step or tool starts it again.
  const work = phase === "working" ? workOf(next, focus) : null;
  if (work && work.key !== next.workKey) {
    next = { ...next, workKey: work.key, workSince: now };
  }

  const desired = desiredLook(next, signal, now, phase, work);
  if (desired.id !== next.animation) {
    // Every animation shows for at least its minimum display time; the next one waits its turn.
    const shownLongEnough =
      !next.visible || now - next.shownSince >= next.shownMin;
    if (shownLongEnough) {
      next = {
        ...next,
        animation: desired.id,
        labelKey: desired.label,
        shownSince: now,
        shownMin: desired.min,
        candidate: null,
      };
    } else {
      next = {
        ...next,
        candidate: {
          id: desired.id,
          since: next.candidate?.id === desired.id ? next.candidate.since : now,
        },
      };
    }
  } else if (next.labelKey !== desired.label) {
    // The same loop for a different step (a web search, then a page opened) is renamed at once.
    next = { ...next, labelKey: desired.label };
  }

  const label = labelOf(phase, next.animation, next.labelKey, next.lang);
  if (next.label !== label || !next.visible) {
    next = { ...next, label, visible: true };
  }
  return next;
};
