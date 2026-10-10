import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, render } from "@testing-library/react";
import { AppSidebar } from "@/components/app-sidebar/app-sidebar";
import { SidebarProvider } from "@/components/ui/sidebar";
import { agentKeys } from "@/lib/agents/queries";
import { authKeys } from "@/lib/auth/queries";
import { botLifecycleKeys } from "@/lib/bot-lifecycle/queries";
import { channelKeys } from "@/lib/channels/queries";
import { sectionKeys } from "@/lib/channels/sections";
import { deploymentKeys } from "@/lib/deployment/queries";
import { pluginKeys } from "@/lib/plugins/queries";
import { userPreferencesQueryOptions } from "@/lib/settings/message-list";

/**
 * The sidebar owns the app's one channel socket.
 *
 * `useChannelEvents` is mounted from `AppSidebar` and nowhere else, so the roster stays live for as
 * long as the shell is on screen. A redesign that dropped the hook would leave every roster row
 * frozen until a reload; one that mounted it twice would double every patch. This pins "exactly
 * once", and that the sidebar re-rendering does not open another.
 */

/** A socket that records its URL and never connects. */
class RecordingWebSocket extends EventTarget implements WebSocket {
  static opened: string[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  binaryType: BinaryType = "blob";
  bufferedAmount = 0;
  extensions = "";
  protocol = "";
  readyState = 0;
  onclose: WebSocket["onclose"] = null;
  onerror: WebSocket["onerror"] = null;
  onmessage: WebSocket["onmessage"] = null;
  onopen: WebSocket["onopen"] = null;
  readonly url: string;
  constructor(url: string | URL) {
    super();
    this.url = String(url);
    RecordingWebSocket.opened.push(this.url);
  }
  close() {}
  send() {}
}

let originalFetch: typeof fetch;
let originalWebSocket: typeof WebSocket;
const clients: QueryClient[] = [];

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost:3010" });
  originalFetch = globalThis.fetch;
  originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = RecordingWebSocket;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      throw new Error(`Unexpected request ${String(input)}`);
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  cleanup();
  for (const client of clients) client.clear();
  clients.length = 0;
  RecordingWebSocket.opened.length = 0;
});
afterAll(() => {
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = originalWebSocket;
  GlobalRegistrator.unregister();
});

function renderSidebar() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  clients.push(queryClient);
  queryClient.setQueryData(userPreferencesQueryOptions("user").queryKey, {
    messageListEmphasis: "agent",
    selfHostBannerDismissed: false,
  });
  queryClient.setQueryData(authKeys.currentUser(), {
    id: "user",
    email: "user@example.com",
    role: "user",
    onboarding: null,
  });
  queryClient.setQueryData(agentKeys.list(false), []);
  queryClient.setQueryDefaults(botLifecycleKeys.attention, {
    refetchInterval: false,
  });
  queryClient.setQueryData(botLifecycleKeys.attention, []);
  queryClient.setQueryData(pluginKeys.connections(), {
    connections: [],
    redirectUri: null,
  });
  queryClient.setQueryData(pluginKeys.page(), {
    catalogue: [],
    servers: [],
    skills: [],
    botsMayCallBack: false,
    redirectUri: null,
    composioConfigured: false,
  });
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: false,
    selfHostBanner: false,
  });
  queryClient.setQueryData(channelKeys.list(), {
    pages: [{ channels: [], nextCursor: null }],
    pageParams: [""],
  });
  queryClient.setQueryData(sectionKeys.all, []);
  const routeTree = createRootRoute({
    component: () => (
      <SidebarProvider>
        <AppSidebar />
      </SidebarProvider>
    ),
  });
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

test("the sidebar opens the channel events socket exactly once", async () => {
  const view = renderSidebar();
  await view.findByText("You don't have channels yet");
  expect(RecordingWebSocket.opened).toHaveLength(1);
  expect(RecordingWebSocket.opened[0]?.endsWith("/api/channels/events")).toBe(
    true,
  );

  // A re-render of the sidebar (the search popup opening) must not open a second socket.
  await act(async () => {
    view.getByRole("button", { name: "Search" }).click();
  });
  expect(
    await view.findByRole("combobox", { name: "Search Bots and Settings" }),
  ).toBeTruthy();
  expect(RecordingWebSocket.opened).toHaveLength(1);
});

test("the header and footer carry the redesign's controls and nothing of the old nav", async () => {
  const view = renderSidebar();
  await view.findByText("You don't have channels yet");
  // Base UI's Button gives a Link drawn through it `role="button"`; the href is what matters, and
  // `compose` is how the + asks who the conversation is with rather than preselecting a Bot.
  expect(
    view.getByRole("button", { name: "New chat" }).getAttribute("href"),
  ).toBe("/channel/new?compose=1");
  expect(view.getByRole("button", { name: "Account menu" })).toBeTruthy();
  // A real link, announced as one: it opens a page.
  expect(
    view.getByRole("link", { name: /Connect apps/ }).getAttribute("href"),
  ).toBe("/marketplace");
  for (const old of ["Bots", "Skills", "Agents", "Team Bots", "Memory"]) {
    expect(view.queryByRole("link", { name: old })).toBeNull();
  }
});
