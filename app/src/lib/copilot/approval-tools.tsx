import {
  type ReactFrontendTool,
  useCopilotKit,
  useFrontendTool as useSDKFrontendTool,
} from "@copilotkit/react-core/v2";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect } from "react";
import { InlineApproval } from "@/components/approvals/inline-approval";
import { tryClient } from "@/lib/client";
import { noteBrowsed, recordActivity } from "@/lib/computers/activity";
import {
  browsingStepsFor,
  observeToolCall,
  stepsWhenAsked,
} from "@/lib/computers/browsing-steps";
import {
  awaitServerWait,
  claimServerWait,
  readServerWait,
  type ServerWait,
  stopServerWait,
} from "@/lib/computers/handoff";
import { noteComputerActivity } from "@/lib/computers/use-computer-sleep";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { useActiveBotHolder } from "./active-bot";
import { frontendApprovalSnapshot } from "./approval-context";
import { reportComputerActivity } from "./computer-activity";

type RenderProps = {
  toolCallId: string;
  name?: string;
  args?: unknown;
  status?: string;
  result?: string;
  [key: string]: unknown;
};

const writes = new Set([
  "computer_click",
  "computer_type",
  "computer_key",
  "computer_fill",
  "computer_select",
  "computer_check",
  "computer_upload",
  "computer_dialog",
  "computer_run_command",
  "computer_write_file",
]);

/**
 * Which calls this page has seen being made, and which of those it has seen answered, so each is
 * put in the Activity list once however often the transcript redraws it. A call that first appears
 * already answered is history being restored, not something the Bot is doing now.
 */
const liveCalls = new Set<string>();
const askedCalls = new Set<string>();
const answeredCalls = new Set<string>();

function record(botId: string, steps: () => ReturnType<typeof stepsWhenAsked>) {
  try {
    for (const step of steps()) recordActivity(botId, step);
  } catch {
    // A line missing from a pane, never a failed tool call.
  }
}

function parsedResult(result: string | undefined): unknown {
  if (result === undefined) return undefined;
  try {
    return JSON.parse(result);
  } catch {
    return result;
  }
}

/**
 * What a computer call means for the panel around it, read from how it is drawn.
 *
 * With COMPUTER_TOOLS_IN_RUN the server carries the call out, so no browser handler runs to say so:
 * the transcript drawing it is the one place this page sees it. Made (still running): the sleeping
 * view wakes and the live screen may open. Its arguments complete (executing here, or answered):
 * the line a request for help adds when asked. Answered: its browsing steps.
 */
export function reportDrawnCall(
  botId: string,
  props: RenderProps,
  name: string,
): void {
  if (!name.startsWith("computer_") || !botId) return;
  const id = props.toolCallId;
  const answered = props.status === "complete" || props.result !== undefined;
  if (!answered && !liveCalls.has(id)) {
    liveCalls.add(id);
    noteComputerActivity(botId);
    reportComputerActivity(botId);
  }
  if (!liveCalls.has(id)) return;
  if ((props.status === "executing" || answered) && !askedCalls.has(id)) {
    askedCalls.add(id);
    record(botId, () => stepsWhenAsked(name, props.args));
  }
  if (answered && !answeredCalls.has(id)) {
    answeredCalls.add(id);
    const result = parsedResult(props.result);
    record(botId, () => browsingStepsFor(name, props.args, result));
    if (
      name === "computer_navigate" &&
      result &&
      typeof result === "object" &&
      "ok" in result &&
      result.ok === true
    )
      noteBrowsed(botId);
  }
}

function DrawnCall({
  botId,
  name,
  props,
}: {
  botId: string;
  name: string;
  props: RenderProps;
}) {
  const { toolCallId, status, result } = props;
  // biome-ignore lint/correctness/useExhaustiveDependencies: reported per call state, not per redraw.
  useEffect(() => {
    reportDrawnCall(botId, props, name);
  }, [botId, name, toolCallId, status, result]);
  return null;
}

/**
 * Route computer changes through the server's durable approval gate, and draw a pending decision
 * inline where the action would have been.
 *
 * EVERY CHANGE GOES THROUGH THE GATE, not only when "Ask before making changes" is on. The server
 * decides, and it can ask for reasons the browser cannot see: a team rule, a safety requirement, the
 * auto-review model. It used to read the person's switch here, and the SDK registers a tool's
 * handler once and never again (its registration effect does not depend on the handler), so the
 * handler kept the switch as it was on first render, usually still loading. Every change then went
 * straight to the computer outside any run, and the gate could only answer "this action needs an
 * authenticated run". Nothing in this handler may depend on render-time state for that reason.
 *
 * COMPUTER_TOOLS_IN_RUN changes who carries a call out, not what is drawn. The server executes each
 * call inside the run, so this handler only ever runs for a call the run left unanswered: one the
 * server stopped on to wait for the person (a sign-in, a takeover, a secret, an approval), which it
 * resumes here, or one the server has no executor for, which the browser carries out as before. The
 * tool is registered again when the capability arrives, so the handler matches the server.
 */
export function useFrontendTool<T extends Record<string, unknown>>(
  tool: ReactFrontendTool<T>,
) {
  const { copilotkit } = useCopilotKit();
  // Stable for the provider's life, so the SDK's once-registered handler may keep it.
  const queryClient = useQueryClient();
  const bot = useActiveBotHolder();
  /*
   * Read from the cache the provider fills, never fetched from here: every tool would otherwise ask,
   * and until it is answered the handler is the browser's, as it always was.
   */
  const { data: capabilities } = useQuery({
    ...deploymentCapabilitiesQueryOptions(),
    enabled: false,
  });
  const inRun = capabilities?.computerToolsInRun === true;
  const render = tool.render;
  type Handler = NonNullable<ReactFrontendTool<T>["handler"]>;
  /*
   * EVERY COMPUTER TOOL, HOWEVER IT IS CARRIED OUT. A click or a typed field is run by the server's
   * gate below and never reaches the tool's own handler, so this is the one place that sees each
   * computer call once: it wakes a sleeping computer view as the call is made, and puts the call's
   * browsing steps in the Activity list (`observeToolCall`). In-run, the drawing does it instead.
   */
  const observed =
    (run: Handler): Handler =>
    (args, context) =>
      observeToolCall(bot.current, tool.name, args, () => run(args, context));
  /** The browser carrying a call out, writes through the server's gate. */
  const carryOut: Handler | undefined = tool.handler
    ? async (args, context) => {
        if (!writes.has(tool.name)) return tool.handler?.(args, context);
        let snapshot: ReturnType<typeof frontendApprovalSnapshot>;
        try {
          snapshot = frontendApprovalSnapshot(context);
        } catch {
          // A surface with no observed conversation. The server still gates the action; it can
          // run it when nothing asks, and says why when something does.
          return tool.handler?.(args, context);
        }
        const path = `/api/approvals/computer/${encodeURIComponent(bot.current)}`;
        let response = await tryClient(path, {
          method: "POST",
          body: snapshot,
          signal: context.signal,
        });
        /*
         * 503 is the gate saying the conversation service did not answer, which is a moment's
         * trouble more often than not. One more try, a second later, before the Bot is told.
         */
        if (response.status === 503 && !context.signal?.aborted) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          response = await tryClient(path, {
            method: "POST",
            body: snapshot,
            signal: context.signal,
          });
        }
        const payload: unknown = await response.json();
        if (response.status === 202) {
          if (!context.agent)
            throw new Error("The interrupted conversation is unavailable.");
          // Stop signals the SDK to discard this handler's unfinished result. The server owns
          // resume: the decision executes the action once and continues this conversation.
          copilotkit.stopAgent({ agent: context.agent });
          // Draw the card now rather than on the inbox's next poll.
          void queryClient.invalidateQueries({ queryKey: ["approvals"] });
          return { waiting: true };
        }
        /*
         * A refusal or a failure is RETURNED, not thrown. A thrown handler ends the turn with
         * nothing persisted: the person sees a step that was never completed and the Bot never
         * learns what happened. A result with `ok: false` is what every other computer failure
         * looks like, so the transcript draws "didn't work" with the reason, and the Bot can say
         * so, try again, or ask the person.
         */
        if (!response.ok)
          return {
            ok: false,
            reason:
              payload &&
              typeof payload === "object" &&
              "error" in payload &&
              typeof payload.error === "string"
                ? payload.error
                : "The computer action could not be approved.",
            retryable: response.status === 503,
          };
        if (!payload || typeof payload !== "object" || !("result" in payload))
          throw new Error("The computer action returned no result.");
        return payload.result;
      }
    : undefined;
  /**
   * In-run: resume a call the server stopped on, or carry out one the server did not run.
   *
   * The tab resumes the run itself when the person answers, so the answer streams in front of them:
   * it claims the wait (exactly one of this tab and the server continues it) and returns the tool
   * result the server built from the request, which the SDK appends before starting the
   * continuation run. Continued elsewhere, or an approval (the server always resumes those), the
   * run is stopped here instead, and the continuation arrives with the conversation's history.
   */
  const resume: Handler | undefined = carryOut
    ? async (args, context) => {
        const threadId = context.agent?.threadId;
        const toolCallId = context.toolCall?.id;
        let wait: ServerWait | null = null;
        if (threadId && toolCallId) {
          try {
            wait = await readServerWait(threadId, toolCallId, context.signal);
          } catch {
            return {
              ok: false,
              retryable: true,
              reason:
                "The paused step could not be checked. Nothing was done twice; ask to try again.",
            };
          }
        }
        if (!wait || !threadId || !toolCallId) return carryOut(args, context);
        const handBack = () => {
          if (context.agent) copilotkit.stopAgent({ agent: context.agent });
          return { waiting: true };
        };
        if (wait.kind === "approval") {
          void queryClient.invalidateQueries({ queryKey: ["approvals"] });
          return handBack();
        }
        const answered =
          wait.status === "waiting"
            ? await awaitServerWait(threadId, toolCallId, context.signal)
            : wait.status;
        if (answered === "stopped") {
          // The person stopped the turn: the server must not continue it either.
          await stopServerWait(threadId, toolCallId);
          return { ok: false, stopped: true, reason: "Stopped waiting." };
        }
        if (answered === "ready") {
          const content = await claimServerWait(
            threadId,
            toolCallId,
            context.signal,
          ).catch(() => null);
          if (content !== null) return parsedResult(content);
        }
        return handBack();
      }
    : undefined;
  useSDKFrontendTool(
    {
      ...tool,
      ...(writes.has(tool.name) || inRun
        ? {
            // A component, so the approval card can use hooks; the SDK keeps this function forever.
            render: (props: RenderProps) => {
              const Original = render as
                | ((props: RenderProps) => ReactNode)
                | undefined;
              const drawn = Original ? <Original {...props} /> : null;
              return (
                <>
                  {inRun ? (
                    <DrawnCall
                      botId={bot.current}
                      name={tool.name}
                      props={props}
                    />
                  ) : null}
                  {writes.has(tool.name) ? (
                    <InlineApproval
                      toolCallId={props.toolCallId}
                      fallback={drawn}
                    />
                  ) : (
                    drawn
                  )}
                </>
              );
            },
          }
        : {}),
      handler: inRun ? resume : carryOut ? observed(carryOut) : undefined,
    },
    [inRun],
  );
}
