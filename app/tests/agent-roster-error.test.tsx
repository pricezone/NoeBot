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
import { cleanup, render, waitFor } from "@testing-library/react";
import { AgentRoster } from "@/components/agents/agent-roster";
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";
import { Route as HomeRoute } from "@/routes/_authed/_app/index";

/**
 * Both agent-facing screens read the same `agentListQueryOptions()` query, and both drew their
 * empty state on a FAILED query, not just an empty one: `isPending` (what each screen branches on)
 * goes false on failure exactly as it does on success, so a broken fetch fell through to "you have
 * nothing" and told somebody who may own twenty coworkers that they own none.
 *
 * THE HARNESS IS THIS REPOSITORY'S. `GlobalRegistrator` in `beforeAll`/`afterAll`, `cleanup` in
 * `afterEach`, and queries off `render()`'s own return, matching `proposed-bot-card.test.tsx` for
 * the reason recorded there: bun walks every file into one process, and a document another file
 * tore down mid-run fails invisibly.
 *
 * Each test builds its own `QueryClient` with `retry: false` — the app's own client (see
 * `query-client.ts`) retries once, which is correct for production and would just slow this test
 * down for no assertion it needs. `/` is exercised through its real, exported `Route`; the roster
 * is `AgentRoster`, the component the Marketplace's Agents tab draws since `/agents` became a
 * redirect into it, rendered on its own under a bare root route.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = global.fetch;

beforeEach(() => {
  // Every read in this app goes through `client()` in `lib/client.ts`, which throws once the
  // response is not `ok`. A 500 with no body is the shape a broken server actually sends, and is
  // exactly what `client()`'s fallback message path exists for.
  global.fetch = (async () =>
    new Response(null, { status: 500 })) as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
});

/** A client the failing query settles on in one attempt, so the test does not wait on a retry. */
function failingQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

/**
 * A client that already holds a successful `agents` list under the exact key
 * `agentListQueryOptions()` reads (`agentKeys.list(false)`, the default `hidden` param both
 * screens call it with), built on `failingQueryClient()` so the one refetch it triggers on mount
 * settles without a retry.
 *
 * Combined with the always-failing `global.fetch` this file's `beforeEach` installs, mounting a
 * screen against this client reproduces a failed BACKGROUND refetch: TanStack Query's default
 * `refetchOnMount` fires a fetch immediately because `staleTime` is unset (0), that fetch hits the
 * mocked 500, and `isError` becomes true while `data` — per query-core's error action, which
 * spreads `...state` and never touches `data` — stays exactly this seeded roster. No fake timers or
 * queryFn stand-in are needed: seeding the cache and letting the real, already-mocked fetch fail is
 * the whole scaffold.
 */
function staleQueryClient(agents: AgentProfile[]) {
  const queryClient = failingQueryClient();
  queryClient.setQueryData(agentKeys.list(false), agents);
  return queryClient;
}

/** A minimal but complete `AgentProfile`, overridable per test. */
function agent(
  overrides: Partial<AgentProfile> & { id: string },
): AgentProfile {
  return {
    name: "Agent",
    title: "Title",
    roleDescription: "Role",
    avatarSeed: "seed",
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

/** Waits for the seeded query to have actually failed its background refetch, rather than trusting
 *  that the seeded data alone (which would render identically before any fetch ran) proves it. */
async function waitForFailedRefetch(queryClient: QueryClient) {
  await waitFor(() => {
    expect(queryClient.getQueryState(agentKeys.list(false))?.status).toBe(
      "error",
    );
  });
}

/**
 * `findByText`'s own default wait is 1000ms, and `/` additionally mounts the heavy rich-text
 * `Composer` on top of the roster query this file already exercises, so a render on `/` is
 * measurably slower than its `/agents` twin. Under load that gap crosses 1000ms and the default
 * times out around 1010ms — not a logic bug (data is never cleared or corrupted through the error
 * transition; this was checked with a `Profiler`), just too little headroom for a busy machine. Do
 * not remove this as a redundant-looking argument: every `findByText` in a test that renders `/`
 * needs it, and roster-only tests do not, because they never mount `Composer`.
 */
const HOME_FIND_TIMEOUT = { timeout: 5000 };

/** `/`'s component makes no `Route.useSearch()` / `Route.useNavigate()` call of its own, so mounting
 *  it directly as a memory router's root is enough — no ancestor chain to reconstruct. */
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

/**
 * The roster has no route of its own any more: `/agents` redirects into the Marketplace, whose
 * Agents tab draws `AgentRoster`. The roster reads nothing off a route — its cards and its
 * "Create new Bot" are `Link`s — so a bare root route is enough for it, as it is for `/`.
 */
function renderRoster(queryClient: QueryClient) {
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({ component: () => <AgentRoster /> }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

test("a failed roster on the roster reports the failure, not an empty roster", async () => {
  const view = renderRoster(failingQueryClient());

  expect(await view.findByText("Your agents couldn't be loaded.")).toBeTruthy();
  expect(
    await view.findByText("Agents shared with you couldn't be loaded."),
  ).toBeTruthy();

  // The whole point: a person with agents must never be told they have none because the request
  // that would have proven otherwise never came back.
  expect(view.queryByText("You don't have any agents created.")).toBeNull();
  expect(
    view.queryByText("Nobody has shared an agent with you yet."),
  ).toBeNull();
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

  // The composer goes `disabled={!fallback}` on the very same failure, with nothing on screen
  // saying why unless this alert renders.
  expect(
    await view.findByText(
      "Your coworkers couldn't be loaded, so there's no one to send this to yet.",
      {},
      HOME_FIND_TIMEOUT,
    ),
  ).toBeTruthy();
});

test("both roster sections hold a skeleton while the roster is pending, not an empty state", async () => {
  // A fetch that never settles is `isPending` forever — the state each section's loading arm
  // renders once the router has finished its own (also async) initial match, which is why this
  // still waits rather than reading `view.container` on the very next line.
  global.fetch = (() =>
    new Promise<Response>(() => {})) as unknown as typeof fetch;

  const view = renderRoster(failingQueryClient());

  const skeletons = await waitFor(() => {
    const found = view.container.querySelectorAll('[data-slot="skeleton"]');
    expect(found.length).toBe(2);
    return found;
  });
  expect(skeletons.length).toBe(2);

  // A skeleton sitting beside a premature empty or error sentence would be no fix at all: the
  // point is that loading reserves the section's height instead of claiming an answer it doesn't
  // have yet.
  expect(view.queryByText("You don't have any agents created.")).toBeNull();
  expect(
    view.queryByText("Nobody has shared an agent with you yet."),
  ).toBeNull();
  expect(view.queryByText("Your agents couldn't be loaded.")).toBeNull();
  expect(
    view.queryByText("Agents shared with you couldn't be loaded."),
  ).toBeNull();
});

/*
 * The three tests above all exercise a query that has NEVER succeeded: `isPending` and `isError`
 * both come from a first attempt. TanStack Query keeps a query's last good `data` across a failed
 * BACKGROUND refetch — the library's own comment on that code path reads "flag existing data as
 * invalidated if we get a background error" — so `isError === true` beside a perfectly good,
 * previously-loaded roster is an ordinary state, not the one the tests above cover. Both screens
 * used to let `failed` outrank the populated-list check regardless of which of these two `isError`
 * causes produced it, which replaced a working roster with an error card, and on `/` also showed an
 * alert claiming the composer had nothing to send to while it was, in fact, still enabled.
 */
test("a failed REFETCH on the roster keeps the roster it already had, not the error", async () => {
  const mine = agent({ id: "mine-1", name: "Mine Agent", mine: true });
  const shared = agent({
    id: "shared-1",
    name: "Shared Agent",
    mine: false,
    visibility: "public",
  });
  const queryClient = staleQueryClient([mine, shared]);

  const view = renderRoster(queryClient);
  await waitForFailedRefetch(queryClient);

  expect(await view.findByText("Mine Agent")).toBeTruthy();
  expect(await view.findByText("Shared Agent")).toBeTruthy();
  expect(view.queryByText("Your agents couldn't be loaded.")).toBeNull();
  expect(
    view.queryByText("Agents shared with you couldn't be loaded."),
  ).toBeNull();
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
  // Only renders while `fallback` is set, which the retained roster still supplies — the direct
  // evidence that the composer is not the disabled, nothing-to-send-to state its alert describes.
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

/*
 * A failed REFETCH can also land on cache that is ASYMMETRIC: one slice populated, its sibling
 * genuinely empty. `?.length` cannot tell "loaded, and this slice is empty" apart from "never
 * loaded" — both read as falsy — so gating the destructive arm on `failed` alone (once the
 * populated-list check above it doesn't fire) puts the "couldn't be loaded" card on the empty
 * sibling, right beside a section rendering real cards from that very same query. The real cards
 * are the proof: the response came back, and this slice of it is just empty.
 */
test("a failed REFETCH on the roster with one empty slice shows it as empty, not broken", async () => {
  const mine = agent({ id: "mine-1", name: "Mine Agent", mine: true });
  const queryClient = staleQueryClient([mine]);

  const view = renderRoster(queryClient);
  await waitForFailedRefetch(queryClient);

  expect(await view.findByText("Mine Agent")).toBeTruthy();
  expect(
    await view.findByText("Nobody has shared an agent with you yet."),
  ).toBeTruthy();
  expect(
    view.queryByText("Agents shared with you couldn't be loaded."),
  ).toBeNull();
});

test("a failed REFETCH on the roster with the other slice empty also shows it as empty", async () => {
  const shared = agent({
    id: "shared-1",
    name: "Shared Agent",
    mine: false,
    visibility: "public",
  });
  const queryClient = staleQueryClient([shared]);

  const view = renderRoster(queryClient);
  await waitForFailedRefetch(queryClient);

  expect(await view.findByText("Shared Agent")).toBeTruthy();
  expect(
    await view.findByText("You don't have any agents created."),
  ).toBeTruthy();
  expect(view.queryByText("Your agents couldn't be loaded.")).toBeNull();
});

/*
 * Hiding a coworker takes it off both rosters, and Unhide is only in its dialog, which only a card
 * opens. These serve the two list requests from their real URLs so the hidden roster arrives the
 * way the server sends it: `GET /api/agents?hidden=true`.
 */
function servingRosters(visible: AgentProfile[], hidden: AgentProfile[]) {
  global.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const agents = url.includes("hidden=true") ? hidden : visible;
    return Response.json({ agents });
  }) as unknown as typeof fetch;
}

test("a hidden coworker is on the roster under Hidden, collapsed, with a card that opens it", async () => {
  const mine = agent({ id: "mine-1", name: "Mine Agent" });
  const tucked = agent({ id: "hidden-1", name: "Tucked Agent", hidden: true });
  servingRosters([mine], [tucked]);

  const view = renderRoster(failingQueryClient());

  expect(await view.findByText("Hidden")).toBeTruthy();
  const section = view.container.querySelector("details");
  expect(section).not.toBeNull();
  // Collapsed until asked for, so it does not push the two rosters apart.
  expect(section?.open).toBe(false);
  // Inside the section rather than in either roster above it.
  expect(section?.textContent).toContain("Tucked Agent");
  expect(section?.textContent).not.toContain("Mine Agent");
  // The card's own Details link is the way to the dialog that holds Unhide.
  const link = view.getByLabelText("View details for Tucked Agent");
  expect(link.getAttribute("href")).toBe(
    "/marketplace?tab=agents&agent=hidden-1",
  );
});

test("with nothing hidden, the roster has no Hidden section at all", async () => {
  servingRosters([agent({ id: "mine-1", name: "Mine Agent" })], []);
  const queryClient = failingQueryClient();

  const view = renderRoster(queryClient);

  expect(await view.findByText("Mine Agent")).toBeTruthy();
  // Absent because the hidden roster came back empty, not because it has not come back yet.
  await waitFor(() => {
    expect(queryClient.getQueryState(agentKeys.list(true))?.status).toBe(
      "success",
    );
  });
  expect(view.queryByText("Hidden")).toBeNull();
  expect(view.container.querySelector("details")).toBeNull();
});

test("a pinned coworker moves into Pinned at the top, out of its roster", async () => {
  const kept = agent({ id: "mine-1", name: "Kept Agent" });
  const favourite = agent({ id: "mine-2", name: "Favourite", pinned: true });
  servingRosters([kept, favourite], []);

  const view = renderRoster(failingQueryClient());

  expect(await view.findByText("Pinned")).toBeTruthy();
  const headings = [...view.container.querySelectorAll("h2")].map(
    (heading) => heading.textContent,
  );
  expect(headings).toEqual(["Pinned", "Your agents", "Explore agents"]);
  // Once, in Pinned, rather than twice.
  expect(view.getAllByText("Favourite")).toHaveLength(1);
  const pinnedSection = view.getByText("Pinned").parentElement;
  expect(pinnedSection?.textContent).toContain("Favourite");
  expect(pinnedSection?.textContent).not.toContain("Kept Agent");
});

test("with every coworker of yours pinned, Your agents says so instead of claiming none", async () => {
  servingRosters(
    [agent({ id: "mine-1", name: "Favourite", pinned: true })],
    [],
  );

  const view = renderRoster(failingQueryClient());

  expect(
    await view.findByText("Your agents are all pinned above."),
  ).toBeTruthy();
  expect(view.queryByText("You don't have any agents created.")).toBeNull();
});

test("with nothing pinned, the roster has no Pinned section", async () => {
  servingRosters([agent({ id: "mine-1", name: "Mine Agent" })], []);

  const view = renderRoster(failingQueryClient());

  expect(await view.findByText("Mine Agent")).toBeTruthy();
  expect(view.queryByText("Pinned")).toBeNull();
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
  // `agents` loaded (it holds "Mine Agent"), so `fallback` falls back to it and the composer is
  // enabled — the alert claiming a load failure must not appear beside that working composer.
  expect(
    view.queryByText(
      "Your coworkers couldn't be loaded, so there's no one to send this to yet.",
    ),
  ).toBeNull();
});
