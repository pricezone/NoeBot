import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import {
  BrowserActivity,
  type BrowserGroup,
} from "@/components/channels/browser-activity";
import {
  forgetTeamBotConsentAnswers,
  TeamBotConsentCard,
} from "@/components/channels/team-bot-consent";
import {
  HandoffResumeNotice,
  PausedTaskCard,
  PausedTaskFallback,
} from "@/components/computer/handoff-resume-notice";
import { ConversationProvider } from "@/lib/copilot/conversation";
import { HelpCard, SecretCard } from "@/lib/copilot/computer-tools";
import { UiLanguageProvider } from "@/lib/i18n/strings";
import { settleReactWork } from "./settle-react-work";

/**
 * The cards a Bot's requests are drawn as, once something did not go as asked: a one-value request
 * that lapsed, a takeover nobody took, a browser group that ended on a failure, a Team Bot's consent
 * after the answer. Each says why in the person's language and offers a real way forward.
 */

let originalFetch: typeof fetch;
let posted: { url: string; body: unknown }[] = [];

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST")
      posted.push({
        url,
        body: typeof init.body === "string" ? JSON.parse(init.body) : null,
      });
    if (url.includes("/consents")) return Response.json({ ok: true });
    if (url.endsWith("/control"))
      return Response.json({
        holder: "bot",
        since: "2026-10-13T09:00:00Z",
        requested: false,
        transitioning: false,
        resumeSnapshotRequired: false,
      });
    if (url.includes("/approvals")) return Response.json({ requests: [] });
    return Response.json({}, { status: 404 });
  }) as typeof fetch;
});
afterEach(() => {
  cleanup();
  posted = [];
  forgetTeamBotConsentAnswers();
});
afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

function inConversation(
  node: ReactNode,
  asked: string[],
  options: { turnActive?: boolean; language?: "en" | "el" } = {},
) {
  return (
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <ConversationProvider
        ask={(text) => {
          asked.push(text);
          return true;
        }}
        {...(options.turnActive === undefined
          ? {}
          : { turnActive: options.turnActive })}
      >
        <UiLanguageProvider language={options.language ?? "en"}>
          {node}
        </UiLanguageProvider>
      </ConversationProvider>
    </QueryClientProvider>
  );
}

describe("a one-value request that ended without the value", () => {
  test("says nobody entered it in time, and Ask again asks for the code as the person", () => {
    const asked: string[] = [];
    const view = render(
      inConversation(
        <SecretCard
          computerId="noe"
          label="the code sent to your phone"
          result={JSON.stringify({ ok: false, outcome: "expired" })}
          running={false}
        />,
        asked,
      ),
    );
    expect(view.getByText("Expired")).toBeTruthy();
    expect(
      view.getByText("Nobody entered it in time, so the Bot stopped waiting."),
    ).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: "Ask again" }));
    expect(asked).toEqual(["Ask me again for the code"]);
    // Asked once: the pill goes, so a second press cannot ask twice.
    expect(view.queryByRole("button", { name: "Ask again" })).toBeNull();
  });

  test("a declined request says so, in Greek in a Greek conversation", () => {
    const asked: string[] = [];
    const view = render(
      inConversation(
        <SecretCard
          computerId="noe"
          label="ο κωδικός SMS"
          result={JSON.stringify({
            ok: false,
            outcome: "cancelled",
            result: "The person declined to enter ο κωδικός SMS.",
          })}
          running={false}
        />,
        asked,
        { language: "el" },
      ),
    );
    expect(view.getByText("Ακυρώθηκε")).toBeTruthy();
    expect(
      view.getByText("Το αρνήθηκες, οπότε δεν συμπληρώθηκε τίποτα."),
    ).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Ρώτα ξανά" }));
    expect(asked).toEqual(["Ζήτησέ μου ξανά τον κωδικό"]);
  });

  test("a request that never reached the person is not drawn as Submitted", () => {
    const view = render(
      inConversation(
        <SecretCard
          computerId="noe"
          label="your password"
          result={JSON.stringify({
            ok: false,
            reason: "That field is not on the page any more.",
            staleRefs: true,
          })}
          running={false}
        />,
        [],
      ),
    );
    expect(view.queryByText("Submitted")).toBeNull();
    expect(view.getByText("Not completed")).toBeTruthy();
    expect(
      view.getByText("That field is not on the page any more."),
    ).toBeTruthy();
  });

  test("no Ask again while a turn is going: the message would be refused", () => {
    const view = render(
      inConversation(
        <SecretCard
          computerId="noe"
          label="the code"
          result={JSON.stringify({ ok: false, outcome: "expired" })}
          running={false}
        />,
        [],
        { turnActive: true },
      ),
    );
    expect(view.getByText(/Nobody entered it in time/)).toBeTruthy();
    expect(view.queryByRole("button", { name: "Ask again" })).toBeNull();
  });
});

describe("a takeover nobody took", () => {
  test("says nobody took over, and Ask again asks to take over as the person", () => {
    const asked: string[] = [];
    const view = render(
      inConversation(
        <HelpCard
          computerId="noe"
          reason="Clear the check on the bank's page"
          result={JSON.stringify({
            ok: false,
            handoffStatus: "expired",
            reason: "Nobody took over before this request lapsed: …",
          })}
          running={false}
        />,
        asked,
      ),
    );
    expect(view.getByText("Expired")).toBeTruthy();
    expect(
      view.getByText("Nobody took over before the request lapsed."),
    ).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Ask again" }));
    expect(asked).toEqual(["Ask me again to take over"]);
  });

  test("a handback is just that: no reason, no Ask again", () => {
    const view = render(
      inConversation(
        <HelpCard
          computerId="noe"
          reason="Clear the check"
          result={JSON.stringify({ ok: true })}
          running={false}
        />,
        [],
      ),
    );
    expect(view.getByText("Handed back")).toBeTruthy();
    expect(view.queryByRole("button")).toBeNull();
  });
});

function step(id: string, name: string, result?: unknown) {
  return {
    kind: "tool" as const,
    id,
    toolCall: {
      id,
      type: "function" as const,
      function: { name, arguments: '{"url":"https://example.com"}' },
    },
    ...(result === undefined ? {} : { result: JSON.stringify(result) }),
  };
}

describe("browser groups", () => {
  test("a person holding the wheel and a page that moved are neutral steps, not issues", () => {
    const group: BrowserGroup = {
      kind: "browser",
      id: "g1",
      steps: [
        step("a", "computer_navigate", {
          ok: true,
          url: "https://example.com/",
          title: "Example",
        }),
        step("b", "computer_click", {
          ok: false,
          humanHasControl: true,
          reason: "A person has control of the browser.",
        }),
        step("c", "computer_click", {
          ok: false,
          staleRefs: true,
          reason: "That ref is stale.",
        }),
        step("d", "computer_click", { ok: true }),
      ],
    };
    const view = render(
      inConversation(<BrowserActivity active={false} group={group} />, []),
    );
    expect(view.getByText("Browsed 1 page")).toBeTruthy();
    expect(view.container.textContent).not.toContain("issue");
    expect(view.queryByRole("alert")).toBeNull();
    const neutral = view.container.querySelectorAll("[data-neutral]");
    expect(Array.from(neutral).map((line) => line.textContent)).toEqual([
      "You had control, so the Bot waited.",
      "The page had changed, so the Bot looked again.",
    ]);
    for (const line of neutral)
      expect(line.className).toContain("text-muted-foreground");
  });

  test("browsing that ended on a failure offers Take over and Open screen", async () => {
    const group: BrowserGroup = {
      kind: "browser",
      id: "g2",
      steps: [
        step("a", "computer_navigate", {
          ok: false,
          reason: "The page did not load.",
        }),
      ],
    };
    const view = render(
      inConversation(<BrowserActivity active={false} group={group} />, []),
    );
    const card = view.getByRole("alert");
    expect(card.textContent).toContain(
      "The Bot ran into a problem in the browser.",
    );
    expect(card.textContent).toContain("The page did not load.");
    expect(view.getByRole("button", { name: "Take over" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Open screen" })).toBeTruthy();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  });

  test("an issue the Bot got past is counted but offers no Take over", () => {
    const group: BrowserGroup = {
      kind: "browser",
      id: "g3",
      steps: [
        step("a", "computer_click", { ok: false, reason: "Missed." }),
        step("b", "computer_click", { ok: true }),
      ],
    };
    const view = render(
      inConversation(<BrowserActivity active={false} group={group} />, []),
    );
    expect(view.container.textContent).toContain("1 issue: Missed.");
    expect(view.queryByRole("button", { name: "Take over" })).toBeNull();
  });
});

describe("a Team Bot's consent", () => {
  const consent = {
    botId: "team-bot",
    serverId: "gmail",
    message: "This Team Bot wants to use your own gmail account.",
  };

  test("keeps its answer when the transcript draws it again", async () => {
    const first = render(
      inConversation(
        <TeamBotConsentCard {...consent} answerKey="call-1" />,
        [],
      ),
    );
    fireEvent.click(first.getByRole("button", { name: "Allow once" }));
    await first.findByRole("img", { name: "Answered" });
    first.unmount();

    // A remount (a refetch, the turn starting) asks nothing again and posts nothing again.
    const again = render(
      inConversation(
        <TeamBotConsentCard {...consent} answerKey="call-1" />,
        [],
      ),
    );
    expect(again.getByRole("img", { name: "Answered" })).toBeTruthy();
    expect(again.getByText("Allowed once.")).toBeTruthy();
    expect(again.queryByRole("button", { name: "Skip" })).toBeNull();
    expect(
      posted.filter((call) => call.url.includes("/consents")),
    ).toHaveLength(1);
  });

  test("offers Try again after an Allow, which asks the Bot as the person", async () => {
    const asked: string[] = [];
    const view = render(
      inConversation(
        <TeamBotConsentCard {...consent} answerKey="call-2" />,
        asked,
      ),
    );
    fireEvent.click(
      view.getByRole("button", { name: "Always allow for this Bot" }),
    );
    const tryAgain = await view.findByRole("button", { name: "Try again" });
    expect(view.queryByText(/Ask it to try again/)).toBeNull();
    fireEvent.click(tryAgain);
    expect(asked).toEqual(["Try again"]);
    await waitFor(() =>
      expect(view.queryByRole("button", { name: "Try again" })).toBeNull(),
    );
  });
});

describe("a browser task paused on a handoff", () => {
  test("is drawn at the step that paused, with Resume, and nowhere else", async () => {
    sessionStorage.setItem(
      "openbot:pending-handoff:noe",
      JSON.stringify({ requestId: "req-1", toolCallId: "call-help" }),
    );
    const agent = {
      isRunning: false,
      setMessages: () => undefined,
      messages: [
        { id: "u1", role: "user" as const, content: "Pay the bill" },
        {
          id: "a1",
          role: "assistant" as const,
          content: "",
          toolCalls: [
            {
              id: "call-help",
              type: "function" as const,
              function: {
                name: "computer_request_help",
                arguments: '{"reason":"Clear the check"}',
              },
            },
          ],
        },
      ],
    };
    try {
      const view = render(
        <>
          <HandoffResumeNotice
            agent={agent}
            botId="noe"
            ready
            run={async () => undefined}
          />
          <div data-testid="other-step">
            <PausedTaskCard toolCallIds={["call-other"]} />
          </div>
          <div data-testid="paused-step">
            <PausedTaskCard toolCallIds={["call-help"]} />
          </div>
          <div data-testid="end">
            <PausedTaskFallback drawn={new Set(["call-help"])} />
          </div>
        </>,
      );
      const resume = await view.findByRole("button", { name: "Resume" });
      expect(view.getByTestId("paused-step").contains(resume)).toBe(true);
      expect(view.getByTestId("paused-step").textContent).toContain(
        "A browser task is paused here.",
      );
      expect(view.getByTestId("other-step").textContent).toBe("");
      expect(view.getByTestId("end").textContent).toBe("");
    } finally {
      sessionStorage.clear();
    }
  });
});
