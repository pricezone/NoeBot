import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
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
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  AppSidebar,
  isHiddenFromSidebar,
  sidebarRoster,
} from "@/components/app-sidebar/app-sidebar";
import { COLLAPSED_SECTIONS_STORAGE_KEY } from "@/components/app-sidebar/collapsed-sections";
import { SidebarProvider } from "@/components/ui/sidebar";
import { agentKeys } from "@/lib/agents/queries";
import { authKeys } from "@/lib/auth/queries";
import { botLifecycleKeys } from "@/lib/bot-lifecycle/queries";
import {
  type ChannelPage,
  type ChannelSummary,
  channelKeys,
} from "@/lib/channels/queries";
import { type SidebarSection, sectionKeys } from "@/lib/channels/sections";
import { applyChannelEvent } from "@/lib/channels/use-channel-events";
import { deploymentKeys } from "@/lib/deployment/queries";
import { formatHotkey, getHotkey } from "@/lib/hotkeys/hotkeys";
import { pluginKeys } from "@/lib/plugins/queries";
import { userPreferencesQueryOptions } from "@/lib/settings/message-list";
import { settleReactWork } from "./settle-react-work";

/**
 * The sidebar's sections and hidden chats: pinned rows on top, each section's heading with its
 * chats under it, the rest after a rule, and hidden rows nowhere until somebody speaks in them.
 */

/** A socket that never connects, so the roster is exactly what each test seeds. */
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

type SeenRequest = { method: string; url: string; body: unknown };
const requests: SeenRequest[] = [];
const clients: QueryClient[] = [];
let originalFetch: typeof fetch;
let originalWebSocket: typeof WebSocket;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost:3010" });
  originalFetch = globalThis.fetch;
  originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = OfflineWebSocket;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ method, url, body });
      if (method === "PATCH") {
        return Response.json({
          section: { id: url.split("/").at(-1), name: body.name, position: 0 },
        });
      }
      if (method === "DELETE") return new Response(null, { status: 204 });
      throw new Error(`Unexpected request ${method} ${url}`);
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  cleanup();
  for (const client of clients) client.clear();
  clients.length = 0;
  requests.length = 0;
  window.localStorage.clear();
});
afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = originalWebSocket;
  GlobalRegistrator.unregister();
});

function channel(
  id: string,
  details: Partial<ChannelSummary> = {},
): ChannelSummary {
  return {
    id,
    name: id,
    agentIds: ["bot"],
    threadId: `thread-${id}`,
    active: true,
    lastMessageAt: "2026-10-01T10:00:00.000Z",
    summary: null,
    lastMessage: null,
    lastMessageAgentId: null,
    createdAt: "2026-10-01T09:00:00.000Z",
    pinned: false,
    lastReadAt: null,
    hiddenAt: null,
    sectionId: null,
    ...details,
  };
}

const WORK: SidebarSection = { id: "work", name: "Work", position: 0 };
const HOME: SidebarSection = { id: "home", name: "Home", position: 1 };
const LATER: SidebarSection = { id: "later", name: "Later", position: 2 };

const ROSTER = [
  channel("Pinned at work", { pinned: true, sectionId: "work" }),
  channel("Payroll", { sectionId: "work" }),
  channel("Groceries", { sectionId: "home" }),
  channel("Loose chat"),
  channel("Filed under a deleted section", { sectionId: "gone" }),
  channel("Tidied away", { hiddenAt: "2026-10-01T10:00:00.000Z" }),
];

describe("the roster's rules", () => {
  test("a hidden row stays hidden until something newer than the stamp is said", () => {
    const hidden = channel("x", { hiddenAt: "2026-10-01T10:00:00.000Z" });
    expect(isHiddenFromSidebar(hidden)).toBe(true);
    expect(
      isHiddenFromSidebar({
        ...hidden,
        lastMessageAt: "2026-10-01T10:00:00.001Z",
      }),
    ).toBe(false);
    expect(isHiddenFromSidebar({ ...hidden, lastMessageAt: null })).toBe(true);
    expect(isHiddenFromSidebar(channel("y"))).toBe(false);
  });

  test("pinned on top whatever its section, then each section, then the rest", () => {
    const roster = sidebarRoster(ROSTER, [WORK, HOME, LATER]);

    expect(roster.pinned.map((row) => row.id)).toEqual(["Pinned at work"]);
    expect(
      roster.sections.map(({ section, channels }) => [
        section.id,
        channels.map((row) => row.id),
      ]),
    ).toEqual([
      ["work", ["Payroll"]],
      ["home", ["Groceries"]],
      ["later", []],
    ]);
    // A section this sidebar does not know is no reason to lose the chat.
    expect(roster.ungrouped.map((row) => row.id)).toEqual([
      "Loose chat",
      "Filed under a deleted section",
    ]);
  });

  test("the socket's hide and section events patch only their own field", () => {
    const data = {
      pages: [{ channels: [channel("a"), channel("b")], nextCursor: null }],
      pageParams: [""],
    };
    const quiet = {
      channelId: "a",
      lastMessage: null,
      lastMessageAt: null,
      lastMessageAgentId: null,
    };

    const hidden = applyChannelEvent(data, {
      ...quiet,
      hiddenAt: "2026-10-02T00:00:00.000Z",
    });
    if (hidden === "unknown") throw new Error("expected a patch");
    expect(hidden.pages[0]?.channels[0]).toEqual({
      ...channel("a"),
      hiddenAt: "2026-10-02T00:00:00.000Z",
    });
    // The other row is the very same object, so it does not re-render.
    expect(hidden.pages[0]?.channels[1]).toBe(data.pages[0]?.channels[1]);

    const filed = applyChannelEvent(data, { ...quiet, sectionId: "work" });
    if (filed === "unknown") throw new Error("expected a patch");
    expect(filed.pages[0]?.channels[0]?.sectionId).toBe("work");
    // Already so: nothing changes, not even the cache's identity.
    expect(applyChannelEvent(data, { ...quiet, sectionId: null })).toBe(data);
  });
});

function renderSidebar(sections: SidebarSection[] = [WORK, HOME, LATER]) {
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
    pages: [{ channels: ROSTER, nextCursor: null }],
    pageParams: [""],
  });
  queryClient.setQueryData(sectionKeys.all, sections);
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => (
        <SidebarProvider>
          <AppSidebar />
        </SidebarProvider>
      ),
    }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  const user = userEvent.setup({ document: view.container.ownerDocument });
  return { view, user, queryClient };
}

/**
 * The roster as drawn, top to bottom: section headings as `# name`, the rule as `—`, rows by name.
 * Read off the DOM in document order, so it is the order a person sees.
 */
function drawnRoster(container: HTMLElement) {
  return [
    ...container.querySelectorAll(
      [
        // The heading's fold button, not its options menu, which is a button with a popup.
        '[data-testid="sidebar-section"] button[aria-expanded]:not([aria-haspopup])',
        // Conversations, not the header's new-chat button.
        'a[href^="/channel/"]:not([href^="/channel/new"])',
        ".bg-border.h-px",
      ].join(", "),
    ),
  ].map((element) => {
    if (element.tagName === "A") {
      return (
        element.querySelector("[title]")?.getAttribute("title") ?? "(untitled)"
      );
    }
    if (element.tagName === "BUTTON") return `# ${element.textContent}`;
    return "—";
  });
}

describe("the sidebar", () => {
  test("draws pinned rows, then each section with its chats, then a rule and the rest", async () => {
    const { view } = renderSidebar();
    await view.findByText("Payroll");

    expect(drawnRoster(view.container)).toEqual([
      "Pinned at work",
      "# Work",
      "Payroll",
      "# Home",
      "Groceries",
      "# Later",
      "—",
      "Loose chat",
      "Filed under a deleted section",
    ]);
    expect(view.queryByText("Tidied away")).toBeNull();
    // An empty section says how to fill it rather than looking broken.
    expect(
      view.getByText(
        "Right-click a chat and choose “Move to new section” to file it here.",
      ),
    ).toBeTruthy();
  });

  test("no sections means no headings and no rule", async () => {
    const { view } = renderSidebar([]);
    await view.findByText("Payroll");

    expect(drawnRoster(view.container)).toEqual([
      "Pinned at work",
      "Payroll",
      "Groceries",
      "Loose chat",
      "Filed under a deleted section",
    ]);
  });

  test("a heading folds its chats away, and the fold is remembered in this browser", async () => {
    const { view, user } = renderSidebar();
    const heading = await view.findByRole("button", { name: "Work" });
    expect(heading.getAttribute("aria-expanded")).toBe("true");

    await user.click(heading);

    expect(heading.getAttribute("aria-expanded")).toBe("false");
    // The pinned one is on top, not in the section, so folding does not take it.
    expect(view.getByText("Pinned at work")).toBeTruthy();
    expect(
      JSON.parse(
        window.localStorage.getItem(COLLAPSED_SECTIONS_STORAGE_KEY) ?? "[]",
      ),
    ).toEqual(["work"]);

    /*
     * The rows under it leave through the roster's exit animation, which happy-dom never finishes,
     * so what is drawn is read from a sidebar mounted afresh: folded from the start, from storage.
     */
    cleanup();
    const again = renderSidebar();
    await again.view.findByText("Groceries");
    expect(again.view.queryByText("Payroll")).toBeNull();
    expect(
      again.view
        .getByRole("button", { name: "Work" })
        .getAttribute("aria-expanded"),
    ).toBe("false");
  });

  test("a section's own menu renames it", async () => {
    const { view, user } = renderSidebar();

    await user.click(
      await view.findByRole("button", { name: "Options for Home" }),
    );
    fireEvent.click(
      await view.findByRole("menuitem", { name: "Rename section…" }),
    );
    const field = await view.findByRole("textbox", { name: "Section name" });
    await user.clear(field);
    await user.type(field, "Household");
    await user.click(view.getByRole("button", { name: "Rename" }));

    await waitFor(() =>
      expect(requests).toContainEqual({
        method: "PATCH",
        url: "/api/channels/sections/home",
        body: { name: "Household" },
      }),
    );
    expect(await view.findByRole("button", { name: "Household" })).toBeTruthy();
  });

  test("deleting a section asks first, and its chats fall back into the main list", async () => {
    const { view, user, queryClient } = renderSidebar();

    await user.click(
      await view.findByRole("button", { name: "Options for Work" }),
    );
    fireEvent.click(
      await view.findByRole("menuitem", { name: "Delete section…" }),
    );
    expect(
      await view.findByText(
        "Its chats are not deleted. They move back to the main list.",
      ),
    ).toBeTruthy();
    await user.click(view.getByRole("button", { name: "Delete section" }));

    await waitFor(() =>
      expect(requests).toContainEqual({
        method: "DELETE",
        url: "/api/channels/sections/work",
        body: undefined,
      }),
    );
    // Read from the caches the sidebar draws from: the heading's exit animation never finishes
    // under happy-dom, and `sidebarRoster` above already pins how those caches are drawn.
    await waitFor(() =>
      expect(
        queryClient
          .getQueryData<SidebarSection[]>(sectionKeys.all)
          ?.map((section) => section.id),
      ).toEqual(["home", "later"]),
    );
    const rows = queryClient.getQueryData<{ pages: ChannelPage[] }>(
      channelKeys.list(),
    )?.pages[0]?.channels;
    expect(rows?.find((row) => row.id === "Payroll")?.sectionId).toBeNull();
    expect(
      rows?.find((row) => row.id === "Pinned at work")?.sectionId,
    ).toBeNull();
  });

  test("Mod+K opens the search, wherever focus is", async () => {
    const { view } = renderSidebar();
    await view.findByText("Payroll");
    const mod =
      formatHotkey(getHotkey("search").combo)[0] === "⌘"
        ? { metaKey: true }
        : { ctrlKey: true };

    fireEvent.keyDown(window, { key: "k", code: "KeyK", ...mod });

    expect(
      await view.findByRole("combobox", { name: "Search Bots and Settings" }),
    ).toBeTruthy();
  });
});
