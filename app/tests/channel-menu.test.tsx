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
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Channel } from "@/components/app-sidebar/channel";
import { Toaster } from "@/components/ui/toast";
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";
import {
  type ChannelPage,
  type ChannelSummary,
  channelKeys,
} from "@/lib/channels/queries";
import { sectionKeys } from "@/lib/channels/sections";
import { settleReactWork } from "./settle-react-work";

/**
 * A roster row's right-click menu: Grok Bot's items in Grok Bot's order, and each one doing what it
 * says — to the server, and to the cached roster the sidebar draws from.
 */

type SeenRequest = { method: string; url: string; body: unknown };
const requests: SeenRequest[] = [];
const clients: QueryClient[] = [];
let originalFetch: typeof fetch;

const BOT: AgentProfile = {
  id: "bot",
  name: "Expense Manager",
  title: "Finance Operations",
  roleDescription: "Review receipts.",
  avatarSeed: "bot",
  visibility: "private",
  endpoint: null,
  builtIn: true,
  hasAuth: false,
  hasCallbackToken: false,
  hidden: false,
  pinned: false,
  systemOwned: false,
  canManage: true,
  mine: true,
};

function row(details: Partial<ChannelSummary> = {}): ChannelSummary {
  return {
    id: "chat-1",
    name: "Expense Manager",
    agentIds: ["bot"],
    threadId: "thread-1",
    active: true,
    lastMessageAt: "2026-10-01T10:00:00.000Z",
    summary: "Receipts for September",
    lastMessage: "Filed them.",
    lastMessageAgentId: "bot",
    createdAt: "2026-10-01T09:00:00.000Z",
    pinned: false,
    lastReadAt: "2026-10-01T10:00:00.000Z",
    hiddenAt: null,
    sectionId: null,
    ...details,
  };
}

/** What the fake server answers, by method and path. Anything else is a test that went astray. */
function answer(method: string, url: string, body: unknown): Response {
  if (method === "GET" && url === "/api/agents/bot") {
    return Response.json({ agent: BOT });
  }
  if (method === "PATCH" && url === "/api/agents/bot") {
    return Response.json({ agent: { ...BOT, ...(body as object) } });
  }
  if (method === "GET" && url.startsWith("/api/agents")) {
    return Response.json({ agents: [BOT] });
  }
  if (method === "GET" && url.startsWith("/api/channels/sections")) {
    return Response.json({ sections: [] });
  }
  if (method === "POST" && url === "/api/channels/sections") {
    return Response.json(
      {
        section: {
          id: "section-new",
          name: (body as { name: string }).name,
          position: 1,
        },
      },
      { status: 201 },
    );
  }
  if (method === "GET" && url.startsWith("/api/channels")) {
    return Response.json({ channels: [], nextCursor: null });
  }
  if (method === "PUT" && url.endsWith("/hidden")) {
    return Response.json({ hiddenAt: "2026-10-01T12:00:00.000Z" });
  }
  if (method === "PUT" && url.endsWith("/section")) {
    return Response.json(body);
  }
  if (method === "PUT" && url.endsWith("/pin")) {
    return Response.json(body);
  }
  if (method === "PUT") return new Response(null, { status: 204 });
  throw new Error(`Unexpected request ${method} ${url}`);
}

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost:3010" });
  originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ method, url, body });
      return answer(method, url, body);
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  cleanup();
  for (const client of clients) client.clear();
  clients.length = 0;
  requests.length = 0;
});
afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

function mount(
  channel: ChannelSummary,
  options: { unread?: boolean; open?: boolean } = {},
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  clients.push(queryClient);
  queryClient.setQueryData(agentKeys.list(false), [BOT]);
  queryClient.setQueryData(channelKeys.list(), {
    pages: [{ channels: [channel], nextCursor: null }],
    pageParams: [""],
  });
  queryClient.setQueryData(sectionKeys.all, [
    { id: "section-work", name: "Work", position: 0 },
  ]);

  const rootRoute = createRootRoute({
    component: () => (
      <>
        <Channel
          busy={false}
          canMarkUnread={
            channel.lastMessageAgentId !== null &&
            channel.lastMessageAt !== null
          }
          channelId={channel.id}
          emphasis="thread"
          name={channel.name}
          participantIds={channel.agentIds}
          pinned={channel.pinned}
          sectionId={channel.sectionId ?? null}
          summary={channel.summary ?? undefined}
          unread={options.unread ?? false}
        />
        <Outlet />
        <Toaster />
      </>
    ),
  });
  const page = (path: string) =>
    createRoute({
      path,
      getParentRoute: () => rootRoute,
      component: () => <p>{path}</p>,
    });
  const router = createRouter({
    history: createMemoryHistory({
      initialEntries: [options.open ? `/channel/${channel.id}` : "/"],
    }),
    routeTree: rootRoute.addChildren([
      page("/"),
      page("/channel/new"),
      page("/channel/$channelId"),
      page("/group/$channelId"),
    ]),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  const user = userEvent.setup({ document: view.container.ownerDocument });
  /** The row as the roster cache holds it now. */
  const cached = () =>
    queryClient
      .getQueryData<{ pages: ChannelPage[] }>(channelKeys.list())
      ?.pages[0]?.channels.find((entry) => entry.id === channel.id);
  return { view, user, router, queryClient, cached };
}

/** Right-click the row and hand back the menu it opened. */
async function openMenu(view: ReturnType<typeof render>, name: string) {
  const link = await view.findByRole("link", { name: new RegExp(name) });
  fireEvent.contextMenu(link, { clientX: 10, clientY: 10 });
  return view.findByRole("menu");
}

/** The menu read top to bottom, items by their text and separators as a rule. */
function menuOutline(menu: HTMLElement) {
  return [
    ...menu.querySelectorAll('[role="menuitem"], [role="separator"]'),
  ].map((element) =>
    element.getAttribute("role") === "separator"
      ? "—"
      : (element.textContent ?? "").trim(),
  );
}

/**
 * Choose an item in the submenu with a bare click. A full pointer sequence from user-event leaves
 * the submenu's trigger on the way, and with every coordinate at zero in happy-dom the submenu reads
 * that as the pointer heading elsewhere and closes before the click lands.
 */
function pick(item: HTMLElement) {
  fireEvent.click(item);
}

const request = (method: string, url: string) =>
  requests.find((seen) => seen.method === method && seen.url === url);

test("a Bot's own conversation offers Grok Bot's items, in Grok Bot's order", async () => {
  const { view } = mount(row());

  const menu = await openMenu(view, "Expense Manager");

  expect(menuOutline(menu)).toEqual([
    "Pin",
    "Move to new section",
    "Mark as Unread",
    "—",
    "Rename Bot",
    "—",
    "Copy conversation ID",
    "—",
    "Hide from sidebar",
    "Delete",
  ]);
  const remove = view.getByRole("menuitem", { name: "Delete" });
  expect(remove.getAttribute("data-variant")).toBe("destructive");
});

test("a group conversation has no Bot to rename, and a pinned one offers Unpin", async () => {
  const { view } = mount(row({ agentIds: ["bot", "other"], pinned: true }));

  const menu = await openMenu(view, "Expense Manager");

  expect(menuOutline(menu)).toEqual([
    "Unpin",
    "Move to new section",
    "Mark as Unread",
    "—",
    "Copy conversation ID",
    "—",
    "Hide from sidebar",
    "Delete",
  ]);
});

test("Mark as Unread moves the marker to just before the Bot's last message", async () => {
  const { view, user, cached } = mount(row());

  await openMenu(view, "Expense Manager");
  await user.click(view.getByRole("menuitem", { name: "Mark as Unread" }));

  await waitFor(() =>
    expect(request("PUT", "/api/channels/chat-1/unread")).toBeTruthy(),
  );
  expect(cached()?.lastReadAt).toBe("2026-10-01T09:59:59.999Z");
});

test("Mark as Unread is greyed out when the person spoke last", async () => {
  const { view } = mount(row({ lastMessageAgentId: null }));

  await openMenu(view, "Expense Manager");

  const item = view.getByRole("menuitem", { name: "Mark as Unread" });
  expect(item.getAttribute("aria-disabled")).toBe("true");
});

test("an unread row offers Mark as Read instead", async () => {
  const { view, user } = mount(row({ lastReadAt: null }), { unread: true });

  await openMenu(view, "Expense Manager");
  await user.click(view.getByRole("menuitem", { name: "Mark as Read" }));

  await waitFor(() =>
    expect(request("PUT", "/api/channels/chat-1/read")).toBeTruthy(),
  );
});

test("marking the open conversation unread leaves it first, or it would read itself again", async () => {
  const { view, user, router } = mount(row(), { open: true });

  await openMenu(view, "Expense Manager");
  await user.click(view.getByRole("menuitem", { name: "Mark as Unread" }));

  await waitFor(() =>
    expect(request("PUT", "/api/channels/chat-1/unread")).toBeTruthy(),
  );
  expect(router.state.location.pathname).not.toBe("/channel/chat-1");
});

test("Copy conversation ID copies the id and says so", async () => {
  const { view, user } = mount(row());

  await openMenu(view, "Expense Manager");
  await user.click(
    view.getByRole("menuitem", { name: "Copy conversation ID" }),
  );

  // user-event puts a clipboard of its own on `navigator` for the test, and this reads it back.
  await waitFor(async () =>
    expect(await navigator.clipboard.readText()).toBe("chat-1"),
  );
  expect(await view.findByText("Conversation ID copied")).toBeTruthy();
});

test("Hide from sidebar stamps the row and asks the server to", async () => {
  const { view, user, cached } = mount(row());

  await openMenu(view, "Expense Manager");
  await user.click(view.getByRole("menuitem", { name: "Hide from sidebar" }));

  await waitFor(() =>
    expect(request("PUT", "/api/channels/chat-1/hidden")?.body).toEqual({
      hidden: true,
    }),
  );
  await waitFor(() =>
    expect(cached()?.hiddenAt).toBe("2026-10-01T12:00:00.000Z"),
  );
});

test("Move to new section files the chat under an existing section", async () => {
  const { view, user, cached } = mount(row());

  await openMenu(view, "Expense Manager");
  await user.click(view.getByRole("menuitem", { name: "Move to new section" }));
  pick(await view.findByRole("menuitem", { name: "Work" }));

  await waitFor(() =>
    expect(request("PUT", "/api/channels/chat-1/section")?.body).toEqual({
      sectionId: "section-work",
    }),
  );
  expect(cached()?.sectionId).toBe("section-work");
});

test("New section… asks for a name, creates it, and moves the chat into it", async () => {
  const { view, user, cached } = mount(row());

  await openMenu(view, "Expense Manager");
  await user.click(view.getByRole("menuitem", { name: "Move to new section" }));
  pick(await view.findByRole("menuitem", { name: "New section…" }));
  await user.type(
    await view.findByRole("textbox", { name: "Section name" }),
    "Clients",
  );
  await user.click(view.getByRole("button", { name: "Create" }));

  await waitFor(() =>
    expect(request("PUT", "/api/channels/chat-1/section")?.body).toEqual({
      sectionId: "section-new",
    }),
  );
  expect(request("POST", "/api/channels/sections")?.body).toEqual({
    name: "Clients",
  });
  expect(cached()?.sectionId).toBe("section-new");
});

test("a chat in a section can be taken out of it", async () => {
  const { view, user, cached } = mount(row({ sectionId: "section-work" }));

  await openMenu(view, "Expense Manager");
  await user.click(view.getByRole("menuitem", { name: "Move to new section" }));
  // Where it is now is shown, and not offered as a move.
  const current = await view.findByRole("menuitem", { name: /Work/ });
  expect(current.getAttribute("aria-disabled")).toBe("true");
  pick(view.getByRole("menuitem", { name: "Remove from section" }));

  await waitFor(() =>
    expect(request("PUT", "/api/channels/chat-1/section")?.body).toEqual({
      sectionId: null,
    }),
  );
  expect(cached()?.sectionId).toBeNull();
});

test("Rename Bot saves the new name over the rest of the Bot's profile", async () => {
  const { view, user } = mount(row());

  await openMenu(view, "Expense Manager");
  await user.click(view.getByRole("menuitem", { name: "Rename Bot" }));
  const field = await view.findByRole("textbox", { name: "Bot name" });
  expect((field as HTMLInputElement).value).toBe("Expense Manager");
  await user.clear(field);
  await user.type(field, "Receipts");
  await user.click(view.getByRole("button", { name: "Rename" }));

  await waitFor(() =>
    expect(request("PATCH", "/api/agents/bot")?.body).toEqual({
      name: "Receipts",
      title: "Finance Operations",
      roleDescription: "Review receipts.",
      visibility: "private",
      endpoint: "",
    }),
  );
  await waitFor(() =>
    expect(view.queryByRole("textbox", { name: "Bot name" })).toBeNull(),
  );
});

test("a refused action is said on the row", async () => {
  const { view, user } = mount(row());
  const pinRefused = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "PUT"
        ? Response.json({ error: "Channel not found." }, { status: 404 })
        : pinRefused(input, init),
    { preconnect: originalFetch.preconnect },
  );
  try {
    await openMenu(view, "Expense Manager");
    await user.click(view.getByRole("menuitem", { name: "Pin" }));
    expect((await view.findByRole("alert")).textContent).toBe(
      "Channel not found.",
    );
  } finally {
    globalThis.fetch = pinRefused;
  }
});
