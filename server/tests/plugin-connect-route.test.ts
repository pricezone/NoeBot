import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { readConnectState } from "../src/plugins/oauth";
import { createPluginRoutes } from "../src/plugins/routes";
import {
  CatalogueEntryUnknownError,
  type OAuthClient,
  PluginInvariantError,
  type ServerRecord,
} from "../src/plugins/store";

/**
 * `POST /servers/:id/connect`, `POST /servers/:id/enable` and `POST /servers/:id/offer-to-all`:
 * the Marketplace's two buttons, and the administrator's switch behind them.
 *
 * Notion has no administrator step: nobody pastes a client id, so the first person to connect is
 * the one who makes the deployment introduce itself (RFC 7591) to the vendor. Google Drive is the
 * regression pin for the OLD behaviour, which must survive unchanged for a manually registered
 * vendor with nothing configured: no client anywhere is still a 409 telling an administrator to add
 * one, and registration is never attempted for it. What is new is that neither needs an
 * administrator to have ADDED the vendor first — connecting adds it, for every Bot — and that a
 * platform-provided client sends people back through the platform's relay rather than here.
 */

/** A real key shape: base64 over 32 bytes, which is what the deployment's own check demands. */
const ENCRYPTION_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

const RELAY = "https://www.hypernoesis.ai/api/plugins/oauth/relay";

function signedIn(
  role: "user" | "admin" = "user",
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    context.set("actor", {
      id: "user-1",
      email: "person@openbot.test",
      role,
    } as never);
    await next();
  };
}

/** A server row as the store answers one, from the one field these routes read back. */
function serverRecord(id: string, offeredToAllBots: boolean): ServerRecord {
  return {
    id,
    title: id,
    logo: null,
    vendor: "test",
    url: `https://${id}.example/mcp`,
    summary: "",
    docsUrl: "",
    provenance: "first-party",
    hasCredential: false,
    toolsRefreshedAt: null,
    lastError: null,
    addedBy: null,
    dynamicClient: false,
    oauthClientSource: null,
    offeredToAllBots,
    authScheme: null,
    tools: [],
    withdrawn: [],
  };
}

type AddCall = { key: string; by: string; offeredToAllBots?: boolean };

function app(
  store: {
    oauthClientFor: (serverId: string) => Promise<OAuthClient | null>;
    ensureOAuthClient?: (
      serverId: string,
      by: string,
    ) => Promise<OAuthClient | null>;
    /** Whether the vendor already has a row. Added by default, so the old tests read as before. */
    serverExists?: (serverId: string) => Promise<boolean>;
    /** The rows as the Marketplace lists them; empty by default. */
    listServers?: () => Promise<ServerRecord[]>;
    addServer?: (input: AddCall) => Promise<ServerRecord>;
    setOfferedToAllBots?: (
      serverId: string,
      on: boolean,
      by: string,
    ) => Promise<ServerRecord>;
  },
  options: {
    role?: "user" | "admin";
    deploymentId?: string;
    externalRedirectUri?: string;
  } = {},
) {
  const routes = createPluginRoutes(
    {
      /*
       * The read that decides whether this is a brokered row, which the handler makes before
       * anything about the consent flow. None of these vendors is one: a brokered app is reached
       * through Composio and enters none of the flow these tests are about. `undefined` is an id
       * naming no row, which falls through to the flow below exactly as a non-brokered row does.
       */
      serverAddress: async () => undefined,
      serverExists: async () => true,
      listServers: async () => [],
      ensureOAuthClient: async () => null,
      ...store,
    } as never,
    signedIn(options.role),
    async () => true,
    {
      publicUrl: "https://openbot.example",
      appUrl: "https://app.example",
      encryptionKey: ENCRYPTION_KEY,
      // Only the callback asks this. Every test here stops at the authorization URL.
      personHasAccess: async () => true,
      ...(options.deploymentId ? { deploymentId: options.deploymentId } : {}),
      ...(options.externalRedirectUri
        ? { externalRedirectUri: options.externalRedirectUri }
        : {}),
    },
  );
  return new Hono().route("/api/plugins", routes);
}

const post = (hono: Hono, path: string, body?: unknown) =>
  hono.request(`http://t/api/plugins${path}`, {
    method: "POST",
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });

describe("connecting a dynamically registered vendor", () => {
  test("registers a client on first connect and mints an authorization URL with it", async () => {
    const ensureCalls: { serverId: string; by: string }[] = [];
    const hono = app({
      oauthClientFor: async () => null,
      ensureOAuthClient: async (serverId, by) => {
        ensureCalls.push({ serverId, by });
        return { clientId: "dyn-1", clientSecret: "", source: "stored" };
      },
    });

    const response = await post(hono, "/servers/notion/connect");

    expect(response.status).toBe(200);
    expect(ensureCalls).toEqual([
      { serverId: "notion", by: "person@openbot.test" },
    ]);

    const body = (await response.json()) as { authorizationUrl: string };
    const url = new URL(body.authorizationUrl);
    expect(url.host).toBe("mcp.notion.com");
    expect(url.pathname).toBe("/authorize");
    expect(url.searchParams.get("client_id")).toBe("dyn-1");
    // A stored client was registered with this deployment's own callback, and keeps naming it.
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://openbot.example/api/plugins/oauth/callback",
    );
  });

  /**
   * One answer for two states, because there is one thing to do about either.
   *
   * A vendor that turned this deployment down and a vendor that could not be reached both leave
   * `ensureOAuthClient` with no client, and the person pressing Connect has the same next step
   * whichever it was. The sentence says both rather than naming the wrong one confidently; which it
   * actually was is in the log, where it is of use to somebody who can act on it.
   */
  test("a registration that produced no client answers 502, naming the vendor", async () => {
    const ensureCalls: { serverId: string; by: string }[] = [];
    const hono = app({
      oauthClientFor: async () => null,
      ensureOAuthClient: async (serverId, by) => {
        ensureCalls.push({ serverId, by });
        return null;
      },
    });

    const response = await post(hono, "/servers/notion/connect");

    expect(response.status).toBe(502);
    expect(ensureCalls.length).toBe(1);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe(
      "Notion would not register this deployment, or could not be reached. Try again, and check the vendor's status if it persists.",
    );
  });
});

describe("connecting a manually registered vendor (regression pin)", () => {
  test("still 409s with no client anywhere, and never attempts self-registration", async () => {
    const ensureCalls: { serverId: string; by: string }[] = [];
    const hono = app({
      oauthClientFor: async () => null,
      ensureOAuthClient: async (serverId, by) => {
        ensureCalls.push({ serverId, by });
        return {
          clientId: "should-not-happen",
          clientSecret: "x",
          source: "stored",
        };
      },
    });

    const response = await post(hono, "/servers/google-drive/connect");

    expect(response.status).toBe(409);
    expect(ensureCalls).toEqual([]);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("no OAuth client registered");
  });
});

/**
 * Connecting a catalogue vendor that nobody has added to this deployment.
 *
 * This used to be a 409 telling the person to find an administrator, and before that a 500. Neither
 * was a decision worth an administrator's: the entry is reviewed code at a pinned host, and the only
 * thing the row will hold that the person does not already control is their own grant. So the press
 * adds it, and adds it the way the Marketplace means — for every Bot — which the Plugins page can
 * narrow afterwards.
 */
describe("connecting a vendor this deployment has not added", () => {
  test("adds it on first connect, offered to every Bot, and carries on to the vendor", async () => {
    const added: AddCall[] = [];
    let exists = false;
    const hono = app({
      serverExists: async () => exists,
      addServer: async (input) => {
        added.push(input);
        exists = true;
        return serverRecord(input.key, input.offeredToAllBots === true);
      },
      // Read after the add, so the row the client hangs off is there.
      oauthClientFor: async () =>
        exists
          ? { clientId: "dyn-1", clientSecret: "", source: "stored" }
          : null,
    });

    const response = await post(hono, "/servers/notion/connect");

    expect(response.status).toBe(200);
    expect(added).toEqual([
      { key: "notion", by: "person@openbot.test", offeredToAllBots: true },
    ]);
    const body = (await response.json()) as { authorizationUrl: string };
    expect(new URL(body.authorizationUrl).host).toBe("mcp.notion.com");
  });

  test("a vendor already added is not added again", async () => {
    const added: AddCall[] = [];
    const hono = app({
      serverExists: async () => true,
      addServer: async (input) => {
        added.push(input);
        return serverRecord(input.key, true);
      },
      oauthClientFor: async () => ({
        clientId: "dyn-1",
        clientSecret: "",
        source: "stored",
      }),
    });

    expect((await post(hono, "/servers/notion/connect")).status).toBe(200);
    expect(added).toEqual([]);
  });

  test("a fault of this deployment's own on the add is a 409 with its sentence, not a 500", async () => {
    const hono = app({
      serverExists: async () => false,
      addServer: async () => {
        throw new PluginInvariantError("notion is two rows at once.");
      },
      oauthClientFor: async () => null,
    });

    const response = await post(hono, "/servers/notion/connect");

    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toBe(
      "notion is two rows at once.",
    );
  });
});

/**
 * A client the platform configured rather than one this deployment holds.
 *
 * One Google client serves every deployment the platform runs, so Google was told ONE redirect
 * URI: the platform's relay. The consent request has to name that address or Google refuses it,
 * and the relay has to be told which deployment to forward the callback to, which is what the id in
 * front of the state is for. Both follow the CLIENT, not the configuration alone: a stored client
 * on the same deployment was registered with this deployment's own callback and keeps naming it.
 */
describe("connecting with a platform-provided client", () => {
  // No secret: the platform holds it, and nothing on this route needs one anyway.
  const ENV_CLIENT: OAuthClient = {
    clientId: "platform-google",
    clientSecret: "",
    source: "env",
  };

  test("names the relay as the redirect URI and addresses the state to this deployment", async () => {
    const hono = app(
      { oauthClientFor: async () => ENV_CLIENT },
      { deploymentId: "inst1", externalRedirectUri: RELAY },
    );

    const response = await post(hono, "/servers/google-drive/connect");

    expect(response.status).toBe(200);
    const body = (await response.json()) as { authorizationUrl: string };
    const url = new URL(body.authorizationUrl);
    expect(url.searchParams.get("client_id")).toBe("platform-google");
    expect(url.searchParams.get("redirect_uri")).toBe(RELAY);

    const state = url.searchParams.get("state") ?? "";
    expect(state.startsWith("inst1.")).toBe(true);
    // The half after the id is a state this deployment sealed, naming the person and the server.
    const sealed = state.slice("inst1.".length);
    expect(sealed).not.toContain(".");
    expect(await readConnectState(sealed, ENCRYPTION_KEY)).toMatchObject({
      userId: "user-1",
      serverId: "google-drive",
    });
  });

  test("a stored client on the same deployment keeps its own callback and a bare state", async () => {
    const hono = app(
      {
        oauthClientFor: async () => ({
          clientId: "pasted-by-admin",
          clientSecret: "s",
          source: "stored",
        }),
      },
      { deploymentId: "inst1", externalRedirectUri: RELAY },
    );

    const response = await post(hono, "/servers/google-drive/connect");

    expect(response.status).toBe(200);
    const url = new URL(
      ((await response.json()) as { authorizationUrl: string })
        .authorizationUrl,
    );
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://openbot.example/api/plugins/oauth/callback",
    );
    expect(url.searchParams.get("state")).not.toContain(".");
  });

  test("a platform client with no deployment id sends the state bare", async () => {
    const hono = app(
      { oauthClientFor: async () => ENV_CLIENT },
      { externalRedirectUri: RELAY },
    );

    const response = await post(hono, "/servers/google-drive/connect");
    const url = new URL(
      ((await response.json()) as { authorizationUrl: string })
        .authorizationUrl,
    );
    expect(url.searchParams.get("redirect_uri")).toBe(RELAY);
    expect(url.searchParams.get("state")).not.toContain(".");
  });

  test("both routes report the relay beside the deployment's own callback", async () => {
    const hono = app(
      {
        oauthClientFor: async () => ENV_CLIENT,
        listServers: async () => [],
        listSkills: async () => [],
        connectionsFor: async () => [],
        brokeredConnectionsFor: async () => [],
      } as never,
      { externalRedirectUri: RELAY },
    );

    const index = (await (
      await hono.request("http://t/api/plugins")
    ).json()) as { redirectUri: string; externalRedirectUri: string };
    expect(index.redirectUri).toBe(
      "https://openbot.example/api/plugins/oauth/callback",
    );
    expect(index.externalRedirectUri).toBe(RELAY);

    const connections = (await (
      await hono.request("http://t/api/plugins/connections")
    ).json()) as { externalRedirectUri: string | null };
    expect(connections.externalRedirectUri).toBe(RELAY);
  });
});

/**
 * Enabling an app that needs no account, for every Bot.
 *
 * The other Marketplace button. Nothing is handed to anybody and nothing is stored, so anybody may
 * press it; what it refuses is the two kinds that DO hold a secret, each with the step that applies.
 */
describe("enabling a catalogue app that needs no account", () => {
  test("adds it, offered to every Bot, and answers with the server", async () => {
    const added: AddCall[] = [];
    const hono = app({
      oauthClientFor: async () => null,
      serverExists: async () => false,
      addServer: async (input) => {
        added.push(input);
        return serverRecord(input.key, input.offeredToAllBots === true);
      },
    });

    const response = await post(hono, "/servers/parallel/enable");

    expect(response.status).toBe(200);
    expect(added).toEqual([
      { key: "parallel", by: "person@openbot.test", offeredToAllBots: true },
    ]);
    const body = (await response.json()) as { server: ServerRecord };
    expect(body.server.id).toBe("parallel");
    expect(body.server.offeredToAllBots).toBe(true);
  });

  test("a builtin entry enables the same way", async () => {
    const added: AddCall[] = [];
    const hono = app({
      oauthClientFor: async () => null,
      serverExists: async () => false,
      addServer: async (input) => {
        added.push(input);
        return serverRecord(input.key, true);
      },
    });

    expect((await post(hono, "/servers/routines/enable")).status).toBe(200);
    expect(added.map((call) => call.key)).toEqual(["routines"]);
  });

  test("pressed again on an app already offered to every Bot, it answers with the row and adds nothing", async () => {
    const added: AddCall[] = [];
    const hono = app({
      oauthClientFor: async () => null,
      serverExists: async () => true,
      listServers: async () => [serverRecord("parallel", true)],
      addServer: async (input) => {
        added.push(input);
        return serverRecord(input.key, true);
      },
    });

    const response = await post(hono, "/servers/parallel/enable");

    expect(response.status).toBe(200);
    expect(
      ((await response.json()) as { server: ServerRecord }).server
        .offeredToAllBots,
    ).toBe(true);
    expect(added).toEqual([]);
  });

  test("cannot undo an administrator's narrowing: an app limited to chosen Bots is refused, and not re-added", async () => {
    const added: AddCall[] = [];
    const hono = app({
      oauthClientFor: async () => null,
      serverExists: async () => true,
      listServers: async () => [serverRecord("parallel", false)],
      addServer: async (input) => {
        added.push(input);
        return serverRecord(input.key, true);
      },
    });

    const response = await post(hono, "/servers/parallel/enable");

    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toContain(
      "limited Parallel Search to chosen Bots",
    );
    expect(added).toEqual([]);
  });

  test("an entry connected on a person's own account is refused, naming Connect", async () => {
    const added: AddCall[] = [];
    const hono = app({
      oauthClientFor: async () => null,
      addServer: async (input) => {
        added.push(input);
        return serverRecord(input.key, true);
      },
    });

    const response = await post(hono, "/servers/notion/enable");

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain(
      "Press Connect instead",
    );
    expect(added).toEqual([]);
  });

  test("an entry on a key this deployment holds is refused, naming an administrator", async () => {
    const hono = app({ oauthClientFor: async () => null });

    const response = await post(hono, "/servers/parallel-authenticated/enable");

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain(
      "an administrator has to add it",
    );
  });

  test("an app this deployment does not offer is a 404", async () => {
    const hono = app({ oauthClientFor: async () => null });
    expect((await post(hono, "/servers/nope/enable")).status).toBe(404);
  });

  test("a fault of this deployment's own is a 409 with its sentence", async () => {
    const hono = app({
      oauthClientFor: async () => null,
      addServer: async () => {
        throw new PluginInvariantError("parallel is two rows at once.");
      },
    });

    const response = await post(hono, "/servers/parallel/enable");

    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toBe(
      "parallel is two rows at once.",
    );
  });
});

describe("offering a server to every Bot, as an administrator", () => {
  test("is refused for everybody else", async () => {
    const hono = app({ oauthClientFor: async () => null });
    const response = await post(hono, "/servers/parallel/offer-to-all", {
      on: true,
    });
    expect(response.status).toBe(403);
  });

  test("switches the flag either way and answers with the server", async () => {
    const calls: { serverId: string; on: boolean; by: string }[] = [];
    const hono = app(
      {
        oauthClientFor: async () => null,
        setOfferedToAllBots: async (serverId, on, by) => {
          calls.push({ serverId, on, by });
          return serverRecord(serverId, on);
        },
      },
      { role: "admin" },
    );

    const on = await post(hono, "/servers/parallel/offer-to-all", { on: true });
    expect(on.status).toBe(200);
    expect(
      ((await on.json()) as { server: ServerRecord }).server.offeredToAllBots,
    ).toBe(true);

    const off = await post(hono, "/servers/parallel/offer-to-all", {
      on: false,
    });
    expect(off.status).toBe(200);
    expect(
      ((await off.json()) as { server: ServerRecord }).server.offeredToAllBots,
    ).toBe(false);

    expect(calls).toEqual([
      { serverId: "parallel", on: true, by: "person@openbot.test" },
      { serverId: "parallel", on: false, by: "person@openbot.test" },
    ]);
  });

  test("anything but a boolean is a 400, and nothing is switched", async () => {
    const calls: unknown[] = [];
    const hono = app(
      {
        oauthClientFor: async () => null,
        setOfferedToAllBots: async (serverId) => {
          calls.push(serverId);
          return serverRecord(serverId, true);
        },
      },
      { role: "admin" },
    );

    expect(
      (await post(hono, "/servers/parallel/offer-to-all", { on: "true" }))
        .status,
    ).toBe(400);
    expect((await post(hono, "/servers/parallel/offer-to-all")).status).toBe(
      400,
    );
    expect(calls).toEqual([]);
  });

  test("a server this deployment has not added is a 404", async () => {
    const hono = app(
      {
        oauthClientFor: async () => null,
        setOfferedToAllBots: async (serverId) => {
          throw new CatalogueEntryUnknownError(serverId);
        },
      },
      { role: "admin" },
    );

    const response = await post(hono, "/servers/nope/offer-to-all", {
      on: true,
    });
    expect(response.status).toBe(404);
  });
});
