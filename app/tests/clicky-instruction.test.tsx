import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  act,
  cleanup,
  render,
  renderHook,
  waitFor,
} from "@testing-library/react";
import {
  CLICKY_INSTRUCTION_LIMIT,
  clippedInstruction,
} from "@/components/clicky/clicky-instruction";
import { ClickyScreenOverlay } from "@/components/clicky/clicky-overlay";
import { clickyKeys } from "@/lib/clicky/queries";
import { replayClickyLineNow, resetClickyReplays } from "@/lib/clicky/replay";
import {
  SENTENCE_MAX_MS,
  sentenceMsPerCharacter,
  useTypedSentence,
} from "@/lib/typed-reveal";
import { queryClient } from "@/query-client";
import {
  type ClickyOverlay,
  type ClickySession,
  newClickySession,
} from "../../shared/clicky";
import { settleReactWork } from "./settle-react-work";

/**
 * The instruction beside "Show me how"'s pointer: it types in at about 20 ms a character (all at
 * once for somebody who asked for less motion), sits beside the pointer or, with nothing to point at,
 * along the bottom of the screen, says the step rather than words about a step that is over, puts
 * what the Bot did into a narration, and types in again on "Say that again". While Clicky looks at
 * the screen again, what it points at is drawn faded and still.
 */

const BOT = "instruction-bot";
let reduced = false;
let preferences: Record<string, unknown> = {};
let originalMatchMedia: typeof window.matchMedia | undefined;
const originalFetch = globalThis.fetch;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  queryClient.clear();
  originalMatchMedia = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: query.includes("prefers-reduced-motion") ? reduced : false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/me")
      return Response.json({ user: { id: "person-1", email: "p@x.test" } });
    if (url === "/api/settings/preferences")
      return Response.json({ preferences });
    return Response.json({ error: "Not here" }, { status: 404 });
  }) as typeof fetch;
});

beforeEach(() => {
  preferences = { messageListEmphasis: "agent", clickyOnboarded: true };
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  resetClickyReplays();
  reduced = false;
});

afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  if (originalMatchMedia) window.matchMedia = originalMatchMedia;
  GlobalRegistrator.unregister();
});

const pointer = (x: number, y: number, label?: string): ClickyOverlay => ({
  kind: "pointer",
  id: "p1",
  at: { x, y },
  ...(label ? { label } : {}),
});

function session(patch: Partial<ClickySession> = {}): ClickySession {
  return {
    ...newClickySession({ id: "s1", botId: BOT, now: 0 }),
    awake: true,
    state: "guiding",
    seq: 1,
    ...patch,
  };
}

function draw(of: ClickySession) {
  queryClient.setQueryData(clickyKeys.session(BOT), of);
  return render(<ClickyScreenOverlay botId={BOT} />);
}

const instruction = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[data-clicky="instruction"]');
const typedText = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[data-clicky="instruction-text"]')
    ?.textContent ?? "";

const walkthrough = (detail?: string): ClickySession["walkthrough"] => ({
  id: "w1",
  goal: "Search",
  startedAt: "",
  updatedAt: "",
  currentStepId: "a",
  steps: [
    {
      id: "a",
      title: "Click the search box",
      ...(detail ? { detail } : {}),
      status: "current",
      overlays: [pointer(0.3, 0.3, "Search")],
    },
    { id: "b", title: "Type your question", status: "pending", overlays: [] },
  ],
});

test("about 20 ms a character, and never more than four seconds for a long one", () => {
  expect(sentenceMsPerCharacter(10)).toBe(20);
  expect(sentenceMsPerCharacter(400) * 400).toBe(SENTENCE_MAX_MS);
});

test("a sentence types in, carries on as words arrive, and starts again when said again", async () => {
  const { result, rerender } = renderHook(
    ({ text, replay }: { text: string; replay: number }) =>
      useTypedSentence(text, replay, false),
    { initialProps: { text: "Click the blue button", replay: 0 } },
  );
  // Not there at once: the first frame draws nothing of it, or very little.
  expect(result.current.text.length).toBeLessThan(5);
  expect(result.current.typing).toBe(true);
  await waitFor(() =>
    expect(result.current).toEqual({
      text: "Click the blue button",
      typing: false,
    }),
  );

  // Words still arriving add to the sentence: it types on from where it was, not from nothing.
  rerender({ text: "Click the blue button at the top", replay: 0 });
  expect(result.current.text.startsWith("Click the blue button")).toBe(true);
  await waitFor(() => expect(result.current.typing).toBe(false));

  // Said again: from nothing.
  rerender({ text: "Click the blue button at the top", replay: 1 });
  expect(result.current.text.length).toBeLessThan(5);
  await waitFor(() => expect(result.current.typing).toBe(false));
});

test("with reduced motion the sentence is simply there", () => {
  const { result, rerender } = renderHook(
    ({ text }: { text: string }) => useTypedSentence(text, 0, true),
    { initialProps: { text: "Click the blue button" } },
  );
  expect(result.current).toEqual({
    text: "Click the blue button",
    typing: false,
  });
  rerender({ text: "Now type your name" });
  expect(result.current).toEqual({
    text: "Now type your name",
    typing: false,
  });
});

test("beside the pointer, the step's instruction types in, hidden from screen readers", async () => {
  const view = draw(
    session({
      walkthrough: walkthrough(),
      reply: { text: "Let's search. First click the box.", final: true },
    }),
  );
  const bubble = await waitFor(() => {
    const found = instruction(view.container);
    expect(found).toBeTruthy();
    return found as HTMLElement;
  });
  // Beside the pointer, not along the bottom.
  expect(bubble.closest('[data-clicky="clicky-pointer"]')).toBeTruthy();
  expect(bubble.closest('[aria-hidden="true"]')).toBeTruthy();
  // The step, not the words said when the plan was made.
  await waitFor(() =>
    expect(typedText(view.container)).toBe("Click the search box"),
  );
  // The live region says it once, whole.
  expect(
    view.container.querySelector('[aria-live="polite"]')?.textContent,
  ).toBe("Step 1 of 2 — Click the search box");
});

test("with reduced motion the instruction is whole from the first frame", async () => {
  reduced = true;
  const view = draw(
    session({
      overlays: [pointer(0.5, 0.5)],
      reply: { text: "That's the Sign in button.", final: true },
    }),
  );
  const bubble = await waitFor(() => {
    const found = instruction(view.container);
    expect(found).toBeTruthy();
    return found as HTMLElement;
  });
  expect(typedText(view.container)).toBe("That's the Sign in button.");
  expect(bubble.getAttribute("data-typing")).toBeNull();
});

test("detailed guidance adds the step's detail, and a line that is the person's stays in view", async () => {
  reduced = true;
  preferences = { ...preferences, clickyGuidance: "detailed" };
  const view = draw(
    session({
      walkthrough: walkthrough("It is at the top of the page."),
      reply: { text: "", final: true, notice: "yours" },
    }),
  );
  await waitFor(() =>
    expect(typedText(view.container)).toBe(
      "Click the search box\nIt is at the top of the page.\nThis one's yours. I'll show you where.",
    ),
  );
});

test("with nothing to point at, the reply sits along the bottom of the screen", async () => {
  reduced = true;
  const view = draw(
    session({
      state: "idle",
      reply: {
        text: "",
        final: true,
        notice: "awake",
      },
    }),
  );
  const bottom = await waitFor(() => {
    const found = view.container.querySelector(
      '[data-slot="clicky-instruction-bottom"]',
    );
    expect(found).toBeTruthy();
    return found as HTMLElement;
  });
  expect(bottom.textContent).toContain("Hi! Ask me anything about the screen.");
  expect(
    view.container.querySelector('[data-clicky="pointer-label"]'),
  ).toBeNull();
});

test("narrating the Bot, what it does is said with the words it names", async () => {
  reduced = true;
  const view = draw(
    session({
      narrating: true,
      trigger: { kind: "person" },
      overlays: [
        {
          kind: "highlight",
          id: "h1",
          rect: { x: 0.2, y: 0.2, width: 0.2, height: 0.05 },
          label: "Search",
        },
        pointer(0.3, 0.22, "Search"),
      ],
      reply: {
        text: "",
        final: true,
        notice: "narrate_click",
        params: { label: "Search" },
      },
    }),
  );
  await waitFor(() =>
    expect(typedText(view.container)).toBe("I'm clicking “Search”."),
  );
  expect(
    view.container.querySelector('[aria-live="polite"]')?.textContent,
  ).toBe("I'm clicking “Search”.");
});

test("while Clicky looks again, what it points at is faded and still", async () => {
  const view = draw(
    session({
      overlaysStale: true,
      overlays: [
        {
          kind: "highlight",
          id: "h1",
          rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 },
        },
        pointer(0.2, 0.15),
      ],
    }),
  );
  const box = await waitFor(() => {
    const found = view.container.querySelector('[data-clicky="highlight"]');
    expect(found).toBeTruthy();
    return found as Element;
  });
  expect((box as SVGElement).style.opacity).toBe("0.4");
  expect(box.getAttribute("data-stale")).toBe("true");
  expect(box.getAttribute("class") ?? "").not.toContain("animate-pulse");
  const arrow = view.container.querySelector<HTMLElement>(
    '[data-clicky="clicky-pointer"] > span',
  );
  expect(arrow?.style.opacity).toBe("0.4");

  // The fresh look is back: drawn as usual again.
  act(() => {
    queryClient.setQueryData(
      clickyKeys.session(BOT),
      session({
        seq: 2,
        overlays: [
          {
            kind: "highlight",
            id: "h1",
            rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 },
          },
          pointer(0.2, 0.15),
        ],
      }),
    );
  });
  await waitFor(() =>
    expect(
      view.container.querySelector<SVGElement>('[data-clicky="highlight"]')
        ?.style.opacity,
    ).toBe("1"),
  );
});

test("Say that again types the instruction in again", async () => {
  const view = draw(
    session({
      overlays: [pointer(0.5, 0.5)],
      reply: { text: "Press the green button.", final: true },
    }),
  );
  await waitFor(() =>
    expect(typedText(view.container)).toBe("Press the green button."),
  );
  act(() => replayClickyLineNow(BOT));
  expect(typedText(view.container).length).toBeLessThan(5);
  await waitFor(() =>
    expect(typedText(view.container)).toBe("Press the green button."),
  );
});

test("a long answer is held to the bubble's size; the bar has it whole", async () => {
  reduced = true;
  const long = "Open the menu at the top right. ".repeat(20).trim();
  expect(clippedInstruction("Short.")).toBe("Short.");
  const clipped = clippedInstruction(long);
  expect(clipped.length).toBeLessThanOrEqual(CLICKY_INSTRUCTION_LIMIT);
  expect(clipped.endsWith("…")).toBe(true);

  const view = draw(
    session({
      overlays: [pointer(0.5, 0.5)],
      reply: { text: long, final: true },
    }),
  );
  await waitFor(() => expect(typedText(view.container)).toBe(clipped));
  const text = view.container.querySelector('[data-clicky="instruction-text"]');
  expect(text?.className).toContain("line-clamp-4");
});

test("with a step and no reply, the step is the instruction", async () => {
  reduced = true;
  const view = draw(session({ walkthrough: walkthrough(), reply: null }));
  await waitFor(() =>
    expect(typedText(view.container)).toBe("Click the search box"),
  );
});
