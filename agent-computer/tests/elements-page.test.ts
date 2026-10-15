import { describe, expect, test } from "bun:test";
import {
  CANDIDATE_LIMIT,
  chooseElements,
  classifyBox,
  ELEMENT_LIMIT,
  OFFSCREEN_LIMIT,
} from "../src/elements";
import {
  createNavigationTracker,
  type FollowedPage,
} from "../src/navigation-state";
import {
  KEYBOARD_ELSEWHERE,
  KEYBOARD_OFF_PAGE,
  performPageKeyboard,
} from "../src/page-keyboard";
import { xdotoolFailure } from "../src/x-input";

/*
 * Clicky sees the whole page now, not the first two hundred controls of it: what is on the screen,
 * what is above and below it, and whether the page moved on after the person did something. And its
 * typing goes through the page's own keyboard, only once the field it meant has the focus.
 */

const viewport = { width: 1280, height: 720 };
const box = (y: number, height = 20, x = 10) => ({ x, y, width: 100, height });

describe("which controls Clicky is handed", () => {
  test("on a page scrolled down, the visible ones are found however many come before them", () => {
    // 300 controls above the screen first in the document, then 5 on it: the old first-200 cut
    // measured only the ones above, and handed Clicky nothing at all.
    const measured = [
      ...Array.from({ length: 300 }, (_, index) => ({
        name: `above ${index}`,
        box: box(-6000 + index * 20),
      })),
      ...Array.from({ length: 5 }, (_, index) => ({
        name: `on screen ${index}`,
        box: box(100 + index * 40),
      })),
    ];
    expect(measured.length).toBeLessThanOrEqual(CANDIDATE_LIMIT);
    const chosen = chooseElements(measured, viewport);
    expect(chosen.visible.map((element) => element.name)).toEqual([
      "on screen 0",
      "on screen 1",
      "on screen 2",
      "on screen 3",
      "on screen 4",
    ]);
    // The nearest above first.
    expect(chosen.offscreen[0]).toMatchObject({
      name: "above 299",
      offscreen: "above",
    });
  });

  test("off the screen, both sides get room, nearest first", () => {
    const measured = [
      ...Array.from({ length: 60 }, (_, index) => ({
        name: `above ${index}`,
        box: box(-20 - index * 30),
      })),
      { name: "far below", box: box(5000) },
      { name: "just below", box: box(800) },
    ];
    const chosen = chooseElements(measured, viewport);
    expect(chosen.offscreen).toHaveLength(OFFSCREEN_LIMIT);
    const below = chosen.offscreen.filter((e) => e.offscreen === "below");
    expect(below.map((e) => e.name)).toEqual(["just below", "far below"]);
    expect(chosen.offscreen[0]?.name).toBe("above 0");
  });

  test("at most the limit on the screen, and nothing beside it or without a size", () => {
    const many = Array.from({ length: 120 }, (_, index) => ({
      name: `${index}`,
      box: box(index * 5, 4),
    }));
    expect(chooseElements(many, viewport).visible).toHaveLength(ELEMENT_LIMIT);
    expect(classifyBox(null, viewport)).toBeNull();
    expect(classifyBox({ x: 0, y: 10, width: 0, height: 10 }, viewport)).toBe(
      null,
    );
    // A carousel's next card, to the right: not somewhere scrolling down reaches.
    expect(classifyBox(box(100, 20, 1400), viewport)).toBeNull();
    expect(classifyBox(box(-40), viewport)).toBe("above");
    expect(classifyBox(box(720), viewport)).toBe("below");
    expect(classifyBox(box(710), viewport)).toBe("visible");
  });
});

/** A page the tracker can follow, with its events fired by hand. */
function fakePage(url = "https://a.example/") {
  const listeners = new Map<string, ((value: unknown) => void)[]>();
  const main = { url: () => current };
  let current = url;
  const page = {
    mainFrame: () => main,
    url: () => current,
    on(event: string, listener: (value: unknown) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
    fire(event: string, value: unknown) {
      for (const listener of listeners.get(event) ?? []) listener(value);
    },
    go(next: string) {
      page.fire("request", {
        isNavigationRequest: () => true,
        frame: () => main,
      });
      current = next;
      page.fire("framenavigated", main);
    },
  };
  return page;
}

describe("whether the page moved on", () => {
  test("a navigation counts once it has settled, and a redirect chain counts once", async () => {
    const tracker = createNavigationTracker({ settleMs: 30 });
    const page = fakePage();
    const pages: FollowedPage[] = [page as unknown as FollowedPage];
    tracker.attach("bot-1", {
      pages: () => pages,
      on: () => undefined,
    });
    const followed = page as unknown as FollowedPage;
    expect(tracker.state("bot-1", followed)).toEqual({
      url: "https://a.example/",
      navigationId: 0,
      settled: true,
    });
    page.go("https://a.example/search?q=1");
    page.go("https://b.example/landing");
    page.go("https://b.example/final");
    expect(tracker.state("bot-1", followed)).toMatchObject({
      navigationId: 0,
      settled: false,
    });
    await Bun.sleep(60);
    expect(tracker.state("bot-1", followed)).toEqual({
      url: "https://b.example/final",
      navigationId: 1,
      settled: true,
    });
  });

  test("a navigation on its way is not settled until it lands, and a failed one is forgotten", () => {
    const tracker = createNavigationTracker({ settleMs: 30 });
    const page = fakePage();
    tracker.attach("bot-1", {
      pages: () => [page as unknown as FollowedPage],
      on: () => undefined,
    });
    const followed = page as unknown as FollowedPage;
    const request = {
      isNavigationRequest: () => true,
      frame: () => followed.mainFrame(),
    };
    page.fire("request", request);
    expect(tracker.state("bot-1", followed).settled).toBe(false);
    page.fire("requestfailed", request);
    expect(tracker.state("bot-1", followed).settled).toBe(true);
    // A frame inside the page navigating is not the page moving on.
    page.fire("framenavigated", { url: () => "https://ads.example/" });
    expect(tracker.state("bot-1", followed).settled).toBe(true);
  });

  test("another tab coming to the front is a change, and pages opened later are followed", async () => {
    const tracker = createNavigationTracker({ settleMs: 10 });
    let opened: ((page: FollowedPage) => void) | undefined;
    const first = fakePage();
    tracker.attach("bot-1", {
      pages: () => [first as unknown as FollowedPage],
      on: (_event, listener) => {
        opened = listener;
      },
    });
    const before = tracker.state("bot-1", first as unknown as FollowedPage);
    const popup = fakePage("https://login.example/");
    opened?.(popup as unknown as FollowedPage);
    const after = tracker.state("bot-1", popup as unknown as FollowedPage);
    expect(after.navigationId).toBe(before.navigationId + 1);
    popup.go("https://login.example/done");
    await Bun.sleep(30);
    expect(
      tracker.state("bot-1", popup as unknown as FollowedPage).navigationId,
    ).toBe(after.navigationId + 1);
    // Each Bot counts its own.
    expect(tracker.navigationId("bot-2")).toBe(0);
  });
});

/** A page whose answer to "who has the keyboard" is scripted, recording what was typed. */
function keyboardPage(answers: { ready: boolean; reason: string | null }[]) {
  const typed: string[] = [];
  const pressed: string[] = [];
  const asked: unknown[] = [];
  let index = 0;
  const page = {
    url: () => "https://gov.example/search",
    viewportSize: () => ({ width: 1000, height: 600 }),
    evaluate: async (_fn: unknown, argument: unknown) => {
      asked.push(argument);
      const answer = answers[Math.min(index, answers.length - 1)];
      index += 1;
      return answer;
    },
    keyboard: {
      insertText: async (text: string) => {
        typed.push(text);
      },
      press: async (key: string) => {
        pressed.push(key);
      },
    },
  };
  return { page, typed, pressed, asked };
}

describe("typing through the page's keyboard", () => {
  test("types once the field clicked has the keyboard, waiting a moment for it to arrive", async () => {
    const { page, typed, asked } = keyboardPage([
      { ready: false, reason: "elsewhere" },
      { ready: true, reason: null },
    ]);
    const result = await performPageKeyboard(
      page as never,
      "/human/type",
      { text: "υπεύθυνη δήλωση", at: { x: 300, y: 200 } },
      null,
      async () => undefined,
    );
    expect(typed).toEqual(["υπεύθυνη δήλωση"]);
    // Asked about the point in the page's own pixels.
    expect(asked[0]).toEqual({ point: { x: 300, y: 200 }, page: false });
    // A length, never the text.
    expect(result).toEqual({
      action: "human_type",
      characters: 15,
      url: "https://gov.example/search",
    });
    expect(JSON.stringify(result)).not.toContain("δήλωση");
  });

  test("types nothing when the field never gets the keyboard", async () => {
    const { page, typed } = keyboardPage([
      { ready: false, reason: "elsewhere" },
    ]);
    await expect(
      performPageKeyboard(
        page as never,
        "/human/type",
        { text: "secret", at: { x: 300, y: 200 } },
        null,
        async () => undefined,
      ),
    ).rejects.toThrow(KEYBOARD_ELSEWHERE);
    expect(typed).toEqual([]);
  });

  test("a key goes to what has the keyboard on the page, and a point off the page is refused", async () => {
    const { page, pressed } = keyboardPage([{ ready: true, reason: null }]);
    await performPageKeyboard(
      page as never,
      "/human/key",
      { key: "Enter" },
      null,
      async () => undefined,
    );
    expect(pressed).toEqual(["Enter"]);
    await expect(
      performPageKeyboard(
        page as never,
        "/human/type",
        { text: "x", at: { x: 5000, y: 5000 } },
        null,
        async () => undefined,
      ),
    ).rejects.toThrow(KEYBOARD_OFF_PAGE);
  });
});

describe("the desktop's input", () => {
  test("a failure names the command, never the text being typed", () => {
    const failure = xdotoolFailure(["type", "--file", "-"], "exit code 1");
    expect(failure.message).toBe(
      "The desktop's input did not go through (xdotool type: exit code 1).",
    );
  });
});
