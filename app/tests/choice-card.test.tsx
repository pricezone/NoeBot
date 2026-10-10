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
import {
  FIRST_TURN_OPTIONS,
  FIRST_TURN_QUESTION,
  frameFirstTurn,
} from "../../shared/first-turn";
import { ChoiceCard } from "@/components/gallery/decisions";
import { ConversationProvider } from "@/lib/copilot/conversation";
import { AskWithOptions } from "@/lib/copilot/escalation-tool";
import { questionAnswers } from "@/lib/copilot/question-answers";
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

  test("Type your own answer turns into an input, and Enter sends the words through the same respond", async () => {
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

    await user.click(
      view.getByRole("button", { name: "Type your own answer" }),
    );
    const input = view.getByRole("textbox", { name: "Your own answer" });
    expect(document.activeElement).toBe(input);
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

    expect(view.getByText("Answered")).toBeTruthy();
    expect(view.getByText("Sorting my inbox")).toBeTruthy();
    expect(view.queryByRole("button", { name: "Type your own answer" })).toBe(
      null,
    );
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

    await user.click(
      view.getByRole("button", { name: "Type your own answer" }),
    );
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

    expect(view.getByText("Answered")).toBeTruthy();
    const picked = view.getByRole("button", { name: /Research and writing/ });
    expect(picked.hasAttribute("disabled")).toBe(true);
    expect(asked).toEqual([]);
  });

  test("dismissed, it is the plain line and the person answers in the composer", async () => {
    const { view } = renderAsked();

    await user.click(view.getByRole("button", { name: "Dismiss" }));

    await waitFor(() =>
      expect(view.queryAllByRole("listitem")).toHaveLength(0),
    );
    expect(view.getByText("Asked you")).toBeTruthy();
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
