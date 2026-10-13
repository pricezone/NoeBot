import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  setSystemTime,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import {
  ChatActivityIndicator,
  waitingKindOf,
} from "@/components/channels/activity-indicator";
import { ToolRenderBoundary } from "@/components/channels/tool-boundary";
import {
  RecoveryCard,
  UnfinishedTurnCard,
  unfinishedTurnOf,
} from "@/components/chat-cards/recovery-card";
import {
  conversationLanguage,
  formatElapsed,
  lastPersonText,
  stringsFor,
  UiLanguageProvider,
} from "@/lib/i18n/strings";
import { settleReactWork } from "./settle-react-work";

/**
 * The one card every failure in a conversation is drawn as, the words it says in English and in
 * Greek, and the status row's long wait. The flows that use the card (a failed send, a request that
 * lapsed, a browser group that failed) have their own files; this pins the pieces they share.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(() => {
  cleanup();
  setSystemTime();
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

describe("RecoveryCard", () => {
  test("draws a pill per handler given, in the fixed order, and each one fires its own", () => {
    const fired: string[] = [];
    const record = (name: string) => () => fired.push(name);
    const view = render(
      <RecoveryCard
        detail="The page did not load."
        onAskAgain={record("ask again")}
        onDismiss={record("dismiss")}
        onOpenScreen={record("open screen")}
        onResume={record("resume")}
        onRetry={record("retry")}
        onStopWaiting={record("stop waiting")}
        onTakeOver={record("take over")}
        title="The Bot ran into a problem in the browser."
      />,
    );

    // An error is announced, with its reason, as one alert.
    const card = view.getByRole("alert");
    expect(card.textContent).toContain(
      "The Bot ran into a problem in the browser.",
    );
    expect(card.textContent).toContain("The page did not load.");

    const pills = Array.from(card.querySelectorAll("[data-action]")).map(
      (pill) => pill.textContent,
    );
    expect(pills).toEqual([
      "Resume",
      "Retry",
      "Take over",
      "Ask again",
      "Open screen",
      "Stop waiting",
    ]);

    for (const name of [
      "Resume",
      "Retry",
      "Take over",
      "Ask again",
      "Open screen",
      "Stop waiting",
      "Dismiss",
    ])
      fireEvent.click(view.getByRole("button", { name }));
    expect(fired).toEqual([
      "resume",
      "retry",
      "take over",
      "ask again",
      "open screen",
      "stop waiting",
      "dismiss",
    ]);
  });

  test("offers nothing it cannot do, and a pause is a status rather than an alert", () => {
    const view = render(
      <RecoveryCard title="A browser task is paused here." tone="paused" />,
    );
    expect(view.queryByRole("alert")).toBeNull();
    expect(view.getByRole("status").textContent).toContain(
      "A browser task is paused here.",
    );
    expect(view.queryAllByRole("button")).toHaveLength(0);
  });

  test("an action on its way holds the others", () => {
    const view = render(
      <RecoveryCard
        busy="takeOver"
        onOpenScreen={() => undefined}
        onTakeOver={() => undefined}
        title="The Bot ran into a problem in the browser."
      />,
    );
    const takeOver = view.getByRole("button", { name: "Take over" });
    expect(takeOver.getAttribute("aria-busy")).toBe("true");
    expect(takeOver.hasAttribute("disabled")).toBe(true);
    expect(
      view
        .getByRole("button", { name: "Open screen" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  test("speaks Greek in a Greek conversation", () => {
    const view = render(
      <UiLanguageProvider language="el">
        <RecoveryCard
          onDismiss={() => undefined}
          onRetry={() => undefined}
          onTakeOver={() => undefined}
          title="…"
        />
      </UiLanguageProvider>,
    );
    expect(view.getByRole("button", { name: "Δοκίμασε ξανά" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Ανάλαβε" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Κλείσιμο" })).toBeTruthy();
  });
});

describe("the unfinished turn", () => {
  test("says the Bot stopped before finishing, and Continue says so as the person, in their language", () => {
    const sent: string[] = [];
    const strings = stringsFor("el");
    const view = render(
      <UiLanguageProvider language="el">
        <UnfinishedTurnCard
          onContinue={() => sent.push(strings.continueMessage)}
        />
      </UiLanguageProvider>,
    );
    expect(view.getByRole("status").textContent).toContain(
      "Ο Bot σταμάτησε πριν τελειώσει",
    );
    fireEvent.click(view.getByRole("button", { name: "Συνέχεια" }));
    expect(sent).toEqual(["Συνέχισε"]);
    expect(stringsFor("en").continueMessage).toBe("Continue");
  });

  test("is read from the conversation only when it says so", () => {
    expect(unfinishedTurnOf(null)).toBe(false);
    expect(unfinishedTurnOf({ ask: () => undefined })).toBe(false);
    expect(unfinishedTurnOf({ unfinishedTurn: "yes" })).toBe(false);
    expect(unfinishedTurnOf({ unfinishedTurn: true })).toBe(true);
  });
});

describe("a card that could not be drawn", () => {
  test("says so in a recovery card, and Retry mounts it again", () => {
    // Broken until the arguments finish streaming; React's own synchronous retry is still broken.
    let broken = true;
    function Flaky() {
      if (broken) throw new Error("half an argument");
      return <p>drawn</p>;
    }
    const quiet = console.error;
    console.error = () => undefined;
    try {
      const view = render(
        <ToolRenderBoundary name="Chart">
          <Flaky />
        </ToolRenderBoundary>,
      );
      expect(view.getByRole("alert").textContent).toContain(
        "Chart could not be drawn.",
      );
      broken = false;
      fireEvent.click(view.getByRole("button", { name: "Retry" }));
      expect(view.getByText("drawn")).toBeTruthy();
      expect(view.queryByRole("alert")).toBeNull();
    } finally {
      console.error = quiet;
    }
  });
});

describe("the strings table", () => {
  test("switches with the person's language and keeps every key", () => {
    const en = stringsFor("en");
    const el = stringsFor("el");
    expect(Object.keys(el).sort()).toEqual(Object.keys(en).sort());
    expect(en.expired).toBe("Expired");
    expect(el.expired).toBe("Έληξε");
    expect(en.lockNote("www.gov.gr")).toBe(
      "Never shown to your Bot. Filled directly to www.gov.gr.",
    );
    expect(el.lockNote("www.gov.gr")).toBe(
      "Δεν εμφανίζεται ποτέ στον Bot σου. Συμπληρώνεται απευθείας στο www.gov.gr.",
    );
    expect(en.browsedPages(1)).toBe("Browsed 1 page");
    expect(el.browsedPages(3)).toBe("Περιήγηση σε 3 σελίδες");
    // A sentence we know is translated; one we do not is shown as written.
    expect(el.reason("The Bot stopped without saying why.")).toBe(
      "Ο Bot σταμάτησε χωρίς να πει γιατί.",
    );
    expect(el.reason("Refused by policy.")).toBe("Refused by policy.");
    expect(en.reason("Refused by policy.")).toBe("Refused by policy.");
    // "Bot", never "assistant".
    for (const table of [en, el])
      for (const value of Object.values(table))
        if (typeof value === "string")
          expect(value.toLowerCase()).not.toContain("assistant");
  });

  test("reads the language off the person's last message", () => {
    expect(conversationLanguage("Book a table")).toBe("en");
    expect(conversationLanguage("Κλείσε τραπέζι")).toBe("el");
    expect(conversationLanguage(null)).toBe("en");
    expect(
      lastPersonText([
        { role: "user", content: "Γεια" },
        { role: "assistant", content: "Hello" },
        {
          role: "user",
          content: [
            { type: "text", text: "and now" },
            { type: "image", url: "x" },
          ],
        },
      ]),
    ).toBe("and now ");
    expect(lastPersonText([{ role: "assistant", content: "Hi" }])).toBeNull();
  });

  test("times a wait as minutes and seconds, and hours past the hour", () => {
    expect(formatElapsed(9)).toBe("0:09");
    expect(formatElapsed(135)).toBe("2:15");
    expect(formatElapsed(3723)).toBe("1:02:03");
  });
});

describe("the status row", () => {
  test("sorts the tool it waits on into what the person has to do", () => {
    expect(waitingKindOf("computer_request_sign_in")).toBe("sign-in");
    expect(waitingKindOf("computer_request_secret")).toBe("code");
    expect(waitingKindOf("computer_request_help")).toBe("takeover");
    expect(waitingKindOf("askApproval")).toBe("approval");
    expect(waitingKindOf("ask_person")).toBe("choice");
    expect(waitingKindOf("askChoice")).toBe("choice");
    expect(waitingKindOf("computer_click")).toBeNull();
    expect(waitingKindOf(null)).toBeNull();
  });

  async function waitedRow(language: "en" | "el") {
    const start = new Date("2026-10-13T09:00:00Z");
    setSystemTime(start);
    const view = render(
      <UiLanguageProvider language={language}>
        <ChatActivityIndicator
          animation="face:pleading"
          label={language === "el" ? "Σε περιμένω" : "Waiting for you"}
          phase="waiting"
          waitingFor="sign-in"
        />
      </UiLanguageProvider>,
    );
    // Under ten seconds the director's own words stand.
    expect(view.getByRole("status").textContent).toBe(
      language === "el" ? "Σε περιμένω" : "Waiting for you",
    );
    setSystemTime(new Date(start.getTime() + 135_000));
    // The row's clock ticks once a second.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_100));
    });
    return view.getByRole("status").textContent;
  }

  test("past ten seconds says what it waits for and for how long", async () => {
    expect(await waitedRow("en")).toBe("Waiting for you to sign in · 2:15");
  });

  test("and says it in Greek in a Greek conversation", async () => {
    expect(await waitedRow("el")).toBe("Σε περιμένω να συνδεθείς · 2:15");
  });

  test("a wait that ends goes back to the director's words", async () => {
    function Row() {
      const [phase, setPhase] = useState<"waiting" | "working">("waiting");
      return (
        <>
          <ChatActivityIndicator
            animation="face:pleading"
            label={phase === "waiting" ? "Waiting for you" : "Reading…"}
            phase={phase}
            waitingFor="code"
          />
          <button onClick={() => setPhase("working")} type="button">
            answered
          </button>
        </>
      );
    }
    const start = new Date("2026-10-13T09:00:00Z");
    setSystemTime(start);
    const view = render(<Row />);
    setSystemTime(new Date(start.getTime() + 30_000));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_100));
    });
    expect(view.getByRole("status").textContent).toBe(
      "Waiting for your code · 0:30",
    );
    fireEvent.click(view.getByRole("button", { name: "answered" }));
    expect(view.getByRole("status").textContent).toBe("Reading…");
  });
});
