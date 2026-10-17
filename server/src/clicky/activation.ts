import type { ClickyTrigger } from "../../../shared/clicky";
import type { ComputerControlEvent } from "../computer/gateway";
import type { HeadlessWait } from "../computer/headless-tools";
import { CLICKY_HELP_REASON } from "./actions";
import type { ClickyService } from "./service";

/**
 * Clicky opening by itself when the Bot needs the person on its computer.
 *
 * Every way a Bot can ask arrives here: the gateway's handover events (a help request from any path,
 * a challenge a page showed, a secret asked for), and a run suspended on the person (a private
 * sign-in, an approval the person has to carry out themselves). Each becomes an `activate` with the
 * request it is about, so a repeat of the same request is ignored by the reducer, and the end of the
 * handover (released, cancelled, supplied) resolves it. A person who turned "open by itself" off is
 * left alone, and so is an event with nobody to show it to.
 *
 * Clicky's own request for control (when it acts for the person) is not the Bot needing anybody, and
 * is recognised by its words; a person pressing Take control themselves is not either, and says so
 * (`source: "manual"`). Neither opens Clicky, from the handover event or from the run it suspends.
 *
 * When a Bot ends a run, a session that is awake is told it finished, so Clicky can say so. A run
 * that only stopped to wait for the person (it went through `onWaiting`) has not finished: its lock
 * is given back while it waits, and that is not said to be the end.
 */

/** Whether a handover is the person's own, or Clicky's: not the Bot needing anybody. */
function notTheBots(request: unknown): boolean {
  if (!request || typeof request !== "object") return false;
  const { reason, source } = request as { reason?: unknown; source?: unknown };
  return reason === CLICKY_HELP_REASON || source === "manual";
}

export type ClickyActivation = {
  onControlEvent(event: ComputerControlEvent): void;
  onWaiting(input: { userId: string; botId: string; wait: HeadlessWait }): void;
  onRunBusy(input: {
    threadId: string;
    busy: boolean;
    userId?: string;
    agentId?: string;
  }): void;
};

/** Sent to the person's phones when Clicky opened because the Bot needs them. */
export type NeedsYou = (input: {
  userId: string;
  botId: string;
  trigger: ClickyTrigger;
}) => Promise<void>;

/** Which trigger a help request is: a page's challenge is a challenge, anything else a takeover. */
export function helpTrigger(event: ComputerControlEvent): ClickyTrigger {
  const source = event.state.request?.source;
  const reason = (event.reason ?? event.state.request?.reason)?.trim();
  return {
    kind:
      source === "cloudflare" || source === "visible-challenge"
        ? "challenge"
        : "takeover",
    ...(event.state.request?.id ? { requestId: event.state.request.id } : {}),
    ...(reason ? { reason: reason.slice(0, 500) } : {}),
    ...(event.pointAt ? { targetRef: event.pointAt } : {}),
  };
}

/** A secret request has no request id of its own: its field and snapshot name it. */
function secretRequestId(event: ComputerControlEvent): string {
  return `secret:${event.state.secretRef ?? ""}:${event.state.secretSnapshotId ?? ""}`;
}

/** What a suspended run is waiting on, as a trigger, or null when it is nothing on the screen. */
export function waitTrigger(wait: HeadlessWait): ClickyTrigger | null {
  const waiting = wait.waiting;
  const requestId =
    typeof waiting.requestId === "string" ? waiting.requestId : undefined;
  const reason = wait.message?.trim().slice(0, 500);
  const base = {
    ...(requestId ? { requestId } : {}),
    ...(reason ? { reason } : {}),
  };
  switch (waiting.kind) {
    case "computer_sign_in":
      return { kind: "sign_in", ...base };
    case "computer_handoff":
      return {
        kind:
          waiting.source === "cloudflare" ||
          waiting.source === "visible-challenge"
            ? "challenge"
            : "takeover",
        ...base,
      };
    // Only an approval the person carries out themselves is about the screen.
    case "approval":
      return waiting.handoff === true ? { kind: "approval", ...base } : null;
    default:
      return null;
  }
}

export function createClickyActivation(deps: {
  service: Pick<ClickyService, "dispatch" | "preferences">;
  needsYou?: NeedsYou;
  /**
   * Whether the person may use that Bot's computer. Asked before a session is opened, a phone is
   * told or the model looks: the event names a person, and that alone is not access.
   */
  canUseComputer?: (userId: string, botId: string) => Promise<boolean>;
}): ClickyActivation {
  /** The secret request open per person and Bot, so its end can resolve it. */
  const secrets = new Map<string, string>();
  /** Which person and Bot each running thread belongs to, from its start to its end. */
  const runs = new Map<string, { userId: string; botId: string }>();
  /** Threads whose run stopped to wait on the person: their next release is not an end. */
  const suspended = new Set<string>();
  /**
   * The request each suspended thread opened Clicky for. The person answering it (the private
   * sign-in form, an approval) is what lets the thread run again, so its next start resolves it.
   */
  const waitsOn = new Map<
    string,
    { userId: string; botId: string; requestId: string }
  >();

  const activate = async (
    userId: string,
    botId: string,
    trigger: ClickyTrigger,
  ) => {
    if (deps.canUseComputer && !(await deps.canUseComputer(userId, botId)))
      return;
    const preferences = await deps.service.preferences(userId);
    if (!preferences.autoActivate) return;
    const outcome = await deps.service.dispatch(userId, botId, {
      type: "command",
      command: { type: "activate", trigger },
    });
    // A repeat of a request already showing changes nothing, and is not sent to the phone again.
    if (outcome?.changed && deps.needsYou)
      await deps.needsYou({ userId, botId, trigger });
  };

  const resolve = (
    userId: string,
    botId: string,
    requestId: string,
    outcome: "completed" | "cancelled" | "expired",
  ) =>
    deps.service.dispatch(
      userId,
      botId,
      { type: "takeover.resolved", requestId, outcome },
      { onlyIfOpen: true },
    );

  const quietly = (work: Promise<unknown>) => {
    void work.catch((error: unknown) =>
      console.warn(
        JSON.stringify({
          type: "clicky-activation-failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      ),
    );
  };

  return {
    onControlEvent(event) {
      const { userId, botId } = event;
      if (!userId) return;
      const requestId = event.state.request?.id;
      switch (event.type) {
        case "help_requested":
          // Clicky's own request, or the person's own Take control: nobody needs them.
          if (event.reason === CLICKY_HELP_REASON || event.source === "manual")
            return;
          quietly(activate(userId, botId, helpTrigger(event)));
          return;
        case "secret_requested": {
          const id = secretRequestId(event);
          secrets.set(`${userId}\u0000${botId}`, id);
          quietly(
            activate(userId, botId, {
              kind: "secret",
              requestId: id,
              ...(event.reason ? { reason: event.reason.slice(0, 500) } : {}),
              ...(event.state.secretRef
                ? { targetRef: event.state.secretRef }
                : {}),
            }),
          );
          return;
        }
        case "secret_supplied":
        case "secret_cancelled": {
          const key = `${userId}\u0000${botId}`;
          const id = secrets.get(key);
          if (!id) return;
          secrets.delete(key);
          quietly(
            resolve(
              userId,
              botId,
              id,
              event.type === "secret_supplied" ? "completed" : "cancelled",
            ),
          );
          return;
        }
        case "control_released":
          if (requestId)
            quietly(resolve(userId, botId, requestId, "completed"));
          return;
        case "help_cancelled":
          if (requestId)
            quietly(resolve(userId, botId, requestId, "cancelled"));
          return;
        case "control_taken":
          // The person has the wheel; Clicky keeps pointing until they hand it back.
          return;
      }
    },

    onWaiting({ userId, botId, wait }) {
      suspended.add(wait.threadId);
      if (suspended.size > 1000) {
        const oldest = suspended.values().next().value;
        if (oldest !== undefined) suspended.delete(oldest);
      }
      /*
       * A run that met a person holding the computer under their own Take control, or under
       * Clicky's, waits for them; it does not need them. Decided on the request it met, not on the
       * words of the refusal.
       */
      if (notTheBots(wait.waiting.handoff)) return;
      const trigger = waitTrigger(wait);
      if (!trigger) return;
      if (trigger.requestId) {
        waitsOn.set(wait.threadId, {
          userId,
          botId,
          requestId: trigger.requestId,
        });
        if (waitsOn.size > 1000) {
          const oldest = waitsOn.keys().next().value;
          if (oldest !== undefined) waitsOn.delete(oldest);
        }
      }
      quietly(activate(userId, botId, trigger));
    },

    onRunBusy({ threadId, busy, userId, agentId }) {
      if (busy) {
        /*
         * A thread that waited on the person runs again: they answered (live: the Taxisnet sign-in
         * filled from a saved login), so "Noë Bot needs you here" closes and its steps go.
         */
        const answered = waitsOn.get(threadId);
        if (answered) {
          waitsOn.delete(threadId);
          quietly(
            resolve(
              answered.userId,
              answered.botId,
              answered.requestId,
              "completed",
            ),
          );
        }
        if (userId && agentId) runs.set(threadId, { userId, botId: agentId });
        // A run whose end was never heard is forgotten eventually, oldest first.
        if (runs.size > 1000) {
          const oldest = runs.keys().next().value;
          if (oldest !== undefined) runs.delete(oldest);
        }
        return;
      }
      const run = runs.get(threadId);
      runs.delete(threadId);
      // Waiting on the person is not finishing: the run picks up again once they are done.
      if (suspended.delete(threadId)) return;
      if (!run) return;
      // No words of its own: the notice ("Noë Bot finished.") says it, in the person's language.
      quietly(
        deps.service.dispatch(
          run.userId,
          run.botId,
          { type: "bot.finished", summary: "" },
          { onlyIfOpen: true },
        ),
      );
    },
  };
}
