import { expect, test } from "bun:test";
import { accountRows, personalKeyRows } from "@/components/keys/key-rows";
import type { PluginServer, PluginsPage } from "@/lib/plugins/queries";

/**
 * What the Keys page lists where: a key you paste on one card, an account you sign in to on the
 * other, and nothing that takes neither.
 */

function server(
  overrides: Partial<PluginServer> & { id: string },
): PluginServer {
  return {
    title: overrides.id,
    vendor: overrides.id,
    url: `https://${overrides.id}.example`,
    summary: `${overrides.id} tools.`,
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
    pluginId: null,
    authKind: null,
    transport: null,
    connectVariables: null,
    oauthDiscovered: false,
    tools: [],
    withdrawn: [],
    ...overrides,
  } as PluginServer;
}

const page: Pick<PluginsPage, "catalogue" | "servers"> = {
  catalogue: [
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
      key: "parallel",
      title: "Parallel Search",
      vendor: "Parallel",
      summary: "Public-web search.",
      docsUrl: "https://example.com",
      auth: "none",
      perInstance: false,
    },
  ] as PluginsPage["catalogue"],
  servers: [
    server({
      id: "treg",
      provenance: "plugin",
      pluginId: "55647425",
      authKind: "header",
      connectVariables: [
        {
          name: "TREG_TOKEN",
          description: null,
          writeOnly: true,
          required: true,
        },
      ],
    }),
    server({
      id: "ahrefs",
      provenance: "plugin",
      pluginId: "56809965",
      authKind: "oauth-discover",
    }),
    server({
      id: "excalidraw",
      provenance: "plugin",
      pluginId: "63408930",
      authKind: "none",
    }),
    server({
      id: "composio-serpapi",
      provenance: "composio",
      authScheme: "API_KEY",
    }),
    server({
      id: "composio-gmail",
      provenance: "composio",
      authScheme: "OAUTH2",
    }),
    server({
      id: "composio-weather",
      provenance: "composio",
      authScheme: "NO_AUTH",
    }),
  ],
};

test("keys are the header plugins and the brokered API-key apps, with what each asks for", () => {
  expect(
    personalKeyRows(page).map((row) => [
      row.key,
      row.kind,
      row.variables.map((variable) => variable.name),
    ]),
  ).toEqual([
    ["treg", "header", ["TREG_TOKEN"]],
    ["composio-serpapi", "brokered-key", []],
  ]);
});

test("accounts are everything else you sign in to; an open connector is on neither card", () => {
  const keys = accountRows(page).map((app) => app.key);
  expect(keys).toContain("notion");
  expect(keys).toContain("ahrefs");
  expect(keys).toContain("composio-gmail");
  expect(keys).not.toContain("treg");
  expect(keys).not.toContain("composio-serpapi");
  expect(keys).not.toContain("excalidraw");
  expect(keys).not.toContain("parallel");
  expect(keys).not.toContain("composio-weather");
});
