import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  redirect,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { Channel } from "@/components/app-sidebar/channel";
import { ASSISTANT_AGENT_ID } from "@/lib/agents/default-agent";
import { LAST_BOT_STORAGE_KEY, readLastBot } from "@/lib/agents/last-bot";
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";
import {
  type ChannelSummary,
  channelKeys,
  channelListQueryOptions,
} from "@/lib/channels/queries";
import { landingTarget } from "@/lib/landing";

/**
 * Deleting the conversation on screen has to leave it — and not come straight back.
 *
 * The row navigates away before the DELETE is sent, so that the person is not left looking at a
 * conversation that no longer exists. But home is no longer a composer: `/` redirects to a
 * conversation picked from the cached roster, and at that moment the roster still holds the
 * channel being deleted, which is also the newest one with the Bot the channel route just
 * recorded. Navigating to `/` therefore bounced back into the very conversation being deleted.
 * These tests mount a `/` that redirects the way the real one does, from the stale cache, so a
 * row that goes there instead of choosing its own destination lands on the deleted channel.
 */

let originalFetch: typeof fetch;
const requests: { url: string; method: string | undefined }[] = [];
const clients: QueryClient[] = [];

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost:3010" });
  originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, method: init?.method });
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      // The roster refetch after a delete, for whoever asks: nothing left.
      return Response.json({ channels: [], nextCursor: null });
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  cleanup();
  // The roster refetch the delete queues must not outlive the file: a query still settling after
  // the window is gone schedules React work against a `window` that no longer exists.
  for (const client of clients) client.clear();
  clients.length = 0;
  requests.length = 0;
  window.localStorage.clear();
});
afterAll(async () => {
  // Let whatever React scheduled in the last commit run while there is still a DOM to run it in.
  await new Promise((resolve) => setTimeout(resolve, 0));
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

function agent(id: string): AgentProfile {
  return {
    id,
    name: id,
    title: "",
    roleDescription: "",
    avatarSeed: id,
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
function channel(id: string, agentIds: string[]): ChannelSummary {
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
  };
}

/** The row for `open`, mounted on that channel's own route with the roster given in the cache. */
function mount(open: ChannelSummary, roster: ChannelSummary[]) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  clients.push(queryClient);
  queryClient.setQueryData(agentKeys.list(false), [agent(ASSISTANT_AGENT_ID)]);
  queryClient.setQueryData(channelKeys.list(), {
    pages: [{ channels: roster, nextCursor: null }],
    pageParams: [""],
  });

  const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({
    component: () => (
      <>
        <Channel
          busy={false}
          channelId={open.id}
          emphasis="thread"
          name={open.name}
          participantIds={open.agentIds}
          pinned={false}
          unread={false}
        />
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
  // The same decision `routes/_authed/_app/index.tsx` makes, from the same cache: whatever the
  // roster holds when `/` is reached is where `/` sends you.
  const home = createRoute({
    path: "/",
    getParentRoute: () => rootRoute,
    beforeLoad: async ({ context }) => {
      const pages = await context.queryClient.ensureInfiniteQueryData(
        channelListQueryOptions(),
      );
      const target = landingTarget({
        lastBotId: readLastBot(),
        channels: pages.pages.flatMap((page) => page.channels),
        agents: context.queryClient.getQueryData(agentKeys.list(false)),
      });
      if (target) throw redirect({ ...target, replace: true });
    },
    component: () => <p>Home</p>,
  });
  const router = createRouter({
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: [`/channel/${open.id}`] }),
    routeTree: rootRoute.addChildren([
      home,
      page("/channel/new", "New chat"),
      page("/channel/$channelId", "Channel"),
    ]),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { view, router, queryClient };
}

/** Right-click the row, choose Delete, confirm. */
async function deleteFromMenu(view: ReturnType<typeof render>, name: string) {
  const row = await view.findByRole("link", { name: new RegExp(name) });
  fireEvent.contextMenu(row, { clientX: 10, clientY: 10 });
  fireEvent.click(
    await view.findByRole("menuitem", { name: /Delete channel/ }),
  );
  fireEvent.click(await view.findByRole("button", { name: "Delete" }));
}

test("deleting the open conversation lands on the Bot's next one, not back on itself", async () => {
  // The channel route recorded this Bot; its newest conversation is the one being deleted.
  window.localStorage.setItem(LAST_BOT_STORAGE_KEY, ASSISTANT_AGENT_ID);
  const newest = channel("newest", [ASSISTANT_AGENT_ID]);
  const older = channel("older", [ASSISTANT_AGENT_ID]);
  const { view, router } = mount(newest, [newest, older]);

  await deleteFromMenu(view, "newest");

  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/channel/older"),
  );
  await waitFor(() =>
    expect(requests).toContainEqual({
      url: "/api/channels/newest",
      method: "DELETE",
    }),
  );
  // Replaced, not pushed: Back must not reopen the conversation that was just deleted.
  expect(router.history.canGoBack()).toBe(false);
});

test("deleting the only conversation starts a fresh one with the default coworker", async () => {
  window.localStorage.setItem(LAST_BOT_STORAGE_KEY, ASSISTANT_AGENT_ID);
  const only = channel("only", [ASSISTANT_AGENT_ID]);
  const { view, router } = mount(only, [only]);

  await deleteFromMenu(view, "only");

  await waitFor(() => {
    expect(router.state.location.pathname).toBe("/channel/new");
    expect(router.state.location.search).toEqual({
      agent: ASSISTANT_AGENT_ID,
    });
  });
  expect(router.history.canGoBack()).toBe(false);
});
