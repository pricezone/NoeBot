import {
  CLICKY_AUTO_STEP_LIMIT,
  CLICKY_PERSON_ONLY_TRIGGERS,
  CLICKY_NUDGE_AFTER_MS,
  CLICKY_PROPOSAL_TTL_MS,
  CLICKY_SESSION_GRANT_TTL_MS,
  CLICKY_TEXT_LIMIT,
  CLICKY_TRANSCRIPT_LIMIT,
  type ClickyAction,
  type ClickyCommand,
  type ClickyNotice,
  type ClickyOverlay,
  type ClickyPoint,
  type ClickyProposal,
  type ClickyRect,
  type ClickyRisk,
  type ClickySeen,
  type ClickySession,
  type ClickyState,
  type ClickyStep,
  type ClickyThinkReason,
  type ClickyWalkthrough,
  currentStep,
  hitsOverlay,
} from "./clicky";
import type { ClickyActionPolicy } from "./user-preferences";

/**
 * Clicky's state machine, as one pure function.
 *
 * Everything that changes a session goes through `reduceClicky`: a person's command, the model's
 * answer, an action finishing, the Bot's handover ending, the clock. It returns the next session and
 * the EFFECTS the server must carry out (ask the model, act, abort, write an audit row); it never does
 * any of them itself, so every rule here is testable without a network, a database or a computer.
 *
 * Three rules matter most:
 *
 * - **Stop wins.** `stop` is accepted from every state. It aborts whatever is running, drops any
 *   proposal and any "for this task" grant, and puts Clicky back in guide mode. Acting stays off until
 *   the person turns "Do it for me" on again.
 * - **Nothing acts without a yes.** An action runs only from `approve` on the exact, unexpired
 *   proposal that is waiting, or from the person's "Allow for this session", and that only covers
 *   low-risk actions: anything hard to undo is asked about every time. The model's proposal is rated by the server's guardrails before it arrives
 *   here; `yours` and `blocked` never become proposals at all, Clicky points instead.
 * - **Late answers are dropped.** A model answer or an action result counts only if it is for the
 *   call this session is still waiting on (`thinkId`, the proposal id), so Stop, a new question or
 *   sleep cannot be undone by something that was already in flight.
 */

export type ClickyAuditEvent =
  | "clicky.session_started"
  | "clicky.action_proposed"
  | "clicky.action_approved"
  | "clicky.action_denied"
  | "clicky.action_performed"
  | "clicky.action_failed"
  | "clicky.action_blocked"
  | "clicky.stopped"
  /** "Do it for me" switched on or off. */
  | "clicky.mode_changed";

/** What the Bot did, as narration names it. */
export type ClickyBotVerb =
  | "click"
  | "type"
  | "navigate"
  | "scroll"
  | "select"
  | "key"
  | "other";

/** The model's plan for a task, before it has ids. */
export type ClickyPlan = {
  goal: string;
  steps: {
    title: string;
    detail?: string;
    overlays: ClickyOverlay[];
    targetRef?: string;
  }[];
};

/** A proposal as the guardrails rated it, before it has an id and a lifetime. */
export type ClickyRatedAction = {
  action: ClickyAction;
  why: string;
  risk: ClickyRisk;
  riskReason?: string;
  /** What was at the action's place when it was rated; kept on the proposal. */
  seen?: ClickySeen;
};

export type ClickyEvent =
  | { type: "command"; command: ClickyCommand }
  | {
      type: "brain.reply";
      thinkId: string;
      say: string;
      /** A new walkthrough, replacing any earlier one. */
      plan?: ClickyPlan;
      /** Where to point now: the current step's overlays, or the answer's when there is no step. */
      overlays?: ClickyOverlay[];
      proposal?: ClickyRatedAction;
      /** The task is finished. */
      done?: boolean;
    }
  | { type: "brain.failed"; thinkId: string; detail?: string }
  | {
      type: "action.done";
      proposalId: string;
      /**
       * What was done, as the server found it just before doing it (the element's role and name,
       * the site, how many characters or which keys), for the audit row. Never the text typed.
       */
      detail?: Record<string, string | number | boolean | null>;
    }
  | { type: "action.failed"; proposalId: string; detail?: string }
  /** The person clicked on the computer's screen (from the live viewer). */
  | { type: "person.input"; at: ClickyPoint }
  | {
      type: "takeover.resolved";
      requestId: string;
      outcome: "completed" | "cancelled" | "expired";
    }
  | { type: "bot.finished"; summary: string }
  /** The Bot is acting on its computer; shown while Clicky is narrating. */
  | {
      type: "bot.action";
      verb: ClickyBotVerb;
      label?: string;
      host?: string;
      key?: string;
      /** Where the element is on the screen, when it is on it. */
      rect?: ClickyRect;
    }
  /** The person typed on the computer (Enter or Tab, or a burst of typing that has settled). */
  | { type: "person.typed" }
  /** The page changed under the person (a navigation, settled). */
  | { type: "page.changed"; url: string }
  /**
   * A look after the person or Clicky did something: whether the step the look was about is done,
   * and where things are now (`overlays` are for the step that is current once `stepDone` applies).
   */
  | {
      type: "brain.check";
      checkId: string;
      stepDone: boolean;
      overlays?: ClickyOverlay[];
      say?: string;
    }
  /** The clock. `lastInputAt` is the person's last input on the screen, kept outside the session. */
  | { type: "tick"; lastInputAt?: number }
  | { type: "notes.saved"; path: string };

export type ClickyEffect =
  | { type: "think"; thinkId: string; reason: ClickyThinkReason; text?: string }
  | { type: "cancel_think" }
  | {
      type: "act";
      proposal: ClickyProposal;
      /** Run on the person's "Allow for this session" rather than a yes for this proposal. */
      viaGrant?: boolean;
    }
  | { type: "abort_action" }
  /** Look at the screen again for the step `stepId` (or the answer's pointer when null). */
  | { type: "check"; checkId: string; stepId: string | null }
  | { type: "cancel_check" }
  | { type: "save_notes" }
  | {
      type: "audit";
      event: ClickyAuditEvent;
      detail: Record<string, string | number | boolean | null>;
    };

export type ClickyContext = {
  now: number;
  /** The person's "how far may Clicky go" setting. */
  actionPolicy: ClickyActionPolicy;
  /** A fresh unique id (proposals, steps, walkthroughs, model calls). */
  newId: () => string;
};

export type ClickyResult = {
  session: ClickySession;
  effects: ClickyEffect[];
  /** Whether anything changed; when false, `session` is the one passed in and nothing is sent. */
  changed: boolean;
  /** Why a command was refused, as a notice the client can show. */
  rejected?: ClickyNotice;
};

const unchanged = (session: ClickySession): ClickyResult => ({
  session,
  effects: [],
  changed: false,
});

const refuse = (
  session: ClickySession,
  notice: ClickyNotice,
): ClickyResult => ({
  session,
  effects: [],
  changed: false,
  rejected: notice,
});

export function reduceClicky(
  session: ClickySession,
  event: ClickyEvent,
  context: ClickyContext,
): ClickyResult {
  const result =
    event.type === "command"
      ? reduceCommand(session, event.command, context)
      : reduceInternal(session, event, context);
  if (!result.changed) return result;
  const at = new Date(context.now).toISOString();
  return {
    ...result,
    session: { ...result.session, seq: session.seq + 1, updatedAt: at },
  };
}

type Draft = { session: ClickySession; effects: ClickyEffect[] };

const changed = (draft: Draft): ClickyResult => ({ ...draft, changed: true });

function iso(context: ClickyContext, offset = 0): string {
  return new Date(context.now + offset).toISOString();
}

function notice(notice: ClickyNotice, text = ""): ClickySession["reply"] {
  return { text, final: true, notice };
}

function appendTurn(
  session: ClickySession,
  role: "person" | "clicky",
  text: string,
  context: ClickyContext,
): ClickySession["transcript"] {
  const trimmed = text.trim().slice(0, CLICKY_TEXT_LIMIT);
  if (!trimmed) return session.transcript;
  return [
    ...session.transcript,
    { role, text: trimmed, at: iso(context) },
  ].slice(-CLICKY_TRANSCRIPT_LIMIT);
}

/** Stops whatever is in flight: the model call, the look after a step, and the action. */
function stopInFlight(session: ClickySession): ClickyEffect[] {
  const effects: ClickyEffect[] = [];
  if (session.state === "thinking" && session.thinkId)
    effects.push({ type: "cancel_think" });
  if (session.check) effects.push({ type: "cancel_check" });
  if (session.state === "acting") effects.push({ type: "abort_action" });
  return effects;
}

/** Fields that put a look after a step away. */
const NO_CHECK = { check: null, overlaysStale: false } as const;

/** Where Clicky rests when it is not doing anything: on the walkthrough if there is one. */
function restingState(session: ClickySession): ClickyState {
  if (!session.awake) return "idle";
  if (session.narrating) return "guiding";
  if (currentStep(session) || session.overlays.length > 0) return "guiding";
  return "idle";
}

/**
 * Looks at the screen again, without leaving `guiding`: Next, Back and the person's clicks keep
 * working while it runs, and its answer counts only if it is still the look being waited for and the
 * step it was about is still the current one. A look never proposes an action.
 */
function startCheck(session: ClickySession, context: ClickyContext): Draft {
  const effects: ClickyEffect[] = session.check
    ? [{ type: "cancel_check" }]
    : [];
  const id = context.newId();
  const stepId = currentStep(session)?.id ?? null;
  effects.push({ type: "check", checkId: id, stepId });
  return {
    session: { ...session, check: { id, stepId }, overlaysStale: true },
    effects,
  };
}

/** Whether a look after a step makes sense now: guiding the person, with something on screen. */
function mayCheck(session: ClickySession): boolean {
  return (
    session.awake &&
    !session.narrating &&
    session.state === "guiding" &&
    (currentStep(session) !== null || session.overlays.length > 0)
  );
}

function startThinking(
  session: ClickySession,
  reason: ClickyThinkReason,
  context: ClickyContext,
  text?: string,
): Draft {
  const effects: ClickyEffect[] =
    session.state === "thinking" && session.thinkId
      ? [{ type: "cancel_think" }]
      : [];
  const thinkId = context.newId();
  effects.push({ type: "think", thinkId, reason, ...(text ? { text } : {}) });
  return {
    session: {
      ...session,
      state: "thinking",
      resumeState: null,
      thinkId,
      lastThink: { reason, ...(text ? { text } : {}) },
      error: null,
    },
    effects,
  };
}

function wakeAudit(session: ClickySession, reason: string): ClickyEffect[] {
  return session.awake
    ? []
    : [
        {
          type: "audit",
          event: "clicky.session_started",
          detail: { botId: session.botId, reason },
        },
      ];
}

function modeAudit(
  mode: ClickySession["mode"],
  session: ClickySession,
): ClickyEffect {
  return {
    type: "audit",
    event: "clicky.mode_changed",
    detail: { botId: session.botId, mode, from: session.mode },
  };
}

function grantActive(session: ClickySession, context: ClickyContext): boolean {
  const grant = session.grant;
  if (grant?.scope !== "session") return false;
  return Date.parse(grant.expiresAt) > context.now;
}

/** A pointer at where an action would happen, so the person can do it themselves. */
function pointerFor(
  action: ClickyAction,
  context: ClickyContext,
): ClickyOverlay[] {
  if (action.kind === "key" || !action.at) return [];
  return [
    {
      kind: "pointer",
      id: context.newId(),
      at: action.at,
      label: action.label,
    },
  ];
}

/** Marks the current step done and moves to the next pending one. */
function advance(
  session: ClickySession,
  context: ClickyContext,
): { session: ClickySession; finished: boolean } {
  const walkthrough = session.walkthrough;
  if (!walkthrough?.currentStepId) return { session, finished: false };
  const index = walkthrough.steps.findIndex(
    (step) => step.id === walkthrough.currentStepId,
  );
  const steps = walkthrough.steps.map(
    (step, position): ClickyStep =>
      position === index ? { ...step, status: "done" } : step,
  );
  const nextIndex = steps.findIndex(
    (step, position) => position > index && step.status === "pending",
  );
  const next: ClickyWalkthrough = {
    ...walkthrough,
    steps:
      nextIndex === -1
        ? steps
        : steps.map((step, position) =>
            position === nextIndex ? { ...step, status: "current" } : step,
          ),
    currentStepId: nextIndex === -1 ? null : (steps[nextIndex]?.id ?? null),
    updatedAt: iso(context),
  };
  return {
    session: {
      ...session,
      walkthrough: next,
      lastProgressAt: iso(context),
      nudgedAt: null,
    },
    finished: nextIndex === -1,
  };
}

/** After a walkthrough's last step. The session's grant outlives it, as the session goes on. */
function finishWalkthrough(session: ClickySession): ClickySession {
  return {
    ...session,
    ...NO_CHECK,
    overlays: [],
    reply: notice("walkthrough_done"),
  };
}

function buildWalkthrough(
  plan: ClickyPlan,
  context: ClickyContext,
): ClickyWalkthrough {
  const steps: ClickyStep[] = plan.steps.map((step, index) => ({
    id: context.newId(),
    title: step.title,
    ...(step.detail ? { detail: step.detail } : {}),
    status: index === 0 ? "current" : "pending",
    overlays: step.overlays,
    ...(step.targetRef ? { targetRef: step.targetRef } : {}),
  }));
  return {
    id: context.newId(),
    goal: plan.goal,
    steps,
    currentStepId: steps[0]?.id ?? null,
    startedAt: iso(context),
    updatedAt: iso(context),
  };
}

/** Puts overlays on the current step, or on the session when there is no step. */
function placeOverlays(
  session: ClickySession,
  overlays: ClickyOverlay[],
): ClickySession {
  const walkthrough = session.walkthrough;
  if (walkthrough?.currentStepId) {
    return {
      ...session,
      overlays: [],
      walkthrough: {
        ...walkthrough,
        steps: walkthrough.steps.map((step) =>
          step.id === walkthrough.currentStepId ? { ...step, overlays } : step,
        ),
      },
    };
  }
  return { ...session, overlays };
}

function reduceCommand(
  session: ClickySession,
  command: ClickyCommand,
  context: ClickyContext,
): ClickyResult {
  switch (command.type) {
    case "wake": {
      if (session.awake && session.state !== "stopped")
        return unchanged(session);
      const awake = { ...session, awake: true };
      return changed({
        session: {
          ...awake,
          state: restingState(awake),
          reply: session.reply ?? notice("awake"),
        },
        effects: wakeAudit(session, "wake"),
      });
    }
    case "sleep": {
      if (!session.awake && session.state === "idle") return unchanged(session);
      return changed({
        session: {
          ...session,
          awake: false,
          state: "idle",
          resumeState: null,
          mode: "guide",
          trigger: null,
          overlays: [],
          proposal: null,
          reply: null,
          grant: null,
          thinkId: null,
          narrating: false,
          ...NO_CHECK,
        },
        effects: stopInFlight(session),
      });
    }
    case "listen": {
      if (command.active) {
        if (session.state === "acting") return refuse(session, "busy");
        if (session.state === "listening") return unchanged(session);
        return changed({
          session: {
            ...session,
            awake: true,
            resumeState: session.state === "thinking" ? null : session.state,
            state: "listening",
          },
          effects: [
            ...wakeAudit(session, "listen"),
            ...(session.state === "thinking"
              ? [{ type: "cancel_think" } as const]
              : []),
          ],
        });
      }
      if (session.state !== "listening") return unchanged(session);
      const back = session.resumeState ?? restingState(session);
      return changed({
        session: { ...session, state: back, resumeState: null },
        effects: [],
      });
    }
    case "ask": {
      const text = command.text.trim().slice(0, CLICKY_TEXT_LIMIT);
      if (!text) return unchanged(session);
      if (session.state === "acting") return refuse(session, "busy");
      const asked: ClickySession = {
        ...session,
        awake: true,
        // A new question moves on from a proposal nobody answered. The session's yes stands: it
        // was given for the session, not for one question.
        proposal: null,
        // A question while the Bot is shown working is the person's own, and Clicky guides again.
        narrating: false,
        trigger: session.narrating ? { kind: "person" } : session.trigger,
        ...NO_CHECK,
        transcript: appendTurn(session, "person", text, context),
        lastProgressAt: iso(context),
        nudgedAt: null,
        autoSteps: 0,
      };
      const draft = startThinking(asked, "ask", context, text);
      return changed({
        session: draft.session,
        effects: [
          ...wakeAudit(session, "ask"),
          ...(session.check ? [{ type: "cancel_check" } as const] : []),
          ...draft.effects,
        ],
      });
    }
    case "show_me": {
      if (session.state === "acting") return refuse(session, "busy");
      const draft = startThinking(
        {
          ...session,
          awake: true,
          proposal: null,
          narrating: false,
          ...NO_CHECK,
          nudgedAt: null,
        },
        "show_me",
        context,
      );
      return changed({
        session: draft.session,
        effects: [
          ...wakeAudit(session, "show_me"),
          ...(session.check ? [{ type: "cancel_check" } as const] : []),
          ...draft.effects,
        ],
      });
    }
    case "next": {
      if (session.state === "acting" || session.state === "thinking")
        return refuse(session, "busy");
      if (!currentStep(session)) return refuse(session, "no_step");
      const moved = advance({ ...session, proposal: null }, context);
      const next = moved.finished
        ? finishWalkthrough(moved.session)
        : moved.session;
      return changed({
        session: { ...next, state: restingState(next), resumeState: null },
        effects: [],
      });
    }
    case "back": {
      if (session.state === "acting" || session.state === "thinking")
        return refuse(session, "busy");
      const walkthrough = session.walkthrough;
      if (!walkthrough) return refuse(session, "no_step");
      const index = walkthrough.currentStepId
        ? walkthrough.steps.findIndex(
            (step) => step.id === walkthrough.currentStepId,
          )
        : walkthrough.steps.length;
      if (index <= 0) return refuse(session, "no_step");
      const previous = index - 1;
      const steps = walkthrough.steps.map((step, position): ClickyStep => {
        if (position === previous) return { ...step, status: "current" };
        if (position === index) return { ...step, status: "pending" };
        return step;
      });
      return changed({
        session: {
          ...session,
          proposal: null,
          state: "guiding",
          resumeState: null,
          walkthrough: {
            ...walkthrough,
            steps,
            currentStepId: steps[previous]?.id ?? null,
            updatedAt: iso(context),
          },
          nudgedAt: null,
        },
        effects: [],
      });
    }
    case "repeat":
      // Nothing changes but the sequence number, which is what makes the clients say it again.
      if (!session.reply) return unchanged(session);
      return changed({ session: { ...session }, effects: [] });
    case "approve": {
      const proposal = session.proposal;
      if (
        session.state !== "awaiting_permission" ||
        !proposal ||
        proposal.id !== command.proposalId
      )
        return refuse(session, "expired");
      if (Date.parse(proposal.expiresAt) <= context.now)
        return refuse(session, "expired");
      if (session.mode !== "act" || context.actionPolicy === "never")
        return refuse(session, "guide_only");
      if (proposal.risk !== "low" && proposal.risk !== "confirm")
        return refuse(session, "yours");
      // "For this session" covers everyday actions only, and only when the person's setting allows
      // it; anything hard to undo is a yes for this one action.
      const sessionWide =
        (command.scope === "session" || command.scope === "task") &&
        proposal.risk === "low" &&
        context.actionPolicy !== "ask_each";
      return changed({
        session: {
          ...session,
          state: "acting",
          resumeState: null,
          autoSteps: 0,
          error: null,
          ...NO_CHECK,
          grant: sessionWide
            ? {
                scope: "session",
                grantedAt: iso(context),
                expiresAt: iso(context, CLICKY_SESSION_GRANT_TTL_MS),
              }
            : session.grant,
        },
        effects: [
          {
            type: "audit",
            event: "clicky.action_approved",
            detail: {
              proposalId: proposal.id,
              action: proposal.action.kind,
              risk: proposal.risk,
              scope: sessionWide ? "session" : "once",
            },
          },
          { type: "act", proposal },
        ],
      });
    }
    case "deny": {
      const proposal = session.proposal;
      if (!proposal || proposal.id !== command.proposalId)
        return unchanged(session);
      if (session.state !== "awaiting_permission") return unchanged(session);
      const pointed = placeOverlays(
        session,
        pointerFor(proposal.action, context),
      );
      return changed({
        session: {
          ...pointed,
          proposal: null,
          state: "guiding",
          reply: notice("denied"),
        },
        effects: [
          {
            type: "audit",
            event: "clicky.action_denied",
            detail: { proposalId: proposal.id, action: proposal.action.kind },
          },
        ],
      });
    }
    case "stop":
      return changed({
        session: {
          ...session,
          state: "stopped",
          resumeState: null,
          mode: "guide",
          proposal: null,
          grant: null,
          thinkId: null,
          narrating: false,
          ...NO_CHECK,
          autoSteps: 0,
          stoppedAt: iso(context),
          reply: notice("stopped"),
        },
        effects: [
          ...stopInFlight(session),
          {
            type: "audit",
            event: "clicky.stopped",
            detail: {
              from: session.state,
              proposalId: session.proposal?.id ?? null,
            },
          },
        ],
      });
    case "pause": {
      if (session.state === "paused" || session.state === "stopped")
        return unchanged(session);
      const resumeTo: ClickyState =
        session.state === "thinking" ||
        session.state === "acting" ||
        session.state === "listening"
          ? restingState(session)
          : session.state;
      return changed({
        session: {
          ...session,
          state: "paused",
          resumeState: resumeTo,
          thinkId: null,
          reply: notice("paused"),
        },
        effects: stopInFlight(session),
      });
    }
    case "resume": {
      if (session.state === "paused") {
        let back = session.resumeState ?? restingState(session);
        let proposal = session.proposal;
        if (
          back === "awaiting_permission" &&
          (!proposal || Date.parse(proposal.expiresAt) <= context.now)
        ) {
          back = restingState(session);
          proposal = null;
        }
        return changed({
          session: {
            ...session,
            awake: true,
            state: back,
            resumeState: null,
            proposal,
          },
          effects: [],
        });
      }
      if (session.state === "stopped") {
        const awake = { ...session, awake: true };
        return changed({
          session: { ...awake, state: restingState(awake), reply: null },
          effects: [],
        });
      }
      return unchanged(session);
    }
    case "retry": {
      if (session.state === "acting") return refuse(session, "busy");
      if (!session.lastThink) return refuse(session, "nothing_to_retry");
      const draft = startThinking(
        { ...session, awake: true, proposal: null, ...NO_CHECK },
        "retry",
        context,
        session.lastThink.text,
      );
      return changed(draft);
    }
    case "set_mode": {
      if (command.mode === session.mode) return unchanged(session);
      if (command.mode === "act") {
        if (context.actionPolicy === "never")
          return refuse(session, "guide_only");
        // A sign-in, a secret or a CAPTCHA the Bot handed over is the person's to do, whatever the
        // mode: Clicky points at it and never offers to do it.
        if (
          session.trigger &&
          CLICKY_PERSON_ONLY_TRIGGERS.includes(session.trigger.kind)
        )
          return refuse(session, "yours");
        const acting: ClickySession = {
          ...session,
          awake: true,
          mode: "act",
          autoSteps: 0,
          grant: null,
        };
        const audit = modeAudit("act", session);
        // "Do it for me" on a task already in hand: look and propose the next action straight away.
        const hasTask = Boolean(session.trigger || currentStep(session));
        if (
          hasTask &&
          session.state !== "acting" &&
          session.state !== "stopped"
        ) {
          const draft = startThinking(
            { ...acting, proposal: null },
            "do_it",
            context,
          );
          return changed({
            session: draft.session,
            effects: [audit, ...draft.effects],
          });
        }
        return changed({ session: acting, effects: [audit] });
      }
      const guided: ClickySession = { ...session, mode: "guide", grant: null };
      const audit = modeAudit("guide", session);
      if (session.state === "awaiting_permission") {
        return changed({
          session: { ...guided, proposal: null, state: restingState(guided) },
          effects: [audit],
        });
      }
      return changed({ session: guided, effects: [audit] });
    }
    case "activate": {
      const trigger = command.trigger;
      if (trigger.requestId && trigger.requestId === session.trigger?.requestId)
        return unchanged(session);
      const caption: ClickyOverlay[] = trigger.reason
        ? [{ kind: "caption", id: context.newId(), text: trigger.reason }]
        : [];
      const activated: ClickySession = {
        ...session,
        awake: true,
        trigger,
        // A handover is a new task: an earlier walkthrough is about something else.
        walkthrough: trigger.kind === "follow_up" ? session.walkthrough : null,
        overlays: caption,
        proposal: null,
        grant: null,
        narrating: false,
        ...NO_CHECK,
        reply: notice(
          trigger.kind === "person" ? "awake" : "takeover",
          trigger.reason ?? "",
        ),
        lastProgressAt: iso(context),
        nudgedAt: null,
        autoSteps: 0,
      };
      const audit = wakeAudit(session, `activate:${trigger.kind}`);
      if (session.state === "acting") {
        return changed({
          session: { ...activated, state: "acting" },
          effects: audit,
        });
      }
      const draft = startThinking(
        session.state === "stopped"
          ? { ...activated, mode: "guide" }
          : activated,
        "activate",
        context,
        trigger.reason,
      );
      return changed({
        session: draft.session,
        effects: [...audit, ...draft.effects],
      });
    }
    case "watch": {
      if (session.awake && session.narrating) return unchanged(session);
      // Never over something the person is in the middle of: a question, an action, a yes to give.
      if (
        session.state === "thinking" ||
        session.state === "acting" ||
        session.state === "awaiting_permission" ||
        session.state === "listening"
      )
        return unchanged(session);
      return changed({
        session: {
          ...session,
          awake: true,
          narrating: true,
          trigger: { kind: "person" },
          mode: "guide",
          state: "guiding",
          resumeState: null,
          overlays: [],
          proposal: null,
          grant: null,
          ...NO_CHECK,
          reply: notice("watching"),
        },
        effects: [
          ...wakeAudit(session, "watch"),
          ...(session.check ? [{ type: "cancel_check" } as const] : []),
        ],
      });
    }
    case "overlay.set": {
      const placed = { ...session, awake: true, overlays: command.overlays };
      return changed({
        session: {
          ...placed,
          state:
            session.state === "idle" || session.state === "guiding"
              ? restingState(placed)
              : session.state,
        },
        effects: wakeAudit(session, "overlay"),
      });
    }
    case "overlay.clear": {
      if (session.overlays.length === 0) return unchanged(session);
      const cleared = { ...session, overlays: [] };
      return changed({
        session: {
          ...cleared,
          state:
            session.state === "guiding" ? restingState(cleared) : session.state,
        },
        effects: [],
      });
    }
    case "save_notes":
      return { session, effects: [{ type: "save_notes" }], changed: false };
  }
}

const NARRATION: Record<ClickyBotVerb, ClickyNotice> = {
  click: "narrate_click",
  type: "narrate_type",
  navigate: "narrate_navigate",
  scroll: "narrate_scroll",
  select: "narrate_select",
  key: "narrate_key",
  other: "narrate_working",
};

function reduceInternal(
  session: ClickySession,
  event: Exclude<ClickyEvent, { type: "command" }>,
  context: ClickyContext,
): ClickyResult {
  switch (event.type) {
    case "brain.reply": {
      if (session.state !== "thinking" || session.thinkId !== event.thinkId)
        return unchanged(session);
      let next: ClickySession = {
        ...session,
        thinkId: null,
        error: null,
        transcript: appendTurn(session, "clicky", event.say, context),
        reply: { text: event.say, final: true },
      };
      if (event.plan && event.plan.steps.length > 0) {
        next = {
          ...next,
          walkthrough: buildWalkthrough(event.plan, context),
          overlays: [],
          lastProgressAt: iso(context),
          nudgedAt: null,
        };
      } else if (event.overlays) {
        next = placeOverlays(next, event.overlays);
      }
      const effects: ClickyEffect[] = [];
      if (event.done) {
        const finished = next.walkthrough
          ? finishWalkthrough({
              ...next,
              walkthrough: {
                ...next.walkthrough,
                steps: next.walkthrough.steps.map((step) =>
                  step.status === "pending" || step.status === "current"
                    ? { ...step, status: "done" }
                    : step,
                ),
                currentStepId: null,
              },
            })
          : next;
        return changed({
          session: {
            ...finished,
            reply: { text: event.say, final: true, notice: "walkthrough_done" },
            state: restingState(finished),
          },
          effects,
        });
      }
      const rated = event.proposal;
      if (rated) {
        const actable =
          (rated.risk === "low" || rated.risk === "confirm") &&
          next.mode === "act" &&
          context.actionPolicy !== "never";
        if (!actable) {
          // Clicky points instead: the person does this one, or it is not done at all.
          next = placeOverlays(next, [
            ...(next.walkthrough?.currentStepId
              ? (currentStep(next)?.overlays ?? [])
              : next.overlays),
            ...pointerFor(rated.action, context),
          ]);
          if (rated.risk === "yours" || rated.risk === "blocked") {
            next = {
              ...next,
              reply: { text: event.say, final: true, notice: rated.risk },
            };
            effects.push({
              type: "audit",
              event: "clicky.action_blocked",
              detail: {
                action: rated.action.kind,
                risk: rated.risk,
                reason: rated.riskReason ?? null,
              },
            });
          }
          return changed({
            session: { ...next, state: restingState(next) },
            effects,
          });
        }
        const proposal: ClickyProposal = {
          id: context.newId(),
          action: rated.action,
          why: rated.why,
          risk: rated.risk,
          ...(rated.riskReason ? { riskReason: rated.riskReason } : {}),
          ...(rated.seen ? { seen: rated.seen } : {}),
          createdAt: iso(context),
          expiresAt: iso(context, CLICKY_PROPOSAL_TTL_MS),
        };
        effects.push({
          type: "audit",
          event: "clicky.action_proposed",
          detail: {
            proposalId: proposal.id,
            action: proposal.action.kind,
            risk: proposal.risk,
            label: proposal.action.label,
            modelLabel: proposal.action.modelLabel ?? null,
          },
        });
        // The session's yes covers everyday actions; anything hard to undo waits for its own.
        if (
          rated.risk === "low" &&
          grantActive(next, context) &&
          next.autoSteps < CLICKY_AUTO_STEP_LIMIT
        ) {
          effects.push(
            {
              type: "audit",
              event: "clicky.action_approved",
              detail: {
                proposalId: proposal.id,
                action: proposal.action.kind,
                risk: proposal.risk,
                scope: "session",
              },
            },
            { type: "act", proposal, viaGrant: true },
          );
          return changed({
            session: {
              ...next,
              proposal,
              state: "acting",
              autoSteps: next.autoSteps + 1,
            },
            effects,
          });
        }
        return changed({
          session: { ...next, proposal, state: "awaiting_permission" },
          effects,
        });
      }
      return changed({
        session: { ...next, state: restingState(next) },
        effects,
      });
    }
    case "brain.failed": {
      if (session.state !== "thinking" || session.thinkId !== event.thinkId)
        return unchanged(session);
      const failed: ClickySession = {
        ...session,
        thinkId: null,
        error: {
          notice: "think_failed",
          ...(event.detail ? { detail: event.detail } : {}),
        },
        reply: notice("think_failed"),
      };
      return changed({
        session: { ...failed, state: restingState(failed) },
        effects: [],
      });
    }
    case "action.done": {
      const proposal = session.proposal;
      if (session.state !== "acting" || proposal?.id !== event.proposalId)
        return unchanged(session);
      const effects: ClickyEffect[] = [
        {
          type: "audit",
          event: "clicky.action_performed",
          detail: {
            ...event.detail,
            proposalId: proposal.id,
            action: proposal.action.kind,
            label: proposal.action.label,
          },
        },
      ];
      const done: ClickySession = { ...session, proposal: null, error: null };
      /** Rests, then looks again: what was done may have moved everything on the screen. */
      const restAndLook = (rested: ClickySession): ClickyResult => {
        const resting = { ...rested, state: restingState(rested) };
        if (!mayCheck(resting)) return changed({ session: resting, effects });
        const look = startCheck(resting, context);
        return changed({
          session: look.session,
          effects: [...effects, ...look.effects],
        });
      };
      // A scroll only brings something into view; it never finishes a step.
      if (!currentStep(done) || proposal.action.kind === "scroll") {
        return restAndLook({ ...done, reply: notice("action_done") });
      }
      const moved = advance(done, context);
      if (moved.finished) {
        return changed({
          session: (() => {
            const finished = finishWalkthrough(moved.session);
            return { ...finished, state: restingState(finished) };
          })(),
          effects,
        });
      }
      // More to do and Clicky may act: look again and propose the next step.
      if (
        moved.session.mode === "act" &&
        moved.session.autoSteps < CLICKY_AUTO_STEP_LIMIT
      ) {
        const draft = startThinking(moved.session, "continue", context);
        return changed({
          session: draft.session,
          effects: [...effects, ...draft.effects],
        });
      }
      return restAndLook({ ...moved.session, reply: notice("action_done") });
    }
    case "action.failed": {
      const proposal = session.proposal;
      if (session.state !== "acting" || proposal?.id !== event.proposalId)
        return unchanged(session);
      const failed: ClickySession = {
        ...session,
        proposal: null,
        error: {
          notice: "action_failed",
          ...(event.detail ? { detail: event.detail } : {}),
        },
        reply: notice("action_failed"),
      };
      return changed({
        session: { ...failed, state: restingState(failed) },
        effects: [
          {
            type: "audit",
            event: "clicky.action_failed",
            detail: {
              proposalId: proposal.id,
              action: proposal.action.kind,
              detail: event.detail ?? null,
            },
          },
        ],
      });
    }
    case "person.input": {
      if (!session.awake || session.state !== "guiding")
        return unchanged(session);
      const step = currentStep(session);
      if (!step?.overlays.some((overlay) => hitsOverlay(event.at, overlay)))
        return unchanged(session);
      const moved = advance({ ...session, ...NO_CHECK }, context);
      if (moved.finished) {
        const finished = finishWalkthrough(moved.session);
        return changed({
          session: { ...finished, state: restingState(finished) },
          effects: session.check ? [{ type: "cancel_check" }] : [],
        });
      }
      // The click may have changed the page: look again to place the next step where it is now.
      const resting = { ...moved.session, state: restingState(moved.session) };
      const look = startCheck(resting, context);
      return changed({
        session: look.session,
        effects: [
          ...(session.check ? [{ type: "cancel_check" } as const] : []),
          ...look.effects.filter((effect) => effect.type !== "cancel_check"),
        ],
      });
    }
    case "person.typed":
    case "page.changed": {
      if (!mayCheck(session)) return unchanged(session);
      const look = startCheck(session, context);
      return changed(look);
    }
    case "brain.check": {
      const pending = session.check;
      if (!pending || pending.id !== event.checkId) return unchanged(session);
      // Anything but guiding (a question, an action, Stop) has moved on from this look.
      if (session.state !== "guiding" || session.narrating)
        return changed({
          session: { ...session, ...NO_CHECK },
          effects: [],
        });
      let next: ClickySession = { ...session, ...NO_CHECK };
      const step = currentStep(next);
      // Only for the step it was asked about: a step finished meanwhile by a click is not finished twice.
      if (event.stepDone && step && step.id === pending.stepId) {
        const moved = advance(next, context);
        if (moved.finished) {
          const finished = finishWalkthrough(moved.session);
          return changed({
            session: { ...finished, state: restingState(finished) },
            effects: [],
          });
        }
        next = moved.session;
      }
      if (event.overlays) next = placeOverlays(next, event.overlays);
      if (event.say?.trim())
        next = {
          ...next,
          reply: { text: event.say.trim(), final: true },
          transcript: appendTurn(next, "clicky", event.say, context),
        };
      return changed({
        session: { ...next, state: restingState(next) },
        effects: [],
      });
    }
    case "bot.action": {
      if (!session.awake || !session.narrating) return unchanged(session);
      if (session.state !== "guiding" && session.state !== "idle")
        return unchanged(session);
      const label = event.label?.trim().slice(0, 120);
      const overlays: ClickyOverlay[] = event.rect
        ? [
            {
              kind: "highlight",
              id: context.newId(),
              rect: event.rect,
              ...(label ? { label } : {}),
            },
            {
              kind: "pointer",
              id: context.newId(),
              at: {
                x: event.rect.x + event.rect.width / 2,
                y: event.rect.y + event.rect.height / 2,
              },
              ...(label ? { label } : {}),
            },
          ]
        : [];
      const narration = NARRATION[event.verb];
      const params: Record<string, string> = {};
      if (label) params.label = label;
      if (event.host) params.host = event.host;
      if (event.key) params.key = event.key;
      const usable =
        (narration === "narrate_click" ||
          narration === "narrate_type" ||
          narration === "narrate_select") &&
        !label
          ? "narrate_working"
          : narration === "narrate_navigate" && !event.host
            ? "narrate_working"
            : narration === "narrate_key" && !event.key
              ? "narrate_working"
              : narration;
      return changed({
        session: {
          ...session,
          state: "guiding",
          overlays,
          reply: { text: "", final: true, notice: usable, params },
        },
        effects: [],
      });
    }
    case "takeover.resolved": {
      if (
        !session.trigger?.requestId ||
        session.trigger.requestId !== event.requestId
      )
        return unchanged(session);
      const resolved: ClickySession = {
        ...session,
        trigger: null,
        walkthrough: null,
        overlays: [],
        proposal: session.state === "acting" ? session.proposal : null,
        reply:
          event.outcome === "completed"
            ? notice("takeover_resolved")
            : session.reply,
      };
      return changed({
        session: {
          ...resolved,
          state:
            session.state === "acting" ||
            session.state === "stopped" ||
            session.state === "paused" ||
            session.state === "listening"
              ? session.state
              : restingState(resolved),
          thinkId: session.state === "thinking" ? null : session.thinkId,
        },
        effects: session.state === "thinking" ? [{ type: "cancel_think" }] : [],
      });
    }
    case "bot.finished": {
      if (!session.awake) return unchanged(session);
      if (session.state !== "idle" && session.state !== "guiding")
        return unchanged(session);
      // A person in the middle of a walkthrough keeps it; the Bot's news waits.
      if (!session.narrating && currentStep(session)) return unchanged(session);
      const summary = event.summary.trim().slice(0, CLICKY_TEXT_LIMIT);
      return changed({
        session: {
          ...session,
          narrating: false,
          overlays: session.narrating ? [] : session.overlays,
          trigger: { kind: "follow_up" },
          reply: { text: summary, final: true, notice: "follow_up" },
          transcript: appendTurn(session, "clicky", summary, context),
        },
        effects: [],
      });
    }
    case "tick": {
      let next = session;
      let changes = false;
      const proposal = session.proposal;
      if (
        session.state === "awaiting_permission" &&
        proposal &&
        Date.parse(proposal.expiresAt) <= context.now
      ) {
        next = { ...next, proposal: null, reply: notice("expired") };
        next = { ...next, state: restingState(next) };
        changes = true;
      }
      if (next.grant && Date.parse(next.grant.expiresAt) <= context.now) {
        next = { ...next, grant: null };
        changes = true;
      }
      const idleSince = Math.max(
        Date.parse(next.lastProgressAt),
        event.lastInputAt ?? 0,
      );
      if (
        next.awake &&
        next.state === "guiding" &&
        currentStep(next) &&
        !next.nudgedAt &&
        context.now - idleSince >= CLICKY_NUDGE_AFTER_MS
      ) {
        next = { ...next, nudgedAt: iso(context), reply: notice("nudge") };
        changes = true;
      }
      return changes
        ? changed({ session: next, effects: [] })
        : unchanged(session);
    }
    case "notes.saved":
      return changed({
        session: { ...session, reply: notice("notes_saved", event.path) },
        effects: [],
      });
  }
}
