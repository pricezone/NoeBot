import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppSidebar } from "@/components/app-sidebar/app-sidebar";
import { SidebarProvider } from "@/components/ui/sidebar";
import { agentKeys } from "@/lib/agents/queries";
import { authKeys } from "@/lib/auth/queries";
import { type ChannelSummary, channelKeys } from "@/lib/channels/queries";
import { sectionKeys } from "@/lib/channels/sections";
import { userPreferencesQueryOptions } from "@/lib/settings/message-list";
import { botLifecycleKeys } from "@/lib/bot-lifecycle/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { pluginKeys } from "@/lib/plugins/queries";

// Keep the sidebar's live-update socket offline; these tests exercise HTTP pagination.
class OfflineWebSocket extends EventTarget implements WebSocket {
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
  }
  close() {}
  send() {}
}

class ScrollObserver implements IntersectionObserver {
  static active = new Set<ScrollObserver>();
  readonly root;
  readonly rootMargin;
  readonly thresholds = [0];
  private targets = new Set<Element>();
  constructor(
    private callback: IntersectionObserverCallback,
    options: IntersectionObserverInit = {},
  ) {
    this.root = options.root ?? null;
    this.rootMargin = options.rootMargin ?? "0px";
    ScrollObserver.active.add(this);
  }
  observe(target: Element) {
    this.targets.add(target);
  }
  unobserve(target: Element) {
    this.targets.delete(target);
  }
  disconnect() {
    this.targets.clear();
    ScrollObserver.active.delete(this);
  }
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
  intersect(isIntersecting = true) {
    this.callback(
      [...this.targets].map((target) => ({
        target,
        isIntersecting,
        intersectionRatio: isIntersecting ? 1 : 0,
        boundingClientRect: target.getBoundingClientRect(),
        intersectionRect: target.getBoundingClientRect(),
        rootBounds: null,
        time: 0,
      })),
      this,
    );
  }
}

let originalFetch: typeof fetch;
let originalWebSocket: typeof WebSocket;
let originalObserver: typeof IntersectionObserver;
let respond: () => Promise<Response>;
const requests: string[] = [];
const clients: QueryClient[] = [];

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost:3010" });
  originalFetch = globalThis.fetch;
  originalWebSocket = globalThis.WebSocket;
  originalObserver = globalThis.IntersectionObserver;
  globalThis.WebSocket = OfflineWebSocket;
  globalThis.IntersectionObserver = ScrollObserver;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return respond();
    },
    { preconnect: originalFetch.preconnect },
  );
});
beforeEach(() => {
  requests.length = 0;
  respond = async () => {
    throw new Error("Unexpected request");
  };
});
afterEach(() => {
  cleanup();
  for (const client of clients) client.clear();
  clients.length = 0;
  expect(ScrollObserver.active.size).toBe(0);
});
afterAll(() => {
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = originalWebSocket;
  globalThis.IntersectionObserver = originalObserver;
  GlobalRegistrator.unregister();
});

function channel(id: string): ChannelSummary {
  return {
    id,
    name: id,
    agentIds: [],
    threadId: id,
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

function renderSidebar() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  clients.push(queryClient);
  queryClient.setQueryData(userPreferencesQueryOptions("user").queryKey, {
    messageListEmphasis: "thread",
    selfHostBannerDismissed: false,
  });
  queryClient.setQueryData(authKeys.currentUser(), {
    id: "user",
    email: "user@example.com",
    role: "user",
    onboarding: null,
  });
  queryClient.setQueryData(agentKeys.list(false), []);
  // The sidebar's attention list polls on its own schedule; this test counts channel requests only.
  queryClient.setQueryDefaults(botLifecycleKeys.attention, {
    staleTime: Number.POSITIVE_INFINITY,
    refetchInterval: false,
  });
  queryClient.setQueryData(botLifecycleKeys.attention, []);
  // The footer's Connect apps pill and account menu read these; seeded so the only requests the
  // fixture sees (and the only ones it answers) are the roster's own pages.
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
    pages: [
      { channels: [channel("Recent conversation")], nextCursor: "older/page" },
    ],
    pageParams: [""],
  });
  // Seeded like the rest, so the only requests the fixture sees are the roster's own pages.
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

function activeObserver() {
  const observer = [...ScrollObserver.active][0];
  if (!observer) throw new Error("No active pagination observer");
  return observer;
}

test("message emphasis updates mounted rows from the account preferences cache", async () => {
  const view = renderSidebar();
  const agent = await view.findByText("Recent conversation");
  const thread = view.getByText("New conversation");
  expect(thread.className).toContain("text-[15px]");
  act(() =>
    clients[0]?.setQueryData(userPreferencesQueryOptions("user").queryKey, {
      messageListEmphasis: "agent",
      selfHostBannerDismissed: false,
    }),
  );
  await waitFor(() => expect(agent.className).toContain("text-[15px]"));
  expect(thread.className).toContain("text-muted-foreground");
});

test("scrolling requests the cursor once, appends older rows, and stops at the final page", async () => {
  const pending = Promise.withResolvers<Response>();
  respond = () => pending.promise;
  const view = renderSidebar();
  expect(await view.findByText("Recent conversation")).toBeTruthy();
  expect(
    view.getByRole("button", { name: "Load older conversations" }),
  ).toBeTruthy();
  await waitFor(() => expect(ScrollObserver.active.size).toBe(1));
  const observer = activeObserver();
  expect(observer.root).toBe(
    view.container.querySelector('[data-sidebar="content"]'),
  );
  act(() => observer.intersect(false));
  expect(requests).toEqual([]);
  act(() => {
    observer.intersect();
    observer.intersect();
  });
  await view.findByRole("button", { name: "Loading older conversations…" });
  expect(requests).toEqual(["/api/channels?cursor=older%2Fpage"]);
  pending.resolve(
    Response.json({
      channels: [channel("Older conversation")],
      nextCursor: null,
    }),
  );
  expect(await view.findByText("Older conversation")).toBeTruthy();
  expect(view.getByText("Recent conversation")).toBeTruthy();
  expect(
    view.queryByRole("button", { name: "Load older conversations" }),
  ).toBeNull();
  expect(ScrollObserver.active.size).toBe(0);
});

test("a failed page preserves rows and waits for an explicit retry", async () => {
  respond = async () =>
    Response.json({ error: "Unavailable" }, { status: 503 });
  const view = renderSidebar();
  await view.findByText("Recent conversation");
  await waitFor(() => expect(ScrollObserver.active.size).toBe(1));
  act(() => activeObserver().intersect());
  expect(await view.findByRole("alert")).toHaveProperty(
    "textContent",
    "Could not load older conversations.",
  );
  expect(view.getByText("Recent conversation")).toBeTruthy();
  expect(ScrollObserver.active.size).toBe(0);
  expect(requests).toHaveLength(1);
  respond = async () =>
    Response.json({
      channels: [channel("Recovered conversation")],
      nextCursor: "last-page",
    });
  fireEvent.click(
    view.getByRole("button", { name: "Retry loading older conversations" }),
  );
  expect(await view.findByText("Recovered conversation")).toBeTruthy();
  expect(requests).toEqual([
    "/api/channels?cursor=older%2Fpage",
    "/api/channels?cursor=older%2Fpage",
  ]);
  await waitFor(() => expect(ScrollObserver.active.size).toBe(1));
  respond = async () =>
    Response.json({
      channels: [channel("Oldest conversation")],
      nextCursor: null,
    });
  act(() => activeObserver().intersect());
  expect(await view.findByText("Oldest conversation")).toBeTruthy();
  expect(requests.at(-1)).toBe("/api/channels?cursor=last-page");
});

test("the magnifier opens the search popup, which neither filters nor pages the roster", async () => {
  const view = renderSidebar();
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await view.findByText("Recent conversation");
  await user.click(view.getByRole("button", { name: "Search" }));
  const search = await view.findByRole("combobox", {
    name: "Search Bots and Settings",
  });
  await user.type(search, "Archived");
  // The search looks for Bots and settings; the roster under it stays whole and asks for nothing.
  expect(requests).toEqual([]);
  expect(view.getByText("Recent conversation")).toBeTruthy();
  // `hidden`: the popup is modal, so what is under it is out of the accessibility tree meanwhile.
  expect(
    view.getByRole("button", {
      name: "Load older conversations",
      hidden: true,
    }),
  ).toBeTruthy();
});
