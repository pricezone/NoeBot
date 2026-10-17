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
import { cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConversationProvider } from "@/lib/copilot/conversation";
import { AskPerson, offeredAnswers } from "@/lib/copilot/escalation-tool";
import { readsAsYesNo } from "@/lib/copilot/yes-no";
import { type UiLanguage, UiLanguageProvider } from "@/lib/i18n/strings";
import { settleReactWork } from "./settle-react-work";

/**
 * A yes-or-no question from a Bot, drawn with Yes and No to pick from: when the Bot marks it
 * `yesNo`, and when it sends no options and the question reads as one.
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

const rows = (view: ReturnType<typeof render>) =>
  view.queryAllByRole("listitem").map((row) => row.textContent?.trim() ?? "");

function ask(
  props: { question: string; yesNo?: boolean; options?: string[] },
  language: UiLanguage = "en",
) {
  const asked: string[] = [];
  const view = render(
    <UiLanguageProvider language={language}>
      <ConversationProvider
        answers={new Map()}
        ask={async (text) => {
          asked.push(text);
        }}
        turnActive={false}
      >
        <AskPerson
          {...props}
          result={JSON.stringify("Put to the person in this conversation.")}
          running={false}
          toolCallId="call-ask"
        />
      </ConversationProvider>
    </UiLanguageProvider>,
  );
  return { asked, view };
}

describe("a question marked yes-or-no", () => {
  test("offers Yes and No and an answer of their own, and sends the one picked", async () => {
    const { asked, view } = ask({ question: "Send the report?", yesNo: true });

    expect(rows(view)).toEqual(["AYes", "BNo"]);
    expect(view.getByPlaceholderText("Type your own answer")).toBeTruthy();
    await user.click(view.getByRole("button", { name: /Yes/ }));

    expect(asked).toEqual(["Yes"]);
  });

  test("speaks the conversation's language", async () => {
    const { asked, view } = ask(
      { question: "Να στείλω την αναφορά;", yesNo: true },
      "el",
    );

    expect(rows(view)).toEqual(["AΝαι", "BΌχι"]);
    await user.click(view.getByRole("button", { name: /Όχι/ }));

    expect(asked).toEqual(["Όχι"]);
  });

  test("keeps the Bot's own options when it gave some", () => {
    const { view } = ask({
      question: "Do you want staging or production?",
      yesNo: true,
      options: ["Staging", "Production"],
    });
    expect(rows(view)).toEqual(["AStaging", "BProduction"]);
  });
});

describe("a question with no options", () => {
  test("that reads as yes-or-no still gets Yes and No", () => {
    const { view } = ask({ question: "Should I book the 9:40 train?" });
    expect(rows(view)).toEqual(["AYes", "BNo"]);
  });

  test("that asks for words is answered in words", () => {
    const { view } = ask({ question: "Which account should I use?" });
    expect(rows(view)).toEqual([]);
    expect(view.getByText("Which account should I use?")).toBeTruthy();
  });
});

describe("reading a question as yes-or-no", () => {
  test.each([
    "Do you want me to send it?",
    "does it need a signature?",
    "Is this the right file?",
    "Can I go ahead?",
    "Would you like a summary?",
    "Have you signed in?",
    "Θέλεις να το στείλω;",
    "Θέλετε περίληψη;",
    "Να το κλείσω?",
    "Μπορώ να συνεχίσω;",
    "Μπορείς να συνδεθείς;",
    "Είναι αυτό το σωστό αρχείο;",
    "Έχεις λογαριασμό;",
    "θελεις να συνεχισω;",
  ])("%s", (question) => {
    expect(readsAsYesNo(question)).toBe(true);
  });

  test.each([
    "Which account should I use?",
    "What do you mainly want help with?",
    "Do you want this",
    "Ναι, το έστειλα.",
    "Τι θέλεις να κάνω;",
    "Is it done.",
  ])("not %s", (question) => {
    expect(readsAsYesNo(question)).toBe(false);
  });

  test("the rows offered follow the same rule", () => {
    const words = { yes: "Yes", no: "No" };
    expect(offeredAnswers({ question: "Is it ready?" }, words)).toEqual([
      "Yes",
      "No",
    ]);
    expect(
      offeredAnswers({ question: "Which one?", yesNo: true }, words),
    ).toEqual(["Yes", "No"]);
    expect(offeredAnswers({ question: "Which one?" }, words)).toEqual([]);
    expect(
      offeredAnswers({ question: "Is it A?", options: ["A", " ", "B"] }, words),
    ).toEqual(["A", "B"]);
  });
});
