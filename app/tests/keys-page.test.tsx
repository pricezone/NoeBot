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
import type { ComponentType } from "react";
import { Route as KeysRoute } from "@/routes/_authed/_app/settings/keys";

/**
 * The Keys page: the model's key on top, the keys you paste, the accounts you sign in to, and for
 * an administrator the deployment's own credentials. Every control reuses the Marketplace's and
 * Admin's mutations, so what is checked here is that the right control is offered to the right
 * person and posts the right request.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = global.fetch;
let role: "user" | "admin";
let metered: boolean;
let source: "vault" | "environment" | "none";
let held: Set<string>;
let writes: string[];
let failPlugins: boolean;

beforeEach(() => {
  role = "user";
  metered = false;
  source = "environment";
  held = new Set();
  writes = [];
  failPlugins = false;
  global.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).split("?")[0] ?? "";
      const method = init?.method ?? "GET";
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });
      if (method !== "GET") {
        writes.push(`${method} ${path} ${String(init?.body ?? "")}`);
      }
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
      if (path === "/api/settings/model-key") {
        return json({
          provider: "openai",
          model: "gpt-5.4",
          metered,
          billingUrl: metered ? "https://www.example/billing" : null,
          ...(role === "admin"
            ? {
                keyId: "model-api-key",
                source,
                credentialId: source === "vault" ? "cred-1" : null,
              }
            : {}),
        });
      }
      if (path === "/api/admin/credentials" && method === "POST") {
        source = "vault";
        return json({ credential: { id: "cred-1" } }, 201);
      }
      if (path === "/api/admin/credentials") {
        return json({
          credentials: [
            { id: "cred-1", revokedAt: null },
            { id: "cred-0", revokedAt: "2026-01-01T00:00:00.000Z" },
          ],
        });
      }
      if (path === "/api/admin/credentials/cred-1/revoke") {
        source = "environment";
        return json({ credential: { id: "cred-1" } });
      }
      if (path === "/api/plugins") {
        if (failPlugins) return new Response(null, { status: 500 });
        return json({
          catalogue: [
            {
              key: "notion",
              title: "Notion",
              vendor: "Notion",
              summary: "Pages and databases of whoever is asking.",
              docsUrl: "https://example.com",
              auth: "user-oauth",
              perInstance: false,
            },
          ],
          servers: [
            {
              id: "treg",
              title: "Treg",
              logo: null,
              vendor: "treg.to",
              url: "https://treg.to/mcp/",
              summary: "OpenRouter for tools.",
              docsUrl: "https://example.com",
              provenance: "plugin",
              hasCredential: false,
              toolsRefreshedAt: null,
              lastError: null,
              addedBy: null,
              dynamicClient: false,
              authScheme: null,
              offeredToAllBots: true,
              oauthClientSource: null,
              pluginId: "55647425",
              authKind: "header",
              transport: null,
              connectVariables: [
                {
                  name: "TREG_TOKEN",
                  description: "Your Treg token.",
                  writeOnly: true,
                  required: true,
                },
              ],
              oauthDiscovered: false,
              tools: [],
              withdrawn: [],
            },
          ],
          skills: [],
          botsMayCallBack: true,
          redirectUri: null,
          composioConfigured: false,
        });
      }
      if (path === "/api/plugins/connections") {
        return json({
          connections: [...held].map((serverId) => ({
            serverId,
            scope: "",
            connectedAt: "2026-10-12T00:00:00.000Z",
          })),
          redirectUri: null,
        });
      }
      const connect = path.match(/^\/api\/plugins\/servers\/([^/]+)\/connect$/);
      if (method === "POST" && connect) {
        const serverId = decodeURIComponent(connect[1] ?? "");
        if (serverId === "notion") {
          return json({ authorizationUrl: "https://consent.example/notion" });
        }
        held.add(serverId);
        return json({ connected: true });
      }
      const disconnect = path.match(
        /^\/api\/plugins\/servers\/([^/]+)\/connection$/,
      );
      if (method === "DELETE" && disconnect) {
        held.delete(decodeURIComponent(disconnect[1] ?? ""));
        return json({ disconnected: true, vendorRevocationRequested: false });
      }
      return new Response(null, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});

afterEach(() => {
  global.fetch = originalFetch;
});

/** The page's component under a bare root route: it reads no search or params of its own. */
function renderKeys() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const Component = KeysRoute.options.component as ComponentType;
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/settings/keys"] }),
    routeTree: createRootRoute({ component: () => <Component /> }),
  });
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return {
    view,
    user: userEvent.setup({ document: view.baseElement.ownerDocument }),
  };
}

test("a member sees the model, keys to add and accounts to connect, and no way to replace the model key", async () => {
  const { view } = renderKeys();
  expect(await view.findByText("OpenAI · gpt-5.4")).toBeTruthy();
  expect(
    view.queryByRole("button", { name: /Replace key|Add key$/ }),
  ).toBeNull();
  expect(view.getByText("Your API keys")).toBeTruthy();
  expect(view.getByRole("button", { name: "Add key for Treg" })).toBeTruthy();
  expect(view.getByText("Connected accounts")).toBeTruthy();
  expect(view.getByRole("button", { name: "Connect Notion" })).toBeTruthy();
  expect(view.queryByText("Deployment credentials")).toBeNull();
});

test("an administrator on a bring-your-own-key deployment replaces the model key in the vault, and can fall back", async () => {
  role = "admin";
  const { view, user } = renderKeys();
  expect(
    await view.findByText("Runs on the key this deployment was set up with."),
  ).toBeTruthy();
  await user.click(view.getByRole("button", { name: "Replace key" }));
  const dialog = await view.findByRole("dialog", {
    name: "Replace the OpenAI key",
  });
  await user.type(within(dialog).getByLabelText("OpenAI API key"), "sk-new-1");
  await user.click(within(dialog).getByRole("button", { name: "Save key" }));
  await waitFor(() => {
    expect(
      writes.find((write) => write.startsWith("POST /api/admin/credentials ")),
    ).toContain('"kind":"model"');
  });
  expect(writes.join("\n")).toContain('"keyId":"model-api-key"');
  expect(writes.join("\n")).toContain('"plaintext":"sk-new-1"');
  expect(
    await view.findByText(
      "Runs on a key stored here, replaced from this page.",
    ),
  ).toBeTruthy();

  await user.click(
    view.getByRole("button", { name: "Use the deployment's key again" }),
  );
  await waitFor(() => {
    expect(writes.join("\n")).toContain(
      "POST /api/admin/credentials/cred-1/revoke",
    );
  });
  // The deployment's own credentials: one live, one revoked, counted for the administrator.
  expect(await view.findByText("1 live credential")).toBeTruthy();
});

test("a metered deployment offers the plan instead of a key", async () => {
  role = "admin";
  metered = true;
  const { view } = renderKeys();
  expect(
    await view.findByText(
      "Runs on the HyperNoesis API. Usage is metered on your plan.",
    ),
  ).toBeTruthy();
  expect(view.queryByRole("button", { name: "Replace key" })).toBeNull();
  // A router-less anchor drawn as a Button: it announces as a button and carries the address.
  expect(
    view.getByRole("button", { name: /Plan and usage/ }).getAttribute("href"),
  ).toBe("https://www.example/billing");
});

test("Add key posts the variables, Key added offers Replace and Remove, and Connect leaves for the vendor", async () => {
  const { view, user } = renderKeys();
  await user.click(
    await view.findByRole("button", { name: "Add key for Treg" }),
  );
  const dialog = await view.findByRole("dialog", { name: "Add your Treg key" });
  await user.type(within(dialog).getByLabelText("TREG_TOKEN"), "sk-treg-123");
  await user.click(within(dialog).getByRole("button", { name: "Add key" }));
  await waitFor(() => {
    expect(writes.join("\n")).toContain(
      "POST /api/plugins/servers/treg/connect",
    );
  });
  const added = await view.findByRole("button", { name: /Key added/ });
  await user.click(added);
  await user.click(
    await view.findByRole("menuitem", { name: "Remove your key" }),
  );
  await waitFor(() => {
    expect(writes.join("\n")).toContain(
      "DELETE /api/plugins/servers/treg/connection",
    );
  });
  expect(
    await view.findByRole("button", { name: "Add key for Treg" }),
  ).toBeTruthy();
});

test("a failed read says so once, and lists nothing that might be wrong", async () => {
  failPlugins = true;
  const { view } = renderKeys();
  expect(
    await view.findByText(/Your keys and accounts could not be loaded/),
  ).toBeTruthy();
  expect(view.queryByText("Your API keys")).toBeNull();
});
