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
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";
import { botPanelSearchSchema } from "@/lib/bot-panel";
import {
  type AgentChannel,
  type ChannelSummary,
  channelKeys,
} from "@/lib/channels/queries";
import { Route as ChannelNewRoute } from "@/routes/_authed/_app/channel/new";
import { settleReactWork } from "./settle-react-work";

/**
 * The first thing a brand-new person sees after onboarding: `/channel/new` with the default Bot
 * and nothing said yet. Somebody with no conversations at all is greeted by the Bot, locally, and
 * their first send opens the new conversation on the Computer tab, where the Bot's browser starts.
 * Anybody with a conversation already is never greeted, and their send opens the channel plainly.
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

const GREETING = /Type a message below to get started/;

const NOE: AgentProfile = {
  avatarSeed: "seed",
  builtIn: true,
  canManage: true,
  endpoint: null,
  hasAuth: false,
  hasCallbackToken: false,
  hidden: false,
  id: "noe",
  mine: true,
  name: "Noë",
  pinned: false,
  roleDescription: "Helps with everything.",
  systemOwned: false,
  title: "Assistant",
  visibility: "private",
};

const CREATED: AgentChannel = {
  id: "channel_new",
  name: "Noë",
  agentIds: [NOE.id],
  threadId: "thread_new",
  active: true,
  lastMessageAt: null,
};

function summary(id: string): ChannelSummary {
  return {
    ...CREATED,
    id,
    threadId: `thread_${id}`,
    summary: null,
    lastMessage: null,
    lastMessageAgentId: null,
    createdAt: "2026-10-09T09:00:00Z",
    pinned: false,
    lastReadAt: null,
  };
}

function queryClientWith(channels: ChannelSummary[]) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  queryClient.setQueryData(agentKeys.list(false), [NOE]);
  queryClient.setQueryData(channelKeys.list(), {
    pages: [{ channels, nextCursor: null }],
    pageParams: [""],
  });
  return queryClient;
}

/**
 * The server, as far as a first send reaches it. Creating the channel waits for the test to let it
 * finish, so what the screen shows between the send and the navigation can be looked at.
 */
function serve() {
  let finishCreate: (() => void) | undefined;
  const created = new Promise<void>((resolve) => {
    finishCreate = resolve;
  });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    if (path === "/api/route" && method === "POST")
      return Response.json({ agentId: NOE.id });
    if (path === "/api/channels" && method === "POST") {
      await created;
      return Response.json({ channel: CREATED });
    }
    if (path === "/api/channels")
      return Response.json({
        channels: [summary(CREATED.id)],
        nextCursor: null,
      });
    return Response.json({ error: "Not here" }, { status: 404 });
  }) as typeof fetch;
  return { finishCreate: () => finishCreate?.() };
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
type TestFileRouteWiring = Parameters<typeof ChannelNewRoute.update>[0] & {
  id: string;
  path: string;
  getParentRoute: () => typeof appRoute;
};
const testChannelNewRoute = ChannelNewRoute.update({
  id: "/channel/new",
  path: "/channel/new",
  getParentRoute: () => appRoute,
} as TestFileRouteWiring);
// The conversation route's own search validation, with a stand-in for everything it draws.
const channelRoute = createRoute({
  path: "/channel/$channelId",
  getParentRoute: () => appRoute,
  validateSearch: botPanelSearchSchema,
  component: () => <p>The new conversation</p>,
});
const routeTree = rootRoute.addChildren([
  authedRoute.addChildren([
    appRoute.addChildren([testChannelNewRoute, channelRoute]),
  ]),
]);

function renderChannelNew(queryClient: QueryClient) {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({
      initialEntries: [`/channel/new?agent=${NOE.id}`],
    }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router, view };
}

/** Type into the composer the way `composer-send-failure.test.tsx` does: a plain-text paste. */
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

test("somebody with no conversations is greeted by the Bot", async () => {
  serve();
  const { view } = renderChannelNew(queryClientWith([]));

  const greeting = await view.findByText(GREETING);
  expect(greeting.textContent).toBe(
    "Hi, I'm Noë Bot. Type a message below to get started — I'll start my computer, and you can watch it work in the panel on the right.",
  );
  // Drawn as the Bot's message, on the Bot's side of the transcript, not as the person's bubble.
  const row = greeting.closest('[data-slot="message"]');
  expect(row?.getAttribute("data-align")).toBe("start");
  expect(
    greeting.closest('[data-slot="bubble"]')?.getAttribute("data-variant"),
  ).toBe("ghost");
});

test("somebody with a conversation already is never greeted", async () => {
  serve();
  const { view } = renderChannelNew(queryClientWith([summary("channel_old")]));

  // The composer being there means the screen has drawn; the greeting still is not.
  await view.findByRole("textbox", { name: "Message" });
  expect(view.queryByText(GREETING)).toBeNull();
});

test("nobody is greeted before their conversations have loaded", async () => {
  globalThis.fetch = (() => new Promise<Response>(() => undefined)) as never;
  const queryClient = queryClientWith([]);
  queryClient.removeQueries({ queryKey: channelKeys.list() });
  const { view } = renderChannelNew(queryClient);

  await view.findByRole("textbox", { name: "Message" });
  expect(view.queryByText(GREETING)).toBeNull();
});

test("the greeting goes once the person sends, and the conversation opens on the Computer tab", async () => {
  const server = serve();
  const { router, view } = renderChannelNew(queryClientWith([]));
  await view.findByText(GREETING);

  await send(view, "Find me a flight to Athens");

  // Between the send and the channel existing: their words are there and the greeting is not.
  expect(await view.findByText("Find me a flight to Athens")).toBeTruthy();
  expect(view.queryByText(GREETING)).toBeNull();

  await act(async () => server.finishCreate());

  expect(await view.findByText("The new conversation")).toBeTruthy();
  expect(router.state.location.pathname).toBe(`/channel/${CREATED.id}`);
  expect(router.state.location.search).toEqual({ panel: "computer" });
});

test("a send from somebody with conversations opens the channel plainly", async () => {
  const server = serve();
  const { router, view } = renderChannelNew(
    queryClientWith([summary("channel_old")]),
  );

  await send(view, "Find me a flight to Athens");
  await act(async () => server.finishCreate());

  expect(await view.findByText("The new conversation")).toBeTruthy();
  expect(router.state.location.pathname).toBe(`/channel/${CREATED.id}`);
  expect(router.state.location.search).toEqual({});
});
