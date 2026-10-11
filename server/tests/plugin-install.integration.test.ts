// biome-ignore-all lint/suspicious/noTemplateCurlyInString: a plugin's `${NAME}` placeholder is data here, not a template.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import type { ActionPolicy } from "../src/computer/policy";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  agents,
  credentials,
  mcpServers,
  mcpTools,
  mcpUserCredentials,
  plugins,
  skills,
  users,
} from "../src/db/schema";
import { accessFor } from "../src/plugins/access";
import { pluginIndexEntry } from "../src/plugins/plugin-index";
import {
  CustomServerRefusedError,
  createPluginStore,
  type DiscoveredOAuth,
  PluginRefusedError,
} from "../src/plugins/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Installing a Marketplace plugin, end to end in the store: the rows it writes, what it refuses,
 * how a person's header token and a vendor's discovered sign-in reach a call, and what removing it
 * takes away. Against the real vault, because the header token's whole path is vault to request.
 *
 * Two of the committed index's plugins stand in for the shapes: Treg (one `header` server, one
 * skill) and Ahrefs (one `oauth-discover` server). Their real ids are used, so this suite owns
 * `treg` and `ahrefs` in the scratch database and removes them after.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const credentialStore = createCredentialStore(database);
const ENCRYPTION_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const policy: ActionPolicy = { mode: "enforce", deny: [], allow: ["true"] };

const suite = randomUUID().slice(0, 8);
const installer = `user_installer_${suite}`;
const stranger = `user_stranger_${suite}`;
const bot = `agent_install_${suite}`;

const TREG = pluginIndexEntry("55647425");
const AHREFS = pluginIndexEntry("56809965");
if (!TREG || !AHREFS) throw new Error("the committed index lost a fixture");
const TREG_SKILL = TREG.skills[0]?.slug ?? "treg-treg";

const calls: {
  url: string;
  headers?: Record<string, string>;
  token?: string;
}[] = [];
let discoveries = 0;
let discovered: DiscoveredOAuth = {
  resource: "https://api.ahrefs.com/mcp/mcp",
  authorizationServer: "https://auth.ahrefs.example",
  authorizationEndpoint: "https://auth.ahrefs.example/authorize",
  tokenEndpoint: "https://auth.ahrefs.example/token",
  registrationEndpoint: "https://auth.ahrefs.example/register",
  revocationEndpoint: null,
  scopes: ["mcp"],
  codeChallengeMethods: ["S256"],
};

const store = createPluginStore({
  database,
  auditStore: createAuditStore(database),
  credentials: credentialStore,
  encryptionKey: ENCRYPTION_KEY,
  policy: () => policy,
  callVendor: async (connection) => {
    calls.push({
      url: connection.url,
      headers: connection.headers,
      token: connection.token,
    });
    return { text: "ok", isError: false };
  },
  discover: async () => {
    discoveries += 1;
    return discovered;
  },
  redirectUri: "https://openbot.example/api/plugins/oauth/callback",
});

const by = `${installer}@example.test`;

/** The two plugins this suite owns, taken away whole — before it runs, in case a run was cut short. */
async function removePlugins() {
  for (const id of [TREG.id, AHREFS.id]) {
    const [row] = await database
      .select({ id: plugins.id })
      .from(plugins)
      .where(eq(plugins.id, id))
      .limit(1);
    if (row) await store.uninstallPlugin(id, "teardown");
  }
}

beforeAll(async () => {
  await removePlugins();
  await database
    .insert(users)
    .values([
      { id: installer, email: `${installer}@example.test`, name: installer },
      { id: stranger, email: `${stranger}@example.test`, name: stranger },
    ])
    .onConflictDoNothing();
  await database
    .insert(agents)
    .values({ id: bot, name: bot, type: "remote_ag_ui", configuration: {} })
    .onConflictDoNothing();
});

afterAll(async () => {
  await removePlugins();
  await database.delete(agents).where(eq(agents.id, bot));
  await database.delete(users).where(inArray(users.id, [installer, stranger]));
});

const install = (entry = TREG) =>
  store.installPlugin({
    entry,
    skills:
      entry === TREG
        ? [
            {
              slug: TREG_SKILL,
              title: "Treg",
              summary: "Reach for this first.",
              instructions: "Call the treg tool.",
            },
          ]
        : [],
    skipped: [
      { kind: "rule", name: "treg-rules", reason: "unsupported-in-v1" },
    ],
    by,
    byUserId: installer,
  });

describe("how a plugin's server is reached", () => {
  test("each auth kind picks the credential it is reached with, and an unknown one refuses", () => {
    const row = (authKind: string | null) => ({
      id: "x",
      provenance: "plugin",
      url: "https://mcp.example.com/mcp",
      authScheme: null,
      authKind,
    });
    expect(accessFor(row("oauth-discover"), null)).toMatchObject({
      credential: "person-oauth",
      reachedAs: "person",
    });
    expect(accessFor(row("static-client"), null)).toMatchObject({
      credential: "person-oauth",
    });
    expect(accessFor(row("header"), null)).toMatchObject({
      credential: "person-header",
      reachedAs: "person",
    });
    expect(accessFor(row("none"), null)).toMatchObject({
      credential: "none",
      reachedAs: "deployment",
    });
    expect(() => accessFor(row(null), null)).toThrow("auth_kind");
    expect(() => accessFor(row("magic"), null)).toThrow("auth_kind");
  });
});

describe("installing", () => {
  test("writes the plugin, its servers and its skills, offered to every Bot, in one go", async () => {
    const { plugin, created } = await install();
    expect(created).toBe(true);
    expect(plugin).toMatchObject({
      id: TREG.id,
      slug: "treg",
      installedByUserId: installer,
      serverIds: ["treg"],
      skillSlugs: [TREG_SKILL],
      skipped: [
        { kind: "rule", name: "treg-rules", reason: "unsupported-in-v1" },
      ],
    });

    const [server] = await database
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.id, "treg"));
    expect(server).toMatchObject({
      provenance: "plugin",
      pluginId: TREG.id,
      authKind: "header",
      offeredToAllBots: true,
      vendor: "treg.to",
      headerTemplates: { Authorization: "Bearer ${TREG_TOKEN}" },
    });
    const [skill] = await database
      .select()
      .from(skills)
      .where(eq(skills.slug, TREG_SKILL));
    expect(skill).toMatchObject({
      origin: "plugin",
      pluginId: TREG.id,
      ownerUserId: null,
      offeredToAllBots: true,
    });

    const listed = (await store.listServers()).find((row) => row.id === "treg");
    expect(listed?.connectVariables).toEqual([
      {
        name: "TREG_TOKEN",
        description: expect.any(String),
        writeOnly: true,
        required: true,
      },
    ]);
    expect(listed?.summary).toBe(TREG.description);
  });

  test("a second install of the same commit changes nothing, not even a narrowing", async () => {
    await store.setOfferedToAllBots("treg", false, "admin");
    const { created } = await install();
    expect(created).toBe(false);
    const [server] = await database
      .select({ offeredToAllBots: mcpServers.offeredToAllBots })
      .from(mcpServers)
      .where(eq(mcpServers.id, "treg"));
    expect(server?.offeredToAllBots).toBe(false);
    await store.setOfferedToAllBots("treg", true, "admin");
  });

  test("another commit is a removal and a fresh install, not an upsert", async () => {
    await expect(install({ ...TREG, gitRef: "f".repeat(40) })).rejects.toThrow(
      PluginRefusedError,
    );
  });

  test("a server added by URL cannot take a plugin server's name", async () => {
    await expect(
      store.addCustomServer({
        id: "treg",
        title: "Mine",
        url: "https://elsewhere.example/mcp",
        by,
      }),
    ).rejects.toThrow(CustomServerRefusedError);
    await expect(
      store.addCustomServer({
        id: "ahrefs",
        title: "Mine",
        url: "https://elsewhere.example/mcp",
        by,
      }),
    ).rejects.toThrow("Marketplace plugin");
  });
});

describe("a person's own header token", () => {
  test("is held in the vault and rendered into the call's headers for that person alone", async () => {
    await database
      .insert(mcpTools)
      .values({ serverId: "treg", name: "search", description: "Search." })
      .onConflictDoNothing();

    await expect(
      store.recordHeaderConnection({
        serverId: "treg",
        userId: installer,
        values: { TREG_TOKEN: "" },
        by,
      }),
    ).rejects.toThrow("needs TREG_TOKEN");
    await expect(
      store.recordHeaderConnection({
        serverId: "treg",
        userId: installer,
        values: { TREG_TOKEN: "sk-treg", OTHER: "x" },
        by,
      }),
    ).rejects.toThrow("does not take OTHER");

    await store.recordHeaderConnection({
      serverId: "treg",
      userId: installer,
      values: { TREG_TOKEN: "sk-treg-123" },
      by,
    });
    const [held] = await database
      .select({ credentialId: mcpUserCredentials.credentialId })
      .from(mcpUserCredentials)
      .where(
        and(
          eq(mcpUserCredentials.serverId, "treg"),
          eq(mcpUserCredentials.userId, installer),
        ),
      );
    expect(held).toBeDefined();
    const [vaultRow] = await database
      .select({
        kind: credentials.kind,
        encryptedValue: credentials.encryptedValue,
      })
      .from(credentials)
      .where(eq(credentials.id, held?.credentialId ?? ""));
    expect(vaultRow?.kind).toBe("mcp_user_token");
    expect(vaultRow?.encryptedValue).not.toContain("sk-treg-123");

    calls.length = 0;
    await store.callTool({
      ref: "treg/search",
      args: {},
      botId: bot,
      actorId: installer,
    });
    expect(calls).toEqual([
      {
        url: "https://treg.to/mcp/",
        headers: { Authorization: "Bearer sk-treg-123" },
        token: undefined,
      },
    ]);

    // Somebody who never added a token is refused with the step, and nothing goes out.
    calls.length = 0;
    await expect(
      store.callTool({
        ref: "treg/search",
        args: {},
        botId: bot,
        actorId: stranger,
      }),
    ).rejects.toThrow("You have not added your Treg token");
    expect(calls).toEqual([]);
  });

  test("ends in the vault when the person disconnects", async () => {
    expect(
      await store.disconnectHeld({
        serverId: "treg",
        userId: installer,
        by: installer,
      }),
    ).toEqual({ disconnected: true, vendorRevocationRequested: false });
    expect(
      await store.disconnectHeld({
        serverId: "treg",
        userId: installer,
        by: installer,
      }),
    ).toMatchObject({ disconnected: false });
    const live = await database
      .select({ id: credentials.id })
      .from(credentials)
      .where(
        and(
          eq(credentials.kind, "mcp_user_token"),
          eq(credentials.provider, "treg"),
          eq(credentials.keyId, installer),
        ),
      );
    expect(live.length).toBeGreaterThan(0);
    await expect(
      store.callTool({
        ref: "treg/search",
        args: {},
        botId: bot,
        actorId: installer,
      }),
    ).rejects.toThrow("You have not added your Treg token");
  });
});

describe("a plugin's skill reaches every Bot", () => {
  test("is offered with no grant row, decided alike, and narrowed by an administrator", async () => {
    const offered = await store.listForAgent(bot);
    expect(offered.skills.map((skill) => skill.slug)).toContain(TREG_SKILL);
    expect(await store.decide("skill", TREG_SKILL, bot)).toEqual({
      allowed: true,
    });

    const narrowed = await store.setSkillOfferedToAllBots(
      TREG_SKILL,
      false,
      "admin",
    );
    expect(narrowed.offeredToAllBots).toBe(false);
    expect(
      (await store.listForAgent(bot)).skills.map((skill) => skill.slug),
    ).not.toContain(TREG_SKILL);
    expect((await store.decide("skill", TREG_SKILL, bot)).allowed).toBe(false);

    await store.setSkillOfferedToAllBots(TREG_SKILL, true, "admin");
    expect(await store.decide("skill", TREG_SKILL, bot)).toEqual({
      allowed: true,
    });
  });
});

describe("a vendor's discovered sign-in", () => {
  test("is found once, cached on the row, and read back as the OAuth the person is sent through", async () => {
    await install(AHREFS);
    discoveries = 0;
    const metadata = await store.ensureOAuthDiscovery("ahrefs", by);
    expect(metadata).toMatchObject({
      tokenEndpoint: "https://auth.ahrefs.example/token",
      registrationEndpoint: "https://auth.ahrefs.example/register",
      scopes: ["mcp"],
    });
    await store.ensureOAuthDiscovery("ahrefs", by);
    expect(discoveries).toBe(1);

    expect(await store.oauthAuthFor("ahrefs")).toMatchObject({
      kind: "user-oauth",
      authorizationUrl: "https://auth.ahrefs.example/authorize",
      tokenUrl: "https://auth.ahrefs.example/token",
      clientRegistration: "dynamic",
      registrationUrl: "https://auth.ahrefs.example/register",
      authorizationParams: { resource: "https://api.ahrefs.com/mcp/mcp" },
      title: "Ahrefs",
    });
    const listed = (await store.listServers()).find(
      (row) => row.id === "ahrefs",
    );
    expect(listed).toMatchObject({
      authKind: "oauth-discover",
      oauthDiscovered: true,
      dynamicClient: true,
      oauthClientSource: null,
    });
    // A treg-shaped row is not signed into through metadata at all.
    await expect(store.ensureOAuthDiscovery("treg", by)).rejects.toThrow(
      PluginRefusedError,
    );
  });

  test("refuses metadata naming an address this deployment will not use, and caches nothing", async () => {
    await database
      .update(mcpServers)
      .set({ oauthMetadata: null })
      .where(eq(mcpServers.id, "ahrefs"));
    const sane = discovered;
    discovered = { ...sane, tokenEndpoint: "http://auth.internal/token" };
    await expect(store.ensureOAuthDiscovery("ahrefs", by)).rejects.toThrow(
      "will not use",
    );
    discovered = { ...sane, codeChallengeMethods: ["plain"] };
    await expect(store.ensureOAuthDiscovery("ahrefs", by)).rejects.toThrow(
      "PKCE",
    );
    discovered = sane;
    expect(await store.oauthAuthFor("ahrefs")).toBeNull();
  });
});

describe("removing", () => {
  test("takes the servers, their tokens, the skills and the plugin row, and nothing else", async () => {
    await store.recordHeaderConnection({
      serverId: "treg",
      userId: installer,
      values: { TREG_TOKEN: "sk-again" },
      by,
    });
    await store.uninstallPlugin(TREG.id, by);

    expect(
      await database.select().from(mcpServers).where(eq(mcpServers.id, "treg")),
    ).toEqual([]);
    expect(
      await database.select().from(skills).where(eq(skills.slug, TREG_SKILL)),
    ).toEqual([]);
    expect(
      await database.select().from(plugins).where(eq(plugins.id, TREG.id)),
    ).toEqual([]);
    const tokens = await database
      .select({ revokedAt: credentials.revokedAt })
      .from(credentials)
      .where(
        and(
          eq(credentials.kind, "mcp_user_token"),
          eq(credentials.provider, "treg"),
        ),
      );
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens.every((row) => row.revokedAt !== null)).toBe(true);
    // The other plugin is untouched.
    expect((await store.listPlugins()).map((plugin) => plugin.id)).toEqual([
      AHREFS.id,
    ]);
    await expect(store.uninstallPlugin(TREG.id, by)).rejects.toThrow(
      "not a server",
    );
  });
});
