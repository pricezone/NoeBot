import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { ChatActivityIndicator } from "@/components/channels/activity-indicator";

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const row = (view: ReturnType<typeof render>) => {
  const indicator = view.getByTestId("activity-indicator");
  const sprite = indicator.querySelector("svg");
  const holder = sprite?.parentElement as HTMLElement | null;
  return { indicator, sprite, holder };
};

test("the status row is the Bot's own character, small and inline with the sentence, with nothing behind it", () => {
  const view = render(
    <ChatActivityIndicator
      animation="action:search"
      avatar={{ seed: "research-desk", color: "#2563eb" }}
      label="Searching the web…"
      phase="working"
    />,
  );
  const { indicator, sprite, holder } = row(view);
  // The director's animation, played as it is: in HD, with its props.
  expect(indicator.dataset.animation).toBe("action:search");
  expect(indicator.dataset.phase).toBe("working");
  expect(sprite?.getAttribute("data-animation")).toBe("action:search");
  // A small avatar's size: a 32 px box, 2 px per cell.
  expect(sprite?.getAttribute("width")).toBe("32");
  // The Bot's colour paints the character; there is no tile, disc or background anywhere.
  expect(holder?.style.color).toBe("#2563eb");
  expect(indicator.querySelector("[style*='background']")).toBeNull();
  expect(indicator.innerHTML).not.toContain("rounded");
  // The sentence is the status, and the only avatar is the character itself.
  expect(view.getByRole("status").textContent).toBe("Searching the web…");
  expect(indicator.querySelectorAll("svg")).toHaveLength(1);
});

test("a near-black Bot keeps its colour and is outlined only on the dark page", () => {
  const view = render(
    <ChatActivityIndicator
      animation="face:curious"
      avatar={{ seed: "a", color: "#18181b" }}
      label="Thinking…"
      phase="thinking"
    />,
  );
  const { holder } = row(view);
  expect(holder?.style.color).toBe("#18181b");
  expect(holder?.className).toContain("dark:[filter:drop-shadow");
  expect(holder?.className).not.toMatch(/(^|\s)\[filter:/);
});

test("without an avatar to take a colour from, it is the design's rose", () => {
  const view = render(
    <ChatActivityIndicator
      animation="face:curious"
      label="Thinking"
      phase="thinking"
    />,
  );
  expect(row(view).holder?.style.color).toBe("#ff2056");
});
