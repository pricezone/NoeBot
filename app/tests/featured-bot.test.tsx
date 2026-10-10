import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { botLandingTarget } from "@/components/app-sidebar/bot-target";
import {
  FeaturedBot,
  featuredAgent,
} from "@/components/app-sidebar/featured-bot";
import { ASSISTANT_AGENT_ID } from "@/lib/agents/default-agent";
import { LAST_BOT_STORAGE_KEY, rememberLastBot } from "@/lib/agents/last-bot";
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";
import {
  type BotAttention,
  botLifecycleKeys,
} from "@/lib/bot-lifecycle/queries";
import { type ChannelSummary, channelKeys } from "@/lib/channels/queries";

/**
 * The Bot at the top of the sidebar: the one this person was with last, else the default
 * coworker; its dot lit while it works or has something waiting; a click opening its newest
 * conversation rather than the roster's.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(() => {
  cleanup();
  window.localStorage.clear();
});
afterAll(() => GlobalRegistrator.unregister());

function agent(id: string, name = id): AgentProfile {
  return {
    id,
    name,
    title: "",
    roleDescription: "",
    avatarSeed: id,
    avatarColor: null,
    avatarExpression: null,
    canEditAvatar: false,
    visibility: "public",
    endpoint: null,
    builtIn: id === ASSISTANT_AGENT_ID,
    hasAuth: false,
    hasCallbackToken: false,
    hidden: false,
    pinned: false,
    systemOwned: false,
    canManage: true,
    mine: true,
  };
}

/** A roster row, in the order the server hands them out: the first is the newest. */
function channel(
  id: string,
  agentIds: string[],
  extra: Partial<ChannelSummary> = {},
): ChannelSummary {
  return {
    id,
    name: id,
    agentIds,
    threadId: `thread-${id}`,
    active: true,
    lastMessageAt: null,
    summary: null,
    lastMessage: null,
    lastMessageAgentId: null,
    createdAt: "2026-09-15T00:00:00Z",
    pinned: false,
    lastReadAt: null,
    ...extra,
  };
}

function attention(
  agentId: string,
  extra: Partial<BotAttention>,
): BotAttention {
  return {
    agentId,
    name: agentId,
    questions: 0,
    approvals: 0,
    handoffs: 0,
    unread: 0,
    paused: false,
    notify: "all",
    ...extra,
  };
}

function draw(seed: {
  agents?: AgentProfile[];
  channels?: ChannelSummary[];
  attention?: BotAttention[];
}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(agentKeys.list(false), seed.agents ?? []);
  client.setQueryDefaults(botLifecycleKeys.attention, {
    refetchInterval: false,
  });
  client.setQueryData(botLifecycleKeys.attention, seed.attention ?? []);
  client.setQueryData(channelKeys.list(), {
    pages: [{ channels: seed.channels ?? [], nextCursor: null }],
    pageParams: [""],
  });

  const rootRoute = createRootRoute({
    component: () => (
      <>
        <FeaturedBot />
        <Outlet />
      </>
    ),
  });
  const page = (path: string, label: string) =>
    createRoute({
      path,
      getParentRoute: () => rootRoute,
      component: () => <p>{label}</p>,
    });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: rootRoute.addChildren([
      page("/", "Home"),
      page("/channel/new", "New chat"),
      page("/channel/$channelId", "Channel"),
    ]),
  });
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { view, router };
}

test("featuredAgent prefers the remembered Bot the roster still lists, else the default", () => {
  const roster = [agent("other"), agent(ASSISTANT_AGENT_ID, "Noë")];
  expect(featuredAgent(roster, "other")?.id).toBe("other");
  expect(featuredAgent(roster, "deleted")?.id).toBe(ASSISTANT_AGENT_ID);
  expect(featuredAgent(roster, null)?.id).toBe(ASSISTANT_AGENT_ID);
  expect(featuredAgent([], null)).toBeUndefined();
  expect(featuredAgent(undefined, "other")).toBeUndefined();
});

test("botLandingTarget opens the Bot's own newest conversation, else a fresh one with it", () => {
  const channels = [
    channel("newest-other", ["other"]),
    channel("group", ["noe", "other"]),
    channel("noe-old", ["noe"]),
  ];
  expect(botLandingTarget("noe", channels, [agent("noe")])).toEqual({
    to: "/channel/$channelId",
    params: { channelId: "noe-old" },
  });
  // No conversation yet: a fresh one with this Bot, not with whoever the roster's default is.
  expect(botLandingTarget("lonely", channels, [agent("lonely")])).toEqual({
    to: "/channel/new",
    search: { agent: "lonely" },
  });
  // A Bot the roster does not list still gets a target, named by id.
  expect(botLandingTarget("unknown", channels, [agent("noe")])).toEqual({
    to: "/channel/new",
    search: { agent: "unknown" },
  });
});

test("renders the default Bot and opens its newest conversation, not the roster's", async () => {
  const { view, router } = draw({
    agents: [agent("other", "Other"), agent(ASSISTANT_AGENT_ID, "Noë")],
    channels: [
      channel("other-newest", ["other"]),
      channel("noe-newest", [ASSISTANT_AGENT_ID]),
      channel("noe-older", [ASSISTANT_AGENT_ID]),
    ],
  });
  const link = await view.findByRole("link", { name: "Open Noë" });
  expect(view.getByText("Noë")).toBeTruthy();
  expect(link.getAttribute("href")).toBe("/channel/noe-newest");
  const user = userEvent.setup({ document: view.baseElement.ownerDocument });
  await user.click(link);
  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/channel/noe-newest"),
  );
});

test("the remembered Bot is featured, and a Bot with no conversation starts one", async () => {
  window.localStorage.setItem(LAST_BOT_STORAGE_KEY, "other");
  const { view } = draw({
    agents: [agent(ASSISTANT_AGENT_ID, "Noë"), agent("other", "Other")],
    channels: [channel("noe-newest", [ASSISTANT_AGENT_ID])],
  });
  const link = await view.findByRole("link", { name: "Open Other" });
  expect(link.getAttribute("href")).toBe("/channel/new?agent=other");
});

/*
 * The channel route records the Bot it shows in an effect, after the sidebar has already drawn.
 * Nothing else about the sidebar changes when the person moves to another Bot's already-read
 * conversation, so the featured slot has to hear about the write itself or it keeps naming the
 * Bot they just left.
 */
test("moving to another Bot's conversation changes the featured Bot without any query changing", async () => {
  window.localStorage.setItem(LAST_BOT_STORAGE_KEY, "other");
  const { view } = draw({
    agents: [agent(ASSISTANT_AGENT_ID, "Noë"), agent("other", "Other")],
    channels: [
      channel("other-newest", ["other"]),
      channel("noe-newest", [ASSISTANT_AGENT_ID]),
    ],
  });
  const before = await view.findByRole("link", { name: "Open Other" });
  expect(before.getAttribute("href")).toBe("/channel/other-newest");

  act(() => rememberLastBot(ASSISTANT_AGENT_ID));

  const after = await view.findByRole("link", { name: "Open Noë" });
  expect(after.getAttribute("href")).toBe("/channel/noe-newest");
  expect(view.queryByRole("link", { name: "Open Other" })).toBeNull();
});

test("the dot lights while the Bot works or has something waiting, and is muted otherwise", async () => {
  const quiet = draw({
    agents: [agent(ASSISTANT_AGENT_ID, "Noë")],
    channels: [channel("c", [ASSISTANT_AGENT_ID])],
  });
  const dot = () =>
    quiet.view.container
      .querySelector("[data-active]")
      ?.getAttribute("data-active");
  await quiet.view.findByRole("link", { name: "Open Noë" });
  expect(dot()).toBe("false");
  cleanup();

  const busy = draw({
    agents: [agent(ASSISTANT_AGENT_ID, "Noë")],
    channels: [channel("c", [ASSISTANT_AGENT_ID], { busy: true })],
  });
  await busy.view.findByRole("link", { name: "Open Noë" });
  expect(
    busy.view.container
      .querySelector("[data-active]")
      ?.getAttribute("data-active"),
  ).toBe("true");
  cleanup();

  const waiting = draw({
    agents: [agent(ASSISTANT_AGENT_ID, "Noë")],
    channels: [channel("c", [ASSISTANT_AGENT_ID])],
    attention: [attention(ASSISTANT_AGENT_ID, { questions: 1 })],
  });
  await waiting.view.findByRole("link", { name: "Open Noë" });
  expect(
    waiting.view.container
      .querySelector("[data-active]")
      ?.getAttribute("data-active"),
  ).toBe("true");
});

test("nothing is drawn when the roster names no Bot", async () => {
  const { view } = draw({ agents: [], channels: [] });
  await view.findByText("Home");
  expect(view.queryByTestId("featured-bot")).toBeNull();
});
