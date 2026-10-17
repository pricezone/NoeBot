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
  avatarColor: null,
  avatarExpression: null,
  canEditAvatar: false,
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

/** A recording as the server lists it. */
function recording(
  overrides: Record<string, unknown> & { id: string; title: string },
) {
  return {
    botId: BOT.id,
    status: "stopped",
    actions: [
      {
        kind: "click",
        target: { role: "button", name: "Search", sensitive: false },
      },
    ],
    draft: null,
    skillSlug: null,
    createdAt: "2026-10-07T09:00:00Z",
    finishedAt: "2026-10-07T09:02:00Z",
    expiresAt: "2026-10-07T09:10:00Z",
    maxDurationMs: 600_000,
    reachedTimeLimit: false,
    ...overrides,
  };
}

/** A wide window, where the panel sits inline, and a backend with a computer to show. */
function wideWithComputer(recordings: ReturnType<typeof recording>[] = []) {
  HTMLElement.prototype.getBoundingClientRect = () =>
    new DOMRect(0, 0, 1200, 800);
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `/api/demonstrations?botId=${BOT.id}`)
        return Response.json({ demonstrations: recordings });
      if (url === `/api/agents/${BOT.id}/files`)
        return Response.json({
          files: [],
          nextCursor: null,
          workspace: "listed",
        });
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
  // Access is in Bot Settings, not the Library.
  expect(view.queryByText("Nothing granted yet")).toBeNull();
  expect(
    view.getByRole("heading", { name: "Recorded workflows" }),
  ).toBeTruthy();
  expect(
    await view.findByText(
      "No recorded workflows yet. Open the Bot's screen and choose Record your steps.",
    ),
  ).toBeTruthy();
  // The screen stays mounted behind the other tabs, hidden rather than torn down.
  expect(
    view.getByRole("region", { name: "Computer sidebar", hidden: true }),
  ).toBeTruthy();
});

test("Details reads Name, Role, Routines, For you, then Bot Settings; Library opens with Files and has no Access", async () => {
  wideWithComputer();
  const { view } = draw("/channel/c1?panel=details");
  const routines = await view.findByRole("heading", { name: "Routines" });
  const name = view.getByRole("heading", { name: "Name" });
  const role = view.getByRole("heading", { name: "Role" });
  const forYou = view.getByRole("heading", { name: "For you" });
  const settings = view.getByRole("button", { name: "Bot Settings" });
  const inOrder = [name, role, routines, forYou, settings];
  for (const [index, element] of inOrder.slice(1).entries()) {
    expect(
      (inOrder[index] as HTMLElement).compareDocumentPosition(element) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  }
  expect(view.queryByRole("button", { name: "Manage…" })).toBeNull();
  // The lifecycle switch is named for what it does; the routine chips keep "Paused".
  expect(view.getByRole("switch", { name: "Pause" })).toBeTruthy();
  expect(view.queryByRole("switch", { name: "Paused" })).toBeNull();
  expect(
    await view.findByText("Nothing scheduled for this coworker"),
  ).toBeTruthy();

  fireEvent.click(view.getByRole("tab", { name: "Library" }));
  await view.findByRole("heading", { name: "Files" });
  // Moved, not copied: the Library no longer lists them.
  expect(view.queryByRole("heading", { name: "Routines" })).toBeNull();
  const library = view
    .getAllByRole("heading", { level: 2 })
    .map((heading) => heading.textContent)
    .filter((text) =>
      ["Files", "Recorded workflows", "Access"].includes(text ?? ""),
    );
  // Access stays in the Bot Settings dialog only.
  expect(library).toEqual(["Files", "Recorded workflows"]);
  expect(await view.findByText(/^No files yet\./)).toBeTruthy();
});

test("the Bot's name and role edit in place, behind a pencil shown on hover and focus", async () => {
  const sent: { method: string; url: string; body: unknown }[] = [];
  let stored: AgentProfile = BOT;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === `/api/agents/${BOT.id}` && method === "PATCH") {
        const body = JSON.parse(String(init?.body));
        sent.push({ method, url, body });
        stored = { ...stored, ...body };
        return Response.json({ agent: stored });
      }
      // The save invalidates the profile, which is read again.
      if (url === `/api/agents/${BOT.id}`)
        return Response.json({ agent: stored });
      return Response.json({ error: "Not here" }, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
  const view = drawPanel(
    <BotPanel
      agentId="bot-1"
      name="Noë"
      onTabChange={() => {}}
      tab="details"
    />,
  );

  const pencil = await view.findByRole("button", { name: "Edit name" });
  // Hidden until the row is hovered or the pencil has keyboard focus; always on a touch screen.
  for (const name of [
    "opacity-0",
    "group-hover/field:opacity-100",
    "focus-visible:opacity-100",
    "[@media(hover:none)]:opacity-100",
  ]) {
    expect(pencil.className).toContain(name);
  }
  const user = userEvent.setup({ document: view.baseElement.ownerDocument });
  await user.click(pencil);
  const input = view.getByRole("textbox", { name: "Name" });
  expect((input as HTMLInputElement).value).toBe("Noë");
  await user.clear(input);
  await user.type(input, "Noë the Second{Enter}");
  await waitFor(() => expect(sent).toHaveLength(1));
  expect(sent[0]?.body).toMatchObject({
    name: "Noë the Second",
    roleDescription: BOT.roleDescription,
    visibility: BOT.visibility,
    // A built-in Bot's managed address is never sent back as if somebody typed it.
    endpoint: "",
  });
  await waitFor(() =>
    expect(view.queryByRole("textbox", { name: "Name" })).toBeNull(),
  );
  // The header follows the profile, so the new name shows there at once.
  expect(
    await view.findByRole("heading", { name: "Noë the Second" }),
  ).toBeTruthy();

  // The role is a paragraph: Enter is a new line there, Cancel drops the draft unsent.
  await user.click(view.getByRole("button", { name: "Edit role" }));
  const role = view.getByRole("textbox", { name: "Role" });
  await user.type(role, " and more{Enter}");
  expect((role as HTMLTextAreaElement).value).toBe(
    `${BOT.roleDescription} and more\n`,
  );
  await user.click(view.getByRole("button", { name: "Cancel" }));
  expect(view.queryByRole("textbox", { name: "Role" })).toBeNull();
  expect(sent).toHaveLength(1);
});

test("a Bot nobody here may change shows its name and role without a pencil", async () => {
  const view = drawPanel(
    <BotPanel
      agentId="bot-1"
      name="Noë"
      onTabChange={() => {}}
      tab="details"
    />,
  );
  await view.findByRole("button", { name: "Edit name" });
  cleanup();

  const client = seededClient();
  client.setQueryData(agentKeys.detail(BOT.id), { ...BOT, canManage: false });
  const root = createRootRoute({
    component: () => (
      <BotPanel
        agentId="bot-1"
        name="Noë"
        onTabChange={() => {}}
        tab="details"
      />
    ),
  });
  const readOnly = render(
    <QueryClientProvider client={client}>
      <RouterProvider
        router={createRouter({
          routeTree: root,
          history: createMemoryHistory({ initialEntries: ["/"] }),
        })}
      />
    </QueryClientProvider>,
  );
  await readOnly.findByRole("heading", { name: "Name" });
  expect(readOnly.queryByRole("button", { name: "Edit name" })).toBeNull();
  expect(readOnly.queryByRole("button", { name: "Edit role" })).toBeNull();
  expect(readOnly.getByText(BOT.roleDescription)).toBeTruthy();
});

test("a long name wraps in the panel header instead of being cut short", async () => {
  const long = "Supercalifragilisticexpialidocious-Assistant-For-Everything";
  const view = drawPanel(
    <BotPanel
      agentId="bot-1"
      name={long}
      onTabChange={() => {}}
      tab="details"
    />,
  );
  const heading = (await view.findAllByRole("heading", { level: 2 })).find(
    (element) => element.textContent === "Noë" || element.textContent === long,
  );
  expect(heading?.className).toContain("break-words");
  expect(heading?.className).not.toContain("truncate");
});

test("Library lists the workflows recorded on the Bot's screen, and an unnamed one is named first", async () => {
  wideWithComputer([
    recording({ id: "r1", title: "Untitled workflow" }),
    recording({
      id: "r2",
      title: "Find an invoice",
      status: "published",
      skillSlug: "find-an-invoice",
      reachedTimeLimit: true,
    }),
    recording({ id: "r3", title: "Still going", status: "recording" }),
  ]);
  const { view } = draw("/channel/c1?panel=library");
  const section = within(
    (await view.findByRole("heading", { name: "Recorded workflows" })).closest(
      "section",
    ) as HTMLElement,
  );
  expect(await section.findByText(/Find an invoice · 1 step/)).toBeTruthy();
  expect(section.getByText(/stopped at the ten-minute limit/)).toBeTruthy();
  expect(section.getByText("Edit /find-an-invoice")).toBeTruthy();
  expect(
    section.getByRole("button", { name: "Run on a schedule" }),
  ).toBeTruthy();
  // The one still recording is the viewer's, not the library's.
  expect(section.queryByText(/Still going/)).toBeNull();
  expect(section.getAllByRole("button", { name: "Delete" })).toHaveLength(2);

  fireEvent.click(section.getByRole("button", { name: "Review skill draft" }));
  const dialog = within(await view.findByRole("dialog"));
  expect(
    dialog.getByRole("heading", { name: "Name this workflow" }),
  ).toBeTruthy();
  expect(dialog.getByLabelText("Workflow name")).toBeTruthy();
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
