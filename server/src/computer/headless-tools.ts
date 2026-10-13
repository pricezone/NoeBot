import {
  AbstractAgent,
  type BaseEvent,
  EventType,
  type Message,
  Middleware,
  type RunAgentInput,
  type RunFinishedEvent,
  type Tool,
  type ToolCall,
} from "@ag-ui/client";
import { Observable, type Subscription } from "rxjs";
import { z } from "zod";
import { SIGN_IN_TOOL_DESCRIPTION } from "../../../shared/sign-in-guidance";
import {
  type ApprovalContinuation,
  currentApprovalContext,
  withApprovalContext,
} from "../approvals/types";
import {
  type AuditInitiator,
  type AuditStore,
  recordAuditEvent,
} from "../audit";
import { now, recordPhase } from "../run-timing";
import {
  type ActionActor,
  type ComputerGateway,
  HumanHasControlError,
} from "./gateway";
import type { PageFrameStore } from "./page-frames";
import type { ControlState } from "./schema";
import { showScreen } from "./show-screen";

/** Client tools supplied by OpenBot when the caller has no browser. */
export type HeadlessTool = {
  definition: Tool;
  /**
   * Executed when called but never offered to the model. For a tool the Bot does not hold, so a
   * call it makes anyway gets a governed refusal rather than going unanswered.
   */
  hidden?: boolean;
  execute(
    args: unknown,
    context: { toolCallId: string; signal: AbortSignal },
  ): Promise<unknown>;
};

export type HeadlessWaiting = {
  kind: string;
  requestId?: string;
  [key: string]: unknown;
};

/** A durable request remains open; continuing the Bot would invent a human answer. */
export class HeadlessToolSuspension extends Error {
  constructor(
    message: string,
    readonly waiting: HeadlessWaiting,
  ) {
    super(message);
    this.name = "HeadlessToolSuspension";
  }
}

const MAX_TOOL_SEGMENTS = 30;

/** What a person's chat run is told when it ends silently twice in a row after a tool step. */
export const SILENT_TURN_MESSAGE =
  "The Bot stopped after a computer step without saying what happened. Ask it to continue.";

/** One suspension, as the run hands it to whoever will resume it. */
export type HeadlessWait = {
  threadId: string;
  runId: string;
  toolCallId: string;
  toolName: string;
  waiting: HeadlessWaiting;
  message: string;
};

export type HeadlessToolsOptions = {
  /**
   * A person's chat run, with the browser still offering its own same-named tools.
   *
   * Only the tools the caller offered are taken over, and the caller's definitions are kept, so the
   * model sees exactly the tools it saw when the browser carried them out; a computer tool the server
   * has no executor for stays the browser's. Each call starts executing as soon as the model has
   * finished writing it. A suspended run ends with a plain finish, not an interrupt outcome: the tab
   * or the server resumes it with the tool result, and the browser agent must not be left holding an
   * interrupt the next turn cannot answer. A run that ends without a word after a tool step is given
   * one more model turn, and failed out loud if that is silent too.
   */
  interactive?: boolean;
  /** How many model turns one run may take. */
  maxSegments?: number;
  /** Told about each suspension before the run ends, so whoever resumes it can find it. */
  onWaiting?: (wait: HeadlessWait) => Promise<void>;
};

type Outcome =
  | { message: Message & { role: "tool" }; error?: string }
  | { suspension: HeadlessToolSuspension; continuation: ApprovalContinuation }
  | { skipped: true };

/**
 * Executes AG-UI client tools inside the Intelligence run. Backend results are
 * forwarded unchanged; only newly emitted unanswered calls can be executed.
 */
export class HeadlessToolsMiddleware extends Middleware {
  constructor(
    private readonly tools: HeadlessTool[],
    private readonly initiator?: AuditInitiator,
    private readonly options: HeadlessToolsOptions = {},
  ) {
    super();
    const names = tools.map((tool) => tool.definition.name);
    if (new Set(names).size !== names.length)
      throw new Error("Headless tool names must be unique.");
  }

  run(
    originalInput: RunAgentInput,
    next: AbstractAgent,
  ): Observable<BaseEvent> {
    return new Observable((subscriber) => {
      const controller = new AbortController();
      const interactive = this.options.interactive === true;
      const offered = new Set(originalInput.tools.map((tool) => tool.name));
      const tools = new Map(
        this.tools
          .filter((tool) => !interactive || offered.has(tool.definition.name))
          .map((tool) => [tool.definition.name, tool]),
      );
      /*
       * Unattended, every computer call is answered here, a governed refusal for one the Bot does not
       * hold. In a chat, one the server has no executor for is the browser's to carry out.
       */
      const owns = (name: string) =>
        tools.has(name) || (!interactive && name.startsWith("computer_"));
      const maxSegments = this.options.maxSegments ?? MAX_TOOL_SEGMENTS;
      const executed = new Set<string>();
      let answeredInRun = 0;
      let nudged = false;
      let subscription: Subscription | undefined;
      let started = false;
      const work = async () => {
        let request: RunAgentInput = interactive
          ? originalInput
          : {
              ...originalInput,
              tools: [
                ...originalInput.tools.filter((tool) => !tools.has(tool.name)),
                ...this.tools
                  .filter((tool) => !tool.hidden)
                  .map((tool) => tool.definition),
              ],
            };
        for (let segment = 0; segment <= maxSegments; segment += 1) {
          if (subscriber.closed) return;
          const historical = new Set(
            request.messages.flatMap((message) =>
              message.role === "assistant"
                ? (message.toolCalls ?? []).map((call) => call.id)
                : [],
            ),
          );
          const emitted = new Set<string>();
          let messages = request.messages;
          let state = request.state;
          let terminal: RunFinishedEvent | undefined;
          let failed = false;
          let spoke = false;
          /** Results of this model turn's calls, in the order they finished. */
          const answered: Message[] = [];
          const scheduled = new Map<string, Promise<Outcome>>();
          let queue: Promise<unknown> = Promise.resolve();
          let suspended = false;
          const current = request;
          /** Carry out one call, after every call scheduled before it. Never rejects. */
          const schedule = (call: ToolCall): Promise<Outcome> => {
            executed.add(call.id);
            const outcome = queue.then(async (): Promise<Outcome> => {
              if (suspended || subscriber.closed) return { skipped: true };
              const context = {
                runId: current.runId,
                threadId: current.threadId,
                toolCallId: call.id,
                toolName: call.function.name,
                args: parsedArguments(call.function.arguments),
                // What the conversation is as this call starts, with the calls before it answered.
                messages: [
                  ...messages,
                  ...answered.filter(
                    (result) => !messages.some((m) => m.id === result.id),
                  ),
                ],
                state,
                context: current.context,
                forwardedProps: current.forwardedProps,
                initiator: this.initiator,
              };
              const outcome = await this.execute(
                tools.get(call.function.name),
                call,
                context,
                controller.signal,
              );
              if ("suspension" in outcome) suspended = true;
              if ("message" in outcome) answered.push(outcome.message);
              return outcome;
            });
            queue = outcome;
            scheduled.set(call.id, outcome);
            return outcome;
          };
          await new Promise<void>((resolve, reject) => {
            subscription = this.runNextWithState(
              request,
              new InvocationTransport(next, request),
            ).subscribe({
              next: ({
                event,
                messages: updatedMessages,
                state: updatedState,
              }) => {
                messages = updatedMessages;
                state = updatedState;
                if (event.type === EventType.TOOL_CALL_START) {
                  emitted.add(String(event.toolCallId));
                  spoke = true;
                }
                if (
                  event.type === EventType.TEXT_MESSAGE_CONTENT &&
                  typeof event.delta === "string" &&
                  event.delta.length > 0
                )
                  spoke = true;
                if (event.type === EventType.MESSAGES_SNAPSHOT) {
                  for (const message of messages) {
                    if (message.role !== "assistant") continue;
                    for (const call of message.toolCalls ?? []) {
                      if (!historical.has(call.id)) emitted.add(call.id);
                    }
                  }
                }
                // A chat run starts each call the moment the model has finished writing it.
                if (interactive && event.type === EventType.TOOL_CALL_END) {
                  const call = callIn(messages, String(event.toolCallId));
                  if (
                    call &&
                    owns(call.function.name) &&
                    !historical.has(call.id) &&
                    !executed.has(call.id)
                  )
                    schedule(call);
                }
                if (event.type === EventType.RUN_FINISHED) {
                  terminal = event as RunFinishedEvent;
                  return;
                }
                if (event.type === EventType.RUN_STARTED) {
                  if (started) return;
                  started = true;
                }
                if (event.type === EventType.RUN_ERROR) failed = true;
                subscriber.next(event);
              },
              error: reject,
              complete: resolve,
            });
          });
          if (subscriber.closed || failed) return;
          if (!terminal)
            throw new Error(
              "The headless agent ended without a terminal event.",
            );
          const answeredBefore = new Set(
            messages.flatMap((message) =>
              message.role === "tool" ? [message.toolCallId] : [],
            ),
          );
          const pending: ToolCall[] = messages.flatMap((message) =>
            message.role === "assistant"
              ? (message.toolCalls ?? []).filter(
                  (call) =>
                    emitted.has(call.id) &&
                    !historical.has(call.id) &&
                    !answeredBefore.has(call.id) &&
                    (!executed.has(call.id) || scheduled.has(call.id)),
                )
              : [],
          );
          const owned = pending.filter((call) => owns(call.function.name));
          if (owned.length === 0) {
            /*
             * A chat turn that just ran a tool and then said nothing would end as "Done" with no
             * answer. One more model turn on the same conversation; if that is silent too, the run
             * fails out loud rather than pretending it finished.
             */
            const silent =
              interactive &&
              answeredInRun > 0 &&
              !spoke &&
              terminal.outcome?.type !== "interrupt" &&
              pending.length === 0;
            if (silent && !nudged && segment < maxSegments) {
              nudged = true;
              request = { ...request, messages, state, resume: undefined };
              continue;
            }
            if (silent) {
              subscriber.next({
                type: EventType.RUN_ERROR,
                code: "OPENBOT_SILENT_TURN",
                message: SILENT_TURN_MESSAGE,
              });
              return;
            }
            subscriber.next(terminal);
            return;
          }
          if (segment === maxSegments)
            throw new Error(
              "The headless tool continuation limit was reached.",
            );
          const results = new Map<string, string>();
          for (const call of owned) {
            if (subscriber.closed) return;
            const outcome = await (scheduled.get(call.id) ?? schedule(call));
            if (subscriber.closed) return;
            if ("skipped" in outcome) continue;
            if ("suspension" in outcome) {
              const failure = outcome.suspension;
              failure.waiting.continuation ??= outcome.continuation;
              subscriber.next({
                type: EventType.CUSTOM,
                name: "openbot.headless.waiting",
                value: {
                  ...failure.waiting,
                  message: failure.message,
                  toolCallId: call.id,
                },
              });
              // Recorded before the run ends: whoever resumes it looks for this first.
              await this.options
                .onWaiting?.({
                  threadId: request.threadId,
                  runId: request.runId,
                  toolCallId: call.id,
                  toolName: call.function.name,
                  waiting: failure.waiting,
                  message: failure.message,
                })
                .catch((error: unknown) => {
                  console.error({
                    error: "headless_wait_record_failed",
                    context: {
                      threadId: request.threadId,
                      toolName: call.function.name,
                      name: error instanceof Error ? error.name : "unknown",
                    },
                    timestamp: new Date().toISOString(),
                  });
                });
              if (subscriber.closed) return;
              subscriber.next(
                interactive
                  ? terminal
                  : {
                      ...terminal,
                      outcome: {
                        type: "interrupt",
                        interrupts: [
                          {
                            id: call.id,
                            toolCallId: call.id,
                            reason: "human_input",
                            message: failure.message,
                            metadata: { openbotWaiting: failure.waiting },
                          },
                        ],
                      },
                    },
              );
              return;
            }
            const { message, error } = outcome;
            messages = [...messages, message];
            results.set(call.id, message.content);
            answeredInRun += 1;
            subscriber.next({
              type: EventType.TOOL_CALL_RESULT,
              messageId: message.id,
              toolCallId: call.id,
              role: "tool",
              content: message.content,
              ...(error ? { error } : {}),
            });
          }
          const interrupts =
            terminal.outcome?.type === "interrupt"
              ? terminal.outcome.interrupts
              : [];
          const unresolved = interrupts.filter(
            (interrupt) => !results.has(interrupt.toolCallId ?? interrupt.id),
          );
          if (owned.length !== pending.length || unresolved.length > 0) {
            subscriber.next(
              unresolved.length > 0
                ? {
                    ...terminal,
                    outcome: { type: "interrupt", interrupts: unresolved },
                  }
                : terminal,
            );
            return;
          }
          request = {
            ...request,
            messages,
            state,
            resume:
              interrupts.length > 0
                ? interrupts.map((interrupt) => ({
                    interruptId: interrupt.id,
                    status: "resolved" as const,
                    payload: results.get(interrupt.toolCallId ?? interrupt.id),
                  }))
                : undefined,
          };
        }
      };
      // Observable teardown owns cancellation; both asynchronous exits are observed.
      work().then(
        () => subscriber.complete(),
        (error: unknown) => {
          if (subscriber.closed) return;
          subscriber.next({
            type: EventType.RUN_ERROR,
            code: "OPENBOT_HEADLESS_TOOL_ERROR",
            message: error instanceof Error ? error.message : String(error),
          });
          subscriber.complete();
        },
      );
      return () => {
        controller.abort();
        subscription?.unsubscribe();
      };
    });
  }

  /** One call, carried out under its approval context, timed, and turned into an outcome. */
  private async execute(
    tool: HeadlessTool | undefined,
    call: ToolCall,
    continuation: ApprovalContinuation,
    signal: AbortSignal,
  ): Promise<Outcome> {
    const begun = now();
    let content: string;
    let error: string | undefined;
    try {
      if (!tool)
        throw new Error(
          `The tool ${call.function.name} is unavailable for this headless turn.`,
        );
      const args: unknown = JSON.parse(call.function.arguments || "{}");
      const result = await withApprovalContext(continuation, () =>
        tool.execute(args, { toolCallId: call.id, signal }),
      );
      content = typeof result === "string" ? result : JSON.stringify(result);
      if (content === undefined)
        throw new Error(`The tool ${call.function.name} returned no result.`);
    } catch (failure) {
      if (failure instanceof HeadlessToolSuspension)
        return { suspension: failure, continuation };
      error = failure instanceof Error ? failure.message : String(failure);
      content = JSON.stringify({ ok: false, error });
    } finally {
      recordPhase(
        `tool.${call.function.name}`,
        now() - begun,
        continuation.threadId,
      );
    }
    return {
      message: {
        id: crypto.randomUUID(),
        role: "tool",
        toolCallId: call.id,
        content,
        ...(error ? { error } : {}),
      },
      ...(error ? { error } : {}),
    };
  }
}

/** A call's arguments as a value, or the raw text when they are not JSON (execute then refuses). */
function parsedArguments(text: string): unknown {
  try {
    return JSON.parse(text || "{}");
  } catch {
    return text;
  }
}

/** The assistant call with this id in the conversation so far. */
function callIn(messages: Message[], id: string): ToolCall | undefined {
  for (const message of messages)
    if (message.role === "assistant")
      for (const call of message.toolCalls ?? [])
        if (call.id === id) return call;
  return undefined;
}

/** AG-UI accumulation reads transport history, so seed each continuation explicitly. */
class InvocationTransport extends AbstractAgent {
  constructor(
    private readonly transport: AbstractAgent,
    input: RunAgentInput,
  ) {
    super({ initialMessages: input.messages, initialState: input.state });
  }
  run(input: RunAgentInput) {
    return this.transport.run(input);
  }
}

/** What the headless sign-in tool needs from the passwords module. See passwords/service.ts. */
export type HeadlessSignInRequester = {
  request(input: {
    ownerUserId: string;
    botId: string;
    site: string;
    reason?: string;
    actor: ActionActor;
    threadId?: string;
    toolCallId?: string;
    continuation?: Record<string, unknown>;
    notify?: boolean;
    title?: string;
    usernameLabel?: string;
    passwordLabel?: string;
    codeLabel?: string;
  }): Promise<{ id: string; origin: string }>;
};

/** Shared by the headless tool and the browser's registration, so both promise the same thing. */
export { SIGN_IN_TOOL_DESCRIPTION };

/** Shipped browser/file/command tools, with identity bound before the model supplies arguments. */
export function createHeadlessComputerTools(options: {
  gateway: ComputerGateway;
  botId: string;
  actor: ActionActor;
  auditStore?: AuditStore;
  /** The private sign-in request. Absent leaves the Bot with help and secret requests only. */
  signIn?: HeadlessSignInRequester;
  /**
   * Where `computer_show_screen` keeps its picture: the gateway's own store unless one is given.
   * With neither, the tool says it cannot show one.
   */
  pageFrames?: PageFrameStore;
}): HeadlessTool[] {
  const { gateway, botId, actor, auditStore, signIn } = options;
  const pageFrames = options.pageFrames ?? gateway.pageFrames;
  const snapshotId = z.number().int().positive();
  const ref = z.string().min(1);
  const text = z.string().min(1);
  const noArgs = z.strictObject({});
  function tool<T extends z.ZodType>(
    name: string,
    description: string,
    schema: T,
    execute: (
      input: z.output<T>,
      context: { toolCallId: string; signal: AbortSignal },
    ) => Promise<unknown>,
  ): HeadlessTool {
    return {
      definition: { name, description, parameters: z.toJSONSchema(schema) },
      execute: async (args, context) => {
        const input = schema.parse(args);
        if (context.signal.aborted)
          throw new Error("The computer action was stopped.");
        try {
          return await execute(input, context);
        } catch (error) {
          if (error instanceof HumanHasControlError) {
            throw new HeadlessToolSuspension(error.message, {
              kind: "computer_handoff",
              botId,
              ...(error.requestId ? { requestId: error.requestId } : {}),
              ...(error.handoff ? { handoff: error.handoff } : {}),
            });
          }
          throw error;
        }
      },
    };
  }
  function waiting(
    state: ControlState,
    reason: string,
    kind = "computer_handoff",
  ): never {
    throw new HeadlessToolSuspension(reason, {
      kind,
      botId,
      ...(state.request
        ? { requestId: state.request.id, handoff: state.request }
        : {}),
    });
  }
  /**
   * A challenge on the page an action produced opens the same takeover a navigation's does, so
   * the unattended turn waits for the person instead of acting on a CAPTCHA.
   */
  function unlessChallenged<T extends { challenge?: unknown }>(result: T): T {
    const challenge = result.challenge as
      | { reason: string; requestId: string; kind: string }
      | undefined;
    if (challenge)
      throw new HeadlessToolSuspension(challenge.reason, {
        kind: "computer_handoff",
        botId,
        requestId: challenge.requestId,
        source: challenge.kind,
      });
    return result;
  }
  const acted = async <T extends { challenge?: unknown }>(
    result: Promise<T>,
  ) => ({ ok: true, ...unlessChallenged(await result) });
  const optionalRef = z.strictObject({
    ref: ref.optional(),
    snapshotId: snapshotId.optional(),
  }).shape;
  const tools = [
    tool(
      "computer_navigate",
      "Open a web page. Returns its title, readable text and `page`: the elements with refs you can act on straight away, and the HTTP status.",
      z.strictObject({ url: text }),
      async ({ url }, { toolCallId }) =>
        acted(gateway.navigate(botId, actor, url, toolCallId)),
    ),
    tool(
      "computer_read",
      "Read the currently open browser page without navigating.",
      noArgs,
      async () => ({ ok: true, ...(await gateway.read(botId)) }),
    ),
    tool(
      "computer_snapshot",
      "List the page's fields, buttons and links with refs. Acting tools already return `page`; call this for the full list when `page.changed` shows only what changed, or refs are stale.",
      noArgs,
      async () => ({ ok: true, ...(await gateway.snapshot(botId)) }),
    ),
    tool(
      "computer_screenshot",
      "Return an image of the browser currently open on your computer.",
      noArgs,
      async () => ({ ok: true, ...(await gateway.screenshot(botId)) }),
    ),
    tool(
      "computer_click",
      "Click an element by ref, with the snapshotId from the latest `page` or snapshot. Returns the page after the click.",
      z.strictObject({ ref, snapshotId }),
      async (input, { signal }) =>
        acted(gateway.click(botId, actor, input, signal)),
    ),
    tool(
      "computer_type",
      "Replace a field's text by ref and snapshotId; submit presses Enter after. For a whole form use computer_fill.",
      z.strictObject({
        ref,
        snapshotId,
        text: z.string(),
        submit: z.boolean().optional(),
      }),
      async (input, { signal }) =>
        acted(gateway.type(botId, actor, input, signal)),
    ),
    tool(
      "computer_fill",
      "Fill a whole form in one call: each field is a ref with exactly one of text, checked, option (a drop-down's label or value) or file (a workspace path). then clicks a ref or submits the form. Stops at the first field that fails and says why.",
      z.strictObject({
        fields: z
          .array(
            z
              .strictObject({
                ref,
                text: z.string().optional(),
                checked: z.boolean().optional(),
                option: z.string().optional(),
                file: z.string().optional(),
              })
              .refine(
                (field) =>
                  [field.text, field.checked, field.option, field.file].filter(
                    (value) => value !== undefined,
                  ).length === 1,
                {
                  message:
                    "Each field needs exactly one of text, checked, option or file.",
                },
              ),
          )
          .min(1)
          .max(60),
        // biome-ignore lint/suspicious/noThenProperty: `then` is the tool contract's field name.
        then: z
          .union([
            z.strictObject({ click: ref }),
            z.strictObject({ submit: z.literal(true) }),
          ])
          .optional(),
        snapshotId,
      }),
      async (input, { signal }) =>
        acted(gateway.fill(botId, actor, input, signal)),
    ),
    tool(
      "computer_select",
      "Choose an option in a drop-down (native or custom) by its visible label or value.",
      z.strictObject({ ref, option: text, snapshotId }),
      async (input, { signal }) =>
        acted(gateway.select(botId, actor, input, signal)),
    ),
    tool(
      "computer_check",
      "Tick (checked true) or untick a checkbox, radio button or switch.",
      z.strictObject({ ref, checked: z.boolean(), snapshotId }),
      async (input, { signal }) =>
        acted(gateway.check(botId, actor, input, signal)),
    ),
    tool(
      "computer_upload",
      "Upload a file from your workspace (path relative to it) into a file input or upload button.",
      z.strictObject({ ref, path: text, snapshotId }),
      async (input, { signal }) =>
        acted(gateway.upload(botId, actor, input, signal)),
    ),
    tool(
      "computer_hover",
      "Move the pointer over an element, to open a menu or show a tooltip.",
      z.strictObject({ ref, snapshotId }),
      async (input, { signal }) =>
        acted(gateway.hover(botId, actor, input, signal)),
    ),
    tool(
      "computer_key",
      "Press Enter, Tab, Escape or another key on the page. When a ref is given pass its snapshotId.",
      z
        .strictObject({
          key: text,
          ref: ref.optional(),
          snapshotId: snapshotId.optional(),
        })
        .refine((input) => !input.ref || input.snapshotId !== undefined, {
          message: "A snapshotId is required when a ref is given.",
        }),
      async (input, { signal }) =>
        acted(gateway.key(botId, actor, input, signal)),
    ),
    tool(
      "computer_scroll",
      "Scroll the page by deltaY pixels (negative is up; default 600). With a ref: scroll it into view, or with deltaY too, scroll inside the panel it is in.",
      z
        .strictObject({ deltaY: z.number().optional(), ...optionalRef })
        .refine((input) => !input.ref || input.snapshotId !== undefined, {
          message: "A snapshotId is required when a ref is given.",
        }),
      async (input, { signal }) =>
        acted(gateway.scroll(botId, actor, input, signal)),
    ),
    tool(
      "computer_dialog",
      "Answer the alert, confirm or prompt the page is showing (`page.dialog`): accept true for OK, false for Cancel; text answers a prompt.",
      z.strictObject({ accept: z.boolean(), text: z.string().optional() }),
      async (input, { signal }) =>
        acted(gateway.dialog(botId, actor, input, signal)),
    ),
    tool(
      "computer_tabs",
      "List the browser's tabs, switch to one, or close one, by index from the list.",
      z
        .strictObject({
          action: z.enum(["list", "switch", "close"]),
          index: z.number().int().min(0).optional(),
        })
        .refine(
          (input) => input.action === "list" || input.index !== undefined,
          {
            message: "Say which tab, by its index from the list.",
          },
        ),
      async (input, { signal }) =>
        acted(gateway.tabs(botId, actor, input, signal)),
    ),
    tool(
      "computer_back",
      "Go back to the previous page in this tab.",
      noArgs,
      async (_input, { signal }) => acted(gateway.back(botId, actor, signal)),
    ),
    tool(
      "computer_show_screen",
      "Show the person a picture of your screen in this conversation, before an irreversible submit or whenever a picture says more. You do not see it. Never rebuild a page as a generated interface to show it.",
      z.strictObject({ caption: z.string().optional() }),
      async (_input, { toolCallId }) => {
        const shown = await showScreen(
          { gateway, pageFrames },
          botId,
          toolCallId,
        );
        return shown.ok
          ? {
              ok: true,
              url: shown.url,
              shown: "The person now sees a picture of this page in the chat.",
            }
          : shown;
      },
    ),
    tool(
      "computer_list_files",
      "List files and folders in your workspace. Call first before reading an uncertain filename.",
      z.strictObject({ path: z.string().optional() }),
      async (input) => ({
        ok: true,
        ...(await gateway.listFiles(botId, actor, input)),
      }),
    ),
    tool(
      "computer_read_file",
      "Read a saved file relative to your persistent workspace, such as notes.md.",
      z.strictObject({ path: text }),
      async (input) => ({
        ok: true,
        ...(await gateway.readFile(botId, actor, input)),
      }),
    ),
    tool(
      "computer_write_file",
      "Save text in your workspace. Set append to add to the end of an existing file.",
      z.strictObject({
        path: text,
        contents: z.string(),
        append: z.boolean().optional(),
      }),
      async (input) => ({
        ok: true,
        ...(await gateway.writeFile(botId, actor, input)),
      }),
    ),
    tool(
      "computer_run_command",
      "Run a bash shell command in your workspace. Pipes and && work; long output is truncated and long commands are stopped. For package installation use sudo apt-get; if refused say so rather than retrying.",
      z.strictObject({ command: text }),
      async (input, { signal }) => ({
        ok: true,
        ...(await gateway.runCommand(botId, actor, input, signal)),
      }),
    ),
    tool(
      "computer_request_help",
      "Create a durable request for the person to take the browser and sign in or clear a challenge. This unattended turn pauses until a person helps; never ask them to send you a password.",
      z.strictObject({ reason: text }),
      async ({ reason }, { toolCallId }) =>
        waiting(
          await gateway.requestHelp(botId, actor, reason, toolCallId),
          reason,
        ),
    ),
    tool(
      "computer_request_secret",
      "Ask the person to enter one secret directly into the focused field. Click the field first. You must never receive the secret; this unattended turn pauses for the person.",
      z.strictObject({ label: text, ref, snapshotId }),
      async (input) =>
        waiting(
          await gateway.requestSecret(botId, actor, input),
          `The person must enter ${input.label} directly into the page.`,
          "computer_secret",
        ),
    ),
  ];
  if (signIn)
    tools.push(
      tool(
        "computer_request_sign_in",
        SIGN_IN_TOOL_DESCRIPTION,
        z.strictObject({
          site: text,
          reason: z.string().optional(),
          title: z.string().optional(),
          usernameLabel: z.string().optional(),
          passwordLabel: z.string().optional(),
          codeLabel: z.string().optional(),
        }),
        async (
          { site, reason, title, usernameLabel, passwordLabel, codeLabel },
          { toolCallId },
        ) => {
          const continuation = currentApprovalContext();
          let request: Awaited<ReturnType<typeof signIn.request>>;
          try {
            request = await signIn.request({
              ownerUserId: actor.userId ?? actor.id,
              botId,
              site,
              ...(reason ? { reason } : {}),
              ...(title ? { title } : {}),
              ...(usernameLabel ? { usernameLabel } : {}),
              ...(passwordLabel ? { passwordLabel } : {}),
              ...(codeLabel ? { codeLabel } : {}),
              actor,
              ...(continuation?.threadId
                ? { threadId: continuation.threadId }
                : {}),
              toolCallId,
              ...(continuation
                ? {
                    continuation: continuation as unknown as Record<
                      string,
                      unknown
                    >,
                  }
                : {}),
              notify: true,
            });
          } catch (error) {
            // A page with no form on it yet, or a site that cannot be signed in to: the Bot is told
            // why and what to do, and nobody is sent a form that could only fail.
            // By name: this module does not import the passwords module it is handed.
            if (error instanceof Error && error.name === "SignInRefusedError")
              return { ok: false, reason: error.message };
            throw error;
          }
          throw new HeadlessToolSuspension(
            `Waiting for the person to sign in to ${request.origin} in a private form.`,
            {
              kind: "computer_sign_in",
              botId,
              requestId: request.id,
              signInRequestId: request.id,
              site: request.origin,
            },
          );
        },
      ),
    );
  if (auditStore)
    tools.push(
      tool(
        "report_refusal",
        "Record a request you chose to decline, and why. This records evidence and does not enforce a policy.",
        z.strictObject({ reason: text, request: z.string().optional() }),
        async ({ reason, request }) => {
          await recordAuditEvent(auditStore, {
            eventType: "bot.declined",
            targetType: "agent",
            targetId: botId,
            ...(actor.userId ? { actorUserId: actor.userId } : {}),
            initiator: actor.initiator,
            payload: {
              bot: botId,
              actor: actor.id,
              reason: reason.slice(0, 500),
              ...(request ? { request: request.slice(0, 500) } : {}),
              reportedBy: "the Bot itself",
            },
          });
          return { ok: true, recorded: true };
        },
      ),
    );
  return tools;
}
