// biome-ignore-all lint/suspicious/noTemplateCurlyInString: a plugin's `${NAME}` placeholder is data here, not a template.
import { describe, expect, test } from "bun:test";
import { CATALOGUE } from "../src/plugins/catalogue";
import {
  normalisePlaceholders,
  parseMcpConfig,
  serverMapOf,
} from "../src/plugins/mcp-config";
import {
  normaliseSlug,
  PLUGIN_PART_ID,
  serverIdFor,
  skillSlugFor,
  uniqueId,
} from "../src/plugins/plugin-ids";
import {
  CATALOGUE_PLUGIN_IDS,
  PLUGIN_INDEX,
  PLUGIN_INDEX_SERVER_IDS,
  listablePlugins,
  parsePluginIndex,
  pluginIndexEntry,
  pluginIndexServer,
} from "../src/plugins/plugin-index";

/**
 * The vendored Marketplace index is data this deployment trusts with URLs it will dial and ids it
 * will mint, so three things are held here: the rules that turn a plugin author's names into ids,
 * the reading of every `mcp.json` dialect into one shape (and what it refuses), and the invariants
 * the committed file must keep whatever the sync script or a hand edit did to it.
 */

describe("the ids a plugin's parts take", () => {
  test("a name is lower-cased, hyphenated and cut to forty characters", () => {
    expect(normaliseSlug("Context.dev")).toBe("context-dev");
    expect(normaliseSlug("  Treg  ")).toBe("treg");
    expect(normaliseSlug("Plain")).toBe("plain");
    expect(normaliseSlug("a".repeat(60))).toBe("a".repeat(40));
    // Cut at a hyphen the cut left dangling, never ending in one.
    expect(normaliseSlug(`${"a".repeat(39)}-bb`)).toBe("a".repeat(39));
  });

  test("a name with nothing usable in it mints no id", () => {
    expect(normaliseSlug("")).toBeNull();
    expect(normaliseSlug("!")).toBeNull();
    expect(normaliseSlug("x")).toBeNull();
  });

  test("a single server takes the plugin's slug unless another plugin owns the word", () => {
    const taken = (id: string) => id === "linear";
    expect(
      serverIdFor({
        pluginSlug: "treg",
        serverName: "treg",
        single: true,
        taken,
      }),
    ).toBe("treg");
    expect(
      serverIdFor({
        pluginSlug: "linear",
        serverName: "mcp",
        single: true,
        taken,
      }),
    ).toBe("linear-mcp");
    expect(
      serverIdFor({
        pluginSlug: "phantom",
        serverName: "docs",
        single: false,
        taken,
      }),
    ).toBe("phantom-docs");
  });

  test("a collision is resolved with a suffix, within the forty characters", () => {
    const minted = new Set(["foo-bar"]);
    expect(uniqueId("foo-bar", (id) => minted.has(id))).toBe("foo-bar-2");
    const long = "a".repeat(40);
    expect(uniqueId(long, (id) => id === long)).toBe(`${"a".repeat(38)}-2`);
    expect(uniqueId(null, () => false)).toBeNull();
    expect(
      skillSlugFor(
        "webflow",
        "code component",
        (slug) => slug === "webflow-code-component",
      ),
    ).toBe("webflow-code-component-2");
  });
});

describe("reading an mcp.json", () => {
  test("every placeholder spelling becomes ${NAME}", () => {
    expect(normalisePlaceholders("Bearer ${env:TREG_TOKEN}")).toBe(
      "Bearer ${TREG_TOKEN}",
    );
    expect(normalisePlaceholders("${CLIENT_SECRET:-}")).toBe(
      "${CLIENT_SECRET}",
    );
    expect(normalisePlaceholders("${input:API_KEY}")).toBe("${API_KEY}");
    expect(normalisePlaceholders("${TOKEN}")).toBe("${TOKEN}");
    // Not a variable name: left for the caller to read as a literal.
    expect(normalisePlaceholders("${lowercase}")).toBe("${lowercase}");
  });

  test("the wrapped and the bare form read alike, and anything else is nothing", () => {
    expect(
      serverMapOf({ mcpServers: { a: { url: "https://x.example/mcp" } } }),
    ).toEqual({ a: { url: "https://x.example/mcp" } });
    expect(
      serverMapOf({
        notion: { type: "http", url: "https://mcp.notion.com/mcp" },
      }),
    ).toEqual({
      notion: { type: "http", url: "https://mcp.notion.com/mcp" },
    });
    expect(serverMapOf({ name: "a plugin", version: "1" })).toBeNull();
    expect(serverMapOf({ mcpServers: "not a map" })).toBeNull();
    expect(serverMapOf([])).toBeNull();
  });

  test("a remote server with no auth is read as is, with its transport", () => {
    const parsed = parseMcpConfig({
      mcpServers: {
        ahrefs: { type: "http", url: "https://api.ahrefs.com/mcp/mcp" },
        docs: { type: "sse", url: "https://docs.example.com/mcp" },
        plain: { type: "remote", url: "https://mcp.plain.com/mcp" },
      },
    });
    expect(parsed.skipped).toEqual([]);
    expect(
      parsed.servers.map((server) => [server.name, server.transport]),
    ).toEqual([
      ["ahrefs", "http"],
      ["docs", "sse"],
      ["plain", "http"],
    ]);
    expect(parsed.servers[0]?.staticClient).toBeNull();
    expect(parsed.servers[0]?.headers).toEqual({});
  });

  test("a header with a placeholder is a template; its variables are listed", () => {
    const parsed = parseMcpConfig({
      mcpServers: {
        treg: {
          url: "https://treg.to/mcp/",
          headers: { Authorization: "Bearer ${env:TREG_TOKEN}" },
        },
      },
    });
    expect(parsed.servers[0]?.headers).toEqual({
      Authorization: "Bearer ${TREG_TOKEN}",
    });
    expect(parsed.servers[0]?.variables).toEqual(["TREG_TOKEN"]);
  });

  test("a literal credential in a header skips the server rather than carrying the secret", () => {
    const parsed = parseMcpConfig({
      mcpServers: {
        leaky: {
          url: "https://mcp.example.com/mcp",
          headers: { "X-Api-Key": "sk-live-abc" },
        },
        fine: {
          url: "https://mcp.example.com/mcp",
          headers: { Accept: "application/json" },
        },
      },
    });
    expect(parsed.skipped).toEqual([
      { kind: "server", name: "leaky", reason: "literal-credential" },
    ]);
    expect(parsed.servers.map((server) => server.name)).toEqual(["fine"]);
  });

  test("a plugin's own OAuth client is kept by id and its secret is dropped", () => {
    const parsed = parseMcpConfig({
      mcpServers: {
        slack: {
          url: "https://mcp.slack.com/mcp",
          auth: {
            CLIENT_ID: "123.456",
            CLIENT_SECRET: "never-written",
            scopes: "chat:write channels:read",
          },
        },
      },
    });
    expect(parsed.servers[0]?.staticClient).toEqual({
      clientId: "123.456",
      scopes: ["chat:write", "channels:read"],
    });
    expect(JSON.stringify(parsed)).not.toContain("never-written");
  });

  test("what a server of ours cannot dial is skipped with its reason", () => {
    const parsed = parseMcpConfig({
      mcpServers: {
        cli: { command: "kraken", args: ["mcp"] },
        proxied: { url: "https://api.cursor.com/rest-mcp/google-drive/mcp" },
        gateway: {
          url: "https://connectors-gateway.grok.com/gateway/v1/finance/mcp",
        },
        templated: { url: "${SALESFORCE_MCP_URL}" },
        plain: { url: "http://mcp.example.com/mcp" },
        local: { url: "https://mcp.internal/mcp" },
        empty: {},
        nothing: "x",
      },
    });
    expect(parsed.servers).toEqual([]);
    expect(parsed.skipped).toEqual([
      { kind: "server", name: "cli", reason: "stdio" },
      { kind: "server", name: "proxied", reason: "cursor-hosted" },
      { kind: "server", name: "gateway", reason: "cursor-hosted" },
      { kind: "server", name: "templated", reason: "url-variable" },
      { kind: "server", name: "plain", reason: "url-refused" },
      { kind: "server", name: "local", reason: "url-refused" },
      { kind: "server", name: "empty", reason: "mcp-config-missing" },
      { kind: "server", name: "nothing", reason: "mcp-config-missing" },
    ]);
  });
});

const plugin = (overrides: Record<string, unknown> = {}) => ({
  id: "1",
  slug: "example",
  name: "example",
  displayName: "Example",
  description: "An example.",
  publisher: { name: "example", displayName: "Example", verified: false },
  logoUrl: "https://cdn.example.com/logo.png",
  categories: ["RESEARCH"],
  gitUrl: "https://github.com/example/plugin",
  gitRef: "a".repeat(40),
  gitPath: "",
  servers: [
    {
      name: "example",
      serverId: "example",
      url: "https://mcp.example.com/mcp",
      transport: "http",
      headers: {},
      auth: { kind: "discover", resourceMetadataUrl: null },
    },
  ],
  skills: [
    { name: "search", slug: "example-search", path: "skills/search/SKILL.md" },
  ],
  variables: {},
  skippedParts: [],
  availability: "installable",
  unavailableReason: null,
  catalogueKey: null,
  ...overrides,
});

const index = (...plugins: Record<string, unknown>[]) => ({
  source: "cursor-marketplace",
  syncedAt: "2026-10-11T00:00:00.000Z",
  plugins,
});

describe("loading an index", () => {
  test("a well-formed file reads back as written", () => {
    const parsed = parsePluginIndex(index(plugin()));
    expect(parsed.plugins).toHaveLength(1);
    expect(parsed.plugins[0]?.servers[0]?.auth).toEqual({
      kind: "discover",
      resourceMetadataUrl: null,
    });
    // A logo that is not https is dropped rather than drawn.
    expect(
      parsePluginIndex(index(plugin({ logoUrl: "http://x/logo.png" })))
        .plugins[0]?.logoUrl,
    ).toBeNull();
  });

  test("the first malformed field is named", () => {
    expect(() => parsePluginIndex(index(plugin({ gitRef: "main" })))).toThrow(
      "plugins[0].gitRef",
    );
    expect(() =>
      parsePluginIndex(
        index(
          plugin({ servers: [{ ...plugin().servers[0], url: "http://x" }] }),
        ),
      ),
    ).toThrow("plugins[0].servers[0].url");
    expect(() =>
      parsePluginIndex(
        index(plugin({ servers: [{ ...plugin().servers[0], serverId: "X" }] })),
      ),
    ).toThrow("plugins[0].servers[0].serverId");
    expect(() =>
      parsePluginIndex(
        index(
          plugin({
            skills: [{ name: "x", slug: "example-x", path: "../SKILL.md" }],
          }),
        ),
      ),
    ).toThrow("plugins[0].skills[0].path");
    expect(() =>
      parsePluginIndex(index(plugin({ availability: "maybe" }))),
    ).toThrow("plugins[0].availability");
    expect(() =>
      parsePluginIndex(
        index(
          plugin({
            servers: [{ ...plugin().servers[0], auth: { kind: "magic" } }],
          }),
        ),
      ),
    ).toThrow("plugins[0].servers[0].auth.kind");
  });

  test("two plugins may not mint one server id or one skill slug, and a server and a skill may share a name", () => {
    expect(() =>
      parsePluginIndex(
        index(plugin({ id: "1" }), plugin({ id: "2", slug: "other" })),
      ),
    ).toThrow("example is minted by plugins 1 and 2");
    expect(() =>
      parsePluginIndex(
        index(
          plugin({ id: "1" }),
          plugin({
            id: "2",
            slug: "other",
            servers: [{ ...plugin().servers[0], serverId: "other" }],
          }),
        ),
      ),
    ).toThrow("example-search is minted by plugins 1 and 2");
    expect(() =>
      parsePluginIndex(
        index(
          plugin({
            skills: [
              {
                name: "example",
                slug: "example",
                path: "skills/example/SKILL.md",
              },
            ],
          }),
        ),
      ),
    ).not.toThrow();
    expect(() => parsePluginIndex(index(plugin(), plugin()))).toThrow(
      "appears twice",
    );
  });
});

describe("the committed index", () => {
  test("holds the three plugins this deployment ships its own entries for", () => {
    for (const [id, key] of Object.entries(CATALOGUE_PLUGIN_IDS)) {
      const entry = pluginIndexEntry(id);
      expect(entry?.availability).toBe("catalogue");
      expect(entry?.catalogueKey).toBe(key);
      expect(CATALOGUE.some((candidate) => candidate.key === key)).toBe(true);
    }
  });

  test("mints no id a catalogue entry, the broker or another plugin already holds", () => {
    const catalogueKeys = new Set(CATALOGUE.map((entry) => entry.key));
    for (const id of PLUGIN_INDEX_SERVER_IDS) {
      expect(PLUGIN_PART_ID.test(id)).toBe(true);
      expect(catalogueKeys.has(id)).toBe(false);
      expect(id === "composio" || id.startsWith("composio-")).toBe(false);
    }
    for (const entry of PLUGIN_INDEX) {
      for (const skill of entry.skills) {
        expect(PLUGIN_PART_ID.test(skill.slug)).toBe(true);
      }
    }
  });

  test("lists only what something of runs here, and carries no secret", () => {
    const listed = listablePlugins();
    expect(listed.length).toBeGreaterThan(100);
    expect(listed.every((entry) => entry.availability !== "unavailable")).toBe(
      true,
    );
    for (const entry of listed) {
      for (const server of entry.servers) {
        expect(server.url.startsWith("https://")).toBe(true);
        if (server.auth.kind === "header") {
          // A header-auth server's headers carry the placeholders its variables name.
          expect(server.auth.variables.length).toBeGreaterThan(0);
          expect(
            Object.values(server.headers).some((template) =>
              /\$\{[A-Z][A-Z0-9_]*\}/.test(template),
            ),
          ).toBe(true);
        } else {
          // Every other server's headers are sent as they stand, so none may hold a placeholder.
          for (const template of Object.values(server.headers)) {
            expect(/\$\{[A-Z][A-Z0-9_]*\}/.test(template)).toBe(false);
          }
        }
      }
      // A plugin's own client secret is never written; its NAME may appear among the variables a
      // plugin asks a team to fill, which is a form field and not a value.
      expect(JSON.stringify(entry.servers)).not.toContain("clientSecret");
      expect(JSON.stringify(entry.servers)).not.toContain("CLIENT_SECRET");
    }
  });

  test("answers a server by the id it minted", () => {
    const treg = pluginIndexServer("treg");
    expect(treg?.plugin.id).toBe("55647425");
    expect(treg?.server.auth.kind).toBe("header");
    expect(pluginIndexServer("notion")).toBeNull();
  });
});
