import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { ClickyOverlay, percent } from "@/components/clicky/clicky-overlay";
import {
  type ClickyOverlay as Overlay,
  type ClickySession,
  newClickySession,
} from "../../shared/clicky";
import { settleReactWork } from "./settle-react-work";

/**
 * Clicky's overlay over the Bot's screen: everything is placed as a fraction of the screen's box, so
 * a point the server sends as normalized coordinates lands on the same spot of the screen at any
 * size. The pointer glides between spots unless the person asked for less motion, and a spot Clicky
 * only guessed says "around here".
 */

let reduced = false;
let originalMatchMedia: typeof window.matchMedia | undefined;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
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
});

afterEach(() => {
  cleanup();
  reduced = false;
});

afterAll(async () => {
  await settleReactWork();
  if (originalMatchMedia) window.matchMedia = originalMatchMedia;
  GlobalRegistrator.unregister();
});

function session(overlays: Overlay[], patch: Partial<ClickySession> = {}) {
  return {
    ...newClickySession({ id: "s1", botId: "bot-1", now: 0 }),
    awake: true,
    state: "guiding" as const,
    overlays,
    ...patch,
  };
}

const pointer = (x: number, y: number, extra: Partial<Overlay> = {}) =>
  ({ kind: "pointer", id: "p1", at: { x, y }, ...extra }) as Overlay;

const clickyPointer = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[data-clicky="clicky-pointer"]');

test("a normalized point is a percentage of the screen's box, rounded", () => {
  expect(percent(0.25)).toBe("25%");
  expect(percent(0.07)).toBe("7%");
  expect(percent(0.123456)).toBe("12.346%");
  // Outside the screen is clamped to its edge, never drawn off it.
  expect(percent(1.4)).toBe("100%");
  expect(percent(-0.2)).toBe("0%");
});

test("the pointer, a highlight, a marker and a caption sit where their coordinates say", () => {
  const view = render(
    <ClickyOverlay
      session={session([
        pointer(0.25, 0.5, { label: "Sign in" }),
        {
          kind: "highlight",
          id: "h1",
          rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.05 },
        },
        { kind: "marker", id: "m1", at: { x: 0.75, y: 0.4 }, index: 2 },
        { kind: "caption", id: "c1", at: { x: 0.5, y: 0.9 }, text: "Here" },
      ])}
    />,
  );
  const arrow = clickyPointer(view.container);
  expect(arrow?.style.left).toBe("25%");
  expect(arrow?.style.top).toBe("50%");
  expect(view.getByText("Sign in")).toBeTruthy();

  const box = view.container.querySelector('[data-clicky="highlight"]');
  expect(box?.getAttribute("x")).toBe("10%");
  expect(box?.getAttribute("y")).toBe("20%");
  expect(box?.getAttribute("width")).toBe("30%");
  expect(box?.getAttribute("height")).toBe("5%");

  const marker = view.container.querySelector<HTMLElement>(
    '[data-clicky="marker"]',
  );
  expect(marker?.style.left).toBe("75%");
  expect(marker?.style.top).toBe("40%");
  expect(marker?.textContent).toBe("2");

  expect(view.getByText("Here")).toBeTruthy();
  // Nothing in the layer can take a click from the screen under it.
  const layer = view.container.querySelector('[data-slot="clicky-overlay"]');
  expect(layer?.className).toContain("pointer-events-none");
});

test("the pointer glides to its next spot: the same element, moved, with a transition", () => {
  const view = render(<ClickyOverlay session={session([pointer(0.2, 0.3)])} />);
  const first = clickyPointer(view.container);
  expect(first?.style.transition).toContain("left 350ms");

  view.rerender(<ClickyOverlay session={session([pointer(0.6, 0.7)])} />);
  const moved = clickyPointer(view.container);
  expect(moved).toBe(first);
  expect(moved?.style.left).toBe("60%");
  expect(moved?.style.top).toBe("70%");
});

test("with reduced motion the pointer jumps and the highlight does not pulse", () => {
  reduced = true;
  const view = render(
    <ClickyOverlay
      session={session([
        pointer(0.2, 0.3),
        {
          kind: "highlight",
          id: "h1",
          rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 },
        },
      ])}
    />,
  );
  expect(clickyPointer(view.container)?.style.transition).toBe("none");
  expect(
    view.container
      .querySelector('[data-clicky="highlight"]')
      ?.getAttribute("class") ?? "",
  ).not.toContain("animate-pulse");
});

test("a guessed spot says around here, with or without a label", () => {
  const view = render(
    <ClickyOverlay
      session={session([
        pointer(0.4, 0.4, { approximate: true, label: "Menu" }),
      ])}
    />,
  );
  expect(view.getByText("Menu, around here")).toBeTruthy();
  expect(clickyPointer(view.container)?.getAttribute("data-approximate")).toBe(
    "true",
  );

  view.rerender(
    <ClickyOverlay
      session={session([pointer(0.4, 0.4, { approximate: true })])}
    />,
  );
  expect(view.getByText("Around here")).toBeTruthy();
});

test("the current step's overlays are drawn, and the step is announced politely", () => {
  const view = render(
    <ClickyOverlay
      session={session([], {
        walkthrough: {
          id: "w1",
          goal: "Sign in",
          startedAt: "",
          updatedAt: "",
          currentStepId: "b",
          steps: [
            { id: "a", title: "Open the menu", status: "done", overlays: [] },
            {
              id: "b",
              title: "Click Sign in",
              status: "current",
              overlays: [pointer(0.9, 0.1)],
            },
            {
              id: "c",
              title: "Type your email",
              status: "pending",
              overlays: [],
            },
          ],
        },
      })}
    />,
  );
  expect(clickyPointer(view.container)?.style.left).toBe("90%");
  const live = view.container.querySelector('[aria-live="polite"]');
  expect(live?.textContent).toBe("Step 2 of 3 — Click Sign in");
});

test("asleep, nothing is drawn; the preview draws no words and no live region", () => {
  const asleep = render(
    <ClickyOverlay session={session([pointer(0.5, 0.5)], { awake: false })} />,
  );
  expect(clickyPointer(asleep.container)).toBeNull();
  asleep.unmount();

  const compact = render(
    <ClickyOverlay
      compact
      session={session([pointer(0.5, 0.5, { label: "Sign in" })])}
    />,
  );
  expect(clickyPointer(compact.container)?.style.left).toBe("50%");
  expect(compact.queryByText("Sign in")).toBeNull();
  expect(compact.container.querySelector('[aria-live="polite"]')).toBeNull();
});
