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
import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { MarketplaceSearch } from "@/components/marketplace/search";
import { TemplateMarket } from "@/components/templates/template-market";
import {
  type AgentProfile,
  agentKeys,
  type BotTemplate,
} from "@/lib/agents/queries";
import { Route as HomeRoute } from "@/routes/_authed/_app/index";

/**
 * The Agents tab, drawn like Grok Bot's Bot marketplace: the templates by category with a
 * featured strip and a View all, the person's own Bots in the same rows, and the roster's
 * error rules carried over from the component this replaced — a failure is said, an empty roster
 * is not an error, and a failed refetch keeps the roster it already had.
 *
 * The home-page cases at the end are the same ones that lived beside the old roster: `/` reads
 * the same roster for its composer, and its sentences are its own.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = global.fetch;
beforeEach(() => {
  // Every read in this app goes through `client()` in `lib/client.ts`, which throws once the
  // response is not `ok`. A 500 with no body is the shape a broken server actually sends.
  global.fetch = (async () =>
    new Response(null, { status: 500 })) as unknown as typeof fetch;
});
afterEach(() => {
  global.fetch = originalFetch;
});

function failingQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function staleQueryClient(agents: AgentProfile[]) {
  const queryClient = failingQueryClient();
  queryClient.setQueryData(agentKeys.list(false), agents);
  return queryClient;
}

function agent(
  overrides: Partial<AgentProfile> & { id: string },
): AgentProfile {
  return {
    name: "Agent",
    title: "Title",
    roleDescription: "Role",
    avatarSeed: "seed",
    avatarColor: null,
    avatarExpression: null,
    canEditAvatar: false,
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
    ...overrides,
  };
}

function template(
  overrides: Partial<BotTemplate> & { id: string; name: string },
): BotTemplate {
  return {
    title: "Title",
    creator: "Noë Bot Team",
    categories: ["From Noë Bot Team", "Sales"],
    summary: "What it does, in one line.",
    description: "A longer description.",
    instructions: "You are a Bot.",
    avatar: { color: "#ff2056", expression: "happy" },
    skills: [],
    apps: [],
    routines: [],
    featured: false,
    ...overrides,
  };
}

async function waitForFailedRefetch(queryClient: QueryClient) {
  await waitFor(() => {
    expect(queryClient.getQueryState(agentKeys.list(false))?.status).toBe(
      "error",
    );
  });
}

const HOME_FIND_TIMEOUT = { timeout: 5000 };

function renderHome(queryClient: QueryClient) {
  const rootRoute = createRootRoute({ component: HomeRoute.options.component });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

/** The market, with whatever search it is handed; what it asks for next is recorded. */
function renderMarket(
  queryClient: QueryClient,
  search: MarketplaceSearch = {},
) {
  const searches: MarketplaceSearch[] = [];
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({
      component: () => (
        <TemplateMarket
          onSearchChange={(next) => {
            searches.push(next);
          }}
          search={search}
        />
      ),
    }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { view, searches };
}

/** A deployment answering the three reads the market makes, and Add. */
function serving(input: {
  visible?: AgentProfile[];
  hidden?: AgentProfile[];
  templates?: BotTemplate[];
}) {
  const added: string[] = [];
  global.fetch = (async (request: RequestInfo | URL, init?: RequestInit) => {
    const url = String(request);
    if (url.startsWith("/api/bot-templates/") && init?.method === "POST") {
      const id = decodeURIComponent(url.split("/")[3] ?? "");
      added.push(id);
      return Response.json(
        { agent: agent({ id: `from-${id}`, name: "New Bot" }) },
        { status: 201 },
      );
    }
    if (url.startsWith("/api/bot-templates")) {
      return Response.json({ templates: input.templates ?? [] });
    }
    const agents = url.includes("hidden=true")
      ? (input.hidden ?? [])
      : (input.visible ?? []);
    return Response.json({ agents });
  }) as unknown as typeof fetch;
  return { added };
}

test("a failed read reports the failure on each of its lines, not an empty roster", async () => {
  const { view } = renderMarket(failingQueryClient());
  expect(await view.findByText("Your Bots couldn't be loaded.")).toBeTruthy();
  expect(
    await view.findByText("Shared with you couldn't be loaded."),
  ).toBeTruthy();
  expect(
    await view.findByText("Bot templates couldn't be loaded."),
  ).toBeTruthy();
  // A person with agents must never be told they have none because the request that would have
  // proven otherwise never came back.
  expect(view.queryByText(/You don't have any Bots yet/)).toBeNull();
  expect(view.queryByText("Nobody has shared a Bot with you yet.")).toBeNull();
});

test("the three reads hold a skeleton while pending, not an empty state", async () => {
  global.fetch = (() =>
    new Promise<Response>(() => {})) as unknown as typeof fetch;
  const { view } = renderMarket(failingQueryClient());
  const skeletons = await waitFor(() => {
    const found = view.container.querySelectorAll('[data-slot="skeleton"]');
    expect(found.length).toBe(3);
    return found;
  });
  expect(skeletons.length).toBe(3);
  expect(view.queryByText(/You don't have any Bots yet/)).toBeNull();
  expect(view.queryByText("Your Bots couldn't be loaded.")).toBeNull();
  expect(view.queryByText("Bot templates couldn't be loaded.")).toBeNull();
});

test("a failed REFETCH keeps the roster it already had, and an empty slice is empty, not broken", async () => {
  const mine = agent({ id: "mine-1", name: "Mine Agent", mine: true });
  const queryClient = staleQueryClient([mine]);
  const { view } = renderMarket(queryClient);
  await waitForFailedRefetch(queryClient);
  expect(await view.findByText("Mine Agent")).toBeTruthy();
  expect(
    await view.findByText("Nobody has shared a Bot with you yet."),
  ).toBeTruthy();
  expect(view.queryByText("Your Bots couldn't be loaded.")).toBeNull();
  expect(view.queryByText("Shared with you couldn't be loaded.")).toBeNull();
});

test("templates are listed under their categories with a featured strip, and Add makes the Bot", async () => {
  const sales = ["a", "b", "c", "d", "e"].map((id) =>
    template({ id: `sales-${id}`, name: `Sales ${id.toUpperCase()}` }),
  );
  const star = template({
    id: "research-desk",
    name: "Research Desk",
    categories: ["From Noë Bot Team", "Operations"],
    featured: true,
  });
  const { added } = serving({ templates: [...sales, star] });
  const { view, searches } = renderMarket(failingQueryClient());
  const user = userEvent.setup({ document: view.baseElement.ownerDocument });

  // The pills: All and Your Bots, then only the categories with a template, in the fixed order.
  await view.findByRole("button", { name: "Sales", pressed: false });
  expect(
    view
      .getAllByRole("button", { pressed: undefined })
      .filter((button) => button.getAttribute("aria-pressed") !== null)
      .map((button) => button.textContent),
  ).toEqual(["All", "Your Bots", "From Noë Bot Team", "Sales", "Operations"]);

  // Featured, on All with no search, and not again in its category row.
  const featured = view.getByRole("region", { name: "Featured" });
  expect(within(featured).getByTestId("featured-research-desk")).toBeTruthy();
  expect(
    within(view.getByRole("region", { name: "Operations" })).queryByTestId(
      "template-research-desk",
    ),
  ).toBeNull();
  // Four of five sales templates in the preview, with a View all.
  const salesSection = view.getByRole("region", { name: "Sales" });
  expect(within(salesSection).getAllByTestId(/^template-/)).toHaveLength(4);
  await user.click(
    within(salesSection).getByRole("button", { name: "View all" }),
  );
  expect(searches.at(-1)).toEqual({
    tab: "agents",
    q: undefined,
    category: "Sales",
  });

  // Add makes a private Bot and opens it.
  await user.click(
    within(salesSection).getByRole("button", { name: "Add Sales A" }),
  );
  await waitFor(() => expect(added).toEqual(["sales-a"]));
  await waitFor(() =>
    expect(searches.at(-1)).toEqual({
      tab: "agents",
      q: undefined,
      agent: "from-sales-a",
    }),
  );
  // And the row opens the template's page.
  await user.click(
    within(salesSection).getByRole("button", { name: "About Sales B" }),
  );
  expect(searches.at(-1)).toEqual({
    tab: "agents",
    q: undefined,
    template: "sales-b",
  });
});

test("one category is shown whole, and Your Bots alone under its pill", async () => {
  const sales = ["a", "b", "c", "d", "e"].map((id) =>
    template({ id: `sales-${id}`, name: `Sales ${id.toUpperCase()}` }),
  );
  serving({
    templates: sales,
    visible: [agent({ id: "mine-1", name: "Mine Agent" })],
  });
  const whole = renderMarket(failingQueryClient(), { category: "Sales" });
  expect(
    within(
      await whole.view.findByRole("region", { name: "Sales" }),
    ).getAllByTestId(/^template-/),
  ).toHaveLength(5);
  expect(whole.view.queryByRole("region", { name: "Featured" })).toBeNull();
  expect(whole.view.queryByRole("region", { name: "Your Bots" })).toBeNull();
  cleanup();

  const bots = renderMarket(failingQueryClient(), { category: "your-bots" });
  expect(await bots.view.findByText("Mine Agent")).toBeTruthy();
  expect(bots.view.queryByRole("region", { name: "Sales" })).toBeNull();
  expect(bots.view.getByLabelText("Open Mine Agent").getAttribute("href")).toBe(
    "/marketplace?tab=agents&agent=mine-1",
  );
});

test("a hidden coworker is under Hidden, collapsed; a pinned one is first among Your Bots", async () => {
  const kept = agent({ id: "mine-1", name: "Kept Agent" });
  const favourite = agent({ id: "mine-2", name: "Favourite", pinned: true });
  const tucked = agent({ id: "hidden-1", name: "Tucked Agent", hidden: true });
  serving({ visible: [kept, favourite], hidden: [tucked] });
  const { view } = renderMarket(failingQueryClient());
  expect(await view.findByText("Hidden")).toBeTruthy();
  const section = view.container.querySelector("details");
  expect(section?.open).toBe(false);
  expect(section?.textContent).toContain("Tucked Agent");
  expect(section?.textContent).not.toContain("Kept Agent");
  // No Pinned section: a pinned Bot leads Your Bots instead.
  expect(view.queryByText("Pinned")).toBeNull();
  const yours = view.getByRole("region", { name: "Your Bots" });
  const names = within(yours)
    .getAllByTestId(/^bot-/)
    .map((row) => row.getAttribute("data-testid"));
  expect(names).toEqual(["bot-mine-2", "bot-mine-1"]);
});

test("a failed roster on / reports the failure and explains the disabled composer", async () => {
  const view = renderHome(failingQueryClient());
  expect(
    await view.findByText(
      "Agents shared with you couldn't be loaded.",
      {},
      HOME_FIND_TIMEOUT,
    ),
  ).toBeTruthy();
  expect(
    view.queryByText("Nobody has shared an agent with you yet."),
  ).toBeNull();
  expect(
    await view.findByText(
      "Your coworkers couldn't be loaded, so there's no one to send this to yet.",
      {},
      HOME_FIND_TIMEOUT,
    ),
  ).toBeTruthy();
});

test("a failed REFETCH on / keeps the roster and does not disclaim the composer", async () => {
  const shared = agent({
    id: "shared-1",
    name: "Shared Agent",
    mine: false,
    visibility: "public",
  });
  const queryClient = staleQueryClient([shared]);
  const view = renderHome(queryClient);
  await waitForFailedRefetch(queryClient);
  expect(
    await view.findByText("Shared Agent", {}, HOME_FIND_TIMEOUT),
  ).toBeTruthy();
  expect(
    await view.findByText(
      "Sent to the coworker it is for.",
      { exact: false },
      HOME_FIND_TIMEOUT,
    ),
  ).toBeTruthy();
  expect(
    view.queryByText(
      "Your coworkers couldn't be loaded, so there's no one to send this to yet.",
    ),
  ).toBeNull();
  expect(
    view.queryByText("Agents shared with you couldn't be loaded."),
  ).toBeNull();
});

test("a failed REFETCH on / with explore empty shows it as empty, not broken", async () => {
  const mine = agent({ id: "mine-1", name: "Mine Agent", mine: true });
  const queryClient = staleQueryClient([mine]);
  const view = renderHome(queryClient);
  await waitForFailedRefetch(queryClient);
  expect(
    await view.findByText(
      "Nobody has shared an agent with you yet.",
      {},
      HOME_FIND_TIMEOUT,
    ),
  ).toBeTruthy();
  expect(
    view.queryByText("Agents shared with you couldn't be loaded."),
  ).toBeNull();
  expect(
    view.queryByText(
      "Your coworkers couldn't be loaded, so there's no one to send this to yet.",
    ),
  ).toBeNull();
});
