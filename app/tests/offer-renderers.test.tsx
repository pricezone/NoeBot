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
import { offerRenderers } from "@/lib/copilot/suggestion-tools";

/**
 * The Marketplace offer card as CopilotKit draws it, render props and all.
 *
 * Found live: the render props carry an `agentId` of their own, undefined, and the wrapper spread
 * them over the Bot's id. The card then read `agentId.length` on undefined and crashed ("could not
 * be drawn"), and the run waited on a card nobody could answer. The Bot's id must win.
 */
beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());
afterEach(() => cleanup());

const originalFetch = global.fetch;
const requested: string[] = [];
beforeEach(() => {
  requested.length = 0;
  global.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requested.push(url);
    if (url.includes("/api/suggestions/marketplace/48677658")) {
      return new Response(
        JSON.stringify({
          item: {
            id: "48677658",
            kind: "plugin",
            name: "GitHub",
            summary: "Manage repos, issues, pull requests, and Actions.",
            eligibility: "needs-account",
            skillsCount: 0,
            target: { kind: "plugin", pluginId: "48677658" },
            held: false,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
});
afterAll(() => {
  global.fetch = originalFetch;
});

test("the Marketplace card reads the item for the Bot it was given, whatever agentId the render props carry", async () => {
  const { ItemCard } = offerRenderers("bot-1");
  const renderProps = {
    agentId: undefined,
    name: "offer_marketplace_item",
    status: "executing",
    args: { id: "48677658", reason: "Manage your repos from here." },
    respond: async () => undefined,
    result: undefined,
  };
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({
      component: () => (
        <ItemCard
          {...(renderProps as unknown as Parameters<typeof ItemCard>[0])}
        />
      ),
    }),
  });
  const view = render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );

  await waitFor(() =>
    expect(
      view.getByText("GitHub is available in the Marketplace."),
    ).toBeTruthy(),
  );
  expect(view.getByText("Open to connect")).toBeTruthy();
  expect(
    requested.some((url) =>
      url.includes("/api/suggestions/marketplace/48677658?agentId=bot-1"),
    ),
  ).toBe(true);
});
