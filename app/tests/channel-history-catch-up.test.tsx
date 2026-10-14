import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { Message, RunAgentInput } from "@ag-ui/core";
import { CopilotKitProvider, useCopilotKit } from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { type InfiniteData, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChannelChat } from "@/components/channels/channel-chat";
import {
  type AgentChannel,
  type ChannelPage,
  type ChannelSummary,
  channelKeys,
} from "@/lib/channels/queries";
import { type ChannelWaiting, noteChannelStep } from "@/lib/channels/steps";
import { applyChannelEvent } from "@/lib/channels/use-channel-events";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * A watching tab catching up with messages it first read half written.
 *
 * FOUND LIVE: a tab watching a turn another tab was running showed "ΔΕΔΔ" for "ΔΕΔΔΗΕ" and "ελέγ" for
 * "ελέγξεις", and a question card with only "Type your own answer" and none of its options, until a
 * reload. A history read made while the Bot was still writing returned the message half written, and
 * every later read with the whole message was merged by keeping the copy this tab already had for
 * that id. Now a stored copy that is the local one written further replaces it, and never while this
 * tab streams the message itself.
 */

type ChannelCache = InfiniteData<ChannelPage>;
const NativeResponse = globalThis.Response;
const NativeReadableStream = globalThis.ReadableStream;
const channel: AgentChannel = {
  id: "catch-up-channel",
  name: "Catch-up test",
  agentIds: ["catch-up-bot"],
  threadId: "catch-up-thread",
  active: true,
  lastMessageAt: "2026-10-14T00:00:00.000Z",
};
const opening = {
  id: "opening",
  role: "assistant",
  content: "Stored opening",
} satisfies Message;
const greekAsk = {
  id: "greek-ask",
  role: "user",
  content: "Θέλω να εκδώσω υπεύθυνη δήλωση",
} satisfies Message;
const QUESTION = "Τρόπος επιβεβαίωσης έκδοσης";
const FULL_ARGS = JSON.stringify({
  title: QUESTION,
  options: [
    { id: "sms", label: "Με SMS στο κινητό μου" },
    { id: "wallet", label: "Μέσω Gov.gr Wallet" },
  ],
});
function asking(args: string): Message {
  return {
    id: "asking",
    role: "assistant",
    toolCalls: [
      {
        id: "call-choice",
        type: "function",
        function: { name: "askChoice", arguments: args },
      },
    ],
  };
}

let originalFetch: typeof fetch;
let history: () => Promise<Response>;
let historyReads = 0;
let run: (input: RunAgentInput) => Response;
let core: ReturnType<typeof useCopilotKit>["copilotkit"] | undefined;

function CoreProbe() {
  core = useCopilotKit().copilotkit;
  return null;
}

function stored(messages: unknown[]) {
  return NativeResponse.json({ messages });
}

/** A run's event stream this test writes to as it goes, so a read can land mid-stream. */
function liveRun() {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stream = new NativeReadableStream<Uint8Array>({
    start(started) {
      controller = started;
    },
  });
  const encoder = new TextEncoder();
  return {
    response: new NativeResponse(stream, {
      headers: { "content-type": "text/event-stream" },
    }),
    send(event: unknown) {
      controller?.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
    },
    close() {
      controller?.close();
    },
  };
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
            "catch-up-bot": { description: "Fixture", capabilities: {} },
          },
          mode: "sse",
          telemetryDisabled: true,
        });
      if (url.pathname.endsWith("/connect"))
        return new NativeResponse(
          [
            { type: "RUN_STARTED", threadId: channel.threadId, runId: "join" },
            { type: "MESSAGES_SNAPSHOT", messages: [] },
            { type: "RUN_FINISHED", threadId: channel.threadId, runId: "join" },
          ]
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join(""),
          { headers: { "content-type": "text/event-stream" } },
        );
      if (url.pathname.endsWith("/run")) {
        const request =
          input instanceof Request ? input : new Request(url, init);
        return run((await request.json()) as RunAgentInput);
      }
      if (/\/api\/channels\/[^/]+\/(busy|activity)$/.test(url.pathname))
        return new NativeResponse(null, { status: 204 });
      if (url.pathname === "/api/voice/sessions")
        return NativeResponse.json({ sessions: [], nextCursor: null });
      if (/\/threads\/[^/]+\/messages$/.test(url.pathname)) {
        historyReads += 1;
        return history();
      }
      // The cards under the conversation and their records: nothing waiting.
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

function cacheChannel() {
  const summary: ChannelSummary = {
    ...channel,
    summary: null,
    lastMessage: null,
    lastMessageAgentId: "catch-up-bot",
    lastMessageAt: channel.lastMessageAt,
    createdAt: "2026-10-14T00:00:00.000Z",
    pinned: false,
    lastReadAt: null,
  };
  queryClient.setQueryData<ChannelCache>(channelKeys.list(), {
    pages: [{ channels: [summary], nextCursor: null }],
    pageParams: [""],
  });
}

async function mount() {
  historyReads = 0;
  history = async () => stored([opening]);
  run = () => {
    throw new Error("No run expected");
  };
  cacheChannel();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <CopilotKitProvider runtimeUrl="http://localhost/api/copilotkit">
        <CoreProbe />
        <ChannelChat channel={channel} runtimeAgentId="catch-up-bot" />
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

let steps = Date.now() + 5_000_000;
/** Another tab reports a step, as its busy signal does over the socket. */
async function stepElsewhere(waiting?: ChannelWaiting) {
  steps += 1;
  await act(async () => {
    noteChannelStep(channel.id, {
      step: steps,
      busy: true,
      ...(waiting ? { waiting } : {}),
    });
  });
}

/** The roster hears of a Bot message this tab did not report itself. */
async function announce(text: string, second: number) {
  await act(async () => {
    queryClient.setQueryData<ChannelCache>(channelKeys.list(), (cache) => {
      if (!cache) throw new Error("No mounted channel cache");
      const patched = applyChannelEvent(cache, {
        channelId: channel.id,
        lastMessage: text,
        lastMessageAgentId: "catch-up-bot",
        lastMessageAt: `2026-10-14T00:01:${String(second).padStart(2, "0")}.000Z`,
      });
      if (patched === "unknown") throw new Error("Channel missing from cache");
      return patched;
    });
  });
}

test("a reply first read half written is replaced by the whole reply on a later read", async () => {
  const view = await mount();
  const partial = "Θα χρειαστείς τον αριθμό παροχής της ΔΕΔΔ";
  const whole = "Θα χρειαστείς τον αριθμό παροχής της ΔΕΔΔΗΕ";
  history = async () =>
    stored([opening, { id: "reply", role: "assistant", content: partial }]);
  await stepElsewhere();
  await view.findByText(partial);

  history = async () =>
    stored([opening, { id: "reply", role: "assistant", content: whole }]);
  await stepElsewhere();

  await view.findByText(whole);
  expect(view.queryByText(partial)).toBeNull();
  expect(
    agentMessages().find((message) => message.id === "reply")?.content,
  ).toBe(whole);
  // One message, replaced in place: never the half and the whole side by side.
  expect(agentMessages().map((message) => message.id)).toEqual([
    "opening",
    "reply",
  ]);
});

test("an older, shorter or different stored copy never replaces the reply on screen", async () => {
  const view = await mount();
  const whole = "Πρέπει να το ελέγξεις πριν το στείλεις.";
  history = async () =>
    stored([opening, { id: "reply", role: "assistant", content: whole }]);
  await stepElsewhere();
  await view.findByText(whole);

  for (const stale of [
    "Πρέπει να το ελέγ",
    "Something else entirely, longer",
  ]) {
    const reads = historyReads;
    history = async () =>
      stored([opening, { id: "reply", role: "assistant", content: stale }]);
    await stepElsewhere();
    await waitFor(() => expect(historyReads).toBeGreaterThan(reads));
    await settleReactWork();
    expect(view.getByText(whole)).toBeTruthy();
    expect(
      agentMessages().find((message) => message.id === "reply")?.content,
    ).toBe(whole);
  }
});

test("a question read back with its options unwritten takes them from a later read", async () => {
  await mount();
  let written = false;
  history = async () =>
    stored([
      opening,
      greekAsk,
      // Mid-stream: the title is out, the options are not.
      asking(written ? FULL_ARGS : `{"title":"${QUESTION}","options":[`),
    ]);
  await stepElsewhere({ kind: "choice", toolCallId: "call-choice" });
  const args = () => {
    const call = agentMessages().find((message) => message.id === "asking");
    return call?.role === "assistant"
      ? call.toolCalls?.[0]?.function.arguments
      : undefined;
  };
  await waitFor(() => expect(args()).toBeDefined());
  expect(args()).not.toBe(FULL_ARGS);

  // The step's reads go on until the call is written in full, and the whole call replaces the half.
  written = true;
  await waitFor(() => expect(args()).toBe(FULL_ARGS), { timeout: 4000 });
});

test("a reply this tab is streaming itself is never replaced by a stored copy, shorter or longer", async () => {
  const view = await mount();
  const live = liveRun();
  let runId = "";
  run = (input) => {
    runId = input.runId;
    queueMicrotask(() => {
      live.send({
        type: "RUN_STARTED",
        threadId: input.threadId,
        runId: input.runId,
      });
      live.send({
        type: "TEXT_MESSAGE_START",
        messageId: "own-reply",
        role: "assistant",
      });
      live.send({
        type: "TEXT_MESSAGE_CONTENT",
        messageId: "own-reply",
        delta: "Θα χρειαστείς τη ΔΕΔΔ",
      });
    });
    return live.response;
  };
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.type(
    view.getByRole("textbox", { name: "Message" }),
    "Τι χρειάζομαι;",
  );
  await user.click(view.getByRole("button", { name: "Send message" }));
  await view.findByText("Θα χρειαστείς τη ΔΕΔΔ");

  // Read mid-stream: first a copy behind the stream, then one ahead of it. Neither is taken.
  for (const [second, copy] of [
    [1, "Θα χρει"],
    [2, "Θα χρειαστείς τη ΔΕΔΔΗΕ"],
  ] as const) {
    const reads = historyReads;
    history = async () =>
      stored([opening, { id: "own-reply", role: "assistant", content: copy }]);
    await announce(copy, second);
    await waitFor(() => expect(historyReads).toBeGreaterThan(reads));
    await settleReactWork();
    expect(
      agentMessages().find((message) => message.id === "own-reply")?.content,
    ).toBe("Θα χρειαστείς τη ΔΕΔΔ");
  }

  // The stream finishes the word itself, exactly once.
  await act(async () => {
    live.send({
      type: "TEXT_MESSAGE_CONTENT",
      messageId: "own-reply",
      delta: "ΗΕ",
    });
    live.send({ type: "TEXT_MESSAGE_END", messageId: "own-reply" });
    live.send({
      type: "RUN_FINISHED",
      threadId: channel.threadId,
      runId,
    });
    live.close();
  });
  await view.findByText("Θα χρειαστείς τη ΔΕΔΔΗΕ");
  expect(
    agentMessages().find((message) => message.id === "own-reply")?.content,
  ).toBe("Θα χρειαστείς τη ΔΕΔΔΗΕ");
});
