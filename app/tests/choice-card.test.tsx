import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import type { Message } from "@ag-ui/core";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApprovalCard, ChoiceCard } from "@/components/gallery/decisions";
import { ConversationProvider } from "@/lib/copilot/conversation";
import { AskWithOptions } from "@/lib/copilot/escalation-tool";
import { questionAnswers } from "@/lib/copilot/question-answers";
import { ANSWERED_IN_CHAT } from "@/lib/copilot/repair-history";
import { type UiLanguage, UiLanguageProvider } from "@/lib/i18n/strings";
import {
  FIRST_TURN_OPTIONS,
  FIRST_TURN_QUESTION,
  frameFirstTurn,
} from "../../shared/first-turn";
import { settleReactWork } from "./settle-react-work";

/**
 * A question with lettered options and a row for an answer of the person's own: the `askChoice`
 * card, and a Bot's `ask_person` question with options drawn as the same card — which is how a Bot
 * made in one click asks what it should help with.
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
  title: FIRST_TURN_QUESTION,
  options: FIRST_TURN_OPTIONS.map((label) => ({ id: label, label })),
};

/** Each option row's text, letter first, the way the card draws it. */
function rows(view: ReturnType<typeof render>) {
  return view
    .getAllByRole("listitem")
    .map((row) => row.textContent?.trim() ?? "");
}

describe("the choice card", () => {
  test("letters each option A, B, C, D…", () => {
    const view = render(
      <ChoiceCard
        args={ARGS}
        respond={async () => {}}
        result={undefined}
        status="executing"
      />,
    );

    expect(rows(view)).toEqual([
      "AResearch and writing",
      "BCode and GitHub work",
      "CWeb tasks and errands",
      "DRecurring checks and reminders",
    ]);
    expect(view.getByText(FIRST_TURN_QUESTION)).toBeTruthy();
  });

  test("an option answers with its id", async () => {
    const answers: unknown[] = [];
    const view = render(
      <ChoiceCard
        args={ARGS}
        respond={async (answer) => {
          answers.push(answer);
        }}
        result={undefined}
        status="executing"
      />,
    );

    await user.click(view.getByRole("button", { name: /Code and GitHub/ }));

    expect(answers).toEqual([
      { choice: "Code and GitHub work", label: "Code and GitHub work" },
    ]);
  });

  test("Type your own answer is a field under the rows, and Enter sends the words through the same respond", async () => {
    const answers: unknown[] = [];
    const view = render(
      <ChoiceCard
        args={ARGS}
        respond={async (answer) => {
          answers.push(answer);
        }}
        result={undefined}
        status="executing"
      />,
    );

    const input = view.getByRole("textbox", { name: "Your own answer" });
    expect(input.getAttribute("placeholder")).toBe("Type your own answer");
    await user.type(input, "Sorting my inbox{Enter}");

    expect(answers).toEqual([
      { choice: "Sorting my inbox", label: "Sorting my inbox", typed: true },
    ]);
  });

  test("a recorded typed answer is drawn as the answer, with no controls left", () => {
    const view = render(
      <ChoiceCard
        args={ARGS}
        respond={undefined}
        result={JSON.stringify({
          choice: "Sorting my inbox",
          label: "Sorting my inbox",
          typed: true,
        })}
        status="complete"
      />,
    );

    // Collapsed to the question and the typed words, with the check and nothing else.
    expect(view.getByText(FIRST_TURN_QUESTION)).toBeTruthy();
    expect(view.getByText("Sorting my inbox")).toBeTruthy();
    expect(view.getByRole("img", { name: "Answered" })).toBeTruthy();
    expect(view.queryAllByRole("listitem")).toHaveLength(0);
    expect(view.queryByRole("textbox")).toBeNull();
    expect(view.queryByRole("button")).toBeNull();
  });
});

describe("a Bot's question with options", () => {
  function renderAsked(answers?: ReadonlyMap<string, string>, sent?: boolean) {
    const asked: string[] = [];
    const view = render(
      <ConversationProvider
        ask={(text) => {
          asked.push(text);
          return sent === undefined ? undefined : Promise.resolve(sent);
        }}
        {...(answers ? { answers } : {})}
      >
        <AskWithOptions
          options={[...FIRST_TURN_OPTIONS]}
          question={FIRST_TURN_QUESTION}
          result={undefined}
          running={false}
          toolCallId="call-1"
        />
      </ConversationProvider>,
    );
    return { asked, view };
  }

  test("picking an option says it in the conversation", async () => {
    const { asked, view } = renderAsked();

    expect(rows(view)[0]).toBe("AResearch and writing");
    await user.click(view.getByRole("button", { name: /Web tasks/ }));

    expect(asked).toEqual(["Web tasks and errands"]);
  });

  test("an answer that could not be sent can be given again", async () => {
    const { asked, view } = renderAsked(undefined, false);

    await user.click(view.getByRole("button", { name: /Web tasks/ }));

    await waitFor(() =>
      expect(
        view
          .getByRole("button", { name: /Research and writing/ })
          .hasAttribute("disabled"),
      ).toBe(false),
    );
    expect(asked).toEqual(["Web tasks and errands"]);
  });

  test("a typed answer is said the same way", async () => {
    const { asked, view } = renderAsked();

    await user.type(
      view.getByRole("textbox", { name: "Your own answer" }),
      "Planning a trip",
    );
    await user.click(view.getByRole("button", { name: "Send answer" }));

    expect(asked).toEqual(["Planning a trip"]);
  });

  test("once answered in the transcript, the card shows the answer and takes no other", async () => {
    const { asked, view } = renderAsked(
      new Map([["call-1", "Research and writing"]]),
    );

    // The picked row alone, checked; the other options and the field are gone.
    expect(view.getByText("Research and writing")).toBeTruthy();
    expect(view.getByRole("img", { name: "Answered" })).toBeTruthy();
    expect(view.queryByText("Code and GitHub work")).toBeNull();
    expect(view.queryByRole("button")).toBeNull();
    expect(asked).toEqual([]);
  });

  test("dismissed, it is the question alone and the person answers in the composer", async () => {
    const { view } = renderAsked();

    await user.click(view.getByRole("button", { name: "Dismiss" }));

    await waitFor(() =>
      expect(view.queryAllByRole("listitem")).toHaveLength(0),
    );
    expect(view.getByText(FIRST_TURN_QUESTION)).toBeTruthy();
    expect(view.getByText("Answer in the chat")).toBeTruthy();
    expect(view.queryByRole("textbox")).toBeNull();
    expect(view.queryByRole("button")).toBeNull();
  });
});

describe("answers read off the transcript", () => {
  const ask: Message = {
    id: "a1",
    role: "assistant",
    content: "Hi!",
    toolCalls: [
      {
        id: "call-1",
        type: "function",
        function: {
          name: "ask_person",
          arguments: JSON.stringify({ question: FIRST_TURN_QUESTION }),
        },
      },
    ],
  };

  test("the person's next message answers the open question", () => {
    expect(
      questionAnswers([
        { id: "u0", role: "user", content: frameFirstTurn() },
        ask,
        { id: "t1", role: "tool", toolCallId: "call-1", content: "Put to…" },
        { id: "u1", role: "user", content: "Code and GitHub work" },
      ]),
    ).toEqual(new Map([["call-1", "Code and GitHub work"]]));
  });

  test("a question nobody has answered yet has no answer", () => {
    expect(questionAnswers([ask]).size).toBe(0);
  });
});

describe("a choice card this tab is not running", () => {
  /** The card as the runtime hands it to a tab that did not start the run: no result, nothing executing. */
  function renderOrphan(
    answers = new Map<string, string>(),
    turnActive = false,
  ) {
    const asked: string[] = [];
    const view = render(
      <ConversationProvider
        answers={answers}
        ask={async (text) => {
          asked.push(text);
        }}
        turnActive={turnActive}
      >
        <ChoiceCard
          args={ARGS}
          respond={undefined}
          result={undefined}
          status="inProgress"
          toolCallId="call-9"
        />
      </ConversationProvider>,
    );
    return { asked, view };
  }

  test("shows its options and sends a picked one as the person's message", async () => {
    const { asked, view } = renderOrphan();

    expect(rows(view)).toHaveLength(4);
    await user.click(view.getByText("Web tasks and errands"));

    await waitFor(() => expect(asked).toEqual(["Web tasks and errands"]));
    expect(view.getByRole("img", { name: "Answered" })).toBeTruthy();
  });

  test("takes an answer of the person's own the same way", async () => {
    const { asked, view } = renderOrphan();

    await user.type(view.getByRole("textbox"), "Something else{Enter}");

    await waitFor(() => expect(asked).toEqual(["Something else"]));
  });

  test("still being written while this tab has the turn, it waits", () => {
    const { view } = renderOrphan(new Map(), true);

    expect(view.queryAllByRole("listitem")).toHaveLength(0);
    expect(view.queryByRole("textbox")).toBeNull();
  });

  test("answered in the chat, it collapses to that answer", () => {
    const { asked, view } = renderOrphan(
      new Map([["call-9", "Code and GitHub work"]]),
    );

    expect(view.getByText("Code and GitHub work")).toBeTruthy();
    expect(view.getByRole("img", { name: "Answered" })).toBeTruthy();
    expect(view.queryByText("Research and writing")).toBeNull();
    expect(asked).toEqual([]);
  });
});

describe("decision cards answered off the transcript", () => {
  const choice: Message = {
    id: "a2",
    role: "assistant",
    content: "",
    toolCalls: [
      {
        id: "call-2",
        type: "function",
        function: {
          name: "askChoice",
          arguments: JSON.stringify(ARGS),
        },
      },
    ],
  };

  test("a card with only a stand-in result is answered by the next message", () => {
    expect(
      questionAnswers([
        choice,
        {
          id: "t2",
          role: "tool",
          toolCallId: "call-2",
          content: ANSWERED_IN_CHAT,
        },
        { id: "u2", role: "user", content: "Web tasks and errands" },
      ]),
    ).toEqual(new Map([["call-2", "Web tasks and errands"]]));
  });

  test("a card answered on the card is not answered by a later message", () => {
    expect(
      questionAnswers([
        choice,
        {
          id: "t2",
          role: "tool",
          toolCallId: "call-2",
          content: JSON.stringify({ choice: "x", label: "x" }),
        },
        { id: "u2", role: "user", content: "thanks" },
      ]).size,
    ).toBe(0);
  });
});

describe("an approval card this tab is not running", () => {
  const APPROVAL = {
    title: "Issue the declaration?",
    summary: "It goes to the recipient once issued.",
    approveLabel: "Issue",
  };

  function renderOrphan(answers = new Map<string, string>()) {
    const asked: string[] = [];
    const view = render(
      <ConversationProvider
        answers={answers}
        ask={async (text) => {
          asked.push(text);
        }}
        turnActive={false}
      >
        <ApprovalCard
          args={APPROVAL}
          respond={undefined}
          result={undefined}
          status="inProgress"
          toolCallId="call-7"
        />
      </ConversationProvider>,
    );
    return { asked, view };
  }

  test("offers its rows and sends the picked one's label", async () => {
    const { asked, view } = renderOrphan();

    expect(rows(view)).toEqual(["AIssue", "BDecline"]);
    await user.click(view.getByText("Issue"));

    await waitFor(() => expect(asked).toEqual(["Issue"]));
  });

  test("a decline with a reason said in the chat collapses to Decline", () => {
    const { view } = renderOrphan(
      new Map([["call-7", "Decline: the address is wrong"]]),
    );

    expect(view.getByText("Decline")).toBeTruthy();
    expect(view.getByText("the address is wrong")).toBeTruthy();
    expect(view.queryByText("Issue")).toBeNull();
  });
});

describe("a choice card read back before its options were written", () => {
  const PARTIAL = { title: FIRST_TURN_QUESTION };

  function orphan(
    args: Partial<typeof ARGS>,
    {
      channelId,
      language = "en",
    }: { channelId?: string; language?: UiLanguage } = {},
  ) {
    const asked: string[] = [];
    return {
      asked,
      tree: (
        <UiLanguageProvider language={language}>
          <ConversationProvider
            answers={new Map()}
            ask={async (text) => {
              asked.push(text);
            }}
            {...(channelId ? { channelId } : {})}
            turnActive={false}
          >
            <ChoiceCard
              args={args as typeof ARGS}
              respond={undefined}
              result={undefined}
              status="inProgress"
              toolCallId="call-partial"
            />
          </ConversationProvider>
        </UiLanguageProvider>
      ),
    };
  }

  test("is not answerable with nothing to pick, and fills in once its arguments arrive", async () => {
    const first = orphan(PARTIAL);
    const view = render(first.tree);

    // Only the question and "preparing": no rows, and no field that would take words alone.
    expect(view.getByText(FIRST_TURN_QUESTION)).toBeTruthy();
    expect(view.getByText("Preparing the question…")).toBeTruthy();
    expect(view.queryAllByRole("listitem")).toHaveLength(0);
    expect(view.queryByRole("textbox")).toBeNull();

    // An options list that has begun but holds nothing yet is still not written.
    view.rerender(orphan({ ...PARTIAL, options: [] }).tree);
    expect(view.queryByRole("textbox")).toBeNull();

    const full = orphan(ARGS);
    view.rerender(full.tree);
    expect(rows(view)).toHaveLength(4);
    expect(view.queryByText("Preparing the question…")).toBeNull();
    await user.click(view.getByText("Web tasks and errands"));
    await waitFor(() => expect(full.asked).toEqual(["Web tasks and errands"]));
  });

  test("draws its options from the server's record of the card while its own are missing", async () => {
    const original = globalThis.fetch;
    const reads: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      reads.push(String(input));
      return Response.json({
        decision: {
          botId: "bot",
          channelId: "channel",
          toolCallId: "call-partial",
          kind: "choice",
          args: ARGS,
          createdAt: "2026-10-14T00:00:00.000Z",
          heartbeatAt: "2026-10-14T00:00:00.000Z",
          live: true,
          answer: null,
          answeredAt: null,
          closed: false,
        },
      });
    }) as typeof fetch;
    try {
      const view = render(orphan(PARTIAL, { channelId: "channel" }).tree);

      await waitFor(() => expect(rows(view)).toHaveLength(4));
      expect(reads.some((path) => path.includes("call-partial"))).toBe(true);
      expect(
        view.getByRole("textbox", { name: "Your own answer" }),
      ).toBeTruthy();
    } finally {
      cleanup();
      globalThis.fetch = original;
    }
  });

  test("in a Greek conversation, its own words are Greek and say Bot", () => {
    const view = render(orphan({}, { language: "el" }).tree);

    expect(view.getByText("Αναμονή για τον Bot…")).toBeTruthy();
    expect(view.getByText("Ετοιμάζεται η ερώτηση…")).toBeTruthy();
    expect(view.queryByText(/assistant/i)).toBeNull();

    view.rerender(orphan(ARGS, { language: "el" }).tree);
    const field = view.getByRole("textbox", { name: "Η δική σου απάντηση" });
    expect(field.getAttribute("placeholder")).toBe(
      "Γράψε τη δική σου απάντηση",
    );
    expect(
      view.getByRole("button", { name: "Αποστολή απάντησης" }),
    ).toBeTruthy();
  });

  test("an approval still being written says so in the conversation's language", () => {
    const view = render(
      <UiLanguageProvider language="el">
        <ConversationProvider ask={() => undefined} turnActive>
          <ApprovalCard
            args={{}}
            respond={undefined}
            result={undefined}
            status="inProgress"
            toolCallId="call-approval"
          />
        </ConversationProvider>
      </UiLanguageProvider>,
    );

    expect(view.getByText("Αναμονή για τον Bot…")).toBeTruthy();
    expect(view.getByText("Ετοιμάζεται το αίτημα…")).toBeTruthy();
  });
});
