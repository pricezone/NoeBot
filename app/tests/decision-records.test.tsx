import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import {
  ApprovalCard,
  ChoiceCard,
  RecordedDecision,
} from "@/components/gallery/decisions";
import type { WaitingDecision } from "@/lib/approvals";
import { ConversationProvider } from "@/lib/copilot/conversation";
import { settleReactWork } from "./settle-react-work";

/**
 * A decision card answered in a tab that does not hold its run.
 *
 * The tab running the turn keeps a record of the card on the server while it waits. Answered in
 * another tab, the answer is written to that record and the running tab hands it to its waiting run,
 * which carries on where it stopped. When the running tab has gone quiet, the answer goes as the
 * person's message instead. An answer that could not be sent says so on the card.
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

const ARGS = {
  title: "Which environment?",
  summary: "The build is green.",
  options: [
    { id: "staging", label: "Staging" },
    { id: "production", label: "Production" },
  ],
};

function record(over: Partial<WaitingDecision> = {}): WaitingDecision {
  return {
    botId: "assistant",
    channelId: "channel-1",
    toolCallId: "call-choice",
    kind: "choice",
    args: ARGS,
    createdAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    live: true,
    answer: null,
    answeredAt: null,
    closed: false,
    ...over,
  };
}

type Call = { method: string; path: string; body: unknown };

/** The decision routes and the page-frame route, answering from `state`. */
function serve(state: {
  record: WaitingDecision;
  answer?: { status: number; body: unknown };
  frame?: string;
}) {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path: url.pathname, body });
      if (url.pathname.includes("/page-frame/"))
        return Response.json({
          frame: state.frame
            ? { url: "https://gov.gr/form", title: null, frame: state.frame }
            : null,
        });
      if (url.pathname.endsWith("/answer"))
        return Response.json(state.answer?.body ?? { decision: state.record }, {
          status: state.answer?.status ?? 200,
        });
      if (url.pathname.startsWith("/api/approvals/decisions"))
        return Response.json(
          { decision: state.record },
          {
            status:
              method === "POST" && url.pathname.endsWith("decisions")
                ? 201
                : 200,
          },
        );
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

function inConversation(
  node: ReactNode,
  options: { ask?: (text: string) => unknown; turnActive?: boolean } = {},
) {
  return (
    <ConversationProvider
      ask={options.ask ?? (() => true)}
      botId="assistant"
      channelId="channel-1"
      turnActive={options.turnActive ?? true}
    >
      {node}
    </ConversationProvider>
  );
}

describe("a decision answered in another tab", () => {
  test("the tab holding the run keeps a record and hands it an answer given elsewhere", async () => {
    const state = { record: record() };
    const server = serve(state);
    const answers: unknown[] = [];
    try {
      const view = render(
        inConversation(
          <ChoiceCard
            args={ARGS}
            respond={async (answer) => {
              answers.push(answer);
            }}
            result={undefined}
            status="executing"
            toolCallId="call-choice"
          />,
        ),
      );
      await waitFor(() =>
        expect(
          server.calls.some(
            (call) =>
              call.method === "POST" &&
              call.path === "/api/approvals/decisions",
          ),
        ).toBe(true),
      );
      const opened = server.calls.find(
        (call) => call.path === "/api/approvals/decisions",
      );
      expect(opened?.body).toMatchObject({
        botId: "assistant",
        channelId: "channel-1",
        toolCallId: "call-choice",
        kind: "choice",
        args: { title: "Which environment?" },
      });

      // Somebody answers in another tab; the next read hands it to the waiting run.
      state.record = record({
        answer: { choice: "staging", label: "Staging" },
      });
      await waitFor(
        () =>
          expect(answers).toEqual([{ choice: "staging", label: "Staging" }]),
        { timeout: 3000 },
      );
      await waitFor(() =>
        expect(
          server.calls.some((call) => call.path.endsWith("/call-choice/close")),
        ).toBe(true),
      );
      expect(view.getByRole("img", { name: "Answered" })).toBeTruthy();
    } finally {
      server.restore();
    }
  });

  test("answered here while the running tab is live, the answer goes to the record, not the chat", async () => {
    const server = serve({ record: record() });
    const said: string[] = [];
    try {
      const view = render(
        inConversation(<RecordedDecision record={record()} />, {
          ask: (text) => {
            said.push(text);
            return true;
          },
          turnActive: false,
        }),
      );
      await user.click(view.getByRole("button", { name: /Staging/ }));
      await waitFor(() =>
        expect(
          server.calls.find((call) => call.path.endsWith("/answer"))?.body,
        ).toEqual({ answer: { choice: "staging", label: "Staging" } }),
      );
      expect(said).toEqual([]);
      await waitFor(() =>
        expect(view.getByRole("img", { name: "Answered" })).toBeTruthy(),
      );
    } finally {
      server.restore();
    }
  });

  test("the transcript's own card in a tab with no turn answers through the record too", async () => {
    const server = serve({ record: record() });
    const said: string[] = [];
    try {
      const view = render(
        inConversation(
          <ChoiceCard
            args={ARGS}
            respond={undefined}
            result={undefined}
            status="inProgress"
            toolCallId="call-choice"
          />,
          {
            ask: (text) => {
              said.push(text);
              return true;
            },
            turnActive: false,
          },
        ),
      );
      await user.click(view.getByRole("button", { name: /Production/ }));
      await waitFor(() =>
        expect(
          server.calls.find((call) => call.path.endsWith("/answer"))?.body,
        ).toEqual({ answer: { choice: "production", label: "Production" } }),
      );
      expect(said).toEqual([]);
    } finally {
      server.restore();
    }
  });

  test("when the running tab has gone quiet, the answer is sent as a message and the record closed", async () => {
    const server = serve({
      record: record({ live: false }),
      answer: {
        status: 409,
        body: { error: "The tab that asked this is gone.", reason: "stale" },
      },
    });
    const said: string[] = [];
    try {
      const view = render(
        inConversation(<RecordedDecision record={record({ live: false })} />, {
          ask: (text) => {
            said.push(text);
            return true;
          },
          turnActive: false,
        }),
      );
      await user.click(view.getByRole("button", { name: /Staging/ }));
      await waitFor(() => expect(said).toEqual(["Staging"]));
      await waitFor(() =>
        expect(
          server.calls.find((call) => call.path.endsWith("/close"))?.body,
        ).toEqual({ answer: { choice: "staging", label: "Staging" } }),
      );
    } finally {
      server.restore();
    }
  });

  test("an approval drawn from its record answers the same way", async () => {
    const approval = record({
      toolCallId: "call-approval",
      kind: "approval",
      args: { title: "Refund this order?", summary: "Charged twice." },
    });
    const server = serve({ record: approval });
    try {
      const view = render(
        inConversation(<RecordedDecision record={approval} />, {
          turnActive: false,
        }),
      );
      await user.click(view.getByRole("button", { name: /Approve/ }));
      await waitFor(() =>
        expect(
          server.calls.find((call) => call.path.endsWith("/answer"))?.body,
        ).toEqual({ answer: { decision: "approved" } }),
      );
    } finally {
      server.restore();
    }
  });
});

describe("the question card", () => {
  test("shows the picture of the Bot's screen above its options, read by the question's call", async () => {
    const server = serve({ record: record(), frame: "iVBORw0KGgo" });
    try {
      const view = render(
        inConversation(
          <ChoiceCard
            args={ARGS}
            respond={async () => {}}
            result={undefined}
            status="executing"
            toolCallId="call-with-screen"
          />,
        ),
      );
      const image = await waitFor(() =>
        view.getByRole("img", { name: "The Bot's screen" }),
      );
      expect(image.getAttribute("src")).toBe(
        "data:image/png;base64,iVBORw0KGgo",
      );
      expect(
        server.calls.some((call) =>
          call.path.endsWith(
            "/api/computers/assistant/page-frame/call-with-screen",
          ),
        ),
      ).toBe(true);
      // Above the rows, not under them.
      const list = view.getByRole("list");
      expect(
        image.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    } finally {
      server.restore();
    }
  });

  test("shows nothing where no picture was taken", async () => {
    const server = serve({ record: record() });
    try {
      const view = render(
        inConversation(
          <ChoiceCard
            args={ARGS}
            respond={async () => {}}
            result={undefined}
            status="executing"
            toolCallId="call-no-screen"
          />,
        ),
      );
      await waitFor(() =>
        expect(
          server.calls.some((call) => call.path.includes("call-no-screen")),
        ).toBe(true),
      );
      expect(view.queryByRole("img", { name: "The Bot's screen" })).toBeNull();
    } finally {
      server.restore();
    }
  });
});

describe("an answer that could not be sent", () => {
  test("the choice card says so and can be answered again", async () => {
    let fail = true;
    const answers: unknown[] = [];
    const view = render(
      <ChoiceCard
        args={ARGS}
        respond={async (answer) => {
          if (fail) throw new Error("The server did not answer.");
          answers.push(answer);
        }}
        result={undefined}
        status="executing"
      />,
    );
    await user.click(view.getByRole("button", { name: /Staging/ }));
    const alert = await waitFor(() => view.getByRole("alert"));
    expect(alert.textContent).toBe("The server did not answer.");

    fail = false;
    await user.click(view.getByRole("button", { name: /Staging/ }));
    await waitFor(() =>
      expect(answers).toEqual([{ choice: "staging", label: "Staging" }]),
    );
    expect(view.queryByRole("alert")).toBeNull();
  });

  test("the approval card says so and can be answered again", async () => {
    let fail = true;
    const answers: unknown[] = [];
    const view = render(
      <ApprovalCard
        args={{ title: "Refund this order?", summary: "Charged twice." }}
        respond={async (answer) => {
          if (fail) throw new Error("");
          answers.push(answer);
        }}
        result={undefined}
        status="executing"
      />,
    );
    await user.click(view.getByRole("button", { name: /Approve/ }));
    const alert = await waitFor(() => view.getByRole("alert"));
    expect(alert.textContent).toBe("Your answer could not be sent. Try again.");

    fail = false;
    await user.click(view.getByRole("button", { name: /Approve/ }));
    await waitFor(() => expect(answers).toEqual([{ decision: "approved" }]));
  });
});
