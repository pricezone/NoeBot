import type {
  ClickyAction,
  ClickyProposal,
  ClickyTriggerKind,
} from "../../../shared/clicky";
import { CLICKY_HELP_REASON } from "../../../shared/clicky";
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
import {
  assessAction,
  guardFocusOf,
  guardTargetOf,
  RISK_RANK,
} from "./guardrails";
import { toScreenPixels } from "./screen";

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
 * or a rule an administrator wrote all stop it, and the person is told why. That holds for an action
 * run on "Allow for this session" too: the yes was for everyday actions on this session, not for one
 * element, so what is there is rated afresh and anything that is no longer everyday is not done.
 *
 * Clicks and the wheel are the desktop's pointer (XTEST), with the window under it checked. Typing
 * and the page's own keys go through the page's keyboard, once the field meant has the focus
 * (agent-computer `page-keyboard.ts`): it cannot reach another window. A scroll to a control off the
 * screen brings it into view by its ref, inside the page.
 */

/**
 * The keys the page itself takes, pressed through the page's keyboard. The rest of the everyday
 * keys (the address bar, a new tab, find, a paste) are the browser's, and go through the desktop's
 * keyboard as before.
 */
const PAGE_KEYS = new Set([
  "Enter",
  "Tab",
  "Shift+Tab",
  "Escape",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Backspace",
  "Delete",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Space",
  "Control+a",
  "Control+c",
  "Control+x",
  "Control+z",
  "Control+y",
  "Control+Shift+z",
]);

/** The words Clicky's own request for control carries, so its own handover does not reopen it. */
export { CLICKY_HELP_REASON };

export type ActionOutcome =
  /** `audit`: what was done, as found just before, for the performed row. Never the text typed. */
  | { ok: true; audit: Record<string, string | number | boolean | null> }
  | { ok: false; detail: string };

export type ClickyActions = {
  run(input: {
    userId: string;
    botId: string;
    proposal: ClickyProposal;
    actionPolicy: ClickyActionPolicy;
    trigger: ClickyTriggerKind | null;
    signal: AbortSignal;
    /** Run on "Allow for this session" rather than a yes for this proposal. */
    viaGrant?: boolean;
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
  | "focus"
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

/** The same page, whatever its fragment says. */
function samePage(a: string, b: string): boolean {
  try {
    const left = new URL(a);
    const right = new URL(b);
    left.hash = "";
    right.hash = "";
    return left.toString() === right.toString();
  } catch {
    return a === b;
  }
}

export function createClickyActions(deps: {
  gateway: Gateway;
  auditStore?: AuditStore;
  /**
   * Who holds each computer, by person, as the handover events said: null for the Bot, undefined
   * when it is not known here (taken before this process started).
   */
  holderOf?: (botId: string) => string | null | undefined;
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

  /**
   * The person holds the computer: asked for and taken in their name if nobody does. When a person
   * already holds it, it must be this one: Clicky never acts on a computer somebody else has taken.
   * Answers why not, or null.
   */
  async function holdAsPerson(
    botId: string,
    actor: ActionActor,
  ): Promise<string | null> {
    const state = await gateway.control(botId);
    if (state.holder === "human") {
      const holder = deps.holderOf?.(botId);
      if (holder === actor.userId) return null;
      return holder === undefined
        ? "I can't tell who has the computer right now. Hand it back, then try again."
        : "Someone else has the computer right now, so I did nothing.";
    }
    const waiting =
      state.request?.status === "waiting" ? state.request.id : undefined;
    const requestId =
      waiting ??
      (await gateway.requestHelp(botId, actor, CLICKY_HELP_REASON)).request?.id;
    if (!requestId) throw new Error("The computer did not hand over control.");
    await gateway.takeControl(botId, actor, requestId);
    return null;
  }

  const refuse = async (
    botId: string,
    userId: string,
    proposal: ClickyProposal,
    detail: string,
    payload: Record<string, string | number | boolean | null>,
  ): Promise<ActionOutcome> => {
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
          action: proposal.action.kind,
          stage: "before acting",
          ...payload,
        },
      }).catch(() => undefined);
    return { ok: false, detail };
  };

  return {
    async run({
      userId,
      botId,
      proposal,
      actionPolicy,
      trigger,
      signal,
      viaGrant,
    }) {
      const actor: ActionActor = {
        id: userId,
        userId,
        initiator: PERSON_INITIATOR,
      };
      const { action } = proposal;

      /*
       * The computer first, then the look. Once the person holds it the Bot cannot act on it, so
       * the page read next is the page the action lands on: looking first left a gap in which the
       * Bot could move the page under an action that had already been checked.
       */
      const notHeld = await holdAsPerson(botId, actor);
      if (notHeld)
        return refuse(botId, userId, proposal, notHeld, {
          reason: "control",
        });
      signal.throwIfAborted();

      const screen = await gateway.elements(botId);
      signal.throwIfAborted();
      const desktop = screen.mode === "desktop";
      const at = action.kind === "key" ? undefined : (action.at ?? undefined);
      const pointed =
        action.kind === "click" || action.kind === "scroll" || Boolean(at);
      const pixels = at ? toScreenPixels(at, screen.screen) : undefined;
      // On a desktop the pointer goes there and the X server says which window it is over.
      const probe = pixels
        ? await gateway.elementAt(botId, pixels, { verifyWindow: desktop })
        : undefined;
      const focus = pointed ? undefined : await gateway.focus(botId);
      signal.throwIfAborted();
      const target = probe ? guardTargetOf(probe) : undefined;
      const focused = focus ? guardFocusOf(focus) : undefined;
      const now = pointed ? target : focused;
      const url = probe?.url || focus?.url || screen.url;

      /*
       * The same page the person was asked about, always, whatever the action. The same element
       * too, when both readings are of something on the page: a place now covered by another window
       * is not "changed", it is outside the page, and the rating below asks about it again.
       */
      const seen = proposal.seen;
      const changed =
        seen &&
        (!samePage(seen.url, url) ||
          (seen.ref !== undefined &&
            probe?.ref !== undefined &&
            seen.ref !== probe.ref) ||
          (seen.role !== undefined &&
            now?.inPage !== false &&
            (!now || now.role !== seen.role || now.name !== seen.name)));
      if (changed)
        return refuse(
          botId,
          userId,
          proposal,
          "The page changed since I asked, so I did nothing. Ask again.",
          { reason: "changed" },
        );
      // Rated again on what is there now. Worse than what the person said yes to is not done.
      const fresh = assessAction(action, {
        actionPolicy,
        ...(target ? { target } : {}),
        ...(focused ? { focused } : {}),
        trigger,
        botId,
        actorId: userId,
        pageHost: hostOf(url),
      });
      if (
        fresh.risk === "yours" ||
        fresh.risk === "blocked" ||
        RISK_RANK[fresh.risk] > RISK_RANK[proposal.risk]
      )
        return refuse(
          botId,
          userId,
          proposal,
          fresh.risk === "yours" || fresh.risk === "blocked"
            ? (fresh.reason ?? "This one is yours.")
            : "What is there now needs a fresh yes.",
          { risk: fresh.risk, reason: fresh.reason ?? null },
        );

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
          pageUrl: url,
          element: probe,
        }),
      );
      if (!decision.forward)
        return refuse(botId, userId, proposal, decision.reason, {
          reason: "policy",
          rule: decision.matched,
        });

      /*
       * On a desktop, an action the person approved on the page is pressed only if the browser is
       * still the window that takes it at that moment; one they approved off the page knowingly is
       * pressed where it was approved.
       */
      const space: Pick<HumanInput, "space" | "requireBrowser"> = desktop
        ? {
            space: "screen",
            ...(now?.inPage !== false ? { requireBrowser: true } : {}),
          }
        : {};
      /*
       * The page's keyboard for what lands on the page; the desktop's only for what the person
       * approved off it knowingly (the browser's own bar), where the page's cannot reach.
       */
      const pageKeyboard = !desktop || now?.inPage !== false;
      const typedAt = pixels ? { at: pixels } : {};
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
            pageKeyboard
              ? {
                  kind: "type",
                  text: action.text,
                  keyboard: "page",
                  ...typedAt,
                }
              : { kind: "type", text: action.text, ...space },
            signal,
          );
          // Its own key after the text, rated as Enter on that field (guardrails.ts).
          if (action.pressEnter)
            await input(
              botId,
              pageKeyboard
                ? { kind: "key", key: "Enter", keyboard: "page", ...typedAt }
                : { kind: "key", key: "Enter", ...space },
              signal,
            );
          break;
        }
        case "key":
          await input(
            botId,
            pageKeyboard && PAGE_KEYS.has(action.keys)
              ? { kind: "key", key: action.keys, keyboard: "page" }
              : { kind: "key", key: action.keys, ...space },
            signal,
          );
          break;
        case "scroll":
          await input(
            botId,
            action.ref
              ? { kind: "scroll-into-view", ref: action.ref }
              : {
                  kind: "scroll",
                  deltaY: action.deltaY,
                  ...(pixels ?? {}),
                  ...space,
                },
            signal,
          );
          break;
      }
      return {
        ok: true,
        audit: {
          label: action.label,
          modelLabel: action.modelLabel ?? null,
          role: now?.role ?? null,
          name: now?.name ?? null,
          host: hostOf(url),
          // How much was typed, or which keys: never the text.
          ...(action.kind === "type" ? { characters: action.text.length } : {}),
          ...(action.kind === "type" && action.pressEnter
            ? { keys: "Enter" }
            : {}),
          ...(action.kind === "key" ? { keys: action.keys } : {}),
          ...(action.kind === "scroll" && action.ref ? { intoView: true } : {}),
          ...(viaGrant ? { viaGrant: true, scope: "session" } : {}),
        },
      };
    },
  };
}
