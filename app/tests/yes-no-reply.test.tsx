import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  YesNoReply,
  yesNoQuestionAtEnd,
} from "@/components/chat-cards/yes-no-reply";
import { ConversationProvider } from "@/lib/copilot/conversation";
import { trailingYesNoQuestion } from "@/lib/copilot/yes-no";

/**
 * Yes and No under a reply that ends on a yes-or-no question the Bot wrote in its own words.
 *
 * Found live: asked to check before setting up a reminder, the Bot wrote "Would you like me to set
 * up a weekly reminder…? If so, what day and time works best for you?" into its reply instead of
 * calling ask_person, and the person had nothing to tap.
 */
beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());
afterEach(() => cleanup());

describe("the question a reply ends on", () => {
  test("the first question of the last paragraph, when Yes or No answers it", () => {
    expect(
      trailingYesNoQuestion(
        "Happy to.\n\nWould you like me to set up a weekly reminder to review your open pull requests? If so, what day and time works best for you?",
      ),
    ).toBe(
      "Would you like me to set up a weekly reminder to review your open pull requests?",
    );
    expect(trailingYesNoQuestion("Έτοιμο. Θέλεις να το στείλω τώρα;")).toBe(
      "Θέλεις να το στείλω τώρα;",
    );
  });

  test("nothing for a reply that does not end by asking, or asks something else", () => {
    expect(trailingYesNoQuestion("Done. The reminder is set.")).toBeNull();
    expect(trailingYesNoQuestion("Should I use Postgres or MySQL?")).toBeNull();
    expect(trailingYesNoQuestion("What day suits you?")).toBeNull();
    expect(
      trailingYesNoQuestion("Shall I go ahead? I already started, see below."),
    ).toBeNull();
  });

  test("only when the conversation ends on the Bot's words, with no tool call", () => {
    const asked = { role: "assistant", content: "Shall I go ahead?" };
    expect(yesNoQuestionAtEnd([asked])).toBe("Shall I go ahead?");
    expect(
      yesNoQuestionAtEnd([asked, { role: "user", content: "Yes" }]),
    ).toBeNull();
    expect(
      yesNoQuestionAtEnd([
        { ...asked, toolCalls: [{ id: "1", function: { name: "x" } }] },
      ]),
    ).toBeNull();
    expect(
      yesNoQuestionAtEnd([
        { role: "assistant", content: [{ type: "text", text: "Shall I?" }] },
      ]),
    ).toBe("Shall I?");
  });
});

describe("the card", () => {
  const drawn = (busy: boolean, said: string[]) =>
    render(
      <ConversationProvider
        ask={(text: string) => {
          said.push(text);
        }}
        botId="bot-1"
        channelId="channel-1"
      >
        <YesNoReply
          busy={busy}
          messages={[
            { role: "assistant", content: "Shall I set up the reminder?" },
          ]}
        />
      </ConversationProvider>,
    );

  test("Yes says Yes as the person's message", async () => {
    const said: string[] = [];
    const view = drawn(false, said);
    expect(view.getByText("Shall I set up the reminder?")).toBeTruthy();
    await userEvent.click(view.getByText("Yes"));
    await waitFor(() => expect(said).toEqual(["Yes"]));
  });

  test("their own words go the same way", async () => {
    const said: string[] = [];
    const view = drawn(false, said);
    await userEvent.type(
      view.getByPlaceholderText("Type your own answer"),
      "Only on Fridays{Enter}",
    );
    await waitFor(() => expect(said).toEqual(["Only on Fridays"]));
  });

  test("nothing while a turn is going", () => {
    const view = drawn(true, []);
    expect(view.queryByText("Yes")).toBeNull();
  });
});
