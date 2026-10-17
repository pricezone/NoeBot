import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import {
  ClickyOverlay,
  containedFrame,
  percent,
  selectClickyOverlay,
  wordsGoLeft,
  wordsRoom,
} from "@/components/clicky/clicky-overlay";
import {
  type ClickyOverlay as Overlay,
  type ClickySession,
  newClickySession,
} from "../../shared/clicky";
import { settleReactWork } from "./settle-react-work";

/**
 * Clicky's overlay over the Bot's screen: everything is placed as a fraction of the frame as it is
 * drawn, so a point the server sends as normalized coordinates lands on the same spot of the screen
 * at any size, and a frame letterboxed in its card is covered without its bands. The pointer glides
 * between spots unless the person asked for less motion, a spot Clicky only guessed says "around
 * here", and words near an edge go on the side that stays on screen.
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

/** The overlay as a surface draws it: from the view it selects out of the session. */
function Drawn({ of }: { of: ClickySession }) {
  return <ClickyOverlay view={selectClickyOverlay(of)} />;
}

const pointer = (x: number, y: number, extra: Partial<Overlay> = {}) =>
  ({ kind: "pointer", id: "p1", at: { x, y }, ...extra }) as Overlay;

const clickyPointer = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[data-clicky="clicky-pointer"]');

test("a normalized point is a percentage of the drawn frame, rounded", () => {
  expect(percent(0.25)).toBe("25%");
  expect(percent(0.07)).toBe("7%");
  expect(percent(0.123456)).toBe("12.346%");
  // Outside the screen is clamped to its edge, never drawn off it.
  expect(percent(1.4)).toBe("100%");
  expect(percent(-0.2)).toBe("0%");
});

test("a 16:9 frame fitted in a 1.6 card is covered without its bands", () => {
  // Wider than the card: full width, a band above and below.
  expect(containedFrame(1.6, 16 / 9)).toEqual({
    left: "0%",
    top: "5%",
    width: "100%",
    height: "90%",
  });
  // Taller than the card: full height, a band either side.
  expect(containedFrame(16 / 9, 1.6)).toEqual({
    left: "5%",
    top: "0%",
    width: "90%",
    height: "100%",
  });
  // The same shape, or nothing known: the whole card.
  expect(containedFrame(1.6, 1.6)).toEqual({
    left: "0%",
    top: "0%",
    width: "100%",
    height: "100%",
  });
  expect(containedFrame(1.6, 0).height).toBe("100%");
});

test("the pointer, a highlight, a marker and a caption sit where their coordinates say", () => {
  const view = render(
    <Drawn
      of={session([
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
  const view = render(<Drawn of={session([pointer(0.2, 0.3)])} />);
  const first = clickyPointer(view.container);
  expect(first?.style.transition).toContain("left 350ms");

  view.rerender(<Drawn of={session([pointer(0.6, 0.7)])} />);
  const moved = clickyPointer(view.container);
  expect(moved).toBe(first);
  expect(moved?.style.left).toBe("60%");
  expect(moved?.style.top).toBe("70%");
});

test("with reduced motion the pointer jumps and the highlight does not pulse", () => {
  reduced = true;
  const view = render(
    <Drawn
      of={session([
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
    <Drawn
      of={session([pointer(0.4, 0.4, { approximate: true, label: "Menu" })])}
    />,
  );
  expect(view.getByText("Menu, around here")).toBeTruthy();
  expect(clickyPointer(view.container)?.getAttribute("data-approximate")).toBe(
    "true",
  );

  view.rerender(
    <Drawn of={session([pointer(0.4, 0.4, { approximate: true })])} />,
  );
  expect(view.getByText("Around here")).toBeTruthy();
});

test("near the top a box's words go under it; near the bottom the pointer's go above", () => {
  const view = render(
    <Drawn
      of={session([
        pointer(0.5, 0.92, { label: "Send" }),
        {
          kind: "highlight",
          id: "top",
          label: "Address bar",
          rect: { x: 0.1, y: 0.02, width: 0.6, height: 0.04 },
        },
        {
          kind: "highlight",
          id: "middle",
          label: "Form",
          rect: { x: 0.1, y: 0.4, width: 0.6, height: 0.2 },
        },
      ])}
    />,
  );
  const labels = [
    ...view.container.querySelectorAll<HTMLElement>(
      '[data-clicky="highlight-label"]',
    ),
  ];
  const top = labels.find((label) => label.textContent === "Address bar");
  const middle = labels.find((label) => label.textContent === "Form");
  expect(top?.getAttribute("data-placement")).toBe("below");
  expect(top?.style.top).toBe("6%");
  expect(middle?.getAttribute("data-placement")).toBe("above");

  const words = view.getByText("Send").parentElement;
  expect(words?.getAttribute("data-placement")).toBe("above");
});

test("the current step's overlays are drawn, and the step is announced politely", () => {
  const view = render(
    <Drawn
      of={session([], {
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

test("words still arriving are not part of what the overlay draws", () => {
  const streaming = session([pointer(0.5, 0.5)], {
    state: "thinking",
    reply: { text: "Cli", final: false },
  });
  const more = { ...streaming, reply: { text: "Click", final: false } };
  // The same view for both, so a surface drawing it is not drawn again for each word.
  expect(selectClickyOverlay(more)).toEqual(selectClickyOverlay(streaming));
  expect(selectClickyOverlay(streaming).reply).toBeNull();
});

test("asleep, nothing is drawn", () => {
  const asleep = render(
    <Drawn of={session([pointer(0.5, 0.5)], { awake: false })} />,
  );
  expect(clickyPointer(asleep.container)).toBeNull();
});

test("the pointer's words go where they fit: right when there is room, left when not", () => {
  // The middle of a small viewer (700 px): 350 px to the right is room enough.
  expect(wordsGoLeft(0.5, 700, 304)).toBe(false);
  // The address bar's middle on a 560 px viewer: 280 px to the right is not, and the left has more.
  expect(wordsGoLeft(0.5, 560, 304)).toBe(false);
  expect(wordsGoLeft(0.55, 560, 304)).toBe(true);
  // A wide viewer keeps the words on the right of a point well past the middle.
  expect(wordsGoLeft(0.7, 1400, 304)).toBe(false);
  // Without a measured width, the fixed share decides.
  expect(wordsGoLeft(0.7, null, 304)).toBe(true);
  expect(wordsGoLeft(0.5, null, 304)).toBe(false);
});

test("the pointer's words narrow to the room on their side rather than run off the screen", () => {
  // Measured live: a 422 px viewer, the address bar's middle. Both sides have 211 px.
  expect(wordsGoLeft(0.5, 422, 304)).toBe(false);
  expect(wordsRoom(0.5, 422, false)).toBe(163);
  // Never narrower than a readable minimum, and unknown without a width.
  expect(wordsRoom(0.95, 422, false)).toBe(140);
  expect(wordsRoom(0.5, null, false)).toBeNull();
  // On the left, the room is what lies left of the point.
  expect(wordsRoom(0.9, 1000, true)).toBe(852);
});

test("showing what the Bot does, a box fades a moment after it is drawn, and the next action's box shows in full", async () => {
  const box = (id: string): Overlay => ({
    kind: "highlight",
    id,
    rect: { x: 0.2, y: 0.2, width: 0.2, height: 0.05 },
    label: "Search",
  });
  const narrating = (id: string) =>
    selectClickyOverlay(session([box(id)], { narrating: true }));
  const view = render(
    <ClickyOverlay narrationFadeAfterMs={40} view={narrating("h1")} />,
  );
  const drawn = () =>
    view.container.querySelector<SVGRectElement>('[data-clicky="highlight"]');
  const label = () =>
    view.container.querySelector<HTMLElement>(
      '[data-clicky="highlight-label"]',
    );
  // Shown in full, and still: a narration box does not pulse.
  expect(drawn()?.style.opacity).toBe("1");
  expect(drawn()?.getAttribute("class") ?? "").not.toContain("animate-pulse");
  await new Promise((resolve) => setTimeout(resolve, 80));
  await settleReactWork();
  expect(drawn()?.dataset.faded).toBe("true");
  expect(drawn()?.style.opacity).toBe("0");
  expect(label()?.style.opacity).toBe("0");
  // The Bot's next action is a new box, shown in full again.
  view.rerender(
    <ClickyOverlay narrationFadeAfterMs={40} view={narrating("h2")} />,
  );
  expect(drawn()?.dataset.faded).toBeUndefined();
  expect(drawn()?.style.opacity).toBe("1");
});

test("a walkthrough's box never fades by itself", async () => {
  const view = render(
    <ClickyOverlay
      narrationFadeAfterMs={20}
      view={selectClickyOverlay(
        session([
          {
            kind: "highlight",
            id: "h1",
            rect: { x: 0.2, y: 0.2, width: 0.2, height: 0.05 },
          },
        ]),
      )}
    />,
  );
  await new Promise((resolve) => setTimeout(resolve, 60));
  await settleReactWork();
  const drawn = view.container.querySelector<SVGRectElement>(
    '[data-clicky="highlight"]',
  );
  expect(drawn?.dataset.faded).toBeUndefined();
  expect(drawn?.style.opacity).toBe("1");
});
