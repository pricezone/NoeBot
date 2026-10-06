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
import type { ComponentType } from "react";
import { EditSkill } from "@/components/skills/edit-skill";
import { SkillsSections } from "@/components/skills/skills-sections";
import { type PluginsPage, pluginKeys } from "@/lib/plugins/queries";
import { Route as AdminSkillsRoute } from "@/routes/_authed/admin/skills";

/**
 * The three places skills are listed or opened, when `GET /api/plugins` fails.
 *
 * Each read `data?.skills ?? []` once `isPending` was false, and `isPending` goes false on a failed
 * fetch exactly as it does on a successful one: a request that never came back was drawn as "You
 * don't have any skills yet.", "No skills yet." and "That skill no longer exists", to people who
 * may have written a dozen. `agent-roster-error.test.tsx` is the same mistake on the agent screens.
 *
 * Only the plugins read fails here; who is signed in and the roster answer.
 *
 * THE HARNESS IS THIS REPOSITORY'S, as in `agent-roster-error.test.tsx` and
 * `boundaries-read-failure.test.tsx`: `GlobalRegistrator` in `beforeAll`/`afterAll`, `cleanup` in
 * `afterEach`, queries off `render()`'s own return, and a `QueryClient` with `retry: false`. The
 * personal list is `SkillsSections`, the component the Marketplace's Skills tab draws since
 * `/skills` became a redirect, rendered on its own under a bare root route.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = global.fetch;

beforeEach(() => {
  global.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0]) => {
      const path = String(input).split("?")[0];
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          headers: { "content-type": "application/json" },
        });
      if (path === "/api/me") {
        return json({
          user: {
            id: "user-1",
            email: "person@example.com",
            role: "admin",
            onboarding: null,
          },
        });
      }
      if (path === "/api/agents") return json({ agents: [] });
      // The one read under test: a 500 with no body, the shape a broken server sends.
      return new Response(null, { status: 500 });
    },
    { preconnect: originalFetch.preconnect },
  );
});

afterEach(() => {
  global.fetch = originalFetch;
});

/** A client the failing query settles on in one attempt, so no test waits on a retry. */
function failingQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

/** A client already holding a plugins page with no skills in it: the honest empty answer. */
function answeredEmpty() {
  const client = failingQueryClient();
  const page: PluginsPage = {
    catalogue: [],
    servers: [],
    skills: [],
    botsMayCallBack: true,
    redirectUri: null,
    composioConfigured: false,
  };
  client.setQueryData(pluginKeys.page(), page);
  return client;
}

async function waitForFailedRead(client: QueryClient) {
  await waitFor(() => {
    expect(client.getQueryState(pluginKeys.page())?.status).toBe("error");
  });
}

/** A component that reads no route of its own, drawn under a root route for `Link`/`useNavigate`. */
function renderAlone(client: QueryClient, Component: ComponentType) {
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({ component: () => <Component /> }),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

test("a person's skills list says the skills failed to load, not that they have none", async () => {
  const client = failingQueryClient();
  const view = renderAlone(client, SkillsSections);
  await waitForFailedRead(client);

  expect(
    await view.findByText("Your skills could not be loaded."),
  ).toBeTruthy();
  expect(view.queryByText("You don't have any skills yet.")).toBeNull();
});

test("a person with genuinely no skills is still told so", async () => {
  const client = answeredEmpty();
  const view = renderAlone(client, SkillsSections);
  await waitForFailedRead(client);

  expect(await view.findByText("You don't have any skills yet.")).toBeTruthy();
  expect(view.queryByText("Your skills could not be loaded.")).toBeNull();
});

test("the admin skills page says the skills failed to load, not that there are none", async () => {
  const client = failingQueryClient();
  const view = renderAlone(
    client,
    AdminSkillsRoute.options.component as ComponentType,
  );
  await waitForFailedRead(client);

  expect(await view.findByText("Skills could not be loaded.")).toBeTruthy();
  expect(view.queryByText("No skills yet.")).toBeNull();
});

test("a deployment with genuinely no skills still says so on the admin page", async () => {
  const client = answeredEmpty();
  const view = renderAlone(
    client,
    AdminSkillsRoute.options.component as ComponentType,
  );
  await waitForFailedRead(client);

  expect(await view.findByText("No skills yet.")).toBeTruthy();
  expect(view.queryByText("Skills could not be loaded.")).toBeNull();
});

test("opening a skill to edit says it failed to load, not that it no longer exists", async () => {
  const client = failingQueryClient();
  const view = renderAlone(client, () => <EditSkill slug="triage" />);
  await waitForFailedRead(client);

  expect(await view.findByText("This skill could not be loaded.")).toBeTruthy();
  expect(
    view.queryByText(
      "That skill no longer exists, or it is not yours to edit.",
    ),
  ).toBeNull();
});
