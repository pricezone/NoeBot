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
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route as ConnectedAccountRoute } from "@/routes/_authed/_app/settings/connected-accounts/$key";

/**
 * A person's own page for one vendor reached as them, with no administrator step in front of it.
 *
 * The page used to withhold Connect until an administrator had added the server row, because the
 * row was where the OAuth client lived; a person arriving before that read "An administrator has
 * not enabled this connector" over a button that would not press. The platform provides the
 * client now and the connect route adds the row itself, so there is no state in which the button
 * is withheld — and the one refusal that still exists, a vendor the platform has no client for
 * yet, arrives as the server's own sentence and is shown where the person is looking.
 *
 * THE HARNESS IS THIS REPOSITORY'S, from `plugin-read-failure.test.tsx`: `GlobalRegistrator` in
 * `beforeAll`/`afterAll`, `cleanup` in `afterEach`, a `QueryClient` with `retry: false`, and the
 * exported `Route` singleton captured and restored around its `.update()`.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const APP_KEY = "google-drive";

/** What the server says about Drive while the platform's client is not configured. */
const NO_CLIENT =
  "Google Drive is not available on this deployment yet: the platform has no OAuth client configured for it. Try again later.";

const originalFetch = global.fetch;

/** Whether this person already holds a Drive connection. Set per test before rendering. */
let connected = false;
/** Every POST the deployment received, as `method path`. */
let writes: string[];

beforeEach(() => {
  connected = false;
  writes = [];
  global.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).split("?")[0] ?? "";
      const method = init?.method ?? "GET";
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });
      if (method === "POST") writes.push(`${method} ${path}`);
      if (path === "/api/plugins") {
        return json({
          catalogue: [
            {
              key: APP_KEY,
              title: "Google Drive",
              vendor: "Google",
              summary: "Files in the Drive of whoever is asking.",
              docsUrl: "https://example.com",
              auth: "user-oauth",
              perInstance: false,
            },
          ],
          // NO ROW. Nobody has touched this vendor on this deployment, and that must not matter.
          servers: [],
          skills: [],
          botsMayCallBack: true,
          redirectUri: "http://localhost/api/plugins/oauth/callback",
          composioConfigured: false,
        });
      }
      if (path === "/api/plugins/connections") {
        return json({
          connections: connected
            ? [
                {
                  serverId: APP_KEY,
                  scope: "https://www.googleapis.com/auth/drive.readonly",
                  connectedAt: "2026-01-01T00:00:00.000Z",
                },
              ]
            : [],
          redirectUri: "http://localhost/api/plugins/oauth/callback",
        });
      }
      if (path === `/api/plugins/servers/${APP_KEY}/connect`) {
        return json({ error: NO_CLIENT }, 409);
      }
      return new Response(null, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});

afterEach(() => {
  global.fetch = originalFetch;
});

function captureRouteState(route: object): Record<string, unknown> {
  return { ...route, options: { ...(route as { options: object }).options } };
}

function restoreRouteState(
  route: object,
  snapshot: Record<string, unknown>,
): void {
  for (const key of Object.keys(route)) {
    if (!(key in snapshot)) {
      delete (route as Record<string, unknown>)[key];
    }
  }
  Object.assign(route, snapshot);
}

const pristine = captureRouteState(ConnectedAccountRoute);
let snapshot: Record<string, unknown>;

beforeEach(() => {
  snapshot = captureRouteState(pristine);
});

afterEach(() => {
  restoreRouteState(ConnectedAccountRoute, snapshot);
});

/** `/settings/connected-accounts/$key`, at the id its `useParams` reads. */
function renderAccount() {
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
  const settingsRoute = createRoute({
    path: "/settings",
    getParentRoute: () => appRoute,
    component: Outlet,
  });
  const indexRoute = createRoute({
    path: "/connected-accounts/",
    getParentRoute: () => settingsRoute,
    component: () => null,
  });
  const account = (
    ConnectedAccountRoute as unknown as {
      update: (options: unknown) => typeof ConnectedAccountRoute;
    }
  ).update({
    id: "/connected-accounts/$key",
    path: "/connected-accounts/$key",
    getParentRoute: () => settingsRoute,
  });
  const tree = rootRoute.addChildren([
    authedRoute.addChildren([
      appRoute.addChildren([settingsRoute.addChildren([indexRoute, account])]),
    ]),
  ]);
  const router = createRouter({
    routeTree: tree,
    history: createMemoryHistory({
      initialEntries: [`/settings/connected-accounts/${APP_KEY}`],
    }),
  });
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

test("Connect is live with no server row behind it, and a 409 is shown in the server's words, not as a dead end", async () => {
  const view = renderAccount();

  // Exact, because the page's back button is named "Connected accounts".
  const connect = (await view.findByRole("button", {
    name: "Connect",
  })) as HTMLButtonElement;
  expect(connect.disabled).toBe(false);
  expect(
    view.queryByText(/An administrator has not enabled this connector/),
  ).toBeNull();
  expect(view.getByText(/No Bot can read this as you/)).toBeTruthy();

  const user = userEvent.setup({ document: view.baseElement.ownerDocument });
  await user.click(connect);

  const alert = await view.findByRole("alert");
  expect(alert.textContent).toBe(NO_CLIENT);
  expect(writes).toEqual([`POST /api/plugins/servers/${APP_KEY}/connect`]);
  // Still there to press again once the platform's client is configured.
  await waitFor(() => {
    expect(
      (view.getByRole("button", { name: "Connect" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });
});

test("a connected account says every Bot can use it as you", async () => {
  connected = true;
  const view = renderAccount();

  expect(
    await view.findByText(
      "Every Bot can use this as you. It sees only what you can see.",
    ),
  ).toBeTruthy();
  // Exact, because the page's back button is named "Connected accounts".
  expect(view.getByRole("button", { name: "Connected" })).toBeTruthy();
  expect(view.queryByRole("button", { name: "Connect" })).toBeNull();
});
