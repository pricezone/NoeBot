import "./channel-new-error-state.fixture";

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
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";
import { botPanelSearchSchema } from "@/lib/bot-panel";
import {
  type AgentChannel,
  type ChannelSummary,
  channelKeys,
} from "@/lib/channels/queries";
import { Route as ChannelNewRoute } from "@/routes/_authed/_app/channel/new";
import { Route as GroupNewRoute } from "@/routes/_authed/_app/group/new";
import { settleReactWork } from "./settle-react-work";

/**
 * The sidebar's + opens `/channel/new?compose=1`: nobody preselected, the To: menu open on "Create
 * new Bot", "Create group chat" and every Bot. "Create new Bot" makes one in a click and opens its
 * conversation; "Add to group chat" on a Bot's row, or "Create group chat", turns the field into
 * chips, and two or more of them start a group on the first send while one is a direct conversation.
 */

const originalFetch = globalThis.fetch;

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function agent(
  overrides: Partial<AgentProfile> & { id: string; name: string },
): AgentProfile {
  return {
    avatarSeed: overrides.id,
    avatarColor: null,
    avatarExpression: null,
    canEditAvatar: true,
    builtIn: true,
    canManage: true,
    endpoint: null,
    hasAuth: false,
    hasCallbackToken: false,
    hidden: false,
    pinned: false,
    mine: true,
    roleDescription: "Role",
    systemOwned: false,
    title: "Title",
    visibility: "private",
    ...overrides,
  };
}

// `assistant` is the default Bot, so a screen that still preselected would pick it.
const NOE = agent({ id: "assistant", name: "Noë", title: "Assistant" });
const PRIMA = agent({ id: "prima", name: "Prima Workspace", title: "Ops" });
const SENDY = agent({ id: "sendy", name: "Sendy", title: "Email" });

function channel(id: string, agentIds: string[]): AgentChannel {
  return {
    id,
    name: id,
    agentIds,
    threadId: `thread_${id}`,
    active: true,
    lastMessageAt: null,
  };
}

function summary(id: string): ChannelSummary {
  return {
    ...channel(id, [NOE.id]),
    summary: null,
    lastMessage: null,
    lastMessageAgentId: null,
    createdAt: "2026-10-09T09:00:00Z",
    pinned: false,
    lastReadAt: null,
  };
}

function queryClientWith(channels: ChannelSummary[] = [summary("old")]) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  queryClient.setQueryData(agentKeys.list(false), [NOE, PRIMA, SENDY]);
  queryClient.setQueryData(channelKeys.list(), {
    pages: [{ channels, nextCursor: null }],
    pageParams: [""],
  });
  return queryClient;
}

type Call = { method: string; path: string; body: unknown };

/** The server, as far as these screens reach it. Every request is recorded. */
function serve() {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    const body =
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    if (path === "/api/agents" && method === "POST" && body?.quick === true)
      return Response.json(
        {
          agent: agent({ id: "agent_new", name: "New Bot" }),
          channel: channel("channel_bot", ["agent_new"]),
        },
        { status: 201 },
      );
    if (path === "/api/route" && method === "POST")
      return Response.json({ agentId: PRIMA.id });
    if (path === "/api/channels" && method === "POST")
      return Response.json({ channel: channel("channel_dm", body.agentIds) });
    if (path === "/api/groups" && method === "POST")
      return Response.json(
        { channel: channel("channel_group", body.agentIds) },
        { status: 201 },
      );
    if (path === "/api/groups/channel_group" && method === "POST")
      return Response.json({}, { status: 202 });
    if (path.startsWith("/api/channels"))
      return Response.json({ channels: [summary("old")], nextCursor: null });
    if (path.startsWith("/api/agents"))
      return Response.json({ agents: [NOE, PRIMA, SENDY] });
    return Response.json({ error: "Not here" }, { status: 404 });
  }) as typeof fetch;
  return calls;
}

const rootRoute = createRootRoute({ component: Outlet });
const authedRoute = createRoute({
  id: "/_authed",
  getParentRoute: () => rootRoute,
  component: Outlet,
});
const appRoute = createRoute({
  id: "/_app",
  getParentRoute: () => authedRoute,
  component: Outlet,
});
type ChannelNewWiring = Parameters<typeof ChannelNewRoute.update>[0] & {
  id: string;
  path: string;
  getParentRoute: () => typeof appRoute;
};
const testChannelNewRoute = ChannelNewRoute.update({
  id: "/channel/new",
  path: "/channel/new",
  getParentRoute: () => appRoute,
} as ChannelNewWiring);
type GroupNewWiring = Parameters<typeof GroupNewRoute.update>[0] & {
  id: string;
  path: string;
  getParentRoute: () => typeof appRoute;
};
const testGroupNewRoute = GroupNewRoute.update({
  id: "/group/new",
  path: "/group/new",
  getParentRoute: () => appRoute,
} as GroupNewWiring);
// The conversation routes, as stand-ins that say where the screen went.
const channelRoute = createRoute({
  path: "/channel/$channelId",
  getParentRoute: () => appRoute,
  validateSearch: botPanelSearchSchema,
  component: () => <p>The conversation</p>,
});
const groupRoute = createRoute({
  path: "/group/$channelId",
  getParentRoute: () => appRoute,
  component: () => <p>The group</p>,
});
const routeTree = rootRoute.addChildren([
  authedRoute.addChildren([
    appRoute.addChildren([
      testChannelNewRoute,
      testGroupNewRoute,
      channelRoute,
      groupRoute,
    ]),
  ]),
]);

function renderAt(url: string, queryClient = queryClientWith()) {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [url] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router, view, user: userEvent.setup({ document }) };
}

/**
 * Close the To: menu, the way moving on to the message does: while it is open, Base UI hides the
 * rest of the screen from assistive technology, the composer included.
 */
async function closeMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.keyboard("{Escape}");
}

/** Type into the composer the way `channel-new-first-run.test.tsx` does, then send. */
async function send(view: ReturnType<typeof render>, words: string) {
  const editor = (await view.findByRole("textbox", {
    name: "Message",
  })) as HTMLElement;
  await act(async () => {
    editor.focus();
    const caret = document.createRange();
    caret.selectNodeContents(editor);
    caret.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(caret);
    fireEvent.paste(editor, {
      clipboardData: {
        files: [],
        items: [],
        types: ["text/plain"],
        getData: (type: string) => (type === "text/plain" ? words : ""),
      },
    });
  });
  await act(async () => {
    fireEvent.click(view.getByLabelText("Send message"));
  });
}

/** The chips in the To: field, by the names on them. */
function chipNames() {
  return [...document.querySelectorAll('[data-slot="combobox-chip"]')].map(
    (chip) => chip.textContent?.trim(),
  );
}

/** "Add to group chat" on one Bot's row in the open menu. */
async function addToGroup(
  view: ReturnType<typeof render>,
  user: ReturnType<typeof userEvent.setup>,
  name: string,
) {
  const row = await view.findByRole("option", { name: new RegExp(name) });
  await user.click(
    within(row).getByRole("button", { name: "Add to group chat" }),
  );
}

test("compose=1 opens the menu with nobody preselected", async () => {
  serve();
  const { view } = renderAt("/channel/new?compose=1");

  const input = (await view.findByRole("combobox")) as HTMLInputElement;
  expect(input.value).toBe("");
  expect(input.getAttribute("placeholder")).toBe("Start a chat with…");
  // Open on its own, and nothing answered yet, so the composer has nobody to send to.
  await view.findByRole("button", { name: "Create new Bot" });
  expect(view.queryAllByRole("option", { selected: true })).toHaveLength(0);
});

test("the menu offers Create new Bot, then Create group chat, then every Bot", async () => {
  serve();
  const { view } = renderAt("/channel/new?compose=1");
  await view.findByRole("button", { name: "Create new Bot" });

  const popup = document.querySelector(
    '[data-slot="combobox-content"]',
  ) as HTMLElement;
  const rows = [
    ...popup.querySelectorAll('button[type="button"], [role="option"]'),
  ]
    .filter(
      (row) =>
        row.getAttribute("role") === "option" ||
        !row.closest('[role="option"]'),
    )
    .map((row) =>
      row.getAttribute("role") === "option"
        ? (row.textContent ?? "").replace("Add to group chat", "").trim()
        : row.textContent?.trim(),
    );
  expect(rows).toEqual([
    "Create new Bot",
    "Create group chat",
    "NoëAssistant",
    "Prima WorkspaceOps",
    "SendyEmail",
  ]);
});

test("Create new Bot makes one in a click and opens its conversation", async () => {
  const calls = serve();
  const { router, view, user } = renderAt("/channel/new?compose=1");

  await user.click(await view.findByRole("button", { name: "Create new Bot" }));

  expect(await view.findByText("The conversation")).toBeTruthy();
  expect(router.state.location.pathname).toBe("/channel/channel_bot");
  expect(
    calls.filter(
      (call) => call.method === "POST" && call.path === "/api/agents",
    ),
  ).toEqual([{ method: "POST", path: "/api/agents", body: { quick: true } }]);
});

test("Add to group chat adds the Bot as a chip and switches to group mode", async () => {
  serve();
  const { view, user } = renderAt("/channel/new?compose=1");

  await addToGroup(view, user, "Prima Workspace");

  await waitFor(() => expect(chipNames()).toEqual(["Prima Workspace"]));
  const input = (await view.findByRole("combobox", {
    name: "Add Bots",
  })) as HTMLInputElement;
  expect(input.getAttribute("placeholder")).toBe("Add Bots…");
  // Picking another row adds to the chips rather than replacing them.
  await user.click(await view.findByRole("option", { name: /Sendy/ }));
  await waitFor(() =>
    expect(chipNames()).toEqual(["Prima Workspace", "Sendy"]),
  );
});

test("Create group chat starts group mode with no Bots yet", async () => {
  serve();
  const { view, user } = renderAt("/channel/new?compose=1");

  await user.click(
    await view.findByRole("button", { name: "Create group chat" }),
  );

  await view.findByRole("combobox", { name: "Add Bots" });
  expect(chipNames()).toEqual([]);
});

test("two or more Bots make a group on send, post the message there and open it", async () => {
  const calls = serve();
  const { router, view, user } = renderAt("/channel/new?compose=1");
  await addToGroup(view, user, "Prima Workspace");
  await user.click(await view.findByRole("option", { name: /Sendy/ }));
  await waitFor(() => expect(chipNames()).toHaveLength(2));
  await closeMenu(user);

  await send(view, "Plan the launch");

  expect(await view.findByText("The group")).toBeTruthy();
  expect(router.state.location.pathname).toBe("/group/channel_group");
  const posts = calls.filter((call) => call.method === "POST");
  expect(posts.find((call) => call.path === "/api/groups")?.body).toEqual({
    agentIds: [PRIMA.id, SENDY.id],
  });
  expect(
    posts.find((call) => call.path === "/api/groups/channel_group")?.body,
  ).toMatchObject({ text: "Plan the launch", agentId: null });
  expect(posts.some((call) => call.path === "/api/channels")).toBe(false);
});

test("one Bot in group mode is a direct conversation", async () => {
  const calls = serve();
  const { router, view, user } = renderAt("/channel/new?compose=1");
  await addToGroup(view, user, "Prima Workspace");
  await waitFor(() => expect(chipNames()).toEqual(["Prima Workspace"]));
  await closeMenu(user);

  await send(view, "Hello");

  expect(await view.findByText("The conversation")).toBeTruthy();
  expect(router.state.location.pathname).toBe("/channel/channel_dm");
  const posts = calls.filter((call) => call.method === "POST");
  expect(posts.find((call) => call.path === "/api/channels")?.body).toEqual({
    agentIds: [PRIMA.id],
  });
  expect(posts.some((call) => call.path.startsWith("/api/groups"))).toBe(false);
});

test("/group/new lands on the To: field in group mode", async () => {
  serve();
  const { router, view } = renderAt("/group/new");

  await view.findByRole("combobox", { name: "Add Bots" });
  expect(router.state.location.pathname).toBe("/channel/new");
  expect(router.state.location.search).toEqual({ compose: 1, group: 1 });
});

test("the first-run greeting still shows on a + screen", async () => {
  serve();
  const { view } = renderAt("/channel/new?compose=1", queryClientWith([]));

  expect(
    await view.findByText(/Type a message below to get started/),
  ).toBeTruthy();
});
