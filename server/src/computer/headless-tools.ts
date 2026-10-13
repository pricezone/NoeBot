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
import {
  currentApprovalContext,
  withApprovalContext,
} from "../approvals/types";
import {
  type AuditInitiator,
  type AuditStore,
  recordAuditEvent,
} from "../audit";
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

/**
 * Executes AG-UI client tools inside the Intelligence run. Backend results are
 * forwarded unchanged; only newly emitted unanswered calls can be executed.
 */
export class HeadlessToolsMiddleware extends Middleware {
  constructor(
    private readonly tools: HeadlessTool[],
    private readonly initiator?: AuditInitiator,
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
      const tools = new Map(
        this.tools.map((tool) => [tool.definition.name, tool]),
      );
      const executed = new Set<string>();
      let subscription: Subscription | undefined;
      let started = false;
      const work = async () => {
        let request: RunAgentInput = {
          ...originalInput,
          tools: [
            ...originalInput.tools.filter((tool) => !tools.has(tool.name)),
            ...this.tools
              .filter((tool) => !tool.hidden)
              .map((tool) => tool.definition),
          ],
        };
        for (let segment = 0; segment <= MAX_TOOL_SEGMENTS; segment += 1) {
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
                if (event.type === EventType.TOOL_CALL_START)
                  emitted.add(String(event.toolCallId));
                if (event.type === EventType.MESSAGES_SNAPSHOT) {
                  for (const message of messages) {
                    if (message.role !== "assistant") continue;
                    for (const call of message.toolCalls ?? []) {
                      if (!historical.has(call.id)) emitted.add(call.id);
                    }
                  }
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
          const answered = new Set(
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
                    !answered.has(call.id) &&
                    !executed.has(call.id),
                )
              : [],
          );
          const owned = pending.filter(
            (call) =>
              tools.has(call.function.name) ||
              call.function.name.startsWith("computer_"),
          );
          if (owned.length === 0) {
            subscriber.next(terminal);
            return;
          }
          if (segment === MAX_TOOL_SEGMENTS)
            throw new Error(
              "The headless tool continuation limit was reached.",
            );
          const results = new Map<string, string>();
          for (const call of owned) {
            if (subscriber.closed) return;
            executed.add(call.id);
            let content: string;
            let error: string | undefined;
            try {
              const tool = tools.get(call.function.name);
              if (!tool)
                throw new Error(
                  `The tool ${call.function.name} is unavailable for this headless turn.`,
                );
              const args: unknown = JSON.parse(call.function.arguments || "{}");
              const continuation = {
                runId: request.runId,
                threadId: request.threadId,
                toolCallId: call.id,
                toolName: call.function.name,
                args,
                messages,
                state,
                context: request.context,
                forwardedProps: request.forwardedProps,
                initiator: this.initiator,
              };
              const result = await withApprovalContext(continuation, () =>
                tool.execute(args, {
                  toolCallId: call.id,
                  signal: controller.signal,
                }),
              );
              content =
                typeof result === "string" ? result : JSON.stringify(result);
              if (content === undefined)
                throw new Error(
                  `The tool ${call.function.name} returned no result.`,
                );
            } catch (failure) {
              if (failure instanceof HeadlessToolSuspension) {
                failure.waiting.continuation ??= {
                  runId: request.runId,
                  threadId: request.threadId,
                  toolCallId: call.id,
                  toolName: call.function.name,
                  args: JSON.parse(call.function.arguments || "{}"),
                  messages,
                  state,
                  context: request.context,
                  forwardedProps: request.forwardedProps,
                  initiator: this.initiator,
                };
                subscriber.next({
                  type: EventType.CUSTOM,
                  name: "openbot.headless.waiting",
                  value: {
                    ...failure.waiting,
                    message: failure.message,
                    toolCallId: call.id,
                  },
                });
                subscriber.next({
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
                });
                return;
              }
              error =
                failure instanceof Error ? failure.message : String(failure);
              content = JSON.stringify({ ok: false, error });
            }
            if (subscriber.closed) return;
            const message: Message = {
              id: crypto.randomUUID(),
              role: "tool",
              toolCallId: call.id,
              content,
              ...(error ? { error } : {}),
            };
            messages = [...messages, message];
            results.set(call.id, content);
            subscriber.next({
              type: EventType.TOOL_CALL_RESULT,
              messageId: message.id,
              toolCallId: call.id,
              role: "tool",
              content,
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
export const SIGN_IN_TOOL_DESCRIPTION =
  "Ask the person you work for to sign you in to a website: Taxisnet and gov.gr, a bank, any login. They get a private Secure Form in this conversation (or take over the browser), and what they type goes straight into your browser by the computer. You never see the username, password or code, so do not refuse a login as too personal and never ask for credentials any other way. Open the site's sign-in page first (click its Sign in or Είσοδος button and wait for the login fields), then call this with the site's address and a short title such as 'Σύνδεση Taxisnet'. For a code that arrives later on a page of its own (an SMS confirmation), call this again on that page: it asks for the code alone. This turn pauses until they answer; you are then told only whether it worked.";

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
