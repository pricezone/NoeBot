import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { Message, RunAgentInput } from "@ag-ui/core";
import {
  CopilotKitProvider,
  useCopilotKit,
  useFrontendTool,
} from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { type InfiniteData, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { z } from "zod";
import { ChannelChat } from "@/components/channels/channel-chat";
import {
  type AgentChannel,
  type ChannelPage,
  type ChannelSummary,
  channelKeys,
} from "@/lib/channels/queries";
import { noteChannelStep } from "@/lib/channels/steps";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * A tab watching a turn another tab is running.
 *
 * It joined the run once, when it opened, and used to read the history again only when a Bot message
 * reached the roster — which a turn waiting on the person never sends, so the Secure Form or the
 * question it was waiting on appeared here only after a reload. Now it reads the history on every
 * step the running tab reports (retrying until the card the step names is there), and every two
 * seconds while the roster says a turn is going. Never by joining the run again: that would run the
 * pending card in this tab too.
 */

type ChannelCache = InfiniteData<ChannelPage>;
const NativeResponse = globalThis.Response;
const channel: AgentChannel = {
  id: "watching-channel",
  name: "Watching test",
  agentIds: ["watching-bot"],
  threadId: "watching-thread",
  active: true,
  lastMessageAt: "2026-10-13T00:00:00.000Z",
};
const opening = {
  id: "opening",
  role: "assistant",
  content: "Stored opening",
} satisfies Message;
const asking = {
  id: "asking",
  role: "assistant",
  toolCalls: [
    {
      id: "call-choice",
      type: "function",
      function: {
        name: "askChoice",
        arguments: JSON.stringify({ title: "Which year?", options: [] }),
      },
    },
  ],
} satisfies Message;

let originalFetch: typeof fetch;
let history: () => Promise<Response>;
let historyReads = 0;
let connects = 0;
let busySignals: unknown[] = [];
let runs = 0;
let core: ReturnType<typeof useCopilotKit>["copilotkit"] | undefined;

function CoreProbe() {
  core = useCopilotKit().copilotkit;
  return null;
}

/** A sign-in tool the tab carries out, standing in for the real one: done as soon as it starts. */
function SignInProbe() {
  useFrontendTool({
    name: "computer_request_sign_in",
    description: "Fixture sign-in",
    parameters: z.object({ origin: z.string() }),
    handler: async () => "signed in",
  });
  return null;
}
function stored(messages: unknown[]) {
  return NativeResponse.json({ messages });
}
function sse(events: unknown[]) {
  return new NativeResponse(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

beforeAll(() => {
  GlobalRegistrator.register();
  originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
        "http://localhost",
      );
      if (url.pathname === "/api/agents")
        return NativeResponse.json({ agents: [] });
      if (url.pathname.startsWith("/api/plugins/for/"))
        return NativeResponse.json({ skills: [], tools: [] });
      if (url.pathname.endsWith("/info"))
        return NativeResponse.json({
          version: "fixture",
          agents: {
            "watching-bot": { description: "Fixture", capabilities: {} },
          },
          mode: "sse",
          telemetryDisabled: true,
        });
      if (url.pathname.endsWith("/connect")) {
        connects += 1;
        return sse([
          { type: "RUN_STARTED", threadId: channel.threadId, runId: "join" },
          { type: "MESSAGES_SNAPSHOT", messages: [] },
          { type: "RUN_FINISHED", threadId: channel.threadId, runId: "join" },
        ]);
      }
      if (url.pathname.endsWith("/run")) {
        const request =
          input instanceof Request ? input : new Request(url, init);
        const body = (await request.json()) as RunAgentInput;
        runs += 1;
        return sse(
          runs === 1
            ? [
                {
                  type: "RUN_STARTED",
                  threadId: body.threadId,
                  runId: body.runId,
                },
                {
                  type: "TOOL_CALL_START",
                  toolCallId: "call-sign-in",
                  toolCallName: "computer_request_sign_in",
                  parentMessageId: "asking-sign-in",
                },
                {
                  type: "TOOL_CALL_ARGS",
                  toolCallId: "call-sign-in",
                  delta: JSON.stringify({ origin: "https://gov.gr" }),
                },
                { type: "TOOL_CALL_END", toolCallId: "call-sign-in" },
                {
                  type: "RUN_FINISHED",
                  threadId: body.threadId,
                  runId: body.runId,
                },
              ]
            : [
                {
                  type: "RUN_STARTED",
                  threadId: body.threadId,
                  runId: body.runId,
                },
                // The continuation answers. An empty one is retried once (a silent end is a failure).
                {
                  type: "TEXT_MESSAGE_START",
                  messageId: "signed-in-reply",
                  role: "assistant",
                },
                {
                  type: "TEXT_MESSAGE_CONTENT",
                  messageId: "signed-in-reply",
                  delta: "Signed in.",
                },
                { type: "TEXT_MESSAGE_END", messageId: "signed-in-reply" },
                {
                  type: "RUN_FINISHED",
                  threadId: body.threadId,
                  runId: body.runId,
                },
              ],
        );
      }
      if (/\/api\/channels\/[^/]+\/busy$/.test(url.pathname)) {
        const request =
          input instanceof Request ? input : new Request(url, init);
        busySignals.push(await request.json());
        return new NativeResponse(null, { status: 204 });
      }
      if (url.pathname === "/api/voice/sessions")
        return NativeResponse.json({ sessions: [], nextCursor: null });
      if (/\/threads\/[^/]+\/messages$/.test(url.pathname)) {
        historyReads += 1;
        return history();
      }
      // The cards under the conversation, and anything else this screen reads: nothing waiting.
      return NativeResponse.json({}, { status: 404 });
    },
    {
      preconnect() {
        throw new Error("Unexpected fixture preconnect");
      },
    },
  );
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  core = undefined;
});
afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

function cacheChannel(busy: boolean) {
  const summary: ChannelSummary = {
    ...channel,
    summary: null,
    lastMessage: null,
    lastMessageAgentId: "watching-bot",
    lastMessageAt: channel.lastMessageAt,
    createdAt: "2026-10-13T00:00:00.000Z",
    pinned: false,
    lastReadAt: null,
    busy,
  };
  queryClient.setQueryData<ChannelCache>(channelKeys.list(), {
    pages: [{ channels: [summary], nextCursor: null }],
    pageParams: [""],
  });
}

async function mount(busy = false) {
  historyReads = 0;
  connects = 0;
  busySignals = [];
  runs = 0;
  history = async () => stored([opening]);
  cacheChannel(busy);
  const view = render(
    <QueryClientProvider client={queryClient}>
      <CopilotKitProvider runtimeUrl="http://localhost/api/copilotkit">
        <CoreProbe />
        <SignInProbe />
        <ChannelChat channel={channel} runtimeAgentId="watching-bot" />
      </CopilotKitProvider>
    </QueryClientProvider>,
  );
  await view.findByText("Stored opening");
  return view;
}

function agentMessages() {
  const agent = core?.getAgent(`channel:${channel.id}`);
  if (!agent) throw new Error("Mounted channel agent is not registered");
  return agent.messages;
}

test("a step naming a waiting card reads the history at once, and keeps reading until the card is there", async () => {
  await mount();
  const readsAtMount = historyReads;
  const connectsAtMount = connects;
  let attempt = 0;
  history = async () => {
    attempt += 1;
    // The conversation service lags: first no such thread, then the old snapshot, then the card.
    if (attempt === 1)
      return NativeResponse.json(
        { error: "THREAD_NOT_FOUND" },
        { status: 404 },
      );
    if (attempt === 2) return stored([opening]);
    return stored([opening, asking]);
  };

  await act(async () => {
    noteChannelStep(channel.id, {
      step: Date.now() + 2_000_000,
      busy: true,
      waiting: { kind: "choice", toolCallId: "call-choice" },
    });
  });

  await waitFor(
    () =>
      expect(agentMessages().some((message) => message.id === "asking")).toBe(
        true,
      ),
    { timeout: 4000 },
  );
  expect(historyReads - readsAtMount).toBe(3);
  // Read, never re-joined: joining would run the pending card in this tab as well.
  expect(connects).toBe(connectsAtMount);
});

test("while the roster says another tab's turn is going, the history is read every two seconds", async () => {
  await mount(true);
  const readsAtMount = historyReads;
  await new Promise((resolve) => setTimeout(resolve, 2300));
  expect(historyReads).toBeGreaterThan(readsAtMount);

  // The turn ends: the reading stops.
  await act(async () => cacheChannel(false));
  const readsAtEnd = historyReads;
  await new Promise((resolve) => setTimeout(resolve, 2300));
  expect(historyReads).toBe(readsAtEnd);
});

test("the tab running the turn reports each step: the turn, each run, and the card that waits", async () => {
  const view = await mount();
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.type(view.getByRole("textbox", { name: "Message" }), "Sign me in");
  await user.click(view.getByRole("button", { name: "Send message" }));

  await waitFor(() => expect(runs).toBe(2), { timeout: 4000 });
  await waitFor(() =>
    expect(busySignals.at(-1)).toMatchObject({ busy: false }),
  );
  const signals = busySignals as {
    busy: boolean;
    step: number;
    waiting?: { kind: string; toolCallId: string };
  }[];
  // Every signal carries a step, and the steps only rise.
  for (const [index, signal] of signals.entries()) {
    expect(typeof signal.step).toBe("number");
    if (index > 0)
      expect(signal.step).toBeGreaterThan(signals[index - 1]?.step ?? 0);
  }
  expect(signals[0]).toMatchObject({ busy: true });
  expect(signals.filter((signal) => signal.waiting !== undefined)).toEqual([
    expect.objectContaining({
      busy: true,
      waiting: { kind: "sign_in", toolCallId: "call-sign-in" },
    }),
  ]);
  // The turn start, two runs starting and ending, the card starting and ending, the turn end.
  expect(signals.length).toBeGreaterThanOrEqual(6);
});
