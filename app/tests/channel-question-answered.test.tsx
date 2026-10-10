import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { type Message, RunAgentInputSchema } from "@ag-ui/core";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { type InfiniteData, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  FIRST_TURN_GREETING,
  FIRST_TURN_OPTIONS,
  FIRST_TURN_QUESTION,
  frameFirstTurn,
} from "../../shared/first-turn";
import { PUT_TO } from "../../shared/handoff-markers";
import { ChannelChat } from "@/components/channels/channel-chat";
import {
  type AgentChannel,
  type ChannelPage,
  channelKeys,
} from "@/lib/channels/queries";
import { EscalationTool } from "@/lib/copilot/escalation-tool";
import { openQuestions } from "@/lib/copilot/question-answers";
import { queryClient } from "@/query-client";

/**
 * A Bot's question answered in the conversation must not stay waiting in Approvals: picking an
 * option or typing an answer tells the server which questions it answered, and a conversation read
 * back after a reload draws the question as answered.
 *
 * The same fixture server as `channel-history-refresh.test.tsx`, with the `ask_person` renderer the
 * app's provider registers.
 */

const NativeResponse = globalThis.Response;
const channel: AgentChannel = {
  id: "question-channel",
  name: "New Bot",
  agentIds: ["new-bot"],
  threadId: "question-thread",
  active: true,
  lastMessageAt: "2026-10-10T09:00:00.000Z",
};

const frame: Message = { id: "frame", role: "user", content: frameFirstTurn() };
const asked: Message = {
  id: "asked",
  role: "assistant",
  content: FIRST_TURN_GREETING,
  toolCalls: [
    {
      id: "call-question",
      type: "function",
      function: {
        name: "ask_person",
        arguments: JSON.stringify({
          question: FIRST_TURN_QUESTION,
          options: FIRST_TURN_OPTIONS,
        }),
      },
    },
  ],
};
const reached: Message = {
  id: "reached",
  role: "tool",
  toolCallId: "call-question",
  content: JSON.stringify(`${PUT_TO}the person in this conversation.`),
};

let stored: Message[] = [];
let answered: unknown[] = [];
let runs = 0;
let originalFetch: typeof fetch;

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
      const request = () =>
        input instanceof Request ? input : new Request(url, init);
      if (url.pathname === "/api/agents")
        return NativeResponse.json({ agents: [] });
      if (url.pathname === "/api/plugins/for/new-bot")
        return NativeResponse.json({ skills: [], tools: [] });
      if (url.pathname.endsWith("/info"))
        return NativeResponse.json({
          version: "fixture",
          agents: { "new-bot": { description: "Fixture", capabilities: {} } },
          mode: "sse",
          telemetryDisabled: true,
        });
      if (url.pathname.endsWith("/connect"))
        return sse([
          { type: "RUN_STARTED", threadId: channel.threadId, runId: "join" },
          { type: "MESSAGES_SNAPSHOT", messages: [] },
          { type: "RUN_FINISHED", threadId: channel.threadId, runId: "join" },
        ]);
      if (url.pathname.endsWith("/run")) {
        const body = RunAgentInputSchema.parse(await request().json());
        runs += 1;
        return sse([
          { type: "RUN_STARTED", threadId: body.threadId, runId: body.runId },
          { type: "RUN_FINISHED", threadId: body.threadId, runId: body.runId },
        ]);
      }
      if (url.pathname === "/api/approvals/questions/answered") {
        answered.push(await request().json());
        return NativeResponse.json({ resolved: ["question-key"] });
      }
      if (/\/api\/channels\/[^/]+\/(activity|busy)$/.test(url.pathname))
        return new NativeResponse(null, { status: 204 });
      if (url.pathname === "/api/voice/sessions")
        return NativeResponse.json({ sessions: [], nextCursor: null });
      if (/\/threads\/[^/]+\/messages$/.test(url.pathname))
        return NativeResponse.json({ messages: stored });
      throw new Error(`Unexpected fixture request: ${url.pathname}`);
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
});
afterAll(() => {
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

function mount(history: Message[]) {
  stored = history;
  answered = [];
  runs = 0;
  queryClient.setQueryData<InfiniteData<ChannelPage>>(channelKeys.list(), {
    pages: [
      {
        channels: [
          {
            ...channel,
            summary: null,
            lastMessage: FIRST_TURN_QUESTION,
            lastMessageAgentId: "new-bot",
            createdAt: "2026-10-10T09:00:00.000Z",
            pinned: false,
            lastReadAt: null,
          },
        ],
        nextCursor: null,
      },
    ],
    pageParams: [""],
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <CopilotKitProvider runtimeUrl="http://localhost/api/copilotkit">
        <EscalationTool />
        <ChannelChat channel={channel} runtimeAgentId="new-bot" />
      </CopilotKitProvider>
    </QueryClientProvider>,
  );
  return { view, user: userEvent.setup({ document }) };
}

test("picking an option answers the question in Approvals too", async () => {
  const { view, user } = mount([frame, asked, reached]);

  await user.click(
    await view.findByRole("button", { name: /Code and GitHub work/ }),
  );

  await waitFor(() =>
    expect(answered).toEqual([
      {
        threadId: channel.threadId,
        questions: [FIRST_TURN_QUESTION],
        response: "Code and GitHub work",
      },
    ]),
  );
  await waitFor(() => expect(runs).toBe(1));
  expect(await view.findByText("Answered")).toBeTruthy();
});

test("a typed answer answers it the same way", async () => {
  const { view, user } = mount([frame, asked, reached]);

  await user.click(
    await view.findByRole("button", { name: "Type your own answer" }),
  );
  await user.type(
    view.getByRole("textbox", { name: "Your own answer" }),
    "Sorting my inbox{Enter}",
  );

  await waitFor(() =>
    expect(answered).toEqual([
      {
        threadId: channel.threadId,
        questions: [FIRST_TURN_QUESTION],
        response: "Sorting my inbox",
      },
    ]),
  );
});

test("read back after a reload, an answered question shows its answer and asks nothing again", async () => {
  const { view } = mount([
    frame,
    asked,
    reached,
    { id: "answer", role: "user", content: "Research and writing" },
  ]);

  expect(await view.findByText("Answered")).toBeTruthy();
  const picked = view.getByRole("button", { name: /Research and writing/ });
  expect(picked.hasAttribute("disabled")).toBe(true);
  // The frame is never drawn, and restoring history settles nothing on the server.
  expect(view.queryByText(/You were created a moment ago/)).toBeNull();
  expect(answered).toEqual([]);
});

test("the questions a message answers are the ones still open when it is sent", () => {
  expect(openQuestions([frame, asked, reached])).toEqual([
    { toolCallId: "call-question", question: FIRST_TURN_QUESTION },
  ]);
  expect(
    openQuestions([
      frame,
      asked,
      reached,
      { id: "answer", role: "user", content: "Research and writing" },
    ]),
  ).toEqual([]);
});
