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
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { paletteGroups } from "@/components/app-sidebar/palette-items";
import { SearchPalette } from "@/components/app-sidebar/search-palette";
import { SETTINGS_NAV } from "@/components/settings/settings-nav";
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";
import { authKeys } from "@/lib/auth/queries";
import { type ChannelSummary, channelKeys } from "@/lib/channels/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { settleReactWork } from "./settle-react-work";

/**
 * The sidebar's search popup: every Bot and every Settings section, narrowed by what is typed, and
 * the arrow keys and Enter to open one. Plus the conversations hidden from the sidebar, which the
 * search is the way back to.
 */

const clients: QueryClient[] = [];
let originalFetch: typeof fetch;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost:3010" });
  originalFetch = globalThis.fetch;
  // Everything the popup reads is seeded; a request would be a fixture that forgot something.
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
});
afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

function agent(
  id: string,
  name: string,
  details: Partial<AgentProfile> = {},
): AgentProfile {
  return {
    id,
    name,
    avatarColor: null,
    avatarExpression: null,
    canEditAvatar: true,
    title: "",
    roleDescription: "",
    avatarSeed: id,
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
    ...details,
  };
}

function channel(
  id: string,
  agentIds: string[],
  details: Partial<ChannelSummary> = {},
): ChannelSummary {
  return {
    id,
    name: id,
    agentIds,
    threadId: `thread-${id}`,
    active: true,
    lastMessageAt: "2026-10-01T10:00:00.000Z",
    summary: null,
    lastMessage: null,
    lastMessageAgentId: null,
    createdAt: "2026-10-01T09:00:00.000Z",
    pinned: false,
    lastReadAt: null,
    ...details,
  };
}

const ADA = agent("ada", "Ada", {
  title: "Finance Operations",
  roleDescription: "Reviews receipts and files expenses.",
});
const BO = agent("bo", "Bo", { title: "Travel desk" });
/** A Bot nobody has talked to yet. */
const CY = agent("cy", "Cy", { roleDescription: "Plans trips." });

const ROSTER = [
  channel("chat-ada", ["ada"]),
  // Hidden after its last message, so it is off the sidebar and only the search leads to it.
  channel("chat-close", ["bo"], {
    name: "Quarterly close",
    hiddenAt: "2026-10-02T00:00:00.000Z",
    summary: "Closing the books",
  }),
];

function mount({
  role = "user",
  usage = false,
}: {
  role?: "user" | "admin";
  usage?: boolean;
} = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  clients.push(queryClient);
  queryClient.setQueryData(agentKeys.list(false), [ADA, BO, CY]);
  queryClient.setQueryData(channelKeys.list(), {
    pages: [{ channels: ROSTER, nextCursor: null }],
    pageParams: [""],
  });
  queryClient.setQueryData(authKeys.currentUser(), {
    id: "user",
    email: "user@example.com",
    role,
    onboarding: null,
  });
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: false,
    selfHostBanner: false,
    usage,
  });

  function Palette() {
    const [open, setOpen] = useState(true);
    return <SearchPalette onOpenChange={setOpen} open={open} />;
  }
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <Palette />
        <Outlet />
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
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: rootRoute.addChildren([
      page("/"),
      page("/channel/$channelId"),
      page("/channel/new"),
      page("/settings"),
      page("/settings/memory"),
      page("/settings/bots"),
      page("/admin"),
    ]),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  const user = userEvent.setup({ document: view.container.ownerDocument });
  return { view, router, user };
}

const optionTexts = (view: ReturnType<typeof render>) =>
  view.getAllByRole("option").map((option) => option.textContent);

describe("what the popup lists", () => {
  test("every Bot, the hidden chats, then Settings, with Admin only for an administrator", () => {
    const groups = paletteGroups({
      query: "",
      bots: [ADA, BO],
      channels: ROSTER,
      settings: SETTINGS_NAV,
      isAdmin: false,
    });

    expect(groups.map((group) => group.id)).toEqual([
      "bots",
      "hidden-chats",
      "settings",
    ]);
    expect(groups[1]?.items.map((item) => item.key)).toEqual([
      "chat:chat-close",
    ]);
    expect(groups[2]?.items.some((item) => item.key === "setting:admin")).toBe(
      false,
    );

    const asAdmin = paletteGroups({
      query: "",
      bots: [ADA, BO],
      channels: ROSTER,
      settings: SETTINGS_NAV,
      isAdmin: true,
    });
    expect(asAdmin[2]?.items.some((item) => item.key === "setting:admin")).toBe(
      true,
    );
  });

  test("a Bot is found by its title or role, a section by its own words, and empty groups go", () => {
    const keys = (query: string) =>
      paletteGroups({
        query,
        bots: [ADA, BO],
        channels: ROSTER,
        settings: SETTINGS_NAV,
        isAdmin: false,
      }).flatMap((group) => group.items.map((item) => item.key));

    expect(keys("RECEIPTS")).toEqual(["bot:ada"]);
    expect(keys("travel")).toEqual(["bot:bo"]);
    expect(keys("memory")).toEqual(["setting:memory"]);
    // "Settings" is in every section's row, so it finds them all and nothing else.
    expect(keys("settings").every((key) => key.startsWith("setting:"))).toBe(
      true,
    );
    expect(keys("settings")).toHaveLength(
      SETTINGS_NAV.filter((item) => !item.adminOnly).length,
    );
    expect(keys("books")).toEqual(["chat:chat-close"]);
    expect(keys("nothing like this")).toEqual([]);
  });
});

describe("the popup", () => {
  test("draws a Bot's name, title and role, and the sections under Settings", async () => {
    const { view } = mount();

    await view.findByRole("combobox", { name: "Search Bots and Settings" });
    const texts = optionTexts(view);
    expect(texts[0]).toBe(
      "AdaFinance OperationsReviews receipts and files expenses.",
    );
    expect(texts[1]).toBe("BoTravel desk");
    expect(texts).toContain("Settings: GeneralSettings");
    // A deployment with no meter and no billing page has no Usage & Billing to offer.
    expect(texts).not.toContain("Settings: Usage & BillingSettings");
    expect(texts).not.toContain("Settings: AdminSettings");
  });

  test("filters as you type and says so when nothing matches", async () => {
    const { view, user } = mount({ usage: true });
    const box = await view.findByRole("combobox", {
      name: "Search Bots and Settings",
    });

    await user.type(box, "bill");
    expect(optionTexts(view)).toEqual(["Settings: Usage & BillingSettings"]);

    await user.clear(box);
    await user.type(box, "zzz");
    expect(view.queryAllByRole("option")).toHaveLength(0);
    expect(view.getByText("No Bots or settings match “zzz”.")).toBeTruthy();
  });

  test("the arrow keys move the filled row, and Enter opens it", async () => {
    const { view, user, router } = mount();
    const box = await view.findByRole("combobox", {
      name: "Search Bots and Settings",
    });
    const selected = () =>
      view
        .getAllByRole("option")
        .filter((option) => option.getAttribute("aria-selected") === "true");

    // The first row is filled from the start, so Enter alone opens the best match.
    expect(selected().map((option) => option.textContent)).toEqual([
      "AdaFinance OperationsReviews receipts and files expenses.",
    ]);
    await user.keyboard("{ArrowDown}");
    const second = selected()[0];
    expect(second?.textContent).toBe("BoTravel desk");
    expect(box.getAttribute("aria-activedescendant")).toBe(second?.id ?? "");
    await user.keyboard("{ArrowUp}{ArrowUp}");
    expect(selected()[0]?.textContent).toContain("Ada");

    // Cy has no conversation yet: a new one, with Cy.
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/channel/new");
      expect(router.state.location.search).toEqual({ agent: "cy" });
    });
    // And the popup closed behind it.
    await waitFor(() =>
      expect(
        view.queryByRole("combobox", { name: "Search Bots and Settings" }),
      ).toBeNull(),
    );
  });

  test("a Bot opens its newest conversation, and a section opens Settings there", async () => {
    const first = mount();
    await first.user.click(
      (await first.view.findAllByRole("option"))[0] as HTMLElement,
    );
    await waitFor(() =>
      expect(first.router.state.location.pathname).toBe("/channel/chat-ada"),
    );
    cleanup();

    const second = mount();
    const box = await second.view.findByRole("combobox", {
      name: "Search Bots and Settings",
    });
    await second.user.type(box, "memory{Enter}");
    await waitFor(() =>
      expect(second.router.state.location.pathname).toBe("/settings/memory"),
    );
  });

  test("a Bot whose only conversation is hidden starts a new one; the hidden one is its own row", async () => {
    const { view, user, router } = mount();
    await view.findByRole("combobox", { name: "Search Bots and Settings" });

    // Bo is the second row. Its one conversation is hidden, and hiding is "out of my way": choosing
    // the Bot does not put that conversation back on screen. The row for it, below, still does.
    await user.keyboard("{ArrowDown}{Enter}");
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/channel/new");
      expect(router.state.location.search).toEqual({ agent: "bo" });
    });
  });

  test("a hidden conversation is still found, marked as hidden, and opens", async () => {
    const { view, user, router } = mount();
    const box = await view.findByRole("combobox", {
      name: "Search Bots and Settings",
    });

    await user.type(box, "quarterly");
    expect(optionTexts(view)).toEqual([
      "Quarterly closeHiddenClosing the books",
    ]);
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/channel/chat-close"),
    );
  });

  test("an administrator is offered Admin", async () => {
    const { view } = mount({ role: "admin" });
    await view.findByRole("combobox", { name: "Search Bots and Settings" });
    expect(optionTexts(view)).toContain("Settings: AdminSettings");
  });
});
