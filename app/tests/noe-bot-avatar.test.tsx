import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import { ChannelAvatar } from "@/components/channels/avatar";
import { NoeBotAvatar } from "@/components/noe-bot/noe-bot-avatar";
import { NoeBotIcon } from "@/components/noe-bot/noe-bot-face";
import { expressionFor, schemeFor } from "@/components/noe-bot/pixel-art";
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";

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

function avatarOf(view: ReturnType<typeof render>) {
  const avatar = view.container.querySelector<HTMLElement>("span");
  return {
    background: avatar?.style.backgroundColor,
    ink: avatar?.style.color,
    face: avatar?.querySelector("svg")?.getAttribute("data-face"),
    className: avatar?.className ?? "",
  };
}

test("a chosen colour and expression are drawn instead of the seed's", () => {
  const seed = "research-desk";
  const chosen = avatarOf(
    render(
      <NoeBotAvatar
        color="#7c3aed"
        expression="curious"
        seed={seed}
        size={40}
      />,
    ),
  );
  expect(chosen.background).toBe("#7c3aed");
  expect(chosen.ink).toBe("#ffffff");
  expect(chosen.face).toBe("curious");
});

test("with nothing chosen it is the seed's face, the one the Bot had before there was a choice", () => {
  const seed = "research-desk";
  for (const unchosen of [
    <NoeBotAvatar key="absent" seed={seed} />,
    <NoeBotAvatar color={null} expression={null} key="null" seed={seed} />,
  ]) {
    const drawn = avatarOf(render(unchosen));
    expect(drawn.background).toBe(schemeFor(seed).background);
    expect(drawn.face).toBe(expressionFor(seed));
    cleanup();
  }
});

test("one half chosen leaves the other to the seed", () => {
  const seed = "noe-assistant";
  const drawn = avatarOf(render(<NoeBotAvatar color="#f59e0b" seed={seed} />));
  expect(drawn.background).toBe("#f59e0b");
  // Amber takes black ink.
  expect(drawn.ink).toBe("#09090b");
  expect(drawn.face).toBe(expressionFor(seed));
});

test("the light grey is ringed so it shows on white, and a saturated colour is not", () => {
  const grey = avatarOf(render(<NoeBotAvatar color="#f4f4f5" seed="a" />));
  expect(grey.className).toContain("ring-1");
  expect(grey.className).toContain("dark:ring-0");
  cleanup();
  const black = avatarOf(render(<NoeBotAvatar color="#18181b" seed="a" />));
  // The near-black disappears into the dark theme's page instead, so only there.
  expect(black.className).toContain("dark:ring-1");
  expect(black.className).not.toMatch(/(^|\s)ring-1/);
  cleanup();
  const rose = avatarOf(render(<NoeBotAvatar color="#ff2056" seed="a" />));
  expect(rose.className).not.toContain("ring");
});

test("a participant's face follows the roster: the colour and expression its owner chose", () => {
  const client = new QueryClient();
  const bot = {
    id: "bot-1",
    avatarSeed: "bot-1-seed",
    avatarColor: "#16a34a",
    avatarExpression: "laughing",
  } as AgentProfile;
  client.setQueryData(agentKeys.list(false), [bot]);
  const view = render(
    <QueryClientProvider client={client}>
      <ChannelAvatar participantIds={["bot-1"]} size={32} />
    </QueryClientProvider>,
  );
  const avatar = view.container.querySelector<HTMLElement>(
    "[style*='background-color']",
  );
  expect(avatar?.style.backgroundColor).toBe("#16a34a");
  expect(avatar?.querySelector("svg")?.getAttribute("data-face")).toBe(
    "laughing",
  );
});
