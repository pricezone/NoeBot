import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render } from "@testing-library/react";
import { ActivityLog } from "@/components/computer/activity-log";
import { activityFor, clearActivity } from "@/lib/computers/activity";
import {
  browsingStepsFor,
  observeToolCall,
  stepsWhenAsked,
} from "@/lib/computers/browsing-steps";
import { computerSleep } from "@/lib/computers/use-computer-sleep";

/**
 * The Bot's browsing in the computer panel's Activity list.
 *
 * The list showed commands and files and nothing of the browsing, so a Bot that opened a portal,
 * clicked through and signed in left it empty. These pin what each step says, that a typed value is
 * never on it, and that a click carried out by the server's gate (which never reaches the tool's own
 * handler) is still recorded.
 */

const BOT = "browsing-bot";

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
});
afterEach(() => {
  cleanup();
  clearActivity(BOT);
  computerSleep.reset();
});
afterAll(async () => {
  await act(async () => undefined);
  GlobalRegistrator.unregister();
});

describe("what each browsing call says", () => {
  test("a page opened: its title, with its host under it", () => {
    expect(
      browsingStepsFor(
        "computer_navigate",
        { url: "https://news.ycombinator.com" },
        {
          ok: true,
          url: "https://news.ycombinator.com/",
          title: "Hacker News",
          text: "…",
        },
      ),
    ).toEqual([
      {
        kind: "page",
        subject: "Hacker News",
        output: "",
        detail: "news.ycombinator.com",
      },
    ]);
    // No title: the host is the line.
    expect(
      browsingStepsFor(
        "computer_navigate",
        { url: "https://example.com/a" },
        { ok: true, url: "https://example.com/a" },
      ),
    ).toEqual([{ kind: "page", subject: "example.com", output: "" }]);
  });

  test("a page that would not open is an issue, a refusal marked as one", () => {
    expect(
      browsingStepsFor(
        "computer_navigate",
        { url: "https://blocked.example/x" },
        { ok: false, refused: true, reason: "A boundary said no." },
      ),
    ).toEqual([
      {
        kind: "issue",
        subject: "Could not open blocked.example",
        output: "A boundary said no.",
        refused: true,
      },
    ]);
  });

  test("a check met on the way is an issue before the page", () => {
    expect(
      browsingStepsFor(
        "computer_navigate",
        { url: "https://shop.example" },
        {
          ok: true,
          url: "https://shop.example/",
          title: "Shop",
          challenge: {
            requestId: "r1",
            kind: "cloudflare",
            reason: "The site is checking the browser.",
          },
          challengeResolved: true,
        },
      ).map((step) => [step.kind, step.subject, step.output]),
    ).toEqual([
      [
        "issue",
        "Met a check on shop.example",
        "The site is checking the browser.",
      ],
      ["page", "Shop", ""],
    ]);
  });

  test("a click names the element the server resolved, never the ref", () => {
    expect(
      browsingStepsFor(
        "computer_click",
        { ref: "e9", snapshotId: 3 },
        { action: "click", element: { role: "button", name: "Submit order" } },
      ),
    ).toEqual([{ kind: "click", subject: "Submit order", output: "" }]);
  });

  test("typing names the field and NEVER what went into it", () => {
    const steps = browsingStepsFor(
      "computer_type",
      { ref: "e1", snapshotId: 3, text: "hunter2-secret", submit: true },
      { action: "type", element: { role: "input", name: "Password" } },
    );
    expect(steps).toEqual([{ kind: "type", subject: "Password", output: "" }]);
    expect(JSON.stringify(steps)).not.toContain("hunter2-secret");
  });

  test("a sign-in the computer typed, by site; one that did not happen is an issue", () => {
    expect(
      browsingStepsFor(
        "computer_request_sign_in",
        { site: "https://bank.example" },
        { ok: true, signedIn: true, site: "https://bank.example" },
      ),
    ).toEqual([{ kind: "sign_in", subject: "bank.example", output: "" }]);
    expect(
      browsingStepsFor(
        "computer_request_sign_in",
        { site: "https://bank.example" },
        {
          ok: false,
          signedIn: false,
          site: "https://bank.example",
          result: "The sign-in to https://bank.example did not complete.",
        },
      ),
    ).toEqual([
      {
        kind: "issue",
        subject: "Not signed in to bank.example",
        output: "The sign-in to https://bank.example did not complete.",
      },
    ]);
  });

  test("a request for help is an issue the moment it is made", () => {
    expect(
      stepsWhenAsked("computer_request_help", {
        reason: "This page wants a code sent to your phone.",
      }),
    ).toEqual([
      {
        kind: "issue",
        subject: "Asked you for help",
        output: "This page wants a code sent to your phone.",
      },
    ]);
    expect(browsingStepsFor("computer_request_help", {}, { ok: true })).toEqual(
      [],
    );
  });

  test("nothing for a call the gate is holding, a stopped one, or one that is not browsing", () => {
    expect(
      browsingStepsFor("computer_click", { ref: "e1" }, { waiting: true }),
    ).toEqual([]);
    expect(
      browsingStepsFor(
        "computer_navigate",
        { url: "https://a.example" },
        { ok: false, stopped: true, reason: "Stopped." },
      ),
    ).toEqual([]);
    expect(
      browsingStepsFor("computer_run_command", { command: "ls" }, { ok: true }),
    ).toEqual([]);
    expect(browsingStepsFor("computer_snapshot", {}, { ok: true })).toEqual([]);
  });
});

describe("the Activity list", () => {
  test("lists the steps of a gated click and a page, newest first, never a typed value", async () => {
    await observeToolCall(
      BOT,
      "computer_navigate",
      { url: "https://example.com" },
      async () => ({ ok: true, url: "https://example.com/", title: "Example" }),
    );
    // What the server's approval gate answers for a typed field: the handler never ran.
    await observeToolCall(
      BOT,
      "computer_type",
      { ref: "e1", snapshotId: 1, text: "my secret words" },
      async () => ({ action: "type", element: { name: "Search" } }),
    );
    expect(activityFor(BOT).map((entry) => entry.kind)).toEqual([
      "page",
      "type",
    ]);

    const view = render(<ActivityLog computerId={BOT} />);
    const lines = [...view.container.querySelectorAll("li")].map(
      (line) => line.textContent,
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("Typed in");
    expect(lines[0]).toContain("Search");
    expect(lines[1]).toContain("Opened");
    expect(lines[1]).toContain("Example");
    expect(lines[1]).toContain("example.com");
    expect(view.container.textContent).not.toContain("my secret words");
  });

  test("says what will appear there before anything has", () => {
    const view = render(<ActivityLog computerId={BOT} />);
    expect(view.container.textContent).toContain(
      "Nothing yet. Pages the Bot opens, commands it runs and files it reads appear here as they happen.",
    );
  });
});
