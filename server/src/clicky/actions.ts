import type {
  ClickyAction,
  ClickyProposal,
  ClickyTriggerKind,
} from "../../../shared/clicky";
import type { ClickyActionPolicy } from "../../../shared/user-preferences";
import { type AuditStore, PERSON_INITIATOR, recordAuditEvent } from "../audit";
import {
  type ActionActor,
  type ComputerGateway,
  intentOf,
} from "../computer/gateway";
import {
  evaluateActionPolicy,
  type PolicyContext,
  policyInitiator,
} from "../computer/policy";
import type { ElementAtResult, HumanInput } from "../computer/schema";
import { assessAction, RISK_RANK } from "./guardrails";
import { placeElements, toScreenPixels } from "./screen";

/**
 * Carrying out what the person approved, as the person.
 *
 * Clicky never acts as the Bot. An approved action is the person's own mouse and keyboard, sent
 * through the same path as their input on the live screen, once they hold the computer: if nobody
 * does, Clicky asks for it on their behalf and takes it as them, and leaves it with them afterwards.
 * So a Bot that is mid-run is told a person has control, exactly as when they take over by hand.
 *
 * Nothing runs on the strength of the approval alone. Just before acting, the page is asked again
 * what is at the point, the guardrails rate the action again on that, and the boundary's deny rules
 * are asked as for any action: a field that turned into a password box, a button that became "Pay",
 * or a rule an administrator wrote all stop it, and the person is told why.
 */

/** The words Clicky's own request for control carries, so its own handover does not reopen it. */
export const CLICKY_HELP_REASON = "Clicky is doing this for you";

export type ActionOutcome = { ok: true } | { ok: false; detail: string };

export type ClickyActions = {
  run(input: {
    userId: string;
    botId: string;
    proposal: ClickyProposal;
    actionPolicy: ClickyActionPolicy;
    trigger: ClickyTriggerKind | null;
    signal: AbortSignal;
  }): Promise<ActionOutcome>;
};

type Gateway = Pick<
  ComputerGateway,
  | "elements"
  | "elementAt"
  | "control"
  | "requestHelp"
  | "takeControl"
  | "humanInput"
  | "actionPolicy"
>;

const TOOL: Record<ClickyAction["kind"], string> = {
  click: "computer_click",
  type: "computer_type",
  key: "computer_key",
  scroll: "computer_scroll",
};

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/** The policy context for a person's input, every field bound like the gateway's own. */
export function personPolicyContext(input: {
  action: ClickyAction;
  botId: string;
  actor: ActionActor;
  pageUrl: string;
  element: ElementAtResult | undefined;
}): PolicyContext {
  const toolName = TOOL[input.action.kind];
  const key = input.action.kind === "key" ? input.action.keys : undefined;
  const intent = intentOf(toolName, key);
  return {
    tool: { name: toolName },
    bot: { id: input.botId },
    actor: { id: input.actor.id },
    page: { url: input.pageUrl, host: hostOf(input.pageUrl) },
    ...(intent ? { intent } : {}),
    key: key ?? "",
    element:
      input.element?.inPage !== false && input.element
        ? {
            ref: input.element.ref ?? "",
            role: input.element.role,
            name: input.element.name,
            type: "",
          }
        : { ref: "", role: "", name: "", type: "" },
    file: { path: "", name: "", extension: "" },
    command: "",
    initiator: policyInitiator(input.actor.initiator),
    mcp: { server: "", tool: "", effect: "" },
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createClickyActions(deps: {
  gateway: Gateway;
  auditStore?: AuditStore;
}): ClickyActions {
  const { gateway } = deps;

  /**
   * The person's input, retried briefly when the computer says the wheel is not free yet: a takeover
   * waits for the Bot's action in flight to finish before the person may drive.
   */
  async function input(
    botId: string,
    gesture: HumanInput,
    signal: AbortSignal,
  ) {
    for (let attempt = 0; ; attempt += 1) {
      signal.throwIfAborted();
      try {
        return await gateway.humanInput(botId, gesture);
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (attempt >= 4 || !/control/i.test(message)) throw error;
        await sleep(250);
      }
    }
  }

  /** The person holds the computer: asked for and taken in their name if they do not yet. */
  async function holdAsPerson(botId: string, actor: ActionActor) {
    const state = await gateway.control(botId);
    if (state.holder === "human") return;
    const waiting =
      state.request?.status === "waiting" ? state.request.id : undefined;
    const requestId =
      waiting ??
      (await gateway.requestHelp(botId, actor, CLICKY_HELP_REASON)).request?.id;
    if (!requestId) throw new Error("The computer did not hand over control.");
    await gateway.takeControl(botId, actor, requestId);
  }

  return {
    async run({ userId, botId, proposal, actionPolicy, trigger, signal }) {
      const actor: ActionActor = {
        id: userId,
        userId,
        initiator: PERSON_INITIATOR,
      };
      const { action } = proposal;
      const screen = await gateway.elements(botId);
      signal.throwIfAborted();
      const at = action.kind === "key" ? undefined : (action.at ?? undefined);
      const pixels = at ? toScreenPixels(at, screen.screen) : undefined;
      const probe = pixels ? await gateway.elementAt(botId, pixels) : undefined;
      signal.throwIfAborted();
      const focused = placeElements(screen).find((element) => element.focused);

      // Rated again on what is there now. Worse than what the person said yes to is not done.
      const fresh = assessAction(action, {
        actionPolicy,
        ...(probe
          ? {
              target: {
                role: probe.role,
                name: probe.name,
                sensitive: probe.sensitive,
                inPage: probe.inPage,
              },
            }
          : {}),
        ...(focused ? { focused } : {}),
        trigger,
        botId,
        actorId: userId,
        pageHost: hostOf(probe?.url ?? screen.url),
      });
      if (
        fresh.risk === "yours" ||
        fresh.risk === "blocked" ||
        RISK_RANK[fresh.risk] > RISK_RANK[proposal.risk]
      ) {
        const detail =
          fresh.risk === "yours" || fresh.risk === "blocked"
            ? (fresh.reason ?? "This one is yours.")
            : "What is there now needs a fresh yes.";
        if (deps.auditStore)
          await recordAuditEvent(deps.auditStore, {
            eventType: "clicky.action_blocked",
            targetType: "computer",
            targetId: botId,
            actorUserId: userId,
            initiator: PERSON_INITIATOR,
            payload: {
              botId,
              proposalId: proposal.id,
              action: action.kind,
              risk: fresh.risk,
              reason: fresh.reason ?? null,
              stage: "before acting",
            },
          }).catch(() => undefined);
        return { ok: false, detail };
      }

      /*
       * The boundary's deny rules, as for any action on this computer. Only the deny list: the allow
       * list says what a Bot may do on its own, and this is the person's own input, which no allow
       * rule was written for. An enterprise control switched off still refuses (policy.ts).
       */
      const policy = gateway.actionPolicy(botId);
      const decision = evaluateActionPolicy(
        {
          mode: policy?.mode ?? "enforce",
          deny: policy?.deny ?? [],
          allow: ["true"],
        },
        personPolicyContext({
          action,
          botId,
          actor,
          pageUrl: probe?.url || screen.url,
          element: probe,
        }),
      );
      if (!decision.forward) return { ok: false, detail: decision.reason };

      await holdAsPerson(botId, actor);
      signal.throwIfAborted();

      const space: Pick<HumanInput, "space"> =
        screen.mode === "desktop" ? { space: "screen" } : {};
      switch (action.kind) {
        case "click": {
          if (!pixels)
            return { ok: false, detail: "There is nowhere to click." };
          await input(
            botId,
            {
              kind: "click",
              ...pixels,
              ...(action.button === "right" ? { button: "right" } : {}),
              ...(action.double ? { double: true } : {}),
              ...space,
            },
            signal,
          );
          break;
        }
        case "type": {
          if (pixels)
            await input(botId, { kind: "click", ...pixels, ...space }, signal);
          await input(
            botId,
            { kind: "type", text: action.text, ...space },
            signal,
          );
          break;
        }
        case "key":
          await input(
            botId,
            { kind: "key", key: action.keys, ...space },
            signal,
          );
          break;
        case "scroll":
          await input(
            botId,
            {
              kind: "scroll",
              deltaY: action.deltaY,
              ...(pixels ?? {}),
              ...space,
            },
            signal,
          );
          break;
      }
      return { ok: true };
    },
  };
}
