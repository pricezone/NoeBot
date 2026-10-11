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
 * leads to the account's own settings page, Enable works in place, and Composio's directory is
 * drawn for an administrator only — the server refuses that read to anybody else, so the section
 * is not offered to them rather than offered and failing.
 *
 * The route is rendered through its real, exported `Route`, attached to decoy pathless
 * `_authed`/`_app` parents so `Route.useSearch()` resolves at the id the file declares. The
 * singleton's own state is captured and restored around each render for the reason
 * `agent-roster-error.test.tsx` recorded before it stopped needing to: `.update()` merges into the
 * live object and `createRouter()` derives state off it, so a render here would otherwise leave
 * the real router pointed at a decoy parent.
 *
 * THE DEPLOYMENT IS A SMALL IN-MEMORY ONE rather than canned responses, because what Enable is
 * for is a sequence: pressed, written, and read back as a green row. `enabled` is the set of
 * catalogue apps the deployment has switched on for everybody, and `POST /servers/:id/enable`
 * adds to it, so the refetch the mutation triggers draws the row the press earned.
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
/** The account-less apps the deployment has enabled for everybody. Routines, to begin with. */
let enabled: Set<string>;
/** What the deployment refuses an Enable with, or null to accept it. */
let refuseEnable: { status: number; error: string } | null = null;
/** Every POST the deployment received, as `method path`. */
let writes: string[];
/** The Marketplace plugins this person has pressed Add on. */
let installedPlugins: Set<string>;
/** The plugin servers this person has handed a key to. */
let heldConnections: Set<string>;
/** What the deployment refuses an install with, or null to accept it. */
let refuseInstall: { status: number; error: string } | null = null;

/** The Marketplace index as the server serves it: one plugin of each shape, across categories. */
const MARKETPLACE = [
  {
    id: "55647425",
    slug: "treg",
    name: "Treg",
    description: "OpenRouter for tools.",
    publisher: "Superdesign",
    verified: false,
    logoUrl: "https://logo.example/treg.png",
    categories: ["RESEARCH"],
    availability: "installable",
    catalogueKey: null,
    servers: [
      {
        serverId: "treg",
        name: "treg",
        authKind: "header",
        variables: ["TREG_TOKEN"],
      },
    ],
    skills: [{ name: "treg", slug: "treg-treg" }],
  },
  {
    id: "56809965",
    slug: "ahrefs",
    name: "Ahrefs",
    description: "SEO data.",
    publisher: "Ahrefs",
    verified: true,
    logoUrl: null,
    categories: ["RESEARCH"],
    availability: "installable",
    catalogueKey: null,
    servers: [
      {
        serverId: "ahrefs",
        name: "ahrefs",
        authKind: "oauth-discover",
        variables: [],
      },
    ],
    skills: [],
  },
  ...["Crustdata", "Context.dev", "Semrush", "Parallel Web"].map(
    (name, index) => ({
      id: `9000${index}`,
      slug: name.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-"),
      name,
      description: `${name} research tools.`,
      publisher: name,
      verified: false,
      logoUrl: null,
      categories: ["RESEARCH"],
      availability: "installable",
      catalogueKey: null,
      servers: [
        {
          serverId: name.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-"),
          name: "mcp",
          authKind: "none",
          variables: [],
        },
      ],
      skills: [],
    }),
  ),
  {
    id: "49339690",
    slug: "intercom",
    name: "Intercom",
    description: "Conversations and contacts.",
    publisher: "Intercom",
    verified: true,
    logoUrl: null,
    categories: ["CUSTOMER_SUPPORT"],
    availability: "installable",
    catalogueKey: null,
    servers: [
      {
        serverId: "intercom",
        name: "intercom",
        authKind: "oauth-discover",
        variables: [],
      },
    ],
    skills: [],
  },
  {
    id: "404",
    slug: "notion-workspace",
    name: "Notion",
    description: "Pages and databases.",
    publisher: "Notion",
    verified: true,
    logoUrl: null,
    categories: ["PRODUCTIVITY"],
    availability: "catalogue",
    catalogueKey: "notion",
    servers: [],
    skills: [],
  },
];

/** The catalogue as the server publishes it: one entry of each auth kind. */
const CATALOGUE = [
  {
    key: "parallel",
    title: "Parallel Search",
    vendor: "Parallel",
    summary: "Public-web search and source extraction.",
    docsUrl: "https://example.com",
    auth: "none",
    perInstance: false,
  },
  {
    key: "parallel-authenticated",
    title: "Parallel Search (API key)",
    vendor: "Parallel",
    summary: "Public-web search using this deployment's key.",
    docsUrl: "https://example.com",
    auth: "deployment-bearer",
    perInstance: false,
  },
  {
    key: "google-drive",
    title: "Google Drive",
    vendor: "Google",
    summary: "Files and folders.",
    docsUrl: "https://example.com",
    auth: "user-oauth",
    perInstance: false,
  },
  {
    key: "notion",
    title: "Notion",
    vendor: "Notion",
    summary: "Pages and databases.",
    docsUrl: "https://example.com",
    auth: "user-oauth",
    perInstance: false,
  },
  {
    key: "parallel-oauth",
    title: "Parallel Search (your account)",
    vendor: "Parallel",
    summary: "Public-web search as your own Parallel account.",
    docsUrl: "https://example.com",
    auth: "user-oauth",
    perInstance: false,
  },
  {
    key: "routines",
    title: "Routines",
    vendor: "OpenBot",
    summary: "Standing instructions a Bot runs on a schedule.",
    docsUrl: "https://example.com",
    auth: "builtin",
    perInstance: false,
  },
];

/** A server row for a catalogue app the deployment has switched on for everybody. */
function enabledRow(key: string) {
  const entry = CATALOGUE.find((item) => item.key === key);
  return {
    id: key,
    title: entry?.title ?? key,
    vendor: entry?.vendor ?? key,
    url: `https://${key}.example`,
    summary: entry?.summary ?? "",
    docsUrl: "https://example.com",
    provenance: "first-party",
    hasCredential: false,
    toolsRefreshedAt: null,
    lastError: null,
    addedBy: null,
    dynamicClient: false,
    authScheme: null,
    offeredToAllBots: true,
    oauthClientSource: null,
    tools: [],
    withdrawn: [],
  };
}

beforeEach(() => {
  role = "user";
  enabled = new Set(["routines"]);
  refuseEnable = null;
  installedPlugins = new Set();
  heldConnections = new Set();
  refuseInstall = null;
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
      const enableMatch = path.match(
        /^\/api\/plugins\/servers\/([^/]+)\/enable$/,
      );
      if (method === "POST" && enableMatch) {
        if (refuseEnable) {
          return json({ error: refuseEnable.error }, refuseEnable.status);
        }
        const key = decodeURIComponent(enableMatch[1] ?? "");
        enabled.add(key);
        return json({ server: enabledRow(key) });
      }
      if (path === "/api/plugins") {
        return json({
          catalogue: CATALOGUE,
          servers: [
            {
              // Added already, and the platform holds its OAuth client. Still yours to connect.
              ...enabledRow("google-drive"),
              oauthClientSource: "env",
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
              lastError: null,
              addedBy: null,
              dynamicClient: false,
              authScheme: "OAUTH2",
              offeredToAllBots: true,
              oauthClientSource: null,
              tools: [],
              withdrawn: [],
            },
            ...[...enabled].map(enabledRow),
            ...[...installedPlugins].flatMap((id) =>
              (
                MARKETPLACE.find((plugin) => plugin.id === id)?.servers ?? []
              ).map((server) => ({
                ...enabledRow(server.serverId),
                title: server.serverId,
                provenance: "plugin",
                pluginId: id,
                authKind: server.authKind,
                transport: null,
                connectVariables:
                  server.authKind === "header"
                    ? server.variables.map((name) => ({
                        name,
                        description: `Your ${name}.`,
                        writeOnly: true,
                        required: true,
                      }))
                    : null,
                oauthDiscovered: false,
              })),
            ),
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
            ...[...heldConnections].map((serverId) => ({
              serverId,
              scope: "",
              connectedAt: "2026-10-11",
            })),
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
      if (path === "/api/plugins/marketplace") {
        return json({
          syncedAt: "2026-10-11T00:00:00.000Z",
          plugins: MARKETPLACE,
          installed: Object.fromEntries(
            [...installedPlugins].map((id) => [
              id,
              {
                id,
                slug: id,
                name: id,
                gitRef: "0".repeat(40),
                installedBy: "person@example.com",
                installedByUserId: "user-1",
                installedAt: "2026-10-11T00:00:00.000Z",
                serverIds:
                  MARKETPLACE.find((plugin) => plugin.id === id)?.servers.map(
                    (server) => server.serverId,
                  ) ?? [],
                skillSlugs: [],
                skipped: [],
                mine: true,
              },
            ]),
          ),
        });
      }
      const connectMatch = path.match(
        /^\/api\/plugins\/servers\/([^/]+)\/connect$/,
      );
      if (method === "POST" && connectMatch) {
        heldConnections.add(decodeURIComponent(connectMatch[1] ?? ""));
        return json({ connected: true });
      }
      if (method === "POST" && path === "/api/plugins/install") {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          pluginId?: string;
        };
        if (refuseInstall) {
          return json({ error: refuseInstall.error }, refuseInstall.status);
        }
        installedPlugins.add(body.pluginId ?? "");
        return json({ created: true });
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
  // The body is a lazy chunk, and the first test in the file pays for its compile: a longer
  // wait than the default second, rather than a test that is green or red by the machine.
  const apps = await view.findByRole(
    "tab",
    { name: "Apps" },
    { timeout: 5000 },
  );
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

  // The installed cluster counts the connections and the enabled apps, and opens the settings page.
  const cluster = await view.findByTestId("installed-cluster");
  expect(cluster.textContent).toContain("2 installed");
  expect(cluster.getAttribute("href")).toBe("/settings/connected-accounts");
});

/*
 * No administrator step stands before Connect. A vendor reached as you is offered whether or not
 * anybody has added a row for it — the connect route adds the row itself — so Notion, which has
 * no row here, has the same live link Drive has. The one kind a person cannot press is the token
 * an administrator holds, and it is not listed at all.
 */
test("Connect is offered for a vendor nobody has added yet, and never disabled; a shared-token vendor is not listed", async () => {
  const { view } = renderMarketplace("/marketplace");

  const notion = await view.findByTestId("account-notion");
  const connect = within(notion).getByRole("link", { name: "Connect Notion" });
  expect(connect.getAttribute("href")).toBe(
    "/settings/connected-accounts/notion",
  );
  expect(connect.hasAttribute("aria-disabled")).toBe(false);
  const parallelOAuth = await view.findByTestId("account-parallel-oauth");
  expect(
    within(parallelOAuth).getByRole("link", {
      name: "Connect Parallel Search (your account)",
    }),
  ).toBeTruthy();
  expect(view.queryByTestId("account-parallel-authenticated")).toBeNull();
});

test("Google Drive carries a Beta tag, and nothing else does", async () => {
  const { view } = renderMarketplace("/marketplace");

  const drive = await view.findByTestId("account-google-drive");
  expect(within(drive).getByText("Beta")).toBeTruthy();
  const notion = await view.findByTestId("account-notion");
  expect(within(notion).queryByText("Beta")).toBeNull();
});

/*
 * An app with no account to hold is enabled in place, for everybody. Routines is already on, so
 * it is under Connected and says Enabled rather than offering a button; Parallel is not, so its
 * row carries Enable, and pressing it writes once and reads back as the green row.
 */
test("an account-less app is enabled with one press and moves under Connected; the counter follows", async () => {
  const { view } = renderMarketplace("/marketplace");

  const routines = await view.findByTestId("account-routines");
  expect(
    within(routines).getByRole("status", { name: "Routines enabled" }),
  ).toBeTruthy();
  expect(within(routines).queryByRole("button")).toBeNull();
  expect(
    within(view.getByRole("region", { name: "Connected" })).getByTestId(
      "account-routines",
    ),
  ).toBeTruthy();

  const parallel = await view.findByTestId("account-parallel");
  expect(
    within(view.getByRole("region", { name: "Available" })).getByTestId(
      "account-parallel",
    ),
  ).toBeTruthy();
  const enable = within(parallel).getByRole("button", {
    name: "Enable Parallel Search",
  });
  expect((enable as HTMLButtonElement).disabled).toBe(false);

  const user = userEvent.setup({ document: view.baseElement.ownerDocument });
  await user.click(enable);

  await waitFor(() => {
    expect(
      within(view.getByRole("region", { name: "Connected" })).getByTestId(
        "account-parallel",
      ),
    ).toBeTruthy();
  });
  expect(writes).toEqual(["POST /api/plugins/servers/parallel/enable"]);
  expect(
    within(view.getByTestId("account-parallel")).getByRole("status", {
      name: "Parallel Search enabled",
    }),
  ).toBeTruthy();
  expect(view.queryByRole("alert")).toBeNull();
  await waitFor(() => {
    expect(view.getByTestId("installed-cluster").textContent).toContain(
      "3 installed",
    );
  });
});

test("a refused Enable is said in the server's words, and the row keeps its button", async () => {
  refuseEnable = {
    status: 403,
    error: "Connecting apps is switched off for this deployment.",
  };
  const { view } = renderMarketplace("/marketplace");

  const parallel = await view.findByTestId("account-parallel");
  const user = userEvent.setup({ document: view.baseElement.ownerDocument });
  await user.click(
    within(parallel).getByRole("button", { name: "Enable Parallel Search" }),
  );

  const alert = await view.findByRole("alert");
  expect(alert.textContent).toBe(
    "Connecting apps is switched off for this deployment.",
  );
  const button = within(view.getByTestId("account-parallel")).getByRole(
    "button",
    { name: "Enable Parallel Search" },
  );
  expect((button as HTMLButtonElement).disabled).toBe(false);
  expect(
    within(view.getByRole("region", { name: "Available" })).getByTestId(
      "account-parallel",
    ),
  ).toBeTruthy();
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

  const search = await view.findByRole("textbox", {
    name: "Search across apps and skills",
  });
  expect((search as HTMLInputElement).value).toBe("mail");
  await view.findByTestId("account-composio-gmail");
  expect(view.queryByTestId("account-google-drive")).toBeNull();
  expect(view.queryByTestId("account-parallel")).toBeNull();

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

test("the Marketplace's plugins are listed by category, four at a time, with View all showing one category whole", async () => {
  const { view, router } = renderMarketplace("/marketplace");

  const research = await view.findByRole("region", { name: "Research" });
  // Six research plugins in the index; the preview shows four, and says there are more.
  expect(within(research).getAllByTestId(/^plugin-/)).toHaveLength(4);
  expect(view.getByRole("region", { name: "Support" })).toBeTruthy();
  // Notion is the catalogue's row, not a second plugin row.
  expect(view.getByTestId("account-notion")).toBeTruthy();
  expect(view.queryByTestId("plugin-404")).toBeNull();

  const user = userEvent.setup({ document: view.baseElement.ownerDocument });
  await user.click(within(research).getByRole("button", { name: "View all" }));
  await waitFor(() => {
    expect(router.state.location.search).toMatchObject({
      category: "RESEARCH",
    });
  });
  await waitFor(() => {
    expect(
      within(view.getByRole("region", { name: "Research" })).getAllByTestId(
        /^plugin-/,
      ),
    ).toHaveLength(6);
  });
  expect(view.queryByRole("region", { name: "Support" })).toBeNull();
  await user.click(view.getByRole("button", { name: "← All apps" }));
  await waitFor(() => {
    expect(router.state.location.search).not.toMatchObject({
      category: "RESEARCH",
    });
  });
  // And the way to the Bots you can start from.
  expect(
    view.getByRole("link", { name: /Bot templates/ }).getAttribute("href"),
  ).toBe("/marketplace?tab=agents");
});

test("Add installs a plugin for every Bot, and the row then says what is left: a key to add, an account to connect, or nothing", async () => {
  const { view } = renderMarketplace("/marketplace");
  const user = userEvent.setup({ document: view.baseElement.ownerDocument });

  // A plugin whose only server is open: Add, and done.
  const crustdata = await view.findByTestId("plugin-90000");
  await user.click(
    within(crustdata).getByRole("button", { name: "Add Crustdata" }),
  );
  await waitFor(() => {
    expect(
      within(view.getByTestId("plugin-90000")).getByRole("status", {
        name: "Crustdata added",
      }),
    ).toBeTruthy();
  });
  expect(writes).toContain("POST /api/plugins/install");
  expect(
    within(view.getByRole("region", { name: "Connected" })).getByTestId(
      "plugin-90000",
    ),
  ).toBeTruthy();

  // A plugin whose server signs the person in: Add, then Connect, which is the account's page.
  const ahrefs = await view.findByTestId("plugin-56809965");
  await user.click(within(ahrefs).getByRole("button", { name: "Add Ahrefs" }));
  await waitFor(() => {
    expect(
      within(view.getByTestId("plugin-56809965"))
        .getByRole("link", { name: "Connect Ahrefs" })
        .getAttribute("href"),
    ).toBe("/settings/connected-accounts/ahrefs");
  });

  // A plugin whose server takes a token: Add, then Add key, which is a form here.
  const treg = await view.findByTestId("plugin-55647425");
  await user.click(within(treg).getByRole("button", { name: "Add Treg" }));
  const addKey = await within(
    await view.findByTestId("plugin-55647425"),
  ).findByRole("button", { name: "Add key for Treg" });
  await user.click(addKey);
  const dialog = await view.findByRole("dialog", { name: "Add your Treg key" });
  await user.type(within(dialog).getByLabelText("TREG_TOKEN"), "sk-treg-123");
  await user.click(within(dialog).getByRole("button", { name: "Add key" }));
  await waitFor(() => {
    expect(writes).toContain("POST /api/plugins/servers/treg/connect");
  });
  expect(view.queryByRole("alert")).toBeNull();
});

test("a refused Add is said in the server's words, and the row keeps its button", async () => {
  refuseInstall = {
    status: 403,
    error: "Connecting apps is switched off for this deployment.",
  };
  const { view } = renderMarketplace("/marketplace");
  const user = userEvent.setup({ document: view.baseElement.ownerDocument });
  const ahrefs = await view.findByTestId("plugin-56809965");
  await user.click(within(ahrefs).getByRole("button", { name: "Add Ahrefs" }));
  expect((await view.findByRole("alert")).textContent).toBe(
    "Connecting apps is switched off for this deployment.",
  );
  expect(
    within(view.getByTestId("plugin-56809965")).getByRole("button", {
      name: "Add Ahrefs",
    }),
  ).toBeTruthy();
});
