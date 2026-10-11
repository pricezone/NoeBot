import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { readConnectState } from "../src/plugins/oauth";
import { pluginIndexEntry } from "../src/plugins/plugin-index";
import { createPluginRoutes } from "../src/plugins/routes";
import {
  CatalogueEntryUnknownError,
  CustomServerRefusedError,
  type OAuthMetadata,
  type PluginRecord,
  PluginRefusedError,
  type ResolvedUserOAuth,
  type ServerAddress,
  type SkillRecord,
} from "../src/plugins/store";

/**
 * The Marketplace plugin routes: `GET /marketplace`, `POST /install`, `DELETE /install/:id`, and
 * what `connect`, `enable`, the skill routes and the server delete do when the row is a plugin's.
 *
 * The store is a fake that records what it was asked, because the questions these routes have to
 * get right are about who may do what and in which words — the store's own behaviour has its
 * integration suite. GitHub is a fake too: a `SKILL.md` per path, or nothing.
 */

const ENCRYPTION_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

function signedIn(
  role: "user" | "admin" = "user",
  id = "user-1",
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    context.set("actor", { id, email: `${id}@openbot.test`, role } as never);
    await next();
  };
}

/** Treg: one `header` server and one skill. Ahrefs: one `oauth-discover` server, no skills. */
const TREG = pluginIndexEntry("55647425");
const AHREFS = pluginIndexEntry("56809965");
if (!TREG || !AHREFS) throw new Error("the committed index lost a fixture");

const METADATA: OAuthMetadata = {
  resource: "https://api.ahrefs.com/mcp/mcp",
  authorizationServer: "https://auth.ahrefs.example",
  authorizationEndpoint: "https://auth.ahrefs.example/authorize",
  tokenEndpoint: "https://auth.ahrefs.example/token",
  registrationEndpoint: "https://auth.ahrefs.example/register",
  revocationEndpoint: null,
  scopes: ["mcp"],
  discoveredAt: new Date().toISOString(),
};

const resolved = (metadata: OAuthMetadata): ResolvedUserOAuth => ({
  kind: "user-oauth",
  authorizationUrl: metadata.authorizationEndpoint,
  tokenUrl: metadata.tokenEndpoint,
  scopes: metadata.scopes,
  clientRegistration: "dynamic",
  registrationUrl: metadata.registrationEndpoint ?? undefined,
  authorizationParams: metadata.resource
    ? { resource: metadata.resource }
    : undefined,
  title: "Ahrefs",
});

function pluginRecord(id: string, installedByUserId: string): PluginRecord {
  const entry = pluginIndexEntry(id);
  return {
    id,
    slug: entry?.slug ?? id,
    name: entry?.displayName ?? id,
    gitRef: entry?.gitRef ?? "0".repeat(40),
    installedBy: `${installedByUserId}@openbot.test`,
    installedByUserId,
    installedAt: "2026-10-11T00:00:00.000Z",
    serverIds: entry?.servers.map((server) => server.serverId) ?? [],
    skillSlugs: entry?.skills.map((skill) => skill.slug) ?? [],
    skipped: [],
  };
}

function skillRecord(slug: string, pluginId: string | null): SkillRecord {
  return {
    id: slug,
    slug,
    ownerUserId: null,
    title: slug,
    summary: "",
    instructions: "Do it.",
    origin: pluginId ? "plugin" : "catalogue",
    installedBy: null,
    pluginId,
    offeredToAllBots: pluginId !== null,
    grantedTo: [],
    tools: [],
  };
}

type Calls = {
  installed: unknown[];
  uninstalled: string[];
  headerConnections: unknown[];
  discovered: string[];
  heldDisconnects: unknown[];
  skillOffers: unknown[];
};

function harness(
  input: {
    role?: "user" | "admin";
    userId?: string;
    plugins?: PluginRecord[];
    rows?: ServerAddress[];
    skills?: SkillRecord[];
    metadata?: OAuthMetadata | null;
    discoveryFails?: boolean;
    installRefuses?: Error;
    variables?: {
      name: string;
      description: string | null;
      writeOnly: boolean;
      required: boolean;
    }[];
    fetchSkill?: (path: string) => string | null;
  } = {},
) {
  const calls: Calls = {
    installed: [],
    uninstalled: [],
    headerConnections: [],
    discovered: [],
    heldDisconnects: [],
    skillOffers: [],
  };
  const plugins = input.plugins ?? [];
  const rows = input.rows ?? [];
  const metadata = input.metadata === undefined ? METADATA : input.metadata;
  const store = {
    listPlugins: async () => plugins,
    listServers: async () => [],
    listSkills: async () => input.skills ?? [],
    serverAddress: async (serverId: string) =>
      rows.find((row) => row.id === serverId),
    serverExists: async (serverId: string) =>
      rows.some((row) => row.id === serverId),
    installPlugin: async (request: unknown) => {
      calls.installed.push(request);
      if (input.installRefuses) throw input.installRefuses;
      return { plugin: pluginRecord(TREG.id, "user-1"), created: true };
    },
    uninstallPlugin: async (pluginId: string) => {
      calls.uninstalled.push(pluginId);
    },
    connectVariablesFor: async () => input.variables ?? null,
    recordHeaderConnection: async (request: unknown) => {
      calls.headerConnections.push(request);
    },
    refreshTools: async () => ({ tools: 1 }),
    ensureOAuthDiscovery: async (serverId: string) => {
      calls.discovered.push(serverId);
      if (input.discoveryFails) {
        throw new PluginRefusedError(
          "Ahrefs did not say how to sign in.",
          null,
        );
      }
      return metadata;
    },
    oauthAuthFor: async () => (metadata ? resolved(metadata) : null),
    oauthClientFor: async () => null,
    ensureOAuthClient: async () => ({
      clientId: "registered",
      clientSecret: "",
      source: "stored" as const,
    }),
    disconnectHeld: async (request: unknown) => {
      calls.heldDisconnects.push(request);
      return { disconnected: true, vendorRevocationRequested: false as const };
    },
    setSkillOfferedToAllBots: async (slug: string, on: boolean) => {
      if (slug === "unknown") throw new CatalogueEntryUnknownError(slug);
      calls.skillOffers.push({ slug, on });
      return { ...skillRecord(slug, TREG.id), offeredToAllBots: on };
    },
    skillOwner: async () => null,
    uninstallSkill: async () => undefined,
    installSkill: async () => undefined,
  };
  const routes = createPluginRoutes(
    store as never,
    signedIn(input.role, input.userId),
    async () => true,
    {
      publicUrl: "https://openbot.example",
      appUrl: "https://app.example",
      encryptionKey: ENCRYPTION_KEY,
      personHasAccess: async () => true,
    },
  );
  const app = new Hono().route("/api/plugins", routes);
  const request = (path: string, init?: RequestInit) =>
    app.request(`http://openbot.example/api/plugins${path}`, init);
  return { calls, request };
}

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/** The committed index's `SKILL.md`s are read out of GitHub; here they are a function. */
const originalFetch = globalThis.fetch;
function withGithub(
  answer: (path: string) => string | null,
  run: () => Promise<void>,
) {
  const fetchFake = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith("https://raw.githubusercontent.com/")) {
      throw new TypeError("unreachable");
    }
    const body = answer(decodeURIComponent(url.split("/").slice(6).join("/")));
    return body === null
      ? new Response("", { status: 404 })
      : new Response(body, { status: 200 });
  }) as unknown as typeof fetch;
  globalThis.fetch = fetchFake;
  return run().finally(() => {
    globalThis.fetch = originalFetch;
  });
}

describe("the Marketplace listing", () => {
  test("lists what runs here, trimmed, with what is installed and whether it is mine", async () => {
    const { request } = harness({
      plugins: [
        pluginRecord(TREG.id, "user-1"),
        pluginRecord(AHREFS.id, "user-2"),
      ],
    });
    const response = await request("/marketplace");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, max-age=300");
    const body = (await response.json()) as {
      plugins: Record<string, unknown>[];
      installed: Record<string, { mine: boolean }>;
    };
    const treg = body.plugins.find((plugin) => plugin.id === TREG.id);
    expect(treg).toMatchObject({
      name: "Treg",
      availability: "installable",
      servers: [
        { serverId: "treg", authKind: "header", variables: ["TREG_TOKEN"] },
      ],
    });
    // Trimmed: no git ref, no header templates, no skipped parts reach the browser.
    expect(JSON.stringify(treg)).not.toContain("gitRef");
    expect(JSON.stringify(treg)).not.toContain("headers");
    expect(
      body.plugins.every((plugin) => plugin.availability !== "unavailable"),
    ).toBe(true);
    expect(body.installed[TREG.id]?.mine).toBe(true);
    expect(body.installed[AHREFS.id]?.mine).toBe(false);
  });
});

describe("installing a plugin", () => {
  test("reads the skills out of GitHub at the pinned commit and installs for every Bot", async () => {
    const { calls, request } = harness();
    await withGithub(
      (path) =>
        path === TREG.skills[0]?.path
          ? "---\nname: Treg\ndescription: Reach for this first.\n---\n\n# Treg\n\nCall the tool."
          : null,
      async () => {
        const response = await request("/install", json({ pluginId: TREG.id }));
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ created: true });
      },
    );
    expect(calls.installed).toHaveLength(1);
    expect(calls.installed[0]).toMatchObject({
      entry: { id: TREG.id },
      by: "user-1@openbot.test",
      byUserId: "user-1",
      skills: [
        {
          slug: TREG.skills[0]?.slug,
          title: "Treg",
          summary: "Reach for this first.",
          instructions: "# Treg\n\nCall the tool.",
        },
      ],
    });
  });

  test("a skill GitHub does not answer is left out with its reason, and the rest installs", async () => {
    const { calls, request } = harness();
    await withGithub(
      () => null,
      async () => {
        const response = await request("/install", json({ pluginId: TREG.id }));
        expect(response.status).toBe(200);
      },
    );
    expect(calls.installed[0]).toMatchObject({
      skills: [],
      skipped: [
        { kind: "skill", name: TREG.skills[0]?.name, reason: "not-found" },
      ],
    });
  });

  test("refuses what is not a plugin, what the catalogue connects, and what runs nowhere here", async () => {
    const { calls, request } = harness();
    expect((await request("/install", json({}))).status).toBe(400);
    expect(
      (await request("/install", json({ pluginId: "999999999" }))).status,
    ).toBe(404);
    const notion = await request("/install", json({ pluginId: "404" }));
    expect(notion.status).toBe(409);
    expect(await notion.json()).toMatchObject({ catalogueKey: "notion" });
    // Parallel's plugin is a CLI; the catalogue has the vendor's MCP server instead.
    const parallel = await request("/install", json({ pluginId: "698" }));
    expect(parallel.status).toBe(409);
    expect(calls.installed).toEqual([]);
  });

  test("the store's refusal is the person's answer, as a 409", async () => {
    const { request } = harness({
      installRefuses: new CustomServerRefusedError(
        "treg is already the name of a server here.",
      ),
    });
    await withGithub(
      () => "Body.",
      async () => {
        const response = await request("/install", json({ pluginId: TREG.id }));
        expect(response.status).toBe(409);
        expect((await response.json()).error).toBe(
          "treg is already the name of a server here.",
        );
      },
    );
  });

  test("removing is the installer's or an administrator's", async () => {
    const plugins = [pluginRecord(TREG.id, "user-2")];
    const stranger = harness({ plugins });
    expect(
      (await stranger.request(`/install/${TREG.id}`, { method: "DELETE" }))
        .status,
    ).toBe(403);
    expect(stranger.calls.uninstalled).toEqual([]);

    const installer = harness({ plugins, userId: "user-2" });
    expect(
      (await installer.request(`/install/${TREG.id}`, { method: "DELETE" }))
        .status,
    ).toBe(200);
    expect(installer.calls.uninstalled).toEqual([TREG.id]);

    const admin = harness({ plugins, role: "admin" });
    expect(
      (await admin.request(`/install/${TREG.id}`, { method: "DELETE" })).status,
    ).toBe(200);
    expect(
      (await admin.request("/install/999", { method: "DELETE" })).status,
    ).toBe(404);
  });
});

const tregRow: ServerAddress = {
  id: "treg",
  title: "Treg",
  url: "https://treg.to/mcp/",
  authScheme: null,
  provenance: "plugin",
  authKind: "header",
  pluginId: TREG.id,
};
const ahrefsRow: ServerAddress = {
  id: "ahrefs",
  title: "Ahrefs",
  url: "https://api.ahrefs.com/mcp/mcp",
  authScheme: null,
  provenance: "plugin",
  authKind: "oauth-discover",
  pluginId: AHREFS.id,
};
const openRow: ServerAddress = {
  id: "convex",
  title: "Convex",
  url: "https://mcp.convex.dev/mcp",
  authScheme: null,
  provenance: "plugin",
  authKind: "none",
  pluginId: "233",
};

describe("connecting a plugin's server", () => {
  test("an open server needs no account, and says so", async () => {
    const { request } = harness({ rows: [openRow] });
    const response = await request("/servers/convex/connect", {
      method: "POST",
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("needs no account");
  });

  test("a header server is a form: asked with nothing it answers what it wants, never a value", async () => {
    const variables = [
      {
        name: "TREG_TOKEN",
        description: "Your Treg token.",
        writeOnly: true,
        required: true,
      },
    ];
    const { calls, request } = harness({ rows: [tregRow], variables });
    const form = await request("/servers/treg/connect", { method: "POST" });
    expect(form.status).toBe(200);
    expect(await form.json()).toEqual({ variables });

    const submitted = await request(
      "/servers/treg/connect",
      json({ variables: { TREG_TOKEN: "sk-treg-123" } }),
    );
    expect(submitted.status).toBe(200);
    expect(await submitted.json()).toEqual({ connected: true });
    expect(calls.headerConnections).toEqual([
      {
        serverId: "treg",
        userId: "user-1",
        values: { TREG_TOKEN: "sk-treg-123" },
        by: "user-1@openbot.test",
      },
    ]);
    // Nothing of the value in the answer.
    expect(
      JSON.stringify(
        await (
          await request("/servers/treg/connect", { method: "POST" })
        ).json(),
      ),
    ).not.toContain("sk-treg");

    const wrong = await request(
      "/servers/treg/connect",
      json({ variables: { TREG_TOKEN: 1 } }),
    );
    expect(wrong.status).toBe(400);
  });

  test("an OAuth server discovers the vendor's endpoints and sends the person there with PKCE and the resource", async () => {
    const { calls, request } = harness({ rows: [ahrefsRow] });
    const response = await request("/servers/ahrefs/connect", {
      method: "POST",
    });
    expect(response.status).toBe(200);
    expect(calls.discovered).toEqual(["ahrefs"]);
    const url = new URL((await response.json()).authorizationUrl as string);
    expect(url.origin + url.pathname).toBe(
      "https://auth.ahrefs.example/authorize",
    );
    expect(url.searchParams.get("client_id")).toBe("registered");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toBe("mcp");
    expect(url.searchParams.get("resource")).toBe(
      "https://api.ahrefs.com/mcp/mcp",
    );
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://openbot.example/api/plugins/oauth/callback",
    );
    const state = await readConnectState(
      url.searchParams.get("state") ?? "",
      ENCRYPTION_KEY,
    );
    expect(state?.serverId).toBe("ahrefs");
    expect(state?.userId).toBe("user-1");
  });

  test("a vendor that publishes no sign-in is a 502 in the store's words", async () => {
    const { request } = harness({
      rows: [ahrefsRow],
      discoveryFails: true,
      metadata: null,
    });
    const response = await request("/servers/ahrefs/connect", {
      method: "POST",
    });
    expect(response.status).toBe(502);
    expect((await response.json()).error).toBe(
      "Ahrefs did not say how to sign in.",
    );
  });

  test("a plugin server nobody installed is not added on the way, unlike a catalogue vendor", async () => {
    const { request } = harness();
    const response = await request("/servers/ahrefs/connect", {
      method: "POST",
    });
    expect(response.status).toBe(404);
    expect((await response.json()).error).toContain("not installed");
  });

  test("Enable is not the plugin button", async () => {
    const { request } = harness({ rows: [openRow] });
    const response = await request("/servers/ahrefs/enable", {
      method: "POST",
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("Press Add on the plugin");
  });

  test("a held connection ends in the vault, as the person's own", async () => {
    const { calls, request } = harness({ rows: [tregRow] });
    const response = await request("/servers/treg/connection", {
      method: "DELETE",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      disconnected: true,
      vendorRevocationRequested: false,
    });
    expect(calls.heldDisconnects).toEqual([
      { serverId: "treg", userId: "user-1", by: "user-1" },
    ]);
  });
});

describe("a plugin's parts stay with the plugin", () => {
  test("an administrator cannot delete one of its servers on its own", async () => {
    const { request } = harness({ rows: [tregRow], role: "admin" });
    const response = await request("/servers/treg", { method: "DELETE" });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain(
      "Remove the plugin instead",
    );
  });

  test("a plugin's skill is neither saved over nor deleted on its own, and can be narrowed", async () => {
    const slug = TREG.skills[0]?.slug ?? "treg-treg";
    const { calls, request } = harness({
      role: "admin",
      skills: [skillRecord(slug, TREG.id)],
    });
    const saved = await request(
      "/skills",
      json({ slug, title: "Mine now", instructions: "Replaced." }),
    );
    expect(saved.status).toBe(409);
    expect(
      (await request(`/skills/${slug}`, { method: "DELETE" })).status,
    ).toBe(409);

    const narrowed = await request(
      `/skills/${slug}/offer-to-all`,
      json({ on: false }),
    );
    expect(narrowed.status).toBe(200);
    expect(calls.skillOffers).toEqual([{ slug, on: false }]);
    expect(
      (await request(`/skills/${slug}/offer-to-all`, json({ on: "no" })))
        .status,
    ).toBe(400);
    expect(
      (await request("/skills/unknown/offer-to-all", json({ on: true })))
        .status,
    ).toBe(404);
  });

  test("the skill switch is an administrator's", async () => {
    const { request } = harness({
      skills: [skillRecord("treg-treg", TREG.id)],
    });
    expect(
      (await request("/skills/treg-treg/offer-to-all", json({ on: true })))
        .status,
    ).toBe(403);
  });
});
