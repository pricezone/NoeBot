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
import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  grantSummary,
  Route as AdminAppRoute,
} from "@/routes/_authed/admin/plugins/$key";
import { Route as AdminToolRoute } from "@/routes/_authed/admin/plugins/$key_.tools.$tool";

/**
 * What the Marketplace's one-press arrangement looks like from the admin side.
 *
 * An app connected or enabled from the Marketplace is offered to every Bot with no grant, and the
 * Plugins screens are where an administrator narrows that. So the connector page carries an
 * "Offered to every Bot" switch, its tool rows say "Every Bot" rather than counting grants that
 * are not the decision, and the per-tool page draws every Bot's switch on and immovable with the
 * same caption beside it. The OAuth client row, for a vendor whose client the platform provides,
 * states that rather than offering a paste form over a client nobody here can rotate.
 *
 * THE HARNESS IS THIS REPOSITORY'S, from `plugin-read-failure.test.tsx`: `GlobalRegistrator` in
 * `beforeAll`/`afterAll`, `cleanup` in `afterEach`, a `QueryClient` with `retry: false`, and each
 * exported `Route` singleton captured and restored around its `.update()`. The deployment is a
 * small in-memory one, because the switch is a sequence — pressed, written, read back.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const APP_KEY = "google-drive";
const TOOL_NAME = "search_files";
const BOT_ID = "bot-1";
const originalFetch = global.fetch;

/** Whether the deployment offers Drive to every Bot. Set per test before rendering. */
let offered = false;
/** Every POST the deployment received, as `method path body`. */
let writes: string[];

beforeEach(() => {
  offered = false;
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
      if (method === "POST") {
        const body = typeof init?.body === "string" ? init.body : "";
        writes.push(`${method} ${path} ${body}`.trim());
      }
      if (
        method === "POST" &&
        path === `/api/plugins/servers/${APP_KEY}/offer-to-all`
      ) {
        const body = JSON.parse(String(init?.body)) as { on: boolean };
        offered = body.on;
        return json({ server: server() });
      }
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
          servers: [server()],
          skills: [],
          botsMayCallBack: true,
          redirectUri: "http://localhost/api/plugins/oauth/callback",
          composioConfigured: false,
        });
      }
      if (path === "/api/plugins/connections") {
        return json({ connections: [], redirectUri: null });
      }
      if (path === "/api/agents") {
        const bots = [
          { id: BOT_ID, name: "Ada", hidden: false, hasCallbackToken: true },
        ];
        return json({
          agents: String(input).includes("hidden=true") ? [] : bots,
        });
      }
      return new Response(null, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});

afterEach(() => {
  global.fetch = originalFetch;
});

/** The Drive row as the deployment holds it now, one tool granted to nobody. */
function server() {
  return {
    id: APP_KEY,
    title: "Google Drive",
    vendor: "Google",
    url: "https://www.googleapis.com/drive/v3",
    summary: "Files in the Drive of whoever is asking.",
    docsUrl: "https://example.com",
    provenance: "first-party",
    hasCredential: false,
    toolsRefreshedAt: null,
    lastError: null,
    addedBy: null,
    dynamicClient: false,
    authScheme: null,
    offeredToAllBots: offered,
    oauthClientSource: "env",
    tools: [
      {
        serverId: APP_KEY,
        name: TOOL_NAME,
        description: "Find files by name.",
        inputSchema: {},
        ref: `${APP_KEY}/${TOOL_NAME}`,
        effect: "read",
        destructive: false,
        grantedTo: [],
      },
    ],
    withdrawn: [],
  };
}

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

const routes = [AdminAppRoute, AdminToolRoute];
const pristine = routes.map(captureRouteState);
let snapshots: Record<string, unknown>[] = [];

beforeEach(() => {
  snapshots = pristine.map(captureRouteState);
});

afterEach(() => {
  routes.forEach((route, index) => {
    restoreRouteState(route, snapshots[index] ?? {});
  });
});

type Updatable = { update: (options: unknown) => unknown };

/** `/admin/plugins/$key` and `/admin/plugins/$key/tools/$tool`, at the ids their `useParams` read. */
function renderAdmin(at: string) {
  const rootRoute = createRootRoute({ component: Outlet });
  const authedRoute = createRoute({
    id: "/_authed",
    getParentRoute: () => rootRoute,
    component: Outlet,
  });
  const adminRoute = createRoute({
    path: "/admin",
    getParentRoute: () => authedRoute,
    component: Outlet,
  });
  const pluginsRoute = createRoute({
    path: "/plugins/",
    getParentRoute: () => adminRoute,
    component: () => null,
  });
  const app = (AdminAppRoute as unknown as Updatable).update({
    id: "/plugins/$key",
    path: "/plugins/$key",
    getParentRoute: () => adminRoute,
  });
  const tool = (AdminToolRoute as unknown as Updatable).update({
    id: "/plugins/$key_/tools/$tool",
    path: "/plugins/$key/tools/$tool",
    getParentRoute: () => adminRoute,
  });
  const tree = rootRoute.addChildren([
    authedRoute.addChildren([
      adminRoute.addChildren([pluginsRoute, app as never, tool as never]),
    ]),
  ]);
  const router = createRouter({
    routeTree: tree,
    history: createMemoryHistory({ initialEntries: [at] }),
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

test("the rule in words: offered to every Bot says so, whatever the grants count", () => {
  expect(grantSummary(0, 3)).toBe("No Bots");
  expect(grantSummary(3, 3)).toBe("All Bots");
  expect(grantSummary(1, 3)).toBe("1 of 3 Bots");
  expect(grantSummary(0, 3, true)).toBe("Every Bot");
  expect(grantSummary(3, 3, true)).toBe("Every Bot");
});

test("the connector page's switch writes the offer and the rows read it back as Every Bot", async () => {
  const view = renderAdmin(`/admin/plugins/${APP_KEY}`);

  const offer = await view.findByRole("switch", {
    name: "Offer Google Drive to every Bot",
  });
  expect(offer.getAttribute("aria-checked")).toBe("false");
  // Granted to nobody, and said as a count while the grants are the decision.
  expect(await view.findByText("No Bots")).toBeTruthy();
  expect(view.getByText("No tools")).toBeTruthy();

  const user = userEvent.setup({ document: view.baseElement.ownerDocument });
  await user.click(offer);

  await waitFor(() => {
    expect(
      view
        .getByRole("switch", { name: "Offer Google Drive to every Bot" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });
  expect(writes).toEqual([
    `POST /api/plugins/servers/${APP_KEY}/offer-to-all {"on":true}`,
  ]);
  expect(await view.findByText("Every Bot")).toBeTruthy();
  expect(view.queryByText("No Bots")).toBeNull();
  // And from the Bot's end: Ada holds every tool, though no grant names her.
  expect(view.getByText("Every tool")).toBeTruthy();
  expect(view.queryByRole("alert")).toBeNull();
});

test("a platform-provided OAuth client is stated, with no paste form and no redirect URI to copy", async () => {
  const view = renderAdmin(`/admin/plugins/${APP_KEY}`);

  expect(await view.findByText("Provided by HyperNoesis")).toBeTruthy();
  expect(view.queryByText("Not registered")).toBeNull();
  expect(view.queryByText("Registered")).toBeNull();
  expect(
    view.queryByText(/Add this to the client's authorised redirect URIs/),
  ).toBeNull();
  expect(
    view.queryByText("http://localhost/api/plugins/oauth/callback"),
  ).toBeNull();
  // The row is a statement, not a button: nothing opens a client dialog.
  expect(view.queryByRole("button", { name: /OAuth client/ })).toBeNull();
  // The administrator can still connect their own account to try it.
  expect(view.getByRole("button", { name: /^Connect/ })).toBeTruthy();
});

test("the per-tool page draws every Bot's switch on and immovable, captioned Every Bot", async () => {
  offered = true;
  const view = renderAdmin(`/admin/plugins/${APP_KEY}/tools/${TOOL_NAME}`);

  const held = await view.findByRole("switch", {
    name: `Let Ada call ${TOOL_NAME}`,
  });
  expect(held.getAttribute("aria-checked")).toBe("true");
  expect(held.hasAttribute("data-disabled")).toBe(true);
  const row = held.closest("[data-slot=item]") ?? view.container;
  expect(within(row as HTMLElement).getByText("Every Bot")).toBeTruthy();
  expect(view.getByText(/May call this tool/)).toBeTruthy();
  expect(
    view.getByText(/Switch “Offered to every Bot” off on the app's page/),
  ).toBeTruthy();
});

test("with the offer off, the per-tool page's switches are the decision again", async () => {
  const view = renderAdmin(`/admin/plugins/${APP_KEY}/tools/${TOOL_NAME}`);

  const held = await view.findByRole("switch", {
    name: `Let Ada call ${TOOL_NAME}`,
  });
  expect(held.getAttribute("aria-checked")).toBe("false");
  expect(held.hasAttribute("data-disabled")).toBe(false);
  expect(view.queryByText("Every Bot")).toBeNull();
});
