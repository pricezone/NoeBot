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
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";
import { Route as ChannelNewRoute } from "@/routes/_authed/_app/channel/new";

beforeAll(() => GlobalRegistrator.register());

afterEach(() => cleanup());

afterAll(() => GlobalRegistrator.unregister());

function agent(
  overrides: Partial<AgentProfile> & { id: string },
): AgentProfile {
  return {
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
    pinned: false,
    mine: true,
    name: "Agent",
    roleDescription: "Role",
    systemOwned: false,
    title: "Title",
    visibility: "private",
    ...overrides,
  };
}

function queryClientWithAgents(agents: AgentProfile[]) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Number.POSITIVE_INFINITY,
      },
    },
  });
  queryClient.setQueryData(agentKeys.list(false), agents);
  return queryClient;
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
const routeTree = rootRoute.addChildren([
  authedRoute.addChildren([appRoute.addChildren([testChannelNewRoute])]),
]);

function renderChannelNew(queryClient: QueryClient) {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/channel/new"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

const GENERAL_ASSISTANT = agent({
  id: "general-assistant",
  name: "General Assistant",
  title: "Everyday work",
});

/**
 * The two rows are the only way into making a Bot or a group from here, so the To: menu must carry
 * both. They act in place now — one makes a Bot in one click, the other turns the field into a list
 * of Bots — so they are buttons rather than links away.
 */
async function expectActionLinks(view: ReturnType<typeof render>) {
  await view.findByRole("button", { name: "Create new Bot" });
  await view.findByRole("button", { name: "Create group chat" });
}

test("/channel/new offers Create new Bot and Create group chat while no Bot is picked", async () => {
  // With nobody to default to, the picker opens on its own and the rows are its first offer.
  const view = renderChannelNew(queryClientWithAgents([]));

  await expectActionLinks(view);
});

test("/channel/new keeps the rows in the opened menu until a name is typed", async () => {
  const view = renderChannelNew(queryClientWithAgents([GENERAL_ASSISTANT]));
  const user = userEvent.setup({ document: view.container.ownerDocument });

  // The default Bot answers the field, so the menu waits to be opened.
  const input = await view.findByRole("combobox");
  expect(view.queryByRole("button", { name: "Create group chat" })).toBeNull();

  await user.click(input);
  await expectActionLinks(view);
  await view.findByRole("option", { name: /General Assistant/ });

  // Typing a name of one's own narrows the list to Bots; the rows step aside.
  await user.clear(input);
  await user.type(input, "Gen");
  await waitFor(() =>
    expect(
      view.queryByRole("button", { name: "Create group chat" }),
    ).toBeNull(),
  );

  // Clearing the search brings them back. Deleted a key at a time, the way a person clears it:
  // happy-dom's select-all-and-delete reaches neither React's change handler nor Base UI's.
  await user.type(input, "{Backspace}{Backspace}{Backspace}");
  await expectActionLinks(view);
});
