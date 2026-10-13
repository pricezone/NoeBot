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
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TeamBotConsentCard } from "@/components/channels/team-bot-consent";
import {
  ApprovalCard,
  ChoiceCard,
  GALLERY as DECISIONS,
} from "@/components/gallery/decisions";
import { ConversationProvider } from "@/lib/copilot/conversation";
import { AskWithoutOptions } from "@/lib/copilot/escalation-tool";
import { PUT_TO } from "../../shared/handoff-markers";
import { settleReactWork } from "./settle-react-work";

/**
 * The one card every question and confirmation in the chat is drawn as: lettered rows, a field for
 * an answer of one's own, an X when the question may be waved away, and — once answered — the
 * question and the one row that was chosen, with a check.
 *
 * Exercised through the components that draw it, so what is pinned is what a person meets: the
 * `askChoice` card, the approval card, a Team Bot's consent request and a Bot's plain question.
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

const CHOICE = {
  title: "Which environment should this go to?",
  summary: "The build is green and nothing else is queued.",
  options: [
    { id: "staging", label: "Staging", description: "Safe, and reversible" },
    { id: "production", label: "Production", description: "Live customers" },
    { id: "preview", label: "A preview link" },
  ],
};

function renderChoice(onDismiss?: () => void) {
  const answers: unknown[] = [];
  const view = render(
    <ChoiceCard
      args={CHOICE}
      {...(onDismiss ? { onDismiss } : {})}
      respond={async (answer) => {
        answers.push(answer);
      }}
      result={undefined}
      status="executing"
    />,
  );
  return { answers, view };
}

/** Each row's text, letter first, the way the card draws it. */
function rows(view: ReturnType<typeof render>) {
  return view
    .getAllByRole("listitem")
    .map((row) => row.textContent?.trim() ?? "");
}

describe("the question card", () => {
  test("draws the question, the line under it, and a lettered row per option", () => {
    const { view } = renderChoice();

    expect(view.getByText(CHOICE.title)).toBeTruthy();
    expect(view.getByText(CHOICE.summary)).toBeTruthy();
    expect(rows(view)).toEqual([
      "AStagingSafe, and reversible",
      "BProductionLive customers",
      "CA preview link",
    ]);
    // The letter is a picture of the shortcut; the row is named by its label alone.
    expect(view.getByRole("button", { name: "Production" })).toBeTruthy();
    expect(
      view
        .getByRole("textbox", { name: "Your own answer" })
        .getAttribute("placeholder"),
    ).toBe("Type your own answer");
  });

  test("a letter key picks its row while the card has focus", async () => {
    const { answers, view } = renderChoice();

    view.getByRole("button", { name: "Staging" }).focus();
    await user.keyboard("c");

    expect(answers).toEqual([{ choice: "preview", label: "A preview link" }]);
  });

  test("a letter typed into the field is part of the answer, not a pick", async () => {
    const { answers, view } = renderChoice();

    await user.type(
      view.getByRole("textbox", { name: "Your own answer" }),
      "abc",
    );

    expect(answers).toEqual([]);
    expect(
      (
        view.getByRole("textbox", {
          name: "Your own answer",
        }) as HTMLInputElement
      ).value,
    ).toBe("abc");
  });

  test("a letter typed anywhere else on the page picks nothing", async () => {
    const answers: unknown[] = [];
    const view = render(
      <>
        <input aria-label="Composer" />
        <ChoiceCard
          args={CHOICE}
          respond={async (answer) => {
            answers.push(answer);
          }}
          result={undefined}
          status="executing"
        />
      </>,
    );

    await user.type(view.getByRole("textbox", { name: "Composer" }), "b");

    expect(answers).toEqual([]);
  });

  test("picked, it collapses to the question and the chosen row, with a check", async () => {
    const { answers, view } = renderChoice();

    await user.click(view.getByRole("button", { name: "Production" }));

    expect(answers).toEqual([{ choice: "production", label: "Production" }]);
    await view.findByRole("img", { name: "Answered" });
    expect(view.getByText(CHOICE.title)).toBeTruthy();
    expect(view.getByText("Production")).toBeTruthy();
    // Nothing else: not the other rows, not the line under the question, not the field.
    expect(view.queryByText("Staging")).toBeNull();
    expect(view.queryByText("A preview link")).toBeNull();
    expect(view.queryByText(CHOICE.summary)).toBeNull();
    expect(view.queryByRole("textbox")).toBeNull();
    expect(view.queryByRole("button")).toBeNull();
  });

  test("a typed answer sends with the arrow, and collapses to a row with the words and a check", async () => {
    const { answers, view } = renderChoice();

    const send = view.getByRole("button", { name: "Send answer" });
    expect(send.hasAttribute("disabled")).toBe(true);
    await user.type(
      view.getByRole("textbox", { name: "Your own answer" }),
      "Both, staging first",
    );
    await user.click(send);

    expect(answers).toEqual([
      {
        choice: "Both, staging first",
        label: "Both, staging first",
        typed: true,
      },
    ]);
    await view.findByRole("img", { name: "Answered" });
    expect(view.getByText("Both, staging first")).toBeTruthy();
    expect(view.queryAllByRole("listitem")).toHaveLength(0);
    expect(view.queryByRole("textbox")).toBeNull();
  });

  test("the X is there whenever the question can be dismissed, and only then", async () => {
    let dismissed = 0;
    const { view } = renderChoice(() => {
      dismissed += 1;
    });

    await user.click(view.getByRole("button", { name: "Dismiss" }));
    expect(dismissed).toBe(1);

    cleanup();
    expect(renderChoice().view.queryByRole("button", { name: "Dismiss" })).toBe(
      null,
    );

    cleanup();
    const answered = render(
      <ChoiceCard
        args={CHOICE}
        onDismiss={() => {}}
        respond={undefined}
        result={JSON.stringify({ choice: "staging", label: "Staging" })}
        status="complete"
      />,
    );
    expect(answered.queryByRole("button", { name: "Dismiss" })).toBeNull();
  });
});

describe("the approval card", () => {
  const APPROVAL = {
    title: "Refund this order?",
    summary:
      "The customer was charged twice for the same order and the second charge has not settled.",
    details: [
      { label: "Amount", value: "$128.40" },
      { label: "Customer", value: "Northwind Traders" },
    ],
    approveLabel: "Refund",
  };

  function renderApproval() {
    const answers: unknown[] = [];
    const view = render(
      <ApprovalCard
        args={APPROVAL}
        respond={async (answer) => {
          answers.push(answer);
        }}
        result={undefined}
        status="executing"
      />,
    );
    return { answers, view };
  }

  test("is the request as a question, its facts, and Approve and Decline as rows A and B", () => {
    const { view } = renderApproval();

    expect(view.getByText(APPROVAL.title)).toBeTruthy();
    expect(view.getByText(APPROVAL.summary)).toBeTruthy();
    expect(view.getByText("$128.40")).toBeTruthy();
    expect(view.getByText("Northwind Traders")).toBeTruthy();
    // The overridden label, and the default for the other.
    expect(rows(view)).toEqual(["ARefund", "BDecline"]);
  });

  test("a reason typed first travels with the row picked, and the card collapses to it", async () => {
    const { answers, view } = renderApproval();

    await user.type(
      view.getByRole("textbox", { name: "Your own answer" }),
      "The customer confirmed it",
    );
    await user.click(view.getByRole("button", { name: "Refund" }));

    expect(answers).toEqual([
      { decision: "approved", note: "The customer confirmed it" },
    ]);
    await view.findByRole("img", { name: "Answered" });
    expect(view.getByText("Refund")).toBeTruthy();
    expect(view.getByText("The customer confirmed it")).toBeTruthy();
    expect(view.queryByText("Decline")).toBeNull();
    expect(view.queryByText("$128.40")).toBeNull();
  });

  test("an answer of one's own, sent alone, is a decline carrying the words", async () => {
    const { answers, view } = renderApproval();

    await user.type(
      view.getByRole("textbox", { name: "Your own answer" }),
      "Refund half instead{Enter}",
    );

    expect(answers).toEqual([
      { decision: "declined", note: "Refund half instead" },
    ]);
  });

  test("a recorded decision is drawn collapsed", () => {
    const view = render(
      <ApprovalCard
        args={APPROVAL}
        respond={undefined}
        result={JSON.stringify({ decision: "declined" })}
        status="complete"
      />,
    );

    expect(view.getByText("Decline")).toBeTruthy();
    expect(view.getByRole("img", { name: "Answered" })).toBeTruthy();
    expect(view.queryByText("Refund")).toBeNull();
    expect(view.queryByRole("button")).toBeNull();
  });
});

describe("a Team Bot asking for the person's own account", () => {
  const originalFetch = globalThis.fetch;
  const sent: { url: string; body: unknown }[] = [];
  beforeEach(() => {
    sent.length = 0;
    globalThis.fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        sent.push({
          url: String(input),
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        return Response.json({ ok: true });
      },
      { preconnect: originalFetch.preconnect },
    );
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("offers four lettered rows, and collapses to the one chosen once it is saved", async () => {
    const view = render(
      <QueryClientProvider client={new QueryClient()}>
        <TeamBotConsentCard
          botId="team-bot"
          message="This Team Bot wants to use your own gmail account. Choose Allow once, Always allow, or Skip, then ask again."
          serverId="gmail"
        />
      </QueryClientProvider>,
    );

    expect(view.getByText("Use your own gmail account?")).toBeTruthy();
    expect(rows(view)).toEqual([
      "AAllow once",
      "BAlways allow for this Bot",
      "CAlways allow for all Team Bots",
      "DSkip",
    ]);

    await user.click(
      view.getByRole("button", { name: "Always allow for all Team Bots" }),
    );

    await view.findByRole("img", { name: "Answered" });
    expect(sent).toEqual([
      {
        url: "/api/team-bots/team-bot/consents",
        body: { serverId: "gmail", decision: "allow_all_team_bots" },
      },
    ]);
    expect(view.getByText("Always allow for all Team Bots")).toBeTruthy();
    expect(
      view.getByText("Always allowed for every Team Bot. Ask it to try again."),
    ).toBeTruthy();
    expect(view.queryByText("Skip")).toBeNull();
    expect(view.queryByRole("button")).toBeNull();
  });
});

describe("a Bot's question with no options", () => {
  const QUESTION = "Which invoice should I chase first?";

  function renderPlain(answers?: ReadonlyMap<string, string>, result?: string) {
    return render(
      <ConversationProvider
        ask={() => undefined}
        {...(answers ? { answers } : {})}
      >
        <AskWithoutOptions
          question={QUESTION}
          result={result}
          running={false}
          toolCallId="call-1"
          why="Two are overdue and I cannot tell which matters more to you."
        />
      </ConversationProvider>,
    );
  }

  test("is the question card's header alone, pointing at the chat", () => {
    const view = renderPlain();

    expect(view.getByText(QUESTION)).toBeTruthy();
    expect(
      view.getByText(
        "Two are overdue and I cannot tell which matters more to you.",
      ),
    ).toBeTruthy();
    expect(view.getByText("Answer in the chat")).toBeTruthy();
    expect(view.queryByRole("button")).toBeNull();
    expect(view.queryByRole("textbox")).toBeNull();
  });

  test("answered in the chat, it collapses to what the person said", () => {
    const view = renderPlain(new Map([["call-1", "The Northwind one"]]));

    expect(view.getByText(QUESTION)).toBeTruthy();
    expect(view.getByText("The Northwind one")).toBeTruthy();
    expect(view.getByRole("img", { name: "Answered" })).toBeTruthy();
    expect(view.queryByText("Answer in the chat")).toBeNull();
  });

  test("a question nobody could be asked says so instead", () => {
    const blocked = renderPlain(undefined, JSON.stringify("No route."));
    expect(blocked.getByText(/could not be put to anyone/)).toBeTruthy();

    cleanup();
    const reached = renderPlain(
      undefined,
      JSON.stringify(`${PUT_TO}the person in this conversation.`),
    );
    expect(reached.getByText("Answer in the chat")).toBeTruthy();
  });
});

test("the decision cards' gallery previews still render as question cards", () => {
  for (const entry of DECISIONS) {
    const view = render(
      <entry.Component {...(entry.preview as Record<string, unknown>)} />,
    );
    expect(view.getAllByRole("listitem").length).toBeGreaterThan(1);
    expect(view.getByRole("textbox", { name: "Your own answer" })).toBeTruthy();
    cleanup();
  }
});
