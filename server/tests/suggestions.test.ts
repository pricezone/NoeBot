import { describe, expect, test } from "bun:test";
import { Hono, type MiddlewareHandler } from "hono";
import {
  FIND_BOT_TEMPLATES_TOOL,
  FIND_MARKETPLACE_ITEMS_TOOL,
  OFFER_BOT_TEMPLATE_TOOL,
  OFFER_MARKETPLACE_ITEM_TOOL,
} from "../../shared/suggestions";
import { createSuggestionRoutes } from "../src/agents/suggestion-routes";
import {
  findMarketplaceItems,
  type MarketplaceSources,
  type MarketplaceViewer,
  marketplaceItem,
  pluginEligibility,
  rankTemplates,
  suggestionGuidance,
  suggestionTools,
  tokensOf,
} from "../src/agents/suggestions";
import type { AppVariables } from "../src/auth/guards";
import { CATALOGUE } from "../src/plugins/catalogue";
import {
  COMPOSIO_PLUGIN_IDS,
  CURSOR_DUPLICATE_PLUGIN_IDS,
  type IndexedPlugin,
  type IndexedServer,
  listablePlugins,
} from "../src/plugins/plugin-index";
import type { TenantTemplate } from "../src/tenant-package";

/**
 * Finding a template or a Marketplace item for a Bot: the ranking, what adding an item does now
 * (`eligibility`), what is left out, and the finders being offered only beside the cards that offer
 * what they find.
 */

const template = (
  overrides: Partial<TenantTemplate> & Pick<TenantTemplate, "id" | "name">,
): TenantTemplate => ({
  title: "Work",
  creator: "Noë Bot Team",
  categories: ["From Noë Bot Team"],
  summary: "",
  description: "",
  instructions: `You are ${overrides.name}.`,
  avatar: { color: "#ff2056", expression: "attentive" },
  skills: [],
  apps: [],
  routines: [],
  featured: false,
  ...overrides,
});

const TEMPLATES: TenantTemplate[] = [
  template({
    id: "research-desk",
    name: "Research Desk",
    title: "Briefings",
    categories: ["From Noë Bot Team", "Operations"],
    summary:
      "Reads around a question and writes a brief somebody can act on, naming what it could not find.",
    skills: ["research-public-web"],
  }),
  template({
    id: "code-reviewer",
    name: "Code Reviewer",
    title: "Reviews",
    categories: ["From Noë Bot Team", "Engineering"],
    summary: "Reads a change and says what would break, before it merges.",
    skills: ["review-a-change"],
  }),
  template({
    id: "lead-researcher",
    name: "Lead Researcher",
    title: "Prospects",
    categories: ["From Noë Bot Team", "Sales"],
    summary:
      "Builds a one-page profile of a company or a person before you reach out.",
  }),
];

describe("ranking templates", () => {
  test("the closest template comes first, with a score from 0 to 1", () => {
    const matches = rankTemplates("research and writing briefs", TEMPLATES);
    expect(matches[0]).toMatchObject({
      id: "research-desk",
      name: "Research Desk",
      title: "Briefings",
    });
    for (const match of matches) {
      expect(match.score).toBeGreaterThan(0);
      expect(match.score).toBeLessThanOrEqual(1);
    }
    expect(matches.map((match) => match.score)).toEqual(
      [...matches.map((match) => match.score)].sort((a, b) => b - a),
    );
  });

  test("a Greek goal meets the same English templates", () => {
    expect(rankTemplates("Έρευνα και γραφή", TEMPLATES)[0]?.id).toBe(
      "research-desk",
    );
    expect(rankTemplates("Κώδικας και GitHub", TEMPLATES)[0]?.id).toBe(
      "code-reviewer",
    );
    expect(rankTemplates("πωλήσεις", TEMPLATES)[0]?.id).toBe("lead-researcher");
  });

  test("words that say nothing about a job match nothing", () => {
    expect(rankTemplates("help me with things please", TEMPLATES)).toEqual([]);
    expect(rankTemplates("", TEMPLATES)).toEqual([]);
  });

  test("at most five, and ties in name order", () => {
    const many = Array.from({ length: 8 }, (_, index) =>
      template({ id: `t-${index}`, name: `Research ${8 - index}` }),
    );
    const matches = rankTemplates("research", many);
    expect(matches).toHaveLength(5);
    expect(matches.map((match) => match.name)).toEqual([
      "Research 1",
      "Research 2",
      "Research 3",
      "Research 4",
      "Research 5",
    ]);
  });

  test("Greek and English fold to the same tokens", () => {
    expect(tokensOf("Προγραμματισμός")).toEqual(["code"]);
    expect(tokensOf("writing CODE")).toEqual(["writ", "code"]);
    expect(tokensOf("ερευνα")).toEqual(tokensOf("Έρευνα"));
  });
});

const server = (auth: IndexedServer["auth"], name = "api"): IndexedServer => ({
  name,
  serverId: `srv-${name}`,
  url: `https://${name}.example/mcp`,
  transport: "http",
  headers: {},
  auth,
});

const skill = (name: string) => ({
  name,
  slug: `skill-${name}`,
  path: `skills/${name}/SKILL.md`,
  description: null,
});

const plugin = (
  overrides: Partial<IndexedPlugin> & Pick<IndexedPlugin, "id">,
): IndexedPlugin => ({
  slug: `plugin-${overrides.id}`,
  name: `plugin-${overrides.id}`,
  displayName: `Plugin ${overrides.id}`,
  description: "",
  publisher: { name: "p", displayName: "P", verified: true },
  logoUrl: null,
  categories: [],
  gitUrl: "https://github.com/example/plugin",
  gitRef: "0".repeat(40),
  gitPath: "",
  servers: [],
  skills: [],
  variables: {},
  skippedParts: [],
  availability: "installable",
  unavailableReason: null,
  catalogueKey: null,
  ...overrides,
});

describe("eligibility", () => {
  test("ready: nothing to connect, skills only, or open connectors", () => {
    expect(pluginEligibility({ servers: [], skills: [skill("tdd")] })).toBe(
      "ready",
    );
    expect(
      pluginEligibility({ servers: [server({ kind: "none" })], skills: [] }),
    ).toBe("ready");
  });

  test("optional: skills now, and connectors that take an account later", () => {
    expect(
      pluginEligibility({
        servers: [
          server({ kind: "discover", resourceMetadataUrl: null }, "a"),
          server({ kind: "none" }, "b"),
        ],
        skills: [skill("x")],
      }),
    ).toBe("optional");
    expect(
      pluginEligibility({
        servers: [server({ kind: "header", variables: ["TOKEN"] })],
        skills: [skill("x")],
      }),
    ).toBe("optional");
  });

  test("needs an account: a registered client, or connectors needing one and no skills", () => {
    expect(
      pluginEligibility({
        servers: [server({ kind: "static-client", clientId: "c", scopes: [] })],
        skills: [skill("x")],
      }),
    ).toBe("needs-account");
    expect(
      pluginEligibility({
        servers: [server({ kind: "discover", resourceMetadataUrl: null })],
        skills: [],
      }),
    ).toBe("needs-account");
    expect(
      pluginEligibility({
        servers: [server({ kind: "header", variables: ["TOKEN"] })],
        skills: [],
      }),
    ).toBe("needs-account");
  });
});

const PLUGINS: IndexedPlugin[] = [
  plugin({
    id: "1",
    displayName: "Testing Kit",
    description: "Test-driven development and debugging skills.",
    skills: [skill("test-driven-development"), skill("systematic-debugging")],
  }),
  plugin({
    id: "2",
    displayName: "Testing Cloud",
    description: "Run tests in the cloud.",
    servers: [server({ kind: "discover", resourceMetadataUrl: null })],
    skills: [skill("run-tests")],
  }),
  plugin({
    id: "3",
    displayName: "Testing Vault",
    description: "Test reports behind a sign-in.",
    servers: [server({ kind: "static-client", clientId: "c", scopes: [] })],
  }),
  plugin({
    id: "4",
    displayName: "Testing Ghost",
    description: "Tests nothing here can run.",
    availability: "unavailable",
    unavailableReason: "stdio",
  }),
  plugin({
    id: "5",
    displayName: "Testing Notion",
    description: "Tests in Notion.",
    availability: "catalogue",
    catalogueKey: "notion",
  }),
];

function sources(
  overrides: Partial<MarketplaceSources> = {},
): MarketplaceSources {
  return {
    plugins: PLUGINS,
    catalogue: CATALOGUE,
    installed: async () => [],
    servers: async () => [],
    held: async () => ({ tools: [], skills: [] }),
    skills: async () => [],
    connected: async () => new Set(),
    ...overrides,
  };
}

const MEMBER: MarketplaceViewer = {
  actor: { id: "user-1", isAdmin: false },
  bot: { id: "bot-1", ownerUserId: "user-1" },
};

describe("finding Marketplace items", () => {
  test("each item carries what adding it does now, and nothing unavailable or replaced", async () => {
    const items = await findMarketplaceItems("testing", sources(), MEMBER);
    expect(
      items.map((item) => [item.id, item.eligibility, item.skillsCount]),
    ).toEqual([
      ["1", "ready", 2],
      ["2", "optional", 1],
      ["3", "needs-account", 0],
    ]);
    expect(items[0]).toEqual({
      id: "1",
      kind: "plugin",
      name: "Testing Kit",
      summary: "Test-driven development and debugging skills.",
      eligibility: "ready",
      skillsCount: 2,
    });
  });

  test("a plugin this Bot already holds is left out; one installed but narrowed is not", async () => {
    const installed = async () => [
      { id: "1", serverIds: [], skillSlugs: ["skill-test-driven-development"] },
      { id: "2", serverIds: ["srv-api"], skillSlugs: ["skill-run-tests"] },
    ];
    const items = await findMarketplaceItems(
      "testing",
      sources({
        installed,
        held: async () => ({
          tools: [],
          skills: [{ slug: "skill-test-driven-development" }],
        }),
      }),
      MEMBER,
    );
    expect(items.map((item) => item.id)).toEqual(["2", "3"]);
  });

  test("catalogue and Composio apps always need an account, and a connected one is left out", async () => {
    const base = sources({
      plugins: [],
      servers: async () => [
        {
          id: "composio-notes",
          title: "Notes",
          summary: "Your notes app.",
          provenance: "composio",
          authScheme: "OAUTH2",
          offeredToAllBots: true,
        },
        {
          id: "composio-open",
          title: "Open Notes",
          summary: "Notes with no account.",
          provenance: "composio",
          authScheme: "NO_AUTH",
          offeredToAllBots: true,
        },
      ],
    });
    const notes = await findMarketplaceItems("notes", base, MEMBER);
    expect(notes).toEqual([
      {
        id: "composio-notes",
        kind: "plugin",
        name: "Notes",
        summary: "Your notes app.",
        eligibility: "needs-account",
        skillsCount: 0,
      },
    ]);
    const notion = await findMarketplaceItems("notion pages", base, MEMBER);
    expect(notion.map((item) => [item.id, item.eligibility])).toEqual([
      ["notion", "needs-account"],
    ]);
    const connected = await findMarketplaceItems(
      "notion pages",
      { ...base, connected: async () => new Set(["notion"]) },
      MEMBER,
    );
    expect(connected).toEqual([]);
  });

  test("skills a person may put on this Bot themselves, and no others", async () => {
    const skills = async () => [
      {
        slug: "my-testing",
        title: "My testing",
        summary: "How I test.",
        ownerUserId: "user-1",
        pluginId: null,
        offeredToAllBots: false,
        grantedTo: [],
      },
      {
        slug: "team-testing",
        title: "Team testing",
        summary: "How the team tests.",
        ownerUserId: null,
        pluginId: null,
        offeredToAllBots: false,
        grantedTo: [],
      },
      {
        slug: "granted-testing",
        title: "Granted testing",
        summary: "Already here.",
        ownerUserId: "user-1",
        pluginId: null,
        offeredToAllBots: false,
        grantedTo: ["bot-1"],
      },
    ];
    const only = sources({ plugins: [], skills });
    const member = await findMarketplaceItems("testing", only, MEMBER);
    expect(member.map((item) => [item.id, item.kind])).toEqual([
      ["skill:my-testing", "skill"],
    ]);
    const admin = await findMarketplaceItems("testing", only, {
      ...MEMBER,
      actor: { id: "admin-1", isAdmin: true },
    });
    expect(admin.map((item) => item.id)).toEqual([
      "skill:my-testing",
      "skill:team-testing",
    ]);
    // Their own skill on somebody else's Bot is not theirs to grant.
    const elsewhere = await findMarketplaceItems("testing", only, {
      ...MEMBER,
      bot: { id: "bot-2", ownerUserId: "someone-else" },
    });
    expect(elsewhere).toEqual([]);
  });

  test("one item by id, held or not, with where it comes from", async () => {
    const item = await marketplaceItem("2", sources(), MEMBER);
    expect(item).toMatchObject({
      id: "2",
      eligibility: "optional",
      target: { kind: "plugin", pluginId: "2" },
      held: false,
    });
    expect(
      (await marketplaceItem("notion", sources(), MEMBER))?.target,
    ).toEqual({ kind: "account", serverId: "notion" });
    expect(await marketplaceItem("4", sources(), MEMBER)).toBeNull();
  });

  test("a Cursor duplicate is never offered: of another Cursor plugin, or of an added Composio app", async () => {
    const installable = listablePlugins().filter(
      (plugin) => plugin.availability === "installable",
    );
    const brokered = installable.find(
      (plugin) => COMPOSIO_PLUGIN_IDS[plugin.id],
    );
    const copy = installable.find(
      (plugin) => CURSOR_DUPLICATE_PLUGIN_IDS[plugin.id],
    );
    if (!brokered || !copy)
      throw new Error("the index has no duplicates to test");
    const toolkit = COMPOSIO_PLUGIN_IDS[brokered.id] as string;
    const ids = async (extra: Parameters<typeof sources>[0]) =>
      (
        await Promise.all(
          [brokered, copy].map((plugin) =>
            findMarketplaceItems(
              plugin.displayName,
              sources({ plugins: [brokered, copy], ...extra }),
              MEMBER,
            ),
          ),
        )
      )
        .flat()
        .map((item) => item.id);

    // Not added through Composio: the Cursor plugin is the only way to the app, so it is offered.
    expect(await ids({})).toContain(brokered.id);
    expect(await ids({})).not.toContain(copy.id);
    // Added through Composio: only the Composio app is.
    const added = await ids({
      composioToolkits: async () => new Set([toolkit]),
    });
    expect(added).not.toContain(brokered.id);
    // Installed already, it stays, as it does in the Marketplace.
    const kept = await ids({
      composioToolkits: async () => new Set([toolkit]),
      installed: async () => [
        { id: brokered.id, serverIds: ["not-held"], skillSlugs: [] },
      ],
    });
    expect(kept).toContain(brokered.id);
  });

  test("writing code finds Superpowers in the real index", async () => {
    const items = await findMarketplaceItems(
      "writing code",
      sources({ plugins: listablePlugins() }),
      MEMBER,
    );
    expect(items.length).toBeLessThanOrEqual(6);
    expect(items.find((item) => item.id === "684")).toMatchObject({
      name: "Superpowers",
      eligibility: "ready",
    });
  });
});

describe("the finders as tools", () => {
  const viewer = async () => MEMBER;

  test("each is offered only beside the card that offers what it finds", () => {
    const names = (offered: string[]) =>
      suggestionTools({
        templates: TEMPLATES,
        marketplace: sources(),
        viewer,
        offered,
      }).map((tool) => tool.name);
    expect(names([])).toEqual([]);
    expect(names([OFFER_BOT_TEMPLATE_TOOL])).toEqual([FIND_BOT_TEMPLATES_TOOL]);
    expect(
      names([OFFER_MARKETPLACE_ITEM_TOOL, OFFER_BOT_TEMPLATE_TOOL]),
    ).toEqual([FIND_BOT_TEMPLATES_TOOL, FIND_MARKETPLACE_ITEMS_TOOL]);
  });

  test("their descriptions say when to offer, once, and that configuring unlocks more", () => {
    const tools = suggestionTools({
      templates: TEMPLATES,
      marketplace: sources(),
      viewer,
      offered: [OFFER_BOT_TEMPLATE_TOOL, OFFER_MARKETPLACE_ITEM_TOOL],
    });
    for (const tool of tools) {
      expect(tool.description).toContain("clearly fits");
      expect(tool.description).toContain("never again");
      expect(tool.description).toContain("Marketplace");
    }
    expect(tools[1]?.description).toContain("Superpowers");
  });

  test("they answer JSON the Bot reads, with Marketplace text marked as data", async () => {
    const [findTemplates, findItems] = suggestionTools({
      templates: TEMPLATES,
      marketplace: sources(),
      viewer,
      offered: [OFFER_BOT_TEMPLATE_TOOL, OFFER_MARKETPLACE_ITEM_TOOL],
    });
    const templates = JSON.parse(
      (await findTemplates?.execute({ query: "code review" })) ?? "",
    );
    expect(templates.templates[0].id).toBe("code-reviewer");
    const items = JSON.parse(
      (await findItems?.execute({ query: "testing" })) ?? "",
    );
    expect(items.untrusted).toContain("untrusted data");
    expect(items.items.map((item: { id: string }) => item.id)).toEqual([
      "1",
      "2",
      "3",
    ]);
    expect(await findItems?.execute({ query: "" })).toBe(
      "Nothing was searched: say what to match.",
    );
  });

  test("the general guidance comes with the finders and not without them", () => {
    expect(suggestionGuidance([{ name: "ask_person" }])).toBeNull();
    const guidance = suggestionGuidance([
      { name: FIND_MARKETPLACE_ITEMS_TOOL },
    ]);
    expect(guidance).toContain("later tasks");
    expect(guidance).toContain("declined");
  });
});

describe("the finders over HTTP", () => {
  const signedIn: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", { id: "user-1", role: "user" } as never);
    await next();
  };
  const app = (bot: { id: string; ownerUserId: string } | null) =>
    new Hono().route(
      "/api/suggestions",
      createSuggestionRoutes({
        templates: TEMPLATES,
        marketplace: sources(),
        store: { get: async () => bot as never },
        requireUser: signedIn,
      }),
    );

  test("templates, items and one item answer as the tools do", async () => {
    const routes = app({ id: "bot-1", ownerUserId: "user-1" });
    const templates = await routes.request(
      "http://x/api/suggestions/templates?query=code%20review",
    );
    expect((await templates.json()).templates[0].id).toBe("code-reviewer");
    const items = await routes.request(
      "http://x/api/suggestions/marketplace?query=testing&agentId=bot-1",
    );
    expect(
      (await items.json()).items.map((item: { id: string }) => item.id),
    ).toEqual(["1", "2", "3"]);
    const one = await routes.request(
      "http://x/api/suggestions/marketplace/3?agentId=bot-1",
    );
    expect((await one.json()).item).toMatchObject({
      id: "3",
      eligibility: "needs-account",
    });
  });

  test("a Bot the person cannot see, and an id nothing offers, are 404s", async () => {
    const hidden = app(null);
    expect(
      (
        await hidden.request(
          "http://x/api/suggestions/marketplace?query=testing&agentId=bot-9",
        )
      ).status,
    ).toBe(404);
    const routes = app({ id: "bot-1", ownerUserId: "user-1" });
    expect(
      (
        await routes.request(
          "http://x/api/suggestions/marketplace/4?agentId=bot-1",
        )
      ).status,
    ).toBe(404);
  });
});
