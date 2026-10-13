import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  AbstractAgent,
  type BaseEvent,
  EventType,
  type Message,
  type RunAgentInput,
} from "@ag-ui/client";
import { LLMock } from "@copilotkit/aimock";
import { Hono, type MiddlewareHandler } from "hono";
import { Observable } from "rxjs";
import { requireSavedToolCall } from "../src/approvals/saved-call";
import type { AppVariables } from "../src/auth/guards";
import {
  type HeadlessTool,
  HeadlessToolSuspension,
  HeadlessToolsMiddleware,
  type HeadlessToolsOptions,
  type HeadlessWait,
  SILENT_TURN_MESSAGE,
} from "../src/computer/headless-tools";
import { loadConfig } from "../src/config";
import { buildAgents, type ComputerInRun } from "../src/copilot";
import {
  createToolCallLedger,
  ToolCallLedgerMiddleware,
} from "../src/runs/ledger";
import {
  createRunWaitResumer,
  createRunWaitRoutes,
  createRunWaitStore,
  createWaitResolver,
  NOBODY_TOOK_OVER,
  type WaitResolver,
  waitFromSuspension,
} from "../src/runs/waits";
import { testEnvironment } from "./support/environment";

/**
 * COMPUTER_TOOLS_IN_RUN, end to end through a real built-in Bot and a fake model.
 *
 * Measured before: every browser step cost 8 to 10 seconds, because each computer tool ended the
 * run and the browser started another one (thread lock, history read, agent rebuild, Learning
 * lookup) after carrying the call out. With the flag on, the server carries each call out inside
 * the run and the model continues in the same run. These hold the parts that must not regress:
 * one run for a whole browser task, a suspension that ends the run with the waiting event and
 * resumes, Stop reaching a tool that is executing, and the flag off changing nothing.
 */

const llm = new LLMock();
let originalBase: string | undefined;
beforeAll(async () => {
  originalBase = process.env.OPENAI_BASE_URL;
  process.env.OPENAI_BASE_URL = await llm.start();
});
afterAll(async () => {
  if (originalBase === undefined) delete process.env.OPENAI_BASE_URL;
  else process.env.OPENAI_BASE_URL = originalBase;
  await llm.stop();
});

/** The model: a click on the first turn; a sentence once it has seen the click's result. */
function scriptModel(answer = "Clicked Save.") {
  llm.clearFixtures();
  llm.reset?.();
  llm.onMessage(/.*/, (request) => {
    const last = request.messages.at(-1);
    return last?.role === "tool"
      ? { content: answer }
      : {
          toolCalls: [
            {
              id: "call-click",
              name: "computer_click",
              arguments: JSON.stringify({ ref: "e7", snapshotId: 3 }),
            },
          ],
        };
  });
}

const browserClick = {
  name: "computer_click",
  description: "Click (as the browser describes it).",
  parameters: {
    type: "object",
    properties: { ref: { type: "string" }, snapshotId: { type: "number" } },
    required: ["ref", "snapshotId"],
  },
};

function clickTool(execute: HeadlessTool["execute"]): HeadlessTool {
  return {
    definition: {
      ...browserClick,
      description: "Click (as the server describes it).",
    },
    execute,
  };
}

async function bot(computerInRun?: ComputerInRun) {
  const agents = await buildAgents(
    [
      {
        id: "bot",
        name: "Bot",
        type: "built_in",
        systemPrompt: "Do what you are asked in the browser.",
      },
    ],
    { provider: "openai", defaultModel: "gpt-4.1-mini" },
    "synthetic-key",
    // stallGuard through loadPersonalMemory: fourteen positions this test does not need.
    ...Array.from({ length: 14 }, () => undefined),
    computerInRun,
  );
  const agent = agents.bot?.clone();
  if (!agent) throw new Error("expected the Bot");
  agent.setMessages([{ id: "u1", role: "user", content: "Click Save." }]);
  return agent;
}

async function run(agent: AbstractAgent) {
  const events: BaseEvent[] = [];
  await agent.runAgent(
    { tools: [browserClick] },
    { onEvent: ({ event }) => void events.push(event) },
  );
  return events;
}

const count = (events: BaseEvent[], type: EventType) =>
  events.filter((event) => event.type === type).length;

describe("computer tools inside the run", () => {
  test("a call executes on the server and the model continues in the same run", async () => {
    scriptModel();
    const executed: unknown[] = [];
    const agent = await bot({
      tools: async () => [
        clickTool(async (args) => {
          executed.push(args);
          return { ok: true, element: { name: "Save" } };
        }),
      ],
    });
    const before = llm.getRequests().length;
    const events = await run(agent);
    expect(executed).toEqual([{ ref: "e7", snapshotId: 3 }]);
    // One run for the whole task: started once, finished once, two model calls inside it.
    expect(count(events, EventType.RUN_STARTED)).toBe(1);
    expect(count(events, EventType.RUN_FINISHED)).toBe(1);
    expect(llm.getRequests().length - before).toBe(2);
    expect(
      events.find((event) => event.type === EventType.TOOL_CALL_RESULT),
    ).toMatchObject({ toolCallId: "call-click" });
    expect(agent.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: "Clicked Save.",
    });
    // The model was offered the browser's own definition, so it sees the tool it always saw.
    const tools = (llm.getRequests().at(-1)?.body?.tools ?? []) as {
      function?: { name?: string; description?: string };
      name?: string;
      description?: string;
    }[];
    const offered = tools.find(
      (tool) => (tool.function?.name ?? tool.name) === "computer_click",
    );
    expect(offered?.function?.description ?? offered?.description).toBe(
      browserClick.description,
    );
  });

  test("with the flag off the call is left for the browser, as before", async () => {
    scriptModel();
    const agent = await bot();
    const before = llm.getRequests().length;
    const events = await run(agent);
    // One model call, and the run ends on the call: the browser carries it out and starts another.
    expect(llm.getRequests().length - before).toBe(1);
    expect(count(events, EventType.TOOL_CALL_RESULT)).toBe(0);
    const last = agent.messages.at(-1);
    expect(last?.role).toBe("assistant");
    expect(
      last?.role === "assistant" ? last.toolCalls?.[0]?.function.name : "",
    ).toBe("computer_click");
  });

  test("a suspension ends the run with the waiting event, and the recorded wait resumes it", async () => {
    scriptModel("Signed in and clicked.");
    const waits: HeadlessWait[] = [];
    const agent = await bot({
      tools: async () => [
        clickTool(async () => {
          throw new HeadlessToolSuspension("Waiting for you to sign in.", {
            kind: "computer_sign_in",
            requestId: "sign-in-1",
          });
        }),
      ],
      onWaiting: async (_botId, wait) => {
        waits.push(wait);
      },
    });
    const events = await run(agent);
    const waiting = events.find((event) => event.type === EventType.CUSTOM) as
      | (BaseEvent & { name: string; value: Record<string, unknown> })
      | undefined;
    expect(waiting?.name).toBe("openbot.headless.waiting");
    expect(waiting?.value).toMatchObject({
      kind: "computer_sign_in",
      requestId: "sign-in-1",
      toolCallId: "call-click",
    });
    // A plain finish: the browser agent must not be left holding an interrupt.
    const finished = events.find(
      (event) => event.type === EventType.RUN_FINISHED,
    ) as BaseEvent & { outcome?: unknown };
    expect(finished.outcome).toBeUndefined();
    expect(count(events, EventType.TOOL_CALL_RESULT)).toBe(0);

    // The wait was recorded before the run ended, with the run to continue.
    expect(waits).toHaveLength(1);
    const store = createRunWaitStore();
    const wait = waits[0];
    if (!wait) throw new Error("expected a wait");
    await store.open(
      waitFromSuspension(wait, { ownerUserId: "owner", botId: "bot" }),
    );
    let ready = false;
    const resolver: WaitResolver = {
      ready: async () => ready,
      result: async () => JSON.stringify({ ok: true, signedIn: true }),
    };
    const continued: { content: string; messages: Message[] }[] = [];
    const sweep = createRunWaitResumer({
      store,
      resolver,
      graceMs: 0,
      minDelayMs: 0,
      continueTurn: async (claimed, content) => {
        continued.push({ content, messages: claimed.continuation.messages });
      },
    });
    expect(await sweep()).toBe(0);
    ready = true;
    expect(await sweep()).toBe(1);
    expect(continued[0]?.content).toContain("signedIn");

    // And the continuation is a run that carries on from the answered call, in the same thread.
    const resumed = await bot({ tools: async () => [] });
    resumed.setMessages([
      ...(continued[0]?.messages ?? []),
      {
        id: "result-1",
        role: "tool",
        toolCallId: "call-click",
        content: continued[0]?.content ?? "",
      },
    ]);
    await run(resumed);
    expect(resumed.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: "Signed in and clicked.",
    });
  });

  test("Stop reaches a tool that is executing between two model calls", async () => {
    scriptModel();
    let signal: AbortSignal | undefined;
    let entered: () => void = () => undefined;
    const executing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const agent = await bot({
      tools: async () => [
        clickTool(
          (_args, context) =>
            new Promise((resolve) => {
              signal = context.signal;
              entered();
              context.signal.addEventListener("abort", () =>
                resolve({ ok: false, stopped: true }),
              );
            }),
        ),
      ],
    });
    const done = run(agent);
    await executing;
    agent.abortRun();
    await done;
    expect(signal?.aborted).toBe(true);
  });
});

/** An agent whose every run is the next scripted segment. */
class Segments extends AbstractAgent {
  inputs: RunAgentInput[] = [];
  constructor(
    private readonly script: ((
      input: RunAgentInput,
    ) => Observable<BaseEvent>)[],
  ) {
    super();
  }
  run(input: RunAgentInput): Observable<BaseEvent> {
    this.inputs.push(input);
    const next = this.script[this.inputs.length - 1];
    if (!next) throw new Error("No more segments.");
    return next(input);
  }
}

function segment(
  input: RunAgentInput,
  body: BaseEvent[],
  beforeFinish?: Promise<unknown>,
): Observable<BaseEvent> {
  return new Observable((subscriber) => {
    subscriber.next({
      type: EventType.RUN_STARTED,
      threadId: input.threadId,
      runId: input.runId,
    } as BaseEvent);
    for (const event of body) subscriber.next(event);
    void (beforeFinish ?? Promise.resolve()).then(() => {
      subscriber.next({
        type: EventType.RUN_FINISHED,
        threadId: input.threadId,
        runId: input.runId,
      } as BaseEvent);
      subscriber.complete();
    });
  });
}

const callEvents = (id: string): BaseEvent[] => [
  {
    type: EventType.TOOL_CALL_START,
    toolCallId: id,
    toolCallName: "computer_click",
    parentMessageId: `m-${id}`,
  } as BaseEvent,
  {
    type: EventType.TOOL_CALL_ARGS,
    toolCallId: id,
    delta: '{"ref":"e7","snapshotId":3}',
  } as BaseEvent,
  { type: EventType.TOOL_CALL_END, toolCallId: id } as BaseEvent,
];

const words = (text: string): BaseEvent[] => [
  {
    type: EventType.TEXT_MESSAGE_START,
    messageId: "reply",
    role: "assistant",
  } as BaseEvent,
  {
    type: EventType.TEXT_MESSAGE_CONTENT,
    messageId: "reply",
    delta: text,
  } as BaseEvent,
  { type: EventType.TEXT_MESSAGE_END, messageId: "reply" } as BaseEvent,
];

function drive(
  agent: Segments,
  tool: HeadlessTool,
  options: Omit<HeadlessToolsOptions, "interactive"> = {},
): Promise<BaseEvent[]> {
  const input: RunAgentInput = {
    threadId: "thread",
    runId: "run",
    messages: [{ id: "u1", role: "user", content: "Click Save." }],
    tools: [browserClick],
    context: [],
    state: {},
    forwardedProps: {},
  };
  return new Promise((resolve, reject) => {
    const events: BaseEvent[] = [];
    new HeadlessToolsMiddleware([tool], undefined, {
      interactive: true,
      ...options,
    })
      .run(input, agent)
      .subscribe({
        next: (event) => void events.push(event),
        error: reject,
        complete: () => resolve(events),
      });
  });
}

describe("the interactive middleware", () => {
  test("starts a call the moment its arguments are complete, before the model turn ends", async () => {
    let started: () => void = () => undefined;
    const executing = new Promise<void>((resolve) => {
      started = resolve;
    });
    const agent = new Segments([
      // This model turn does not end until the click has started: only an eager start gets there.
      (input) => segment(input, callEvents("c1"), executing),
      (input) => segment(input, words("Done.")),
    ]);
    const events = await drive(
      agent,
      clickTool(async () => {
        started();
        return { ok: true };
      }),
    );
    expect(count(events, EventType.TOOL_CALL_RESULT)).toBe(1);
    expect(count(events, EventType.RUN_FINISHED)).toBe(1);
  });

  test("a turn silent after a tool step gets one more model turn", async () => {
    const agent = new Segments([
      (input) => segment(input, callEvents("c1")),
      (input) => segment(input, []),
      (input) => segment(input, words("Saved.")),
    ]);
    const events = await drive(
      agent,
      clickTool(async () => ({ ok: true })),
    );
    expect(agent.inputs).toHaveLength(3);
    expect(count(events, EventType.RUN_ERROR)).toBe(0);
    expect(count(events, EventType.RUN_FINISHED)).toBe(1);
  });

  test("silent twice after a tool step fails out loud instead of finishing as done", async () => {
    const agent = new Segments([
      (input) => segment(input, callEvents("c1")),
      (input) => segment(input, []),
      (input) => segment(input, []),
    ]);
    const events = await drive(
      agent,
      clickTool(async () => ({ ok: true })),
    );
    expect(events.at(-1)).toMatchObject({
      type: EventType.RUN_ERROR,
      code: "OPENBOT_SILENT_TURN",
      message: SILENT_TURN_MESSAGE,
    });
    expect(count(events, EventType.RUN_FINISHED)).toBe(0);
  });

  test("a computer tool the server does not hold stays the browser's", async () => {
    const agent = new Segments([(input) => segment(input, callEvents("c1"))]);
    const events = await drive(agent, {
      ...clickTool(async () => ({ ok: true })),
      definition: { ...browserClick, name: "computer_type" },
    });
    expect(count(events, EventType.TOOL_CALL_RESULT)).toBe(0);
    expect(count(events, EventType.RUN_FINISHED)).toBe(1);
  });
});

describe("resuming a wait: the tab or the server, never both", () => {
  const asOwner: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", { id: "owner", role: "user" } as never);
    await next();
  };
  const continuation = {
    runId: "run",
    threadId: "thread",
    toolCallId: "call-1",
    toolName: "computer_request_help",
    args: { reason: "Please sign in" },
    messages: [],
    state: {},
    context: [],
    forwardedProps: {},
  };

  async function opened(kind = "computer_handoff") {
    const store = createRunWaitStore();
    await store.open(
      waitFromSuspension(
        {
          threadId: "thread",
          runId: "run",
          toolCallId: "call-1",
          toolName: "computer_request_help",
          message: "Take over",
          waiting: { kind, requestId: "req-1", continuation },
        },
        { ownerUserId: "owner", botId: "bot" },
      ),
    );
    return store;
  }

  const answered: WaitResolver = {
    ready: async () => true,
    result: async () =>
      JSON.stringify({ ok: true, handoffStatus: "completed" }),
  };

  test("the tab claims an answered wait with the server's result; the server then cannot", async () => {
    const store = await opened();
    const app = new Hono<{ Variables: AppVariables }>().route(
      "/api/runs",
      createRunWaitRoutes(store, answered, asOwner),
    );
    const status = await app.request("/api/runs/waits/thread/call-1");
    expect(await status.json()).toMatchObject({
      kind: "computer_handoff",
      status: "ready",
    });
    const claim = await app.request("/api/runs/waits/thread/call-1/claim", {
      method: "POST",
      body: "{}",
    });
    expect(await claim.json()).toEqual({
      claimed: true,
      content: JSON.stringify({ ok: true, handoffStatus: "completed" }),
    });
    const continued: string[] = [];
    const sweep = createRunWaitResumer({
      store,
      resolver: answered,
      graceMs: 0,
      continueTurn: async (_wait, content) => {
        continued.push(content);
      },
    });
    expect(await sweep()).toBe(0);
    expect(continued).toEqual([]);
  });

  test("the server waits out the grace period for a tab before it resumes", async () => {
    const store = await opened();
    let clock = 0;
    const continued: string[] = [];
    const sweep = createRunWaitResumer({
      store,
      resolver: answered,
      graceMs: 5_000,
      now: () => clock,
      continueTurn: async (_wait, content) => {
        continued.push(content);
      },
    });
    expect(await sweep()).toBe(0);
    clock = 4_000;
    expect(await sweep()).toBe(0);
    clock = 5_000;
    expect(await sweep()).toBe(1);
    expect(continued).toHaveLength(1);
  });

  test("a stopped turn is continued by nobody, and an approval is never claimed here", async () => {
    const store = await opened();
    const app = new Hono<{ Variables: AppVariables }>().route(
      "/api/runs",
      createRunWaitRoutes(store, answered, asOwner),
    );
    await app.request("/api/runs/waits/thread/call-1/claim", {
      method: "POST",
      body: JSON.stringify({ stop: true }),
    });
    const sweep = createRunWaitResumer({
      store,
      resolver: answered,
      graceMs: 0,
      continueTurn: async () => {
        throw new Error("must not continue");
      },
    });
    expect(await sweep()).toBe(0);

    const approvals = await opened("approval");
    const approvalApp = new Hono<{ Variables: AppVariables }>().route(
      "/api/runs",
      createRunWaitRoutes(approvals, answered, asOwner),
    );
    const refused = await approvalApp.request(
      "/api/runs/waits/thread/call-1/claim",
      { method: "POST", body: "{}" },
    );
    expect(refused.status).toBe(409);
  });

  test("somebody else's wait is not found", async () => {
    const store = await opened();
    const asStranger: MiddlewareHandler<{ Variables: AppVariables }> = async (
      context,
      next,
    ) => {
      context.set("actor", { id: "stranger", role: "user" } as never);
      await next();
    };
    const app = new Hono<{ Variables: AppVariables }>().route(
      "/api/runs",
      createRunWaitRoutes(store, answered, asStranger),
    );
    expect((await app.request("/api/runs/waits/thread/call-1")).status).toBe(
      404,
    );
  });
});

describe("what a resumed run is told", () => {
  const base = {
    threadId: "thread",
    toolCallId: "call-1",
    ownerUserId: "owner",
    botId: "bot",
    waiting: {},
    continuation: {
      runId: "run",
      threadId: "thread",
      toolCallId: "call-1",
      toolName: "computer_request_secret",
      args: { label: "the SMS code", ref: "e3", snapshotId: 2 },
      messages: [],
      state: {},
      context: [],
      forwardedProps: {},
    },
    createdAt: new Date("2026-10-13T10:00:00Z"),
    claimedAt: null,
    claimedBy: null,
  };

  test("a takeover handed back resumes with a fresh snapshot; a lapsed one says nobody came", async () => {
    let status: "waiting" | "completed" | "expired" = "waiting";
    const resolver = createWaitResolver({
      control: async () => ({
        holder: "bot",
        since: "",
        requested: false,
        transitioning: false,
        resumeSnapshotRequired: false,
        request: {
          id: "req-1",
          reason: "Sign in",
          source: "model",
          status,
          createdAt: "",
          updatedAt: "",
        },
      }),
      snapshot: async () => ({ snapshotId: 9, url: "https://example.com" }),
    });
    const wait = { ...base, kind: "computer_handoff", requestId: "req-1" };
    expect(await resolver.ready(wait)).toBe(false);
    status = "completed";
    expect(await resolver.ready(wait)).toBe(true);
    expect(JSON.parse(await resolver.result(wait))).toMatchObject({
      ok: true,
      snapshotId: 9,
      handoffStatus: "completed",
    });
    status = "expired";
    expect(JSON.parse(await resolver.result(wait))).toMatchObject({
      ok: false,
      reason: NOBODY_TOOK_OVER,
    });
  });

  test("a takeover the person started unasked is answered once they hand the wheel back", async () => {
    let holder: "human" | "bot" = "human";
    const resolver = createWaitResolver({
      control: async () => ({
        holder,
        since: "",
        requested: false,
        transitioning: false,
        resumeSnapshotRequired: false,
      }),
      snapshot: async () => ({ snapshotId: 4 }),
    });
    const wait = { ...base, kind: "computer_handoff", requestId: null };
    expect(await resolver.ready(wait)).toBe(false);
    holder = "bot";
    expect(await resolver.ready(wait)).toBe(true);
    expect(JSON.parse(await resolver.result(wait))).toMatchObject({
      ok: true,
      snapshotId: 4,
    });
  });

  test("a secret resumes with how it ended, never the value", async () => {
    const resolver = createWaitResolver({
      control: async () => ({
        holder: "bot",
        since: "",
        requested: false,
        transitioning: false,
        resumeSnapshotRequired: false,
        lastSecret: {
          label: "the SMS code",
          outcome: "supplied",
          at: "2026-10-13T10:00:05Z",
        },
      }),
    });
    const wait = { ...base, kind: "computer_secret", requestId: null };
    expect(await resolver.ready(wait)).toBe(true);
    expect(JSON.parse(await resolver.result(wait))).toMatchObject({
      ok: true,
      outcome: "supplied",
    });
  });

  test("a sign-in resumes with the server's own record of how it ended", async () => {
    let state = "pending";
    const resolver = createWaitResolver({
      signIn: async () => ({ status: state }),
      signInResult: async () => ({
        ok: true,
        signedIn: true,
        site: "https://gov.gr",
      }),
    });
    const wait = { ...base, kind: "computer_sign_in", requestId: "sign-in-1" };
    expect(await resolver.ready(wait)).toBe(false);
    state = "signed_in";
    expect(await resolver.ready(wait)).toBe(true);
    expect(JSON.parse(await resolver.result(wait))).toMatchObject({
      signedIn: true,
    });
  });
});

describe("the flag", () => {
  test("COMPUTER_TOOLS_IN_RUN is on unless it says false or 0", () => {
    const flag = (value?: string) =>
      loadConfig(
        testEnvironment(
          value === undefined ? {} : { COMPUTER_TOOLS_IN_RUN: value },
        ),
      ).computerToolsInRun;
    expect(flag()).toBe(true);
    expect(flag("true")).toBe(true);
    expect(flag("1")).toBe(true);
    expect(flag("false")).toBe(false);
    expect(flag("FALSE")).toBe(false);
    expect(flag("0")).toBe(false);
  });
});

/** A model turn that writes a call and then fails before it finishes. */
function failingSegment(input: RunAgentInput): Observable<BaseEvent> {
  return new Observable((subscriber) => {
    subscriber.next({
      type: EventType.RUN_STARTED,
      threadId: input.threadId,
      runId: input.runId,
    } as BaseEvent);
    for (const event of callEvents("c1")) subscriber.next(event);
    setTimeout(() => {
      subscriber.next({
        type: EventType.RUN_ERROR,
        message: "The model stream broke.",
      } as BaseEvent);
      subscriber.complete();
    }, 5);
  });
}

describe("a model stream that fails after a call has started", () => {
  test("still records what the call did before the failure ends the run", async () => {
    const agent = new Segments([failingSegment]);
    const events = await drive(
      agent,
      clickTool(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { ok: true, element: { name: "Save" } };
      }),
    );
    const result = events.findIndex(
      (event) => event.type === EventType.TOOL_CALL_RESULT,
    );
    const error = events.findIndex(
      (event) => event.type === EventType.RUN_ERROR,
    );
    expect(result).toBeGreaterThan(-1);
    expect(error).toBeGreaterThan(result);
    expect(count(events, EventType.RUN_ERROR)).toBe(1);
  });

  test("still records the wait of a call that stopped for the person", async () => {
    const waits: HeadlessWait[] = [];
    const agent = new Segments([failingSegment]);
    const events = await drive(
      agent,
      clickTool(async () => {
        throw new HeadlessToolSuspension("Waiting for you to sign in.", {
          kind: "computer_sign_in",
          requestId: "sign-in-2",
        });
      }),
      { onWaiting: async (wait) => void waits.push(wait) },
    );
    expect(waits.map((wait) => wait.toolCallId)).toEqual(["c1"]);
    expect(waits[0]?.waiting.continuation).toBeDefined();
    const waiting = events.findIndex(
      (event) => event.type === EventType.CUSTOM,
    );
    const error = events.findIndex(
      (event) => event.type === EventType.RUN_ERROR,
    );
    expect(waiting).toBeGreaterThan(-1);
    expect(error).toBeGreaterThan(waiting);
  });
});

describe("a call carried out inside the run cannot be carried out again by the browser", () => {
  test("the ledger marks it used before it runs, so a crafted browser request is refused", async () => {
    scriptModel();
    const ledger = createToolCallLedger();
    let executions = 0;
    const agent = await bot({
      tools: async () => [
        clickTool(async () => {
          executions++;
          return { ok: true };
        }),
      ],
      beforeExecute: (botId, call) =>
        ledger.settle({ ...call, ownerUserId: "owner", botId }),
    });
    agent.use(
      new ToolCallLedgerMiddleware(ledger, {
        ownerUserId: "owner",
        botId: "bot",
      }),
    );
    await run(agent);
    expect(executions).toBe(1);
    // The browser path: a snapshot that leaves the server's result out, asking to run it again.
    const replay = requireSavedToolCall({
      toolCallId: "call-click",
      toolName: "computer_click",
      args: { ref: "e7", snapshotId: 3 },
      read: async () => ({ messages: [] }),
      ledger: {
        consume: () =>
          ledger.consume({
            threadId: agent.threadId,
            toolCallId: "call-click",
            ownerUserId: "owner",
            botId: "bot",
            toolName: "computer_click",
            args: { ref: "e7", snapshotId: 3 },
          }),
      },
      attempts: 1,
      sleep: async () => undefined,
    });
    await expect(replay).rejects.toThrow("already carried out once");
  });

  test("the ledger's observer also marks used every call the run answered itself", async () => {
    const ledger = createToolCallLedger();
    const answered = new Segments([
      (input) =>
        segment(input, [
          ...callEvents("c9"),
          {
            type: EventType.TOOL_CALL_RESULT,
            messageId: "r9",
            toolCallId: "c9",
            role: "tool",
            content: '{"ok":true}',
          } as BaseEvent,
        ]),
    ]);
    answered.use(
      new ToolCallLedgerMiddleware(ledger, {
        ownerUserId: "owner",
        botId: "bot",
      }),
    );
    answered.threadId = "thread";
    await answered.runAgent();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(
      ledger.consume({
        threadId: "thread",
        toolCallId: "c9",
        ownerUserId: "owner",
        botId: "bot",
        toolName: "computer_click",
        args: { ref: "e7", snapshotId: 3 },
      }),
    ).resolves.toBe("replayed");
  });
});

describe("the run-wait sweep, kind to computers and to the queue", () => {
  const owner = { ownerUserId: "owner", botId: "bot" };
  async function openWait(
    store: ReturnType<typeof createRunWaitStore>,
    id: string,
  ) {
    await store.open(
      waitFromSuspension(
        {
          threadId: "thread",
          runId: "run",
          toolCallId: id,
          toolName: "computer_request_help",
          message: "Take over",
          waiting: {
            kind: "computer_handoff",
            requestId: `req-${id}`,
            continuation: {},
          },
        },
        owner,
      ),
    );
    // Distinct creation times, so the walk order is the open order.
    await new Promise((resolve) => setTimeout(resolve, 2));
  }

  test("a takeover on a computer that is not running is not asked, so it is never woken", async () => {
    let controls = 0;
    const resolver = createWaitResolver({
      status: async () => ({ state: "absent" }),
      control: async () => {
        controls++;
        throw new Error("would wake the computer");
      },
    });
    const store = createRunWaitStore();
    await openWait(store, "a");
    const [wait] = await store.listOpen(["computer_handoff"], 1);
    if (!wait) throw new Error("expected a wait");
    expect(await resolver.ready(wait)).toBe(false);
    expect(controls).toBe(0);
  });

  test("an unanswered wait is checked less and less often", async () => {
    const store = createRunWaitStore();
    await openWait(store, "a");
    let clock = 0;
    let checks = 0;
    const sweep = createRunWaitResumer({
      store,
      resolver: {
        ready: async () => {
          checks++;
          return false;
        },
        result: async () => "{}",
      },
      continueTurn: async () => undefined,
      now: () => clock,
    });
    for (clock = 0; clock <= 20_000; clock += 1_000) await sweep();
    // Due at 0, 2 s, 6 s, 14 s: four checks in twenty seconds, not twenty.
    expect(checks).toBe(4);
  });

  test("a wait that cannot be checked is given up, and never holds newer waits back", async () => {
    const store = createRunWaitStore();
    await openWait(store, "broken");
    await openWait(store, "fine");
    let clock = 0;
    const continued: string[] = [];
    const sweep = createRunWaitResumer({
      store,
      resolver: {
        ready: async (wait) => {
          if (wait.toolCallId === "broken") throw new Error("unreachable");
          return true;
        },
        result: async () => "{}",
      },
      continueTurn: async (wait) => void continued.push(wait.toolCallId),
      now: () => clock,
      graceMs: 0,
      pageSize: 1,
      checksPerSweep: 1,
      maxFailures: 2,
    });
    for (clock = 0; clock <= 10_000; clock += 1_000) await sweep();
    expect(continued).toEqual(["fine"]);
    expect(await store.listOpen(["computer_handoff"], 10)).toEqual([]);
    expect((await store.get("owner", "thread", "broken"))?.claimedBy).toBe(
      "expired",
    );
  });

  test("a wait older than anybody would still be waiting is expired, not resumed", async () => {
    const store = createRunWaitStore();
    await openWait(store, "old");
    const sweep = createRunWaitResumer({
      store,
      resolver: { ready: async () => true, result: async () => "{}" },
      continueTurn: async () => {
        throw new Error("must not continue");
      },
      now: () => Date.now() + 3 * 60 * 60_000,
      graceMs: 0,
    });
    expect(await sweep()).toBe(0);
    expect((await store.get("owner", "thread", "old"))?.claimedBy).toBe(
      "expired",
    );
  });
});
