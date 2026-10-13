import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { PendingRequests } from "@/components/chat-cards/pending-requests";
import type { WaitingDecision } from "@/lib/approvals";
import { noteChannelStep } from "@/lib/channels/steps";
import type { LiveCalls } from "@/lib/channels/watch";
import { ConversationProvider } from "@/lib/copilot/conversation";
import { settleReactWork } from "./settle-react-work";

/*
 * Every kind of request a Bot can leave waiting on the person, drawn under the conversation from the
 * server for a tab whose transcript is not drawing it: an action waiting for approval, a question the
 * Bot asked, a choice or approval card another tab's run is waiting on, a secret. Matched to the
 * transcript by the request itself, never by the tool's name, and read again the moment the tab
 * running the turn reports a step.
 */
beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
let user: ReturnType<typeof userEvent.setup>;
beforeEach(() => {
  user = userEvent.setup({ document });
});
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const THREAD = "thread-1";
const CHANNEL = "channel-kinds";

const approval = (
  id: string,
  threadId = THREAD,
  toolCallId = `call-${id}`,
) => ({
  id,
  status: "pending",
  createdAt: new Date().toISOString(),
  action: {
    botId: "assistant",
    toolRef: "computer_click",
    effect: "write",
    scope: "gov.gr",
    threadId,
    toolCallId,
    args: {},
    target: {},
  },
});

const decision = (
  toolCallId: string,
  over: Partial<WaitingDecision> = {},
): WaitingDecision => ({
  botId: "assistant",
  channelId: CHANNEL,
  toolCallId,
  kind: "choice",
  args: {
    title: `Pick for ${toolCallId}`,
    options: [
      { id: "a", label: "Alpha" },
      { id: "b", label: "Beta" },
    ],
  },
  createdAt: new Date().toISOString(),
  heartbeatAt: new Date().toISOString(),
  live: true,
  answer: null,
  answeredAt: null,
  closed: false,
  ...over,
});

type Served = {
  requests?: unknown[];
  questions?: unknown[];
  decisions?: WaitingDecision[];
  control?: Record<string, unknown>;
};

function serve(served: Served) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      const method = init?.method ?? "GET";
      calls.push({
        method,
        path: url.pathname,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (url.pathname === "/api/sign-in-requests")
        return Response.json({ requests: [] });
      if (url.pathname.endsWith("/control"))
        return Response.json({
          holder: "bot",
          since: new Date().toISOString(),
          requested: false,
          transitioning: false,
          resumeSnapshotRequired: false,
          ...served.control,
        });
      if (url.pathname === "/api/approvals")
        return Response.json({
          enabled: true,
          requests: served.requests ?? [],
          rules: [],
          teamRules: [],
          questions: served.questions ?? [],
        });
      if (url.pathname === "/api/approvals/decisions")
        return Response.json({ decisions: served.decisions ?? [] });
      if (url.pathname === "/api/approvals/questions/answered")
        return Response.json({ resolved: ["question-1"] });
      return Response.json({}, { status: 404 });
    },
    { preconnect: original.preconnect },
  ) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

const nothingLive: LiveCalls = {
  ids: new Set(),
  open: new Map(),
  questions: new Set(),
};

function draw(
  live: LiveCalls = nothingLive,
  ask: (text: string) => unknown = () => true,
): ReactNode {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <ConversationProvider
        ask={ask}
        botId="assistant"
        channelId={CHANNEL}
        turnActive={false}
      >
        <PendingRequests
          botId="assistant"
          channelId={CHANNEL}
          live={live}
          shown={{ ids: live.ids, unanswered: new Set() }}
          threadId={THREAD}
        />
      </ConversationProvider>
    </QueryClientProvider>
  );
}

test("an action waiting for approval in this conversation is drawn, with its choices", async () => {
  const server = serve({
    requests: [approval("here"), approval("elsewhere", "thread-2")],
  });
  try {
    const view = render(draw());
    await waitFor(() =>
      expect(view.getByRole("button", { name: "Allow once" })).toBeTruthy(),
    );
    // Only the one asked in this conversation.
    expect(view.getAllByRole("button", { name: "Allow once" })).toHaveLength(1);
  } finally {
    server.restore();
  }
});

test("an approval whose call the transcript already holds is left to the transcript", async () => {
  const server = serve({ requests: [approval("here")] });
  try {
    const view = render(draw({ ...nothingLive, ids: new Set(["call-here"]) }));
    await waitFor(() =>
      expect(server.calls.some((call) => call.path === "/api/approvals")).toBe(
        true,
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(view.queryByRole("button", { name: "Allow once" })).toBeNull();
  } finally {
    server.restore();
  }
});

test("a question the Bot asked here is drawn and answered as the person's message, then closed", async () => {
  const server = serve({
    questions: [
      {
        id: "question-1",
        botId: "assistant",
        threadId: THREAD,
        question: "Which tax year?",
        why: "The form asks for one.",
        createdAt: new Date().toISOString(),
      },
    ],
  });
  const said: string[] = [];
  try {
    const view = render(
      draw(nothingLive, (text) => {
        said.push(text);
        return true;
      }),
    );
    await waitFor(() => expect(view.getByText("Which tax year?")).toBeTruthy());
    await user.type(
      view.getByRole("textbox", { name: "Your own answer" }),
      "2025{Enter}",
    );
    await waitFor(() => expect(said).toEqual(["2025"]));
    await waitFor(() =>
      expect(
        server.calls.find(
          (call) => call.path === "/api/approvals/questions/answered",
        )?.body,
      ).toEqual({
        threadId: THREAD,
        questions: ["Which tax year?"],
        response: "2025",
      }),
    );
  } finally {
    server.restore();
  }
});

test("a question the transcript is drawing open is not drawn again", async () => {
  const server = serve({
    questions: [
      {
        id: "question-1",
        botId: "assistant",
        threadId: THREAD,
        question: "Which tax year?",
        createdAt: new Date().toISOString(),
      },
    ],
  });
  try {
    const view = render(
      draw({ ...nothingLive, questions: new Set(["Which tax year?"]) }),
    );
    await waitFor(() =>
      expect(server.calls.some((call) => call.path === "/api/approvals")).toBe(
        true,
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(view.queryByText("Which tax year?")).toBeNull();
  } finally {
    server.restore();
  }
});

test("choice and approval cards another tab's run waits on are drawn from their records, matched by call id", async () => {
  const server = serve({
    decisions: [
      decision("call-shown"),
      decision("call-missing"),
      decision("call-approval", {
        kind: "approval",
        args: { title: "Refund this order?", summary: "Charged twice." },
      }),
    ],
  });
  try {
    const view = render(
      draw({
        ids: new Set(["call-shown", "call-other"]),
        open: new Map([
          // The transcript draws this very card open, so it is left to the transcript.
          ["call-shown", { name: "askChoice", args: { title: "Pick" } }],
          // An open call of the same tool is not the same request, and hides nothing.
          ["call-other", { name: "askChoice", args: { title: "Other" } }],
        ]),
        questions: new Set(),
      }),
    );
    await waitFor(() =>
      expect(view.getByText("Pick for call-missing")).toBeTruthy(),
    );
    expect(view.getByText("Refund this order?")).toBeTruthy();
    expect(view.queryByText("Pick for call-shown")).toBeNull();
  } finally {
    server.restore();
  }
});

test("a secret is left to the transcript only when its open call asks for that very field", async () => {
  const control = {
    secretWanted: "the code sent to your phone",
    secretRef: "e12",
    secretSnapshotId: 3,
  };
  const server = serve({ control });
  try {
    const other = render(
      draw({
        ids: new Set(["call-old"]),
        open: new Map([
          [
            "call-old",
            {
              name: "computer_request_secret",
              args: { label: "the password", ref: "e99", snapshotId: 1 },
            },
          ],
        ]),
        questions: new Set(),
      }),
    );
    await waitFor(() =>
      expect(other.getByText("The code sent to your phone")).toBeTruthy(),
    );
    cleanup();

    const same = render(
      draw({
        ids: new Set(["call-now"]),
        open: new Map([
          [
            "call-now",
            {
              name: "computer_request_secret",
              args: { label: "the code", ref: "e12", snapshotId: 3 },
            },
          ],
        ]),
        questions: new Set(),
      }),
    );
    await waitFor(() =>
      expect(server.calls.some((call) => call.path.endsWith("/control"))).toBe(
        true,
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(same.queryByText("The code sent to your phone")).toBeNull();
  } finally {
    server.restore();
  }
});

test("a step from the tab running the turn reads every waiting request again at once", async () => {
  const server = serve({});
  try {
    render(draw());
    const reads = (path: string) =>
      server.calls.filter((call) => call.path === path).length;
    await waitFor(() =>
      expect(reads("/api/approvals/decisions")).toBeGreaterThan(0),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    const before = {
      decisions: reads("/api/approvals/decisions"),
      inbox: reads("/api/approvals"),
      signIns: reads("/api/sign-in-requests"),
    };
    noteChannelStep(CHANNEL, {
      step: Date.now() + 1_000_000,
      busy: true,
      waiting: { kind: "choice", toolCallId: "call-new" },
    });
    // Well inside the 1.5 s poll: this is the step, not the timer.
    await waitFor(
      () => {
        expect(reads("/api/approvals/decisions")).toBeGreaterThan(
          before.decisions,
        );
        expect(reads("/api/approvals")).toBeGreaterThan(before.inbox);
        expect(reads("/api/sign-in-requests")).toBeGreaterThan(before.signIns);
      },
      { timeout: 600 },
    );
  } finally {
    server.restore();
  }
});
