import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";

/**
 * The browser's half of COMPUTER_TOOLS_IN_RUN.
 *
 * The server carries each computer call out inside the run, so the browser handler only ever runs
 * for a call the run left unanswered: one the server stopped on to wait for the person, which this
 * tab resumes by claiming it, or one the server has no executor for, which the browser carries out
 * as before. And because no browser handler runs for the rest, the drawing of a call is what puts it
 * in the Activity list. Also here: the continuation retry that keeps a browser step followed by
 * silence from ending a turn as "Done" with no answer.
 */

const real = { ...(await import("@copilotkit/react-core/v2")) };
type Registered = Parameters<typeof real.useFrontendTool>[0];
const registered: Registered[] = [];
const stopped: unknown[] = [];
mock.module("@copilotkit/react-core/v2", () => ({
  ...real,
  useCopilotKit: () => ({
    copilotkit: { stopAgent: (input: unknown) => stopped.push(input) },
  }),
  useFrontendTool: (tool: Registered) => {
    const index = registered.findIndex((entry) => entry.name === tool.name);
    if (index === -1) registered.push(tool);
    else registered[index] = tool;
  },
}));
const { useFrontendTool, reportDrawnCall } = await import(
  "@/lib/copilot/approval-tools"
);
const { deploymentKeys } = await import("@/lib/deployment/queries");
const { activityFor } = await import("@/lib/computers/activity");
const { awaitsContinuation, runWithContinuationRetry, SILENT_CONTINUATION } =
  await import("@/lib/copilot/continuation-retry");

beforeAll(() => GlobalRegistrator.register());
afterEach(() => {
  cleanup();
  stopped.length = 0;
});
afterAll(() => {
  GlobalRegistrator.unregister();
  mock.module("@copilotkit/react-core/v2", () => real);
});

const carried: string[] = [];
function Tools() {
  useFrontendTool({
    name: "computer_request_help",
    description: "Ask for help",
    handler: async () => {
      carried.push("computer_request_help");
      return { ok: true, carriedInBrowser: true };
    },
  });
  useFrontendTool({
    name: "computer_show_screen",
    description: "Show the screen",
    handler: async () => {
      carried.push("computer_show_screen");
      return { ok: true, shown: true };
    },
  });
  return null;
}

function mount() {
  const queries = new QueryClient();
  queries.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: false,
    selfHostBanner: false,
    computerToolsInRun: true,
  });
  render(
    <QueryClientProvider client={queries}>
      <Tools />
    </QueryClientProvider>,
  );
  return queries;
}

function answering(routes: Record<string, () => Response>) {
  const asked: string[] = [];
  const original = global.fetch;
  global.fetch = Object.assign(
    async (path: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const key = `${init?.method ?? "GET"} ${String(path)}`;
      asked.push(key);
      const answer = routes[key];
      return answer
        ? answer()
        : Response.json({ error: "none" }, { status: 404 });
    },
    { preconnect: original.preconnect },
  );
  return { asked, restore: () => (global.fetch = original) };
}

const context = (name: string, id: string) => ({
  agent: { threadId: "thread", agentId: "bot" },
  toolCall: {
    id,
    type: "function" as const,
    function: { name, arguments: "{}" },
  },
});

const WAIT = "/api/runs/waits/thread/call-1";

test("a takeover the server waited on is resumed here, with the result the server built", async () => {
  mount();
  const fetches = answering({
    [`GET ${WAIT}`]: () =>
      Response.json({
        kind: "computer_handoff",
        requestId: "r1",
        status: "ready",
      }),
    [`POST ${WAIT}/claim`]: () =>
      Response.json({
        claimed: true,
        content: JSON.stringify({ ok: true, handoffStatus: "completed" }),
      }),
  });
  try {
    const tool = registered.find(
      (entry) => entry.name === "computer_request_help",
    );
    const result = await tool?.handler?.(
      {},
      context("computer_request_help", "call-1") as never,
    );
    expect(result).toEqual({ ok: true, handoffStatus: "completed" });
    expect(fetches.asked).toEqual([`GET ${WAIT}`, `POST ${WAIT}/claim`]);
    expect(carried).toEqual([]);
    expect(stopped).toEqual([]);
  } finally {
    fetches.restore();
  }
});

test("continued elsewhere, or an approval, stops this run rather than continuing it twice", async () => {
  const queries = mount();
  const invalidated: unknown[] = [];
  const invalidate = queries.invalidateQueries.bind(queries);
  queries.invalidateQueries = ((filters?: unknown) => {
    invalidated.push(filters);
    return invalidate(filters as never);
  }) as typeof queries.invalidateQueries;
  const tool = registered.find(
    (entry) => entry.name === "computer_request_help",
  );
  const elsewhere = answering({
    [`GET ${WAIT}`]: () =>
      Response.json({
        kind: "computer_sign_in",
        requestId: "s1",
        status: "ready",
      }),
    [`POST ${WAIT}/claim`]: () => Response.json({ claimed: false }),
  });
  try {
    expect(
      await tool?.handler?.(
        {},
        context("computer_request_help", "call-1") as never,
      ),
    ).toEqual({ waiting: true });
    expect(stopped).toHaveLength(1);
  } finally {
    elsewhere.restore();
  }
  const approval = answering({
    [`GET ${WAIT}`]: () =>
      Response.json({ kind: "approval", requestId: "a1", status: "waiting" }),
  });
  try {
    expect(
      await tool?.handler?.(
        {},
        context("computer_request_help", "call-1") as never,
      ),
    ).toEqual({ waiting: true });
    expect(stopped).toHaveLength(2);
    expect(approval.asked).toEqual([`GET ${WAIT}`]);
  } finally {
    approval.restore();
  }
});

test("a call the server did not carry out is carried out in the browser, as before", async () => {
  mount();
  const fetches = answering({});
  try {
    const tool = registered.find(
      (entry) => entry.name === "computer_show_screen",
    );
    const result = await tool?.handler?.(
      {},
      context("computer_show_screen", "call-2") as never,
    );
    expect(result).toEqual({ ok: true, shown: true });
    expect(carried).toEqual(["computer_show_screen"]);
  } finally {
    fetches.restore();
    carried.length = 0;
  }
});

test("a drawn call is put in the Activity list once, and restored history is not", () => {
  const live = {
    toolCallId: "nav-1",
    args: { url: "https://example.com" },
    status: "inProgress",
  };
  reportDrawnCall("bot-activity", live, "computer_navigate");
  reportDrawnCall(
    "bot-activity",
    {
      ...live,
      status: "complete",
      result: JSON.stringify({
        ok: true,
        url: "https://example.com",
        title: "Example",
      }),
    },
    "computer_navigate",
  );
  reportDrawnCall(
    "bot-activity",
    {
      ...live,
      status: "complete",
      result: JSON.stringify({
        ok: true,
        url: "https://example.com",
        title: "Example",
      }),
    },
    "computer_navigate",
  );
  // History: first drawn already answered, so nothing the Bot is doing now.
  reportDrawnCall(
    "bot-activity",
    {
      toolCallId: "nav-old",
      args: { url: "https://old.example" },
      status: "complete",
      result: JSON.stringify({
        ok: true,
        url: "https://old.example",
        title: "Old",
      }),
    },
    "computer_navigate",
  );
  const lines = activityFor("bot-activity");
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatchObject({ kind: "page", subject: "Example" });
});

const turn = (last: Message): Message[] => [
  { id: "u1", role: "user", content: "Click Save" },
  {
    id: "a1",
    role: "assistant",
    content: "",
    toolCalls: [
      {
        id: "c1",
        type: "function",
        function: { name: "computer_click", arguments: "{}" },
      },
    ],
  },
  last,
];

test("a turn that ends on the browser's answer awaits a continuation; one with words does not", () => {
  const before = new Set(["u0"]);
  const result: Message = {
    id: "t1",
    role: "tool",
    toolCallId: "c1",
    content: '{"ok":true}',
  };
  expect(awaitsContinuation(turn(result), before, () => true)).toBe(true);
  expect(awaitsContinuation(turn(result), before, () => false)).toBe(false);
  expect(
    awaitsContinuation(
      [...turn(result), { id: "a2", role: "assistant", content: "Saved." }],
      before,
      () => true,
    ),
  ).toBe(false);
});

function retryingAgent(script: ((messages: Message[]) => Message[])[]) {
  const subscribers: {
    onRunErrorEvent?: (params: { event?: { message?: string } }) => void;
  }[] = [];
  const agent = {
    messages: turn({
      id: "t1",
      role: "tool",
      toolCallId: "c1",
      content: '{"ok":true}',
    }),
    subscribe(subscriber: (typeof subscribers)[number]) {
      subscribers.push(subscriber);
      return { unsubscribe: () => undefined };
    },
  };
  let runs = 0;
  const run = async () => {
    const step = script[runs++];
    if (step) agent.messages = step(agent.messages);
    else
      for (const subscriber of subscribers)
        subscriber.onRunErrorEvent?.({
          event: { message: "Thread lock denied" },
        });
  };
  return { agent, run, runs: () => runs };
}

test("a continuation that never came is started once more, and then the turn fails out loud", async () => {
  const recovered = retryingAgent([
    (messages) => messages,
    (messages) => [
      ...messages,
      { id: "a2", role: "assistant", content: "Saved." },
    ],
  ]);
  expect(
    await runWithContinuationRetry({
      agent: recovered.agent,
      run: recovered.run,
      before: new Set(["u1"]),
      followsUp: () => true,
      stopped: () => false,
    }),
  ).toBeNull();
  expect(recovered.runs()).toBe(2);

  const silent = retryingAgent([
    (messages) => messages,
    (messages) => messages,
  ]);
  expect(
    await runWithContinuationRetry({
      agent: silent.agent,
      run: silent.run,
      before: new Set(["u1"]),
      followsUp: () => true,
      stopped: () => false,
    }),
  ).toBe(SILENT_CONTINUATION);

  const failing = retryingAgent([(messages) => messages]);
  expect(
    await runWithContinuationRetry({
      agent: failing.agent,
      run: failing.run,
      before: new Set(["u1"]),
      followsUp: () => true,
      stopped: () => false,
    }),
  ).toBe("Thread lock denied");

  const stoppedTurn = retryingAgent([(messages) => messages]);
  expect(
    await runWithContinuationRetry({
      agent: stoppedTurn.agent,
      run: stoppedTurn.run,
      before: new Set(["u1"]),
      followsUp: () => true,
      stopped: () => true,
    }),
  ).toBeNull();
  expect(stoppedTurn.runs()).toBe(1);
});
