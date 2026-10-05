import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import { ChannelAvatar } from "@/components/channels/avatar";
import { NoeBotAvatar } from "@/components/noe-bot/noe-bot-avatar";
import { NoeBotIcon } from "@/components/noe-bot/noe-bot-face";

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

test("a named avatar is one image, announced by name, hiding the drawing inside it", () => {
  const view = render(
    <AbstractAvatar name="Noë" seed="noe-assistant" size={40} />,
  );
  const image = view.getByRole("img", { name: "Noë" });
  expect(image.style.width).toBe("40px");
  const svg = image.querySelector("svg");
  expect(svg?.getAttribute("aria-hidden")).toBe("true");
  expect(svg?.getAttribute("viewBox")).toBe("-1 -2 16 16");
  expect(svg?.querySelector("path")?.getAttribute("d")).toMatch(/^M\d/);
});

test("the same seed draws the same face everywhere, on the 16 grid at every size", () => {
  const small = render(<NoeBotAvatar seed="research-desk" size={28} />);
  const again = render(<NoeBotAvatar seed="research-desk" size={28} />);
  const face = (view: ReturnType<typeof render>) =>
    view.container.querySelector("svg")?.getAttribute("data-face");
  expect(face(small)).toBe(face(again));
  const large = render(<NoeBotAvatar seed="research-desk" size={80} />);
  expect(face(large)).toBe(face(small));
  expect(large.container.querySelector("svg")?.getAttribute("viewBox")).toBe(
    "-1 -2 16 16",
  );
  expect(large.container.querySelector("svg")?.getAttribute("width")).toBe(
    "56",
  );
});

test("a channel of several Bots stacks one face per Bot, and a lone Bot gets its own", () => {
  const group = render(
    <ChannelAvatar participantIds={["a", "b", "c", "d"]} size={32} />,
  );
  expect(group.container.querySelectorAll("svg")).toHaveLength(3);
  const single = render(<ChannelAvatar participantIds={["a"]} size={32} />);
  expect(single.container.querySelectorAll("svg")).toHaveLength(1);
  expect(single.container.querySelector("svg")?.getAttribute("data-face")).toBe(
    group.container.querySelector("svg")?.getAttribute("data-face"),
  );
});

test("the icon for Bots in general is the mascot's own face", () => {
  const view = render(<NoeBotIcon className="size-5" />);
  const svg = view.container.querySelector("svg");
  expect(svg?.getAttribute("data-face")).toBe("body");
  expect(svg?.getAttribute("viewBox")).toBe("-1 -2 16 16");
  expect(svg?.getAttribute("fill")).toBe("currentColor");
});
