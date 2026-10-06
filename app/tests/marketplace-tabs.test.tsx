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
import { clearReturnTo } from "@/lib/return-to";
import { Route as MarketplaceRoute } from "@/routes/_authed/_app/marketplace/index";

/**
 * The Marketplace modal: which tab is open comes from `?tab`, the search field is `?q`, Connect
 * leads to the account's own settings page, and Composio's directory is drawn for an
 * administrator only — the server refuses that read to anybody else, so the section is not
 * offered to them rather than offered and failing.
 *
 * The route is rendered through its real, exported `Route`, attached to decoy pathless
 * `_authed`/`_app` parents so `Route.useSearch()` resolves at the id the file declares. The
 * singleton's own state is captured and restored around each render for the reason
 * `agent-roster-error.test.tsx` recorded before it stopped needing to: `.update()` merges into the
 * live object and `createRouter()` derives state off it, so a render here would otherwise leave
 * the real router pointed at a decoy parent.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(() => {
  cleanup();
  clearReturnTo();
});
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

/** Whose Marketplace this is. Set per test before rendering. */
let role: "admin" | "user" = "user";

beforeEach(() => {
  role = "user";
  global.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
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
            role,
            onboarding: null,
          },
        });
      }
      if (path === "/api/plugins") {
        return json({
          catalogue: [
            {
              key: "google-drive",
              title: "Google Drive",
              vendor: "Google",
              summary: "Files and folders.",
              docsUrl: "https://example.com",
              auth: "user-oauth",
              perInstance: false,
            },
          ],
          servers: [
            {
              id: "google-drive",
              title: "Google Drive",
              vendor: "Google",
              url: "https://drive.example",
              summary: "Files and folders.",
              docsUrl: "https://example.com",
              provenance: "first-party",
              hasCredential: false,
              toolsRefreshedAt: null,
              authScheme: null,
              tools: [],
            },
            {
              id: "composio-gmail",
              title: "Gmail",
              logo: "https://logo.example/gmail.png",
              vendor: "Composio",
              url: "composio://gmail",
              summary: "Mail and labels.",
              docsUrl: "https://example.com",
              provenance: "composio",
              hasCredential: false,
              toolsRefreshedAt: null,
              authScheme: "OAUTH2",
              tools: [],
            },
          ],
          skills: [],
          botsMayCallBack: true,
          redirectUri: null,
          composioConfigured: true,
        });
      }
      if (path === "/api/plugins/connections") {
        return json({
          connections: [
            {
              serverId: "composio-gmail",
              scope: "",
              connectedAt: "2026-01-01",
            },
          ],
          redirectUri: null,
        });
      }
      if (path === "/api/plugins/composio/apps") {
        return json({
          apps: [
            {
              slug: "slack",
              name: "Slack",
              description: "Messages, channels and files.",
              logo: null,
              categories: [],
              actionCount: 167,
              enabled: false,
            },
          ],
        });
      }
      if (path === "/api/agents") return json({ agents: [] });
      return new Response(null, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
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

const pristineRouteState = captureRouteState(MarketplaceRoute);
let routeSnapshot: Record<string, unknown>;

beforeEach(() => {
  routeSnapshot = captureRouteState(pristineRouteState);
});

afterEach(() => {
  restoreRouteState(MarketplaceRoute, routeSnapshot);
});

/** The Marketplace at `href`, under the id its `Route.useSearch()` reads: `/_authed/_app/marketplace/`. */
function renderMarketplace(href: string) {
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
  const wired = (
    MarketplaceRoute as unknown as {
      update: (options: unknown) => typeof MarketplaceRoute;
    }
  ).update({
    id: "/marketplace/",
    path: "/marketplace/",
    getParentRoute: () => appRoute,
  });
  const home = createRoute({
    path: "/",
    getParentRoute: () => appRoute,
    component: () => <p>Home</p>,
  });
  const tree = rootRoute.addChildren([
    authedRoute.addChildren([appRoute.addChildren([home, wired])]),
  ]);
  const router = createRouter({
    routeTree: tree,
    history: createMemoryHistory({ initialEntries: [href] }),
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
  return { view, router };
}

test("the Apps tab is the default, with Connect leading to the account's settings page", async () => {
  const { view } = renderMarketplace("/marketplace");

  await view.findByRole("dialog", { name: "Marketplace" });
  const apps = await view.findByRole("tab", { name: "Apps" });
  expect(apps.getAttribute("aria-selected")).toBe("true");

  // The connected account under Connected, the rest under Available. Each action is a link
  // named for its app, so a list of them reads as which-is-which rather than "Connect" ten times.
  const gmail = await view.findByTestId("account-composio-gmail");
  expect(
    within(gmail).getByRole("link", { name: /connected, manage/ }),
  ).toBeTruthy();
  const drive = await view.findByTestId("account-google-drive");
  const connect = within(drive).getByRole("link", { name: /^Connect / });
  expect(connect.getAttribute("href")).toBe(
    "/settings/connected-accounts/google-drive",
  );
  expect(view.getByRole("region", { name: "Connected" })).toBeTruthy();
  expect(view.getByRole("region", { name: "Available" })).toBeTruthy();

  // The installed cluster counts the connections and opens the settings page.
  const cluster = await view.findByTestId("installed-cluster");
  expect(cluster.textContent).toContain("1 installed");
  expect(cluster.getAttribute("href")).toBe("/settings/connected-accounts");
});

test("?tab picks the tab, and clicking another writes it back to the URL", async () => {
  const { view, router } = renderMarketplace("/marketplace?tab=skills");

  const skills = await view.findByRole("tab", { name: "Skills" });
  expect(skills.getAttribute("aria-selected")).toBe("true");
  expect(await view.findByText("Your skills")).toBeTruthy();
  expect(view.queryByTestId("account-google-drive")).toBeNull();

  const user = userEvent.setup({ document: view.baseElement.ownerDocument });
  await user.click(view.getByRole("tab", { name: "Agents" }));
  await waitFor(() =>
    expect((router.state.location.search as { tab?: string }).tab).toBe(
      "agents",
    ),
  );
  expect(await view.findByText("Your agents")).toBeTruthy();
});

test("?q fills the search and narrows the apps; typing writes ?q back", async () => {
  const { view, router } = renderMarketplace("/marketplace?q=mail");

  const search = await view.findByRole("textbox", { name: "Search plugins" });
  expect((search as HTMLInputElement).value).toBe("mail");
  await view.findByTestId("account-composio-gmail");
  expect(view.queryByTestId("account-google-drive")).toBeNull();

  const user = userEvent.setup({ document: view.baseElement.ownerDocument });
  await user.clear(search);
  await user.type(search, "drive");
  await waitFor(() =>
    expect((router.state.location.search as { q?: string }).q).toBe("drive"),
  );
  expect(await view.findByTestId("account-google-drive")).toBeTruthy();
  expect(view.queryByTestId("account-composio-gmail")).toBeNull();
});

test("Featured plugins is drawn for an administrator and not for anybody else", async () => {
  const asUser = renderMarketplace("/marketplace");
  await asUser.view.findByTestId("account-google-drive");
  expect(asUser.view.queryByText("Featured plugins")).toBeNull();
  cleanup();

  role = "admin";
  const asAdmin = renderMarketplace("/marketplace");
  expect(await asAdmin.view.findByText("Featured plugins")).toBeTruthy();
  const slack = await asAdmin.view.findByTestId("composio-slack");
  expect(within(slack).getByRole("button", { name: "Add" })).toBeTruthy();
});

test("closing the modal leaves for the remembered location, the home route by default", async () => {
  const { view, router } = renderMarketplace("/marketplace?tab=agents");
  await view.findByRole("dialog", { name: "Marketplace" });
  const user = userEvent.setup({ document: view.baseElement.ownerDocument });
  await user.click(view.getByRole("button", { name: "Close" }));
  await waitFor(() => expect(router.state.location.pathname).toBe("/"));
});
