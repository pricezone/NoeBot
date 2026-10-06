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
import { type ReactNode, useCallback } from "react";
import { BotPanel } from "@/components/bot-panel/bot-panel";
import { useBotPanel } from "@/components/bot-panel/use-bot-panel";
import { ChatHeader } from "@/components/chat/chat-header";
import { DetailPanel } from "@/components/layout/detail-panel";
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";
import {
  BOT_PANEL_STORAGE_KEY,
  type BotPanelTab,
  botPanelSearchSchema,
  parseStoredBotPanelOpen,
} from "@/lib/bot-panel";
import { botLifecycleKeys } from "@/lib/bot-lifecycle/queries";
import { reportComputerActivity } from "@/lib/copilot/computer-activity";
import { pluginKeys } from "@/lib/plugins/queries";
import { routineKeys } from "@/lib/routines/queries";

/**
 * The bot panel beside a conversation, wired the way the channel route wires it: the tab from
 * `?panel=` (with the legacy `?settings=` and `?watch=` folded in), the open state from the
 * stored preference, and the Bot's computer asking for attention on top — for the session only.
 */

let originalRect: typeof HTMLElement.prototype.getBoundingClientRect;
const originalFetch = globalThis.fetch;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  originalRect = HTMLElement.prototype.getBoundingClientRect;
});
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  HTMLElement.prototype.getBoundingClientRect = originalRect;
  window.localStorage.removeItem(BOT_PANEL_STORAGE_KEY);
});
afterAll(async () => {
  // Let React's scheduler drain before the window it reads `window.event` from goes away.
  await new Promise((resolve) => setTimeout(resolve, 0));
  GlobalRegistrator.unregister();
});

const BOT: AgentProfile = {
  avatarSeed: "seed",
  builtIn: true,
  canManage: true,
  endpoint: null,
  hasAuth: false,
  hasCallbackToken: false,
  hidden: false,
  id: "bot-1",
  mine: true,
  name: "Noë",
  pinned: false,
  roleDescription: "Helps with everything.",
  systemOwned: false,
  title: "",
  visibility: "private",
};

/** A wide window, where the panel sits inline, and a backend with a computer to show. */
function wideWithComputer() {
  HTMLElement.prototype.getBoundingClientRect = () =>
    new DOMRect(0, 0, 1200, 800);
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/control"))
        return Response.json({
          holder: "bot",
          since: "2026-09-26",
          requested: false,
          transitioning: false,
          resumeSnapshotRequired: false,
        });
      return Response.json({ error: "Not here" }, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
}

function seededClient() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  client.setQueryData(agentKeys.detail(BOT.id), BOT);
  client.setQueryData(botLifecycleKeys.lifecycle(BOT.id), {
    agentId: BOT.id,
    paused: false,
    pausedAt: null,
    notify: "all",
  });
  client.setQueryData(pluginKeys.forAgent(BOT.id), { tools: [], skills: [] });
  client.setQueryData(routineKeys.list(), {
    routines: [],
    sweep: { lastSweptAt: null, working: false },
  });
  return client;
}

const rootRoute = createRootRoute({ component: Outlet });
const chatRoute = createRoute({
  path: "/channel/$channelId",
  getParentRoute: () => rootRoute,
  validateSearch: botPanelSearchSchema,
  component: ChatPage,
});
const routeTree = rootRoute.addChildren([chatRoute]);

/** The channel route's wiring around a stub transcript. */
function ChatPage() {
  const { panel } = chatRoute.useSearch();
  const navigate = chatRoute.useNavigate();
  const setPanel = useCallback(
    (tab: BotPanelTab | undefined) =>
      void navigate({ search: (previous) => ({ ...previous, panel: tab }) }),
    [navigate],
  );
  const botPanel = useBotPanel({ computerAgentId: BOT.id, panel, setPanel });
  return (
    <DetailPanel
      chromeless
      detail={
        <BotPanel
          agentId={BOT.id}
          name={BOT.name}
          onTabChange={botPanel.setTab}
          tab={botPanel.tab}
        />
      }
      detailWidth={320}
      onClose={botPanel.close}
      onOverlayChange={botPanel.onOverlayChange}
      open={botPanel.demanded}
      preferOpen={botPanel.storedOpen}
    >
      <ChatHeader
        agentIds={[BOT.id]}
        name={BOT.name}
        onPill={botPanel.openDetails}
        onToggle={botPanel.toggle}
        panelOpen={botPanel.isOpen}
      />
      <p>Transcript</p>
    </DetailPanel>
  );
}

function draw(initialEntry: string) {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });
  const view = render(
    <QueryClientProvider client={seededClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { view, router };
}

/** The panel on its own, inside the router its links and dialog need. */
function drawPanel(panel: ReactNode) {
  const root = createRootRoute({ component: () => panel });
  const router = createRouter({
    routeTree: root,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={seededClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

function selectedTab(view: ReturnType<typeof render>) {
  return view
    .getAllByRole("tab")
    .find((tab) => tab.getAttribute("aria-selected") === "true")?.textContent;
}

test("only the exact stored 'closed' closes the panel", () => {
  expect(parseStoredBotPanelOpen(null)).toBe(true);
  expect(parseStoredBotPanelOpen("open")).toBe(true);
  expect(parseStoredBotPanelOpen("")).toBe(true);
  expect(parseStoredBotPanelOpen("Closed")).toBe(true);
  expect(parseStoredBotPanelOpen("closed")).toBe(false);
});

test("the legacy ?settings and ?watch parameters become tabs, and ?panel wins", () => {
  expect(botPanelSearchSchema.parse({ settings: true })).toEqual({
    panel: "details",
  });
  expect(botPanelSearchSchema.parse({ watch: true })).toEqual({
    panel: "computer",
  });
  expect(botPanelSearchSchema.parse({ panel: "library", watch: true })).toEqual(
    { panel: "library" },
  );
  expect(botPanelSearchSchema.parse({ settings: false })).toEqual({});
  expect(botPanelSearchSchema.parse({})).toEqual({});
});

test("?settings=true opens Details and ?watch=true opens the Computer", async () => {
  wideWithComputer();
  const settings = draw("/channel/c1?settings=true");
  await settings.view.findByRole("tablist", { name: "Bot panel" });
  expect(selectedTab(settings.view)).toBe("Details");
  expect(settings.view.getByText("Helps with everything.")).toBeTruthy();
  cleanup();

  const watch = draw("/channel/c1?watch=true");
  await watch.view.findByRole("region", { name: "Computer sidebar" });
  expect(selectedTab(watch.view)).toBe("Computer");
  expect(watch.view.getByText("Noë's screen")).toBeTruthy();
});

test("the panel is open by default on the Computer, and a tab switch is a navigation", async () => {
  wideWithComputer();
  const { view, router } = draw("/channel/c1");
  await view.findByRole("region", { name: "Computer sidebar" });
  expect(selectedTab(view)).toBe("Computer");
  // Open from the never-written preference: nothing in the URL asked for it.
  expect(router.state.location.search).toEqual({});

  fireEvent.click(view.getByRole("tab", { name: "Library" }));
  await waitFor(() =>
    expect(router.state.location.search).toEqual({ panel: "library" }),
  );
  expect(selectedTab(view)).toBe("Library");
  expect(view.getByText("Nothing granted yet")).toBeTruthy();
  // The screen stays mounted behind the other tabs, hidden rather than torn down.
  expect(
    view.getByRole("region", { name: "Computer sidebar", hidden: true }),
  ).toBeTruthy();
});

test("the close X remembers 'closed' and clears the tab; the pill reopens on Details", async () => {
  wideWithComputer();
  const { view, router } = draw("/channel/c1?panel=library");
  await view.findByRole("tablist", { name: "Bot panel" });
  expect(selectedTab(view)).toBe("Library");

  fireEvent.click(view.getByRole("button", { name: "Close details" }));
  expect(window.localStorage.getItem(BOT_PANEL_STORAGE_KEY)).toBe("closed");
  await waitFor(() => expect(router.state.location.search).toEqual({}));
  await waitFor(() =>
    expect(view.queryByRole("tablist", { name: "Bot panel" })).toBeNull(),
  );
  expect(
    view
      .getByRole("button", { name: "Show details" })
      .getAttribute("aria-expanded"),
  ).toBe("false");

  fireEvent.click(view.getByRole("button", { name: "Open Noë" }));
  await waitFor(() =>
    expect(router.state.location.search).toEqual({ panel: "details" }),
  );
  expect(window.localStorage.getItem(BOT_PANEL_STORAGE_KEY)).toBe("open");
  await view.findByRole("tablist", { name: "Bot panel" });
  expect(selectedTab(view)).toBe("Details");
  expect(
    view
      .getByRole("button", { name: "Hide details" })
      .getAttribute("aria-expanded"),
  ).toBe("true");
});

test("the Bot using its computer opens the screen for this session without touching the preference", async () => {
  wideWithComputer();
  window.localStorage.setItem(BOT_PANEL_STORAGE_KEY, "closed");
  const { view, router } = draw("/channel/c1");
  await view.findByRole("button", { name: "Show details" });
  expect(view.queryByRole("tablist", { name: "Bot panel" })).toBeNull();

  await act(async () => {
    reportComputerActivity(BOT.id);
  });
  await view.findByRole("region", { name: "Computer sidebar" });
  expect(selectedTab(view)).toBe("Computer");
  // Opened by the Bot, not by the person: the preference and the URL are as they were.
  expect(window.localStorage.getItem(BOT_PANEL_STORAGE_KEY)).toBe("closed");
  expect(router.state.location.search).toEqual({});

  // Closing dismisses this run: the same run does not reopen it.
  fireEvent.click(view.getByRole("button", { name: "Close details" }));
  await waitFor(() =>
    expect(view.queryByRole("tablist", { name: "Bot panel" })).toBeNull(),
  );
  await act(async () => {
    reportComputerActivity(BOT.id);
  });
  expect(view.queryByRole("tablist", { name: "Bot panel" })).toBeNull();
  // Another Bot's activity is not this conversation's.
  await act(async () => {
    reportComputerActivity("someone-else");
  });
  expect(view.queryByRole("tablist", { name: "Bot panel" })).toBeNull();
});

test("a group shows its Bots and neither a Library nor a Computer", async () => {
  const view = drawPanel(
    <BotPanel
      agentId="bot-1"
      name="Planning"
      onTabChange={() => {}}
      participants={[
        { id: "bot-1", name: "Noë" },
        { id: "bot-2", name: "Sendy" },
      ]}
      tab="computer"
    />,
  );
  await view.findByRole("heading", { name: "Planning" });
  expect(view.queryByRole("tablist")).toBeNull();
  expect(view.queryByRole("tab", { name: "Library" })).toBeNull();
  expect(view.queryByRole("region", { name: "Computer sidebar" })).toBeNull();
  const bots = within(view.getByRole("list"));
  expect(bots.getByText("Noë")).toBeTruthy();
  expect(bots.getByText("Sendy")).toBeTruthy();
  expect(view.getByText("2 Bots")).toBeTruthy();
});

test("a Bot with no title invites a label, which opens its dialog", async () => {
  const view = drawPanel(
    <BotPanel
      agentId="bot-1"
      name="Noë"
      onTabChange={() => {}}
      tab="details"
    />,
  );
  const label = await view.findByRole("button", {
    name: "Add a label to Noë",
  });
  expect(label.textContent).toBe("Add a label");
  fireEvent.click(label);
  expect(await view.findByRole("dialog")).toBeTruthy();
});
