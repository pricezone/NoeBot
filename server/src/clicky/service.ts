import { randomUUID } from "node:crypto";
import {
  type ClickyNotice,
  type ClickyOverlay,
  type ClickyPoint,
  type ClickyProposal,
  type ClickySession,
  currentStep,
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
import type { ClickyBotVerb } from "../../../shared/clicky-state";
import type { ComputerGateway } from "../computer/gateway";
import type { PageState, ScreenElements } from "../computer/schema";
import type { ActionOutcome, ClickyActions } from "./actions";
import {
  type BrainCheck,
  type ClickyBrain,
  type ClickyPreferenceView,
  namedSitesOf,
} from "./brain";
import type { ClickyHub } from "./hub";
import { writeNotes } from "./notes";
import type { ClickyGuideInput } from "./schema";
import {
  elementByRef,
  normalizedRect,
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
 *
 * Seeing progress: after the person clicks, types or turns the wheel on the screen (and after
 * Clicky acts), the page's state is asked every 700 ms for up to 4 s (`/elements/state`, cheap, no
 * look): a navigation dispatches `page.changed`, and typing or a scroll that took the page nowhere
 * dispatches `person.typed` once it pauses (each key or turn starts the wait again, so a burst is
 * one look). A field typed into and left, or a "scroll down" done, is a step no Enter ever says is
 * finished. The reducer answers both with a `check` effect, run
 * here: the page is let settle, then the model looks once more ("was the step done; where is its
 * control now") without proposing anything, and its answer comes back as `brain.check`. A look
 * already running for the same step is kept rather than started again, unless the page has moved on
 * since it looked. Checks have their own rate-limit bucket; a look that could not be made says so
 * (`failed`); and a check whose id is no longer the one waited on is dropped (the reducer drops it
 * too).
 *
 * Narration: while a person watches the Bot work (`narrating`), each page action the Bot is about to
 * take (`botAction`, from the gateway) is shown. Only for a session this process last saw awake and
 * narrating is anything read at all; then the session is read, and only if it is still an open,
 * narrating session of that person and Bot is the element's place asked (`/elements/ref`, which takes
 * no snapshot of its own, so the Bot's refs stay as they are). `/elements` is never asked meanwhile.
 *
 * What is kept in memory here (who is typing, which looks are running) is per process. Hosted
 * instances run one replica; with more, a look or a watch runs where its event arrived, and the
 * reducer's ids keep a late or duplicate answer from counting.
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

/** How many more times a look that found the page still loading looks again. */
const LOADING_LOOKS_AGAIN = 3;

/** How the watch after a person's input is paced. */
export const CLICKY_PROGRESS = {
  /** How often the page's state is asked while watching. */
  pollMs: 700,
  /** How long a watch lasts, and how much longer for a navigation still on its way. */
  windowMs: 4_000,
  extendMs: 4_000,
  /** How long after Enter or Tab (or the last key typed) a page that has not moved counts as typed into. */
  typingSettleMs: 1_200,
  /** How long after the person's last turn of the wheel the page counts as scrolled. */
  scrollSettleMs: 700,
  /** How long a look that found the page still loading waits before it looks again. */
  loadingRetryMs: 1_500,
  /** How long a look after a step waits before asking whether the page has settled. */
  settleFloorMs: 300,
};

/** The verb narration says for each of the Bot's page tools. */
export function botVerbOf(tool: string): ClickyBotVerb {
  switch (tool) {
    case "computer_click":
    // A box ticked or cleared is a click on it, said with its name ("clicking “Remember me”").
    case "computer_check":
      return "click";
    case "computer_type":
    case "computer_fill":
      return "type";
    case "computer_navigate":
    case "computer_back":
      return "navigate";
    case "computer_scroll":
      return "scroll";
    case "computer_select":
      return "select";
    case "computer_key":
      return "key";
    default:
      return "other";
  }
}

/** One of the Bot's page actions, as narration hears it (`ComputerBotAction` without the ids). */
export type ClickyBotAction = {
  tool: string;
  ref?: string;
  snapshotId?: number;
  role?: string;
  name?: string;
  url?: string;
  key?: string;
  option?: string;
};

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
  /**
   * The person clicked on the live screen at this normalized point. `driving`: they hold the
   * computer, so the click reached it, and the page is watched for what it did.
   */
  personInput(
    userId: string,
    botId: string,
    at: ClickyPoint,
    options?: { driving?: boolean },
  ): void;
  /**
   * The person typed on the computer while holding it: `submit` for Enter or Tab, `text` for any
   * other typing. Only that it happened; never what.
   */
  personTyped(userId: string, botId: string, kind: "text" | "submit"): void;
  /** The person scrolled the computer's screen while holding it. */
  personScrolled(userId: string, botId: string): void;
  /**
   * The Bot is about to act on its page; shown to this person if they are watching it narrated.
   * `autoWatch`: they have its screen open, so narration starts by itself when Show me how is
   * asleep, or awake with nothing on the screen and nobody needing them.
   */
  botAction(
    userId: string,
    botId: string,
    action: ClickyBotAction,
    options?: { autoWatch?: boolean },
  ): void;
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
  gateway: Pick<ComputerGateway, "elements" | "writeFile"> &
    Partial<Pick<ComputerGateway, "pageState" | "elementRect">>;
  brain?: ClickyBrain;
  actions?: ClickyActions;
  auditStore?: AuditStore;
  now?: () => number;
  newId?: () => string;
  tickMs?: number;
  /** How many looks a person may ask for in a row, and how fast they come back. */
  looks?: { burst?: number; perMinute?: number };
  /** The same for the looks after a step, which the person does not ask for. */
  checks?: { burst?: number; perMinute?: number };
  /** The pace of the watch after a person's input; `CLICKY_PROGRESS` unless a test says. */
  progress?: Partial<typeof CLICKY_PROGRESS>;
  /**
   * On Stop: hand back the computer if this person holds it under Clicky's own request (the client
   * hands it back too, on sleep and close as well, where it respects the person's Keep control; this
   * is for one that went away first).
   */
  releaseOwnControl?: (userId: string, botId: string) => Promise<void>;
}): ClickyService {
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? randomUUID;
  const looks = createLookLimiter(deps.looks);
  const checks = createLookLimiter(deps.checks ?? { burst: 4, perMinute: 12 });
  const pace = { ...CLICKY_PROGRESS, ...deps.progress };

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
  /** The look after a step running per session: settling (waiting on the page) or looking. */
  const checking = new Map<
    Key,
    {
      checkId: string;
      stepId: string | null;
      controller: AbortController;
      phase: "settling" | "looking";
      navigationId?: number;
    }
  >();
  /** The navigation each session last looked at, so one page is not looked at twice. */
  const lookedAt = new Map<Key, number>();
  /** The watch after a person's input, per session, and whether it was typing. */
  const watchers = new Map<
    Key,
    { controller: AbortController; typed: boolean }
  >();
  /** Sessions whose next look must start afresh: the page moved on since the running one looked. */
  const restartLook = new Set<Key>();
  /** Narration in flight per session; only the latest of the actions waiting behind it is shown. */
  const narrations = new Map<
    Key,
    { next?: { action: ClickyBotAction; autoWatch: boolean } }
  >();
  /** Sessions this process last saw awake and narrating: only theirs are read for the Bot's actions. */
  const narratingHere = new Set<Key>();
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
    if (session.awake && session.narrating) narratingHere.add(key);
    else narratingHere.delete(key);
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
    throw new Error("The session kept changing under it. Try again.");
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
    if (
      event.type === "command" &&
      (event.command.type === "sleep" || event.command.type === "stop")
    )
      quietWatch(keyOf(userId, botId));
    // Stop only: on sleep the app hands control back itself, unless the person chose to keep it.
    if (event.type === "command" && event.command.type === "stop") {
      if (deps.releaseOwnControl)
        void deps.releaseOwnControl(userId, botId).catch((error: unknown) =>
          console.warn(
            JSON.stringify({
              type: "clicky-release-failed",
              error: error instanceof Error ? error.message : String(error),
            }),
          ),
        );
    }
    if (!settled) return null;
    const { result, preferences } = settled;
    // After the save and outside the queue. `save_notes` arrives with `changed: false`, so effects
    // run whether or not anything changed. An action waits for this result's audit rows (its
    // approval among them) to be written: nothing is done that the trail does not hold.
    const written: Promise<void>[] = [];
    /*
     * A look asked for again about the step a running look is about is the same look: it is kept,
     * and answers under the new id, rather than being thrown away and paid for twice.
     */
    const key = keyOf(userId, botId);
    const again = result.effects.find(
      (effect): effect is Extract<ClickyEffect, { type: "check" }> =>
        effect.type === "check",
    );
    const running = checking.get(key);
    const keep =
      again !== undefined &&
      running !== undefined &&
      !running.controller.signal.aborted &&
      running.stepId === again.stepId &&
      !restartLook.has(key);
    restartLook.delete(key);
    if (keep && running && again) running.checkId = again.checkId;
    for (const effect of result.effects) {
      if (keep && (effect.type === "cancel_check" || effect.type === "check"))
        continue;
      runEffect(
        userId,
        botId,
        result.session,
        effect,
        preferences,
        hooks,
        written,
      );
    }
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
      case "check":
        void runCheck(userId, botId, session, effect, preferences);
        return;
      case "cancel_check":
        checking.get(key)?.controller.abort();
        checking.delete(key);
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
      const brain = deps.brain;
      if (!brain) throw new Error("There is no model to look with here.");
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
      // After Clicky acted, the page it acted on may still be moving: let a navigation land first.
      if (effect.reason === "continue")
        await settlePage(botId, controller.signal);
      const ask = () =>
        brain.think({
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
      let reply = await ask();
      /*
       * A page still loading when it looked (a sign-in redirect, a page that draws itself late):
       * looked at again once it has settled, a few times, rather than answered with a step nobody
       * can do. Live on dilosi.services.gov.gr: "Wait for page load", while «Συνέχεια» was there.
       */
      for (
        let again = 0;
        again < LOADING_LOOKS_AGAIN &&
        reply.type === "brain.reply" &&
        reply.loading === true;
        again += 1
      ) {
        await wait(pace.loadingRetryMs, controller.signal);
        await settlePage(botId, controller.signal);
        screen = undefined;
        reply = await ask();
      }
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
        throw new Error("Acting is not available on this deployment.");
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
        ...(viaGrant && session.grant?.host
          ? { grantHost: session.grant.host }
          : {}),
        // Opening a site is rated against the sites the person named, here as at the proposal.
        namedSites: namedSitesOf(session),
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
    // What Clicky did may take the page somewhere: watched like the person's own click.
    if (outcome.ok && lastState.get(key) === "guiding")
      startWatch(userId, botId, false, 0);
  }

  /** `ms`, or less when `signal` aborts (which then throws). */
  function wait(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", stopped);
        resolve();
      }, ms);
      const stopped = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      signal.addEventListener("abort", stopped, { once: true });
    });
  }

  /**
   * Waits for the Bot's page to settle (a navigation on its way has landed and stayed put), at most
   * the watch's window and a little more, and answers the navigation it settled on. Without a way to
   * ask, a moment's pause.
   */
  async function settlePage(
    botId: string,
    signal: AbortSignal,
  ): Promise<number | undefined> {
    const read = deps.gateway.pageState;
    await wait(pace.settleFloorMs, signal);
    if (!read) return undefined;
    const started = Date.now();
    for (;;) {
      const state = await read(botId).catch(() => null);
      signal.throwIfAborted();
      if (!state) return undefined;
      if (
        state.settled ||
        Date.now() - started >= pace.windowMs + pace.extendMs
      )
        return state.navigationId;
      await wait(Math.max(50, Math.round(pace.pollMs / 2)), signal);
    }
  }

  /**
   * The look after a step: the page let settle, then one model look without proposals, answered as
   * `brain.check`. Over the checks' own limit, or with nothing to look with, it is answered at once
   * with nothing done, so the overlays stop being drawn dimmed.
   */
  async function runCheck(
    userId: string,
    botId: string,
    session: ClickySession,
    effect: Extract<ClickyEffect, { type: "check" }>,
    preferences: ClickyPreferences,
  ) {
    const key = keyOf(userId, botId);
    checking.get(key)?.controller.abort();
    const controller = new AbortController();
    const entry: {
      checkId: string;
      stepId: string | null;
      controller: AbortController;
      phase: "settling" | "looking";
      navigationId?: number;
    } = {
      checkId: effect.checkId,
      stepId: effect.stepId,
      controller,
      phase: "settling",
    };
    checking.set(key, entry);
    /*
     * Only the look still waited on is answered (under the id it is waited on by now: a repeat of
     * it for the same step is answered by this one): a newer one, or Stop, has moved on from it.
     */
    const answer = async (result: BrainCheck | { failed: true }) => {
      if (controller.signal.aborted || checking.get(key) !== entry) return;
      await dispatch(
        userId,
        botId,
        "failed" in result
          ? {
              type: "brain.check",
              checkId: entry.checkId,
              stepDone: false,
              failed: true,
            }
          : {
              type: "brain.check",
              checkId: entry.checkId,
              stepDone: result.stepDone,
              ...(result.stepsDone ? { stepsDone: result.stepsDone } : {}),
              ...(result.overlays ? { overlays: result.overlays } : {}),
              ...(result.say ? { say: result.say } : {}),
            },
        { onlyIfOpen: true },
      );
    };
    try {
      const brain = deps.brain;
      // No look to be had: said as such, so the marks stay dimmed rather than looking current.
      if (!brain?.check || !checks.take(key, now())) {
        await answer({ failed: true });
        return;
      }
      const navigationId = await settlePage(botId, controller.signal);
      entry.phase = "looking";
      if (navigationId !== undefined) {
        entry.navigationId = navigationId;
        lookedAt.set(key, navigationId);
      }
      const result = await brain.check({
        userId,
        botId,
        session,
        stepId: effect.stepId,
        preferences,
        signal: controller.signal,
      });
      await answer(result);
    } catch {
      if (!controller.signal.aborted)
        await answer({ failed: true }).catch(() => undefined);
    } finally {
      if (checking.get(key) === entry) checking.delete(key);
    }
  }

  /** Stops watching a session's page: it slept, or was stopped. */
  function quietWatch(key: Key) {
    watchers.get(key)?.controller.abort();
    watchers.delete(key);
  }

  /**
   * Watch the page after the person (or Clicky) did something. `typed`: they typed, so once the
   * page is settled and `typedAfterMs` has passed, that alone is worth a look.
   */
  function startWatch(
    userId: string,
    botId: string,
    typed: boolean,
    typedAfterMs: number,
  ) {
    const key = keyOf(userId, botId);
    const previous = watchers.get(key);
    previous?.controller.abort();
    const entry = {
      controller: new AbortController(),
      typed: typed || (previous?.typed ?? false),
    };
    watchers.set(key, entry);
    void watch(userId, botId, entry, typedAfterMs);
  }

  async function watch(
    userId: string,
    botId: string,
    entry: { controller: AbortController; typed: boolean },
    typedAfterMs: number,
  ) {
    const key = keyOf(userId, botId);
    const { signal } = entry.controller;
    const typedDone = async () => {
      if (!entry.typed || signal.aborted) return;
      await dispatch(
        userId,
        botId,
        { type: "person.typed" },
        { onlyIfOpen: true },
      );
    };
    try {
      const read = deps.gateway.pageState;
      const base = read ? await read(botId).catch(() => null) : null;
      signal.throwIfAborted();
      if (!read || !base) {
        await wait(typedAfterMs, signal);
        await typedDone();
        return;
      }
      const started = Date.now();
      let state: PageState = base;
      for (;;) {
        if (state.navigationId !== base.navigationId) {
          await pageChanged(userId, botId, state);
          return;
        }
        const elapsed = Date.now() - started;
        if (entry.typed && state.settled && elapsed >= typedAfterMs) {
          await typedDone();
          return;
        }
        // The window is up; a navigation still on its way is given a little longer.
        if (
          elapsed >= pace.windowMs &&
          (state.settled || elapsed >= pace.windowMs + pace.extendMs)
        ) {
          await typedDone();
          return;
        }
        await wait(pace.pollMs, signal);
        const next = await read(botId).catch(() => null);
        signal.throwIfAborted();
        if (!next) {
          await typedDone();
          return;
        }
        state = next;
      }
    } catch {
      // Stopped, or a newer watch took over: nothing to say.
    } finally {
      if (watchers.get(key) === entry) watchers.delete(key);
    }
  }

  /**
   * The page moved on under the person. Looked at, unless a look already will: one still waiting
   * for the page to settle sees this page anyway, and a page already looked at is not looked at twice.
   */
  async function pageChanged(userId: string, botId: string, state: PageState) {
    const key = keyOf(userId, botId);
    const inFlight = checking.get(key);
    if (
      inFlight &&
      (inFlight.phase === "settling" ||
        inFlight.navigationId === state.navigationId)
    )
      return;
    if (!inFlight && lookedAt.get(key) === state.navigationId) return;
    // A look running on the page before this one is not kept: this page is looked at afresh.
    if (inFlight) restartLook.add(key);
    await dispatch(
      userId,
      botId,
      { type: "page.changed", url: state.url },
      { onlyIfOpen: true },
    );
  }

  /**
   * Whether narration may start by itself on this session: asleep (or none yet), or awake with
   * nothing on the screen, no walkthrough, nothing waiting on the person and the Bot not needing
   * them. Never over Stop or Pause (the reducer refuses those too).
   */
  function mayStartWatching(session: ClickySession | null): boolean {
    if (!session?.awake) return true;
    return (
      session.state === "idle" &&
      !currentStep(session) &&
      session.overlays.length === 0 &&
      !session.proposal &&
      (!session.trigger ||
        session.trigger.kind === "person" ||
        session.trigger.kind === "follow_up")
    );
  }

  /** The host a URL names, or nothing. */
  function hostOf(url: string | undefined): string | undefined {
    if (!url) return undefined;
    try {
      return new URL(url).host || undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * One of the Bot's actions shown to a person watching it: the session read first, and only for an
   * open, narrating one is the element's place asked of the computer.
   */
  async function narrate(
    userId: string,
    botId: string,
    action: ClickyBotAction,
    autoWatch: boolean,
  ) {
    if (!narratingHere.has(keyOf(userId, botId)) && !autoWatch) return;
    let session = await deps.store.load(userId, botId);
    if (!session?.awake || !session.narrating) {
      // The person has the screen open and nothing else is going on: show them what the Bot does.
      if (!autoWatch || !mayStartWatching(session)) return;
      const watched = await dispatch(userId, botId, {
        type: "command",
        command: { type: "watch" },
      });
      session = watched?.session ?? null;
      if (!session?.awake || !session.narrating) return;
    }
    if (session.state !== "guiding" && session.state !== "idle") return;
    const found =
      action.ref && deps.gateway.elementRect
        ? await deps.gateway
            .elementRect(botId, action.ref, action.snapshotId)
            .catch(() => null)
        : null;
    const rect =
      found?.rect && "screen" in found
        ? normalizedRect(found.rect, found.screen)
        : undefined;
    const verb = botVerbOf(action.tool);
    const label = action.name?.trim();
    const host = verb === "navigate" ? hostOf(action.url) : undefined;
    await dispatch(
      userId,
      botId,
      {
        type: "bot.action",
        verb,
        ...(label ? { label } : {}),
        ...(host ? { host } : {}),
        ...(verb === "key" && action.key ? { key: action.key } : {}),
        ...(verb === "select" && action.option
          ? { option: action.option }
          : {}),
        ...(rect && rect.width > 0 && rect.height > 0 ? { rect } : {}),
      },
      { onlyIfOpen: true },
    );
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
      if (!outcome) throw new Error("Show me how could not open a session.");
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

    personInput(userId, botId, at, options) {
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
      // The click reached the computer: it may have opened something.
      if (options?.driving) startWatch(userId, botId, false, 0);
    },

    personTyped(userId, botId) {
      const key = keyOf(userId, botId);
      lastInput.set(key, now());
      if (lastState.get(key) !== "guiding") return;
      /*
       * Enter and Tab, and plain typing once it pauses: each key starts the watch again, so it is
       * looked into once, after the last key. A field typed into and left (the next one clicked)
       * is a step done that no Enter ever says; the checks' own limit keeps the looks few.
       */
      startWatch(userId, botId, true, pace.typingSettleMs);
    },

    personScrolled(userId, botId) {
      const key = keyOf(userId, botId);
      lastInput.set(key, now());
      // "Scroll down" done, and the next step's control now on the screen: looked into once the
      // wheel stops, as typing is.
      if (lastState.get(key) !== "guiding") return;
      startWatch(userId, botId, true, pace.scrollSettleMs);
    },

    botAction(userId, botId, action, options) {
      const key = keyOf(userId, botId);
      const autoWatch = options?.autoWatch === true;
      // Nobody here is watching this Bot: nothing is read, not even the session.
      if (!narratingHere.has(key) && !autoWatch) return;
      const running = narrations.get(key);
      if (running) {
        running.next = { action, autoWatch };
        return;
      }
      const slot: {
        next?: { action: ClickyBotAction; autoWatch: boolean };
      } = {};
      narrations.set(key, slot);
      void (async () => {
        let current:
          | { action: ClickyBotAction; autoWatch: boolean }
          | undefined = { action, autoWatch };
        while (current) {
          await narrate(userId, botId, current.action, current.autoWatch).catch(
            () => undefined,
          );
          current = slot.next;
          slot.next = undefined;
        }
        narrations.delete(key);
      })();
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
      for (const controller of [
        ...thinking.values(),
        ...acting.values(),
        ...[...checking.values()].map((entry) => entry.controller),
        ...[...watchers.values()].map((entry) => entry.controller),
      ])
        controller.abort();
      thinking.clear();
      acting.clear();
      checking.clear();
      watchers.clear();
    },
  };
  return service;
}
