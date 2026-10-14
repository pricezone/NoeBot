import { randomUUID } from "node:crypto";
import type {
  ClickyNotice,
  ClickyOverlay,
  ClickyPoint,
  ClickyProposal,
  ClickySession,
} from "../../../shared/clicky";
import {
  type ClickyAuditEvent,
  type ClickyEffect,
  type ClickyEvent,
  type ClickyPlan,
  type ClickyResult,
  reduceClicky,
} from "../../../shared/clicky-state";
import {
  type AuditEventType,
  type AuditStore,
  PERSON_INITIATOR,
  recordAuditEvent,
} from "../audit";
import type { ComputerGateway } from "../computer/gateway";
import type { ScreenElements } from "../computer/schema";
import type { ActionOutcome, ClickyActions } from "./actions";
import type { ClickyBrain, ClickyPreferenceView } from "./brain";
import type { ClickyHub } from "./hub";
import { writeNotes } from "./notes";
import type { ClickyGuideInput } from "./schema";
import {
  elementByRef,
  overlaysFor,
  type PlacedElement,
  placeElements,
  targetOf,
} from "./screen";
import type { ClickyStore } from "./store";

/**
 * Clicky's sessions at work: every change goes load, reduce, save, publish, then carry out what the
 * reducer asked for.
 *
 * The reducer (`shared/clicky-state.ts`) decides everything and does nothing; this does what it
 * decided. Its effects are the model call (`think`, one at a time per session, the previous one
 * aborted), the action the person approved (`act`, abortable by Stop), the notes, and the audit rows.
 * Effects run after the save that produced them, outside the per-session queue, so an effect that
 * dispatches again (the model's answer, an action finishing) queues behind rather than deadlocking.
 *
 * Writes are compare-and-set on `seq` (`store.ts`): on a conflict the session is read again and the
 * event reduced again on what is there now, so a command racing the model's answer on another
 * replica is applied to the newer session instead of overwriting it. Within this process the same
 * session's events also queue, so the conflicts are rare.
 *
 * A clock ticks the sessions that are awake every few seconds (a proposal lapsing, the "stuck?"
 * nudge), with the last time the person touched the screen, which is kept here and not in the
 * session: it changes with every click and is only ever a hint.
 */

/** The audit rows Clicky writes, by the reducer's names. Literal, so the trail's taxonomy can find them. */
export const CLICKY_AUDIT_EVENT_TYPES: Record<
  ClickyAuditEvent,
  AuditEventType
> = {
  "clicky.session_started": "clicky.session_started",
  "clicky.action_proposed": "clicky.action_proposed",
  "clicky.action_approved": "clicky.action_approved",
  "clicky.action_denied": "clicky.action_denied",
  "clicky.action_performed": "clicky.action_performed",
  "clicky.action_failed": "clicky.action_failed",
  "clicky.action_blocked": "clicky.action_blocked",
  "clicky.stopped": "clicky.stopped",
  "clicky.mode_changed": "clicky.mode_changed",
};

export const CLICKY_TICK_MS = 5_000;

/** The commands that ask the model to look. */
const LOOKS = new Set(["ask", "show_me", "retry"]);

/**
 * A bucket of looks per person and Bot: `burst` at once, refilled at `perMinute`. In memory: each
 * replica counts its own, which only ever lets a little more through.
 */
export function createLookLimiter(
  options: { burst?: number; perMinute?: number } = {},
) {
  const burst = options.burst ?? 5;
  const perMs = (options.perMinute ?? 20) / 60_000;
  const buckets = new Map<string, { tokens: number; at: number }>();
  return {
    take(key: string, now: number): boolean {
      const bucket = buckets.get(key) ?? { tokens: burst, at: now };
      const tokens = Math.min(burst, bucket.tokens + (now - bucket.at) * perMs);
      if (tokens < 1) {
        buckets.set(key, { tokens, at: now });
        return false;
      }
      buckets.set(key, { tokens: tokens - 1, at: now });
      if (buckets.size > 10_000) {
        const oldest = buckets.keys().next().value;
        if (oldest !== undefined) buckets.delete(oldest);
      }
      return true;
    },
  };
}

export type ClickyPreferences = ClickyPreferenceView & {
  autoActivate: boolean;
};

export type DispatchOutcome = {
  session: ClickySession;
  changed: boolean;
  rejected?: ClickyNotice;
};

export type ClickyService = {
  /** The open session for a person and a Bot, made fresh when there is none to resume. */
  open(userId: string, botId: string): Promise<ClickySession>;
  /**
   * One event through the reducer. `onlyIfOpen` leaves a person with no open session alone (the
   * clock, a Bot finishing) rather than opening one for them.
   */
  dispatch(
    userId: string,
    botId: string,
    event: ClickyEvent,
    options?: { onlyIfOpen?: boolean },
  ): Promise<DispatchOutcome | null>;
  /**
   * Install the Bot's walkthrough: each step pointed at the element its ref names on the screen
   * now, and Clicky woken to show it.
   */
  guide(
    userId: string,
    botId: string,
    input: ClickyGuideInput,
  ): Promise<{
    session: ClickySession;
    pointed: number;
    missing: string[];
    /** Why the walkthrough was not installed: Clicky was busy acting. */
    rejected?: ClickyNotice;
  }>;
  /** The person clicked on the live screen at this normalized point. */
  personInput(userId: string, botId: string, at: ClickyPoint): void;
  preferences(userId: string): Promise<ClickyPreferences>;
  /** One pass of the clock over the sessions that are awake. */
  tick(): Promise<void>;
  start(): void;
  stop(): void;
};

type Key = string;
const keyOf = (userId: string, botId: string): Key => `${userId}\u0000${botId}`;

/** Effects that need to know what was waiting when they were asked for. */
type EffectHooks = {
  /** Answers a `think` itself instead of asking the model (the Bot's own walkthrough). */
  think?: (effect: Extract<ClickyEffect, { type: "think" }>) => void;
};

export function createClickyService(deps: {
  store: ClickyStore;
  hub: ClickyHub;
  preferences: (userId: string) => Promise<ClickyPreferences>;
  gateway: Pick<ComputerGateway, "elements" | "writeFile">;
  brain?: ClickyBrain;
  actions?: ClickyActions;
  auditStore?: AuditStore;
  now?: () => number;
  newId?: () => string;
  tickMs?: number;
  /** How many looks a person may ask for in a row, and how fast they come back. */
  looks?: { burst?: number; perMinute?: number };
}): ClickyService {
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? randomUUID;
  const looks = createLookLimiter(deps.looks);

  /** Each session's events, one after another. */
  const queues = new Map<Key, Promise<unknown>>();
  function queued<T>(key: Key, task: () => Promise<T>): Promise<T> {
    const previous = queues.get(key) ?? Promise.resolve();
    const next = previous.then(task, task);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    queues.set(key, settled);
    void settled.then(() => {
      if (queues.get(key) === settled) queues.delete(key);
    });
    return next;
  }

  /** Sessions awake here, for the clock; what each was doing, for the person's clicks. */
  const awake = new Map<Key, { userId: string; botId: string }>();
  const lastState = new Map<Key, ClickySession["state"]>();
  /** The last snapshot's seq and model call per session, which `reply.delta` is stamped with. */
  const lastSeq = new Map<Key, number>();
  const lastThinkId = new Map<Key, string | null>();
  /** When the person last touched each screen. */
  const lastInput = new Map<Key, number>();
  const thinking = new Map<Key, AbortController>();
  const acting = new Map<Key, AbortController>();
  /** What Clicky did in each session, for its notes. In memory: the audit trail is the record. */
  const done = new Map<
    string,
    { at: string; label: string; kind: string; outcome: string }[]
  >();

  const remember = (userId: string, botId: string, session: ClickySession) => {
    const key = keyOf(userId, botId);
    lastState.set(key, session.state);
    lastSeq.set(key, session.seq);
    lastThinkId.set(key, session.thinkId);
    if (session.awake) awake.set(key, { userId, botId });
    else awake.delete(key);
  };

  async function settle(
    userId: string,
    botId: string,
    event: ClickyEvent,
    onlyIfOpen: boolean,
  ): Promise<{ result: ClickyResult; preferences: ClickyPreferences } | null> {
    const preferences = await deps.preferences(userId);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      let current: ClickySession;
      if (onlyIfOpen) {
        const loaded = await deps.store.load(userId, botId);
        if (!loaded) return null;
        current = loaded;
      } else {
        const opened = await deps.store.open(userId, botId, now());
        current = opened.session;
        if (opened.created) {
          remember(userId, botId, current);
          deps.hub.publish(userId, botId, current);
        }
      }
      const result = reduceClicky(current, event, {
        now: now(),
        actionPolicy: preferences.actionPolicy,
        newId,
      });
      if (result.changed) {
        const saved = await deps.store.save(
          userId,
          botId,
          result.session,
          current.seq,
        );
        // Somebody else wrote first: read what is there now and decide again on that.
        if (!saved) continue;
        remember(userId, botId, result.session);
        deps.hub.publish(userId, botId, result.session);
      } else {
        remember(userId, botId, current);
      }
      return { result, preferences };
    }
    throw new Error("Clicky's session kept changing under it. Try again.");
  }

  async function dispatch(
    userId: string,
    botId: string,
    event: ClickyEvent,
    options: { onlyIfOpen?: boolean; unlimited?: boolean } = {},
    hooks: EffectHooks = {},
  ): Promise<DispatchOutcome | null> {
    /*
     * Every question, "show me" and retry is a model call with a picture of the screen: a few in a
     * row are fine, a stream of them (a stuck client, a script) waits its turn with the same notice
     * as any other "one moment".
     */
    if (
      !options.unlimited &&
      event.type === "command" &&
      LOOKS.has(event.command.type) &&
      !looks.take(keyOf(userId, botId), now())
    ) {
      const opened = await deps.store.open(userId, botId, now());
      return { session: opened.session, changed: false, rejected: "busy" };
    }
    const settled = await queued(keyOf(userId, botId), () =>
      settle(userId, botId, event, options.onlyIfOpen === true),
    );
    if (!settled) return null;
    const { result, preferences } = settled;
    // After the save and outside the queue. `save_notes` arrives with `changed: false`, so effects
    // run whether or not anything changed. An action waits for this result's audit rows (its
    // approval among them) to be written: nothing is done that the trail does not hold.
    const written: Promise<void>[] = [];
    for (const effect of result.effects)
      runEffect(
        userId,
        botId,
        result.session,
        effect,
        preferences,
        hooks,
        written,
      );
    return {
      session: result.session,
      changed: result.changed,
      ...(result.rejected ? { rejected: result.rejected } : {}),
    };
  }

  function runEffect(
    userId: string,
    botId: string,
    session: ClickySession,
    effect: ClickyEffect,
    preferences: ClickyPreferences,
    hooks: EffectHooks,
    written: Promise<void>[],
  ) {
    const key = keyOf(userId, botId);
    switch (effect.type) {
      case "think":
        if (hooks.think) {
          hooks.think(effect);
          return;
        }
        void think(userId, botId, session, effect, preferences);
        return;
      case "cancel_think":
        thinking.get(key)?.abort();
        thinking.delete(key);
        return;
      case "act":
        void act(
          userId,
          botId,
          session,
          effect.proposal,
          preferences,
          effect.viaGrant === true,
          Promise.all([...written]),
        );
        return;
      case "abort_action":
        acting.get(key)?.abort();
        acting.delete(key);
        return;
      case "save_notes":
        void saveNotes(userId, botId, session);
        return;
      case "audit": {
        if (!deps.auditStore) return;
        const row = recordAuditEvent(deps.auditStore, {
          eventType: CLICKY_AUDIT_EVENT_TYPES[effect.event],
          targetType: "computer",
          targetId: botId,
          actorUserId: userId,
          initiator: PERSON_INITIATOR,
          payload: { botId, sessionId: session.id, ...effect.detail },
        });
        written.push(row);
        row.catch((error: unknown) =>
          console.error(
            JSON.stringify({
              type: "clicky-audit-failed",
              event: effect.event,
              error: error instanceof Error ? error.message : String(error),
            }),
          ),
        );
        return;
      }
    }
  }

  async function think(
    userId: string,
    botId: string,
    session: ClickySession,
    effect: Extract<ClickyEffect, { type: "think" }>,
    preferences: ClickyPreferences,
  ) {
    const key = keyOf(userId, botId);
    thinking.get(key)?.abort();
    const controller = new AbortController();
    thinking.set(key, controller);
    try {
      if (!deps.brain) throw new Error("Clicky has no model to look with.");
      let screen: ScreenElements | undefined;
      /*
       * A Bot asking for the person named the element to use first: point at it at once, before the
       * model has even looked, so the first thing the person sees is where to go.
       */
      const targetRef = session.trigger?.targetRef;
      if (effect.reason === "activate" && targetRef) {
        screen = await deps.gateway.elements(botId);
        const element = elementByRef(placeElements(screen), targetRef);
        if (element && !controller.signal.aborted)
          await dispatch(userId, botId, {
            type: "command",
            command: {
              type: "overlay.set",
              overlays: [
                ...session.overlays,
                ...overlaysFor(targetOf(element), newId),
              ],
            },
          });
      }
      const reply = await deps.brain.think({
        userId,
        botId,
        session,
        thinkId: effect.thinkId,
        reason: effect.reason,
        ...(effect.text ? { text: effect.text } : {}),
        preferences,
        signal: controller.signal,
        /*
         * Stamped with the seq of the snapshot the screens now hold, which is in state "thinking"
         * for this same call: usually the one that started it, or a later one that kept thinking
         * (Clicky's first pointer on activation). Once the session has moved on (an answer, Stop,
         * a new question), what is still arriving belongs to nothing and is not sent.
         */
        onDelta: (text) => {
          if (
            controller.signal.aborted ||
            lastState.get(key) !== "thinking" ||
            lastThinkId.get(key) !== effect.thinkId
          )
            return;
          deps.hub.delta(
            userId,
            botId,
            lastSeq.get(key) ?? session.seq,
            effect.thinkId,
            text,
          );
        },
        ...(screen ? { screen } : {}),
      });
      if (controller.signal.aborted) return;
      await dispatch(userId, botId, reply);
    } catch (error) {
      if (controller.signal.aborted) return;
      await dispatch(userId, botId, {
        type: "brain.failed",
        thinkId: effect.thinkId,
        detail: error instanceof Error ? error.message : "The look failed.",
      }).catch(() => undefined);
    } finally {
      if (thinking.get(key) === controller) thinking.delete(key);
    }
  }

  async function act(
    userId: string,
    botId: string,
    session: ClickySession,
    proposal: ClickyProposal,
    preferences: ClickyPreferences,
    viaGrant: boolean,
    recorded: Promise<unknown>,
  ) {
    const key = keyOf(userId, botId);
    acting.get(key)?.abort();
    const controller = new AbortController();
    acting.set(key, controller);
    let outcome: ActionOutcome;
    try {
      if (!deps.actions)
        throw new Error("Clicky cannot act on this deployment.");
      // The approval's row first. If the trail cannot hold it, the action is not done.
      const trail = await recorded.then(
        () => true,
        () => false,
      );
      if (!trail)
        throw new Error(
          "The action could not be recorded, so it was not done.",
        );
      outcome = await deps.actions.run({
        userId,
        botId,
        proposal,
        actionPolicy: preferences.actionPolicy,
        trigger: session.trigger?.kind ?? null,
        signal: controller.signal,
        ...(viaGrant ? { viaGrant: true } : {}),
      });
    } catch (error) {
      outcome = {
        ok: false,
        detail: controller.signal.aborted
          ? "Stopped."
          : error instanceof Error
            ? error.message
            : "The action failed.",
      };
    } finally {
      if (acting.get(key) === controller) acting.delete(key);
    }
    const log = done.get(session.id) ?? [];
    log.push({
      at: new Date(now()).toISOString(),
      kind: proposal.action.kind,
      label: proposal.action.label,
      outcome: outcome.ok ? "done" : `not done: ${outcome.detail}`,
    });
    done.set(session.id, log.slice(-50));
    // Sessions come and go; the oldest logs are forgotten first.
    if (done.size > 500) {
      const oldest = done.keys().next().value;
      if (oldest !== undefined) done.delete(oldest);
    }
    await dispatch(
      userId,
      botId,
      outcome.ok
        ? {
            type: "action.done",
            proposalId: proposal.id,
            detail: outcome.audit,
          }
        : {
            type: "action.failed",
            proposalId: proposal.id,
            detail: outcome.detail,
          },
    ).catch(() => undefined);
  }

  async function saveNotes(
    userId: string,
    botId: string,
    session: ClickySession,
  ) {
    try {
      const path = await writeNotes({
        gateway: deps.gateway,
        userId,
        botId,
        session,
        actions: done.get(session.id) ?? [],
        now: now(),
      });
      await dispatch(userId, botId, { type: "notes.saved", path });
    } catch (error) {
      console.warn(
        JSON.stringify({
          type: "clicky-notes-failed",
          botId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  let timer: ReturnType<typeof setInterval> | undefined;

  const service: ClickyService = {
    async open(userId, botId) {
      const opened = await deps.store.open(userId, botId, now());
      remember(userId, botId, opened.session);
      if (opened.created) deps.hub.publish(userId, botId, opened.session);
      return opened.session;
    },

    dispatch: (userId, botId, event, options) =>
      dispatch(userId, botId, event, options),

    async guide(userId, botId, input) {
      const screen = await deps.gateway.elements(botId).catch(() => null);
      const placed: PlacedElement[] = screen ? placeElements(screen) : [];
      const missing: string[] = [];
      let pointed = 0;
      const plan: ClickyPlan = {
        goal: input.goal,
        steps: input.steps.map((step) => {
          const element = elementByRef(placed, step.ref);
          if (step.ref && !element) missing.push(step.ref);
          if (element) pointed += 1;
          const overlays: ClickyOverlay[] = element
            ? overlaysFor(targetOf(element), newId)
            : [];
          return {
            title: step.say,
            overlays,
            ...(element ? { targetRef: element.ref } : {}),
          };
        }),
      };
      /*
       * Through the reducer like everything else: "show me" opens a look, and the look is answered
       * at once with the Bot's own plan instead of asking the model, so the walkthrough is installed
       * by the same rule that installs the model's.
       */
      let answered: Promise<DispatchOutcome | null> | undefined;
      const asked = await dispatch(
        userId,
        botId,
        { type: "command", command: { type: "show_me" } },
        // The Bot's own walkthrough asks no model, so it costs none of the person's looks.
        { unlimited: true },
        {
          think: (effect) => {
            answered = dispatch(userId, botId, {
              type: "brain.reply",
              thinkId: effect.thinkId,
              say: input.steps[0]?.say ?? input.goal,
              plan,
            });
          },
        },
      );
      const outcome = (answered ? await answered : null) ?? asked;
      if (!outcome) throw new Error("Clicky could not open a session.");
      if (answered && deps.auditStore)
        await recordAuditEvent(deps.auditStore, {
          eventType: "clicky.guide_installed",
          targetType: "computer",
          targetId: botId,
          actorUserId: userId,
          initiator: PERSON_INITIATOR,
          payload: {
            botId,
            sessionId: outcome.session.id,
            steps: input.steps.length,
            pointed,
            missing: missing.length,
          },
        }).catch(() => undefined);
      return {
        session: outcome.session,
        pointed,
        missing,
        ...(asked?.rejected ? { rejected: asked.rejected } : {}),
      };
    },

    personInput(userId, botId, at) {
      const key = keyOf(userId, botId);
      lastInput.set(key, now());
      // Only a walkthrough moves on a click, and only one this process knows is showing.
      if (lastState.get(key) !== "guiding") return;
      void dispatch(
        userId,
        botId,
        { type: "person.input", at },
        { onlyIfOpen: true },
      ).catch(() => undefined);
    },

    preferences: deps.preferences,

    async tick() {
      await Promise.all(
        [...awake.entries()].map(async ([key, { userId, botId }]) => {
          const lastInputAt = lastInput.get(key);
          const outcome = await dispatch(
            userId,
            botId,
            {
              type: "tick",
              ...(lastInputAt !== undefined ? { lastInputAt } : {}),
            },
            { onlyIfOpen: true },
          ).catch(() => null);
          if (!outcome) awake.delete(key);
        }),
      );
    },

    start() {
      if (timer) return;
      timer = setInterval(() => {
        void service.tick();
      }, deps.tickMs ?? CLICKY_TICK_MS);
      // The clock never keeps the process alive on its own.
      (timer as { unref?: () => void }).unref?.();
    },

    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      for (const controller of [...thinking.values(), ...acting.values()])
        controller.abort();
      thinking.clear();
      acting.clear();
    },
  };
  return service;
}
