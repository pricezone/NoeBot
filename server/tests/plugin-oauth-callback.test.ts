import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../src/auth/guards";
import {
  challengeFor,
  redeemAuthorizationCode,
  sealConnectState,
} from "../src/plugins/oauth";
import { catalogueEntry } from "../src/plugins/catalogue";
import { createPluginRoutes } from "../src/plugins/routes";

/**
 * `GET /oauth/callback`: the request the vendor sends somebody back on.
 *
 * It has no session by design — whose connection this is comes from the state, not from whatever
 * cookie the browser happens to be carrying. That is what makes the state the only thing standing
 * between a consent screen and a live refresh token in this deployment's vault, and it is why what
 * the state says has to be checked against the deployment as it is when the callback LANDS rather
 * than as it was when the flow started ten minutes earlier.
 *
 * So these tests are mostly about what must not be written: a grant for a state this deployment did
 * not seal, for a state old enough to have expired, or for somebody who no longer has access.
 */

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

const CALLBACK = "http://t/api/plugins/oauth/callback";

const FAILED =
  "https://app.example/settings/connected-accounts?connected=failed";

function signedIn(): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    context.set("actor", {
      id: "user-1",
      email: "person@openbot.test",
      role: "user",
    } as never);
    await next();
  };
}

/** What `recordConnection` was asked to write, which is the row this endpoint can create. */
type Recorded = {
  serverId: string;
  userId: string;
  refreshToken: string;
  scope: string;
};

/** A client as the store answers one: the credentials, and where the deployment got them. */
type Client = {
  clientId: string;
  clientSecret: string;
  source: "env" | "stored";
};

const DYNAMIC: Client = {
  clientId: "dyn-1",
  clientSecret: "",
  source: "stored",
};

/** The platform's relay, which a platform-provided client was registered with at the vendor. */
const RELAY = "https://www.hypernoesis.ai/api/plugins/oauth/relay";

function app(input: {
  recorded: Recorded[];
  /** Whether the person named by the state still has access. Present by default. */
  personHasAccess?: (userId: string) => Promise<boolean>;
  /** What the vault does with the grant. Records it by default; a test may refuse instead. */
  recordConnection?: (connection: Recorded) => Promise<void>;
  /**
   * What the client read does. Answers a dynamic client by default; a test may throw instead.
   *
   * The callback asks it with no session in hand, so a throw here is the one failure on this route
   * that nothing above it was ever going to catch.
   */
  oauthClientFor?: () => Promise<Client>;
  /**
   * The listing the callback runs as the person who just consented. Recorded by default; a test
   * may make it fail, because its failure must never change where the person is sent.
   */
  refreshTools?: (
    serverId: string,
    actorId?: string,
  ) => Promise<{ tools: number }>;
  /** Every refresh the callback asked for, as (server, person). */
  refreshed?: { serverId: string; actorId: string | undefined }[];
  /** The platform's relay and this deployment's id, for a platform-provided client. */
  externalRedirectUri?: string;
  deploymentId?: string;
  /** The platform's token endpoint, which holds a platform-provided client's secret. */
  tokenProxy?: { url: string; bearer: string };
}) {
  const store = {
    // The brokered read the connect handler makes before anything about the consent flow. This
    // deployment has no brokered rows, so it answers nothing and the flow below is untouched.
    serverAddress: async () => undefined,
    // Every vendor here is already added, so connect goes straight to the client.
    serverExists: async () => true,
    // How a person is signed in, read off the catalogue as the product does for an entry.
    oauthAuthFor: async (serverId: string) => {
      const entry = catalogueEntry(serverId);
      return entry?.auth.kind === "user-oauth"
        ? { ...entry.auth, title: entry.title }
        : null;
    },
    oauthClientFor: input.oauthClientFor ?? (async () => DYNAMIC),
    ensureOAuthClient: async () => DYNAMIC,
    recordConnection:
      input.recordConnection ??
      (async (connection: Recorded) => {
        input.recorded.push(connection);
      }),
    refreshTools:
      input.refreshTools ??
      (async (serverId: string, actorId?: string) => {
        input.refreshed?.push({ serverId, actorId });
        return { tools: 0 };
      }),
  };
  const routes = createPluginRoutes(
    store as never,
    signedIn(),
    async () => true,
    {
      publicUrl: "https://openbot.example",
      appUrl: "https://app.example",
      encryptionKey: KEY,
      personHasAccess: input.personHasAccess ?? (async () => true),
      ...(input.externalRedirectUri
        ? { externalRedirectUri: input.externalRedirectUri }
        : {}),
      ...(input.deploymentId ? { deploymentId: input.deploymentId } : {}),
      ...(input.tokenProxy ? { tokenProxy: input.tokenProxy } : {}),
    },
  );
  return new Hono().route("/api/plugins", routes);
}

/** One token request as the vendor — or the platform's proxy — received it. */
type TokenRequest = {
  url: string;
  authorization: string | null;
  params: URLSearchParams;
};

/** A vendor that would happily hand over a refresh token, so only our own checks can refuse. */
async function withWillingVendor<T>(
  run: (asked: TokenRequest[]) => Promise<T>,
): Promise<T> {
  const asked: TokenRequest[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    asked.push({
      url: String(url),
      authorization: new Headers(init?.headers).get("authorization"),
      params: new URLSearchParams(String(init?.body)),
    });
    return new Response(
      JSON.stringify({ refresh_token: "rt-1", scope: "read" }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  try {
    return await run(asked);
  } finally {
    globalThis.fetch = realFetch;
  }
}

function callbackUrl(state: string): string {
  return `${CALLBACK}?code=code-1&state=${encodeURIComponent(state)}`;
}

describe("a consent that came back the way it left", () => {
  test("the state minted by connect is the state the callback reads", async () => {
    const recorded: Recorded[] = [];
    const hono = app({ recorded });

    const started = await hono.request(
      "http://t/api/plugins/servers/notion/connect",
      { method: "POST" },
    );
    const { authorizationUrl } = (await started.json()) as {
      authorizationUrl: string;
    };
    const authorization = new URL(authorizationUrl);
    const state = authorization.searchParams.get("state") ?? "";

    const asked = await withWillingVendor(async (asked) => {
      const response = await hono.request(callbackUrl(state));
      expect(response.headers.get("location")).toBe(
        "https://app.example/settings/connected-accounts/notion",
      );
      return asked;
    });

    expect(recorded).toEqual([
      {
        serverId: "notion",
        userId: "user-1",
        refreshToken: "rt-1",
        scope: "read",
      },
    ]);
    /*
     * The verifier survived the round trip, and it survived it INSIDE the state rather than beside
     * it: the code challenge the vendor was shown is the S256 of the verifier the callback redeemed
     * with. That is the property the sealed state has to keep — it is unreadable, not lossy.
     */
    const verifier = asked[0]?.params.get("code_verifier") ?? "";
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(challengeFor(verifier)).toBe(
      authorization.searchParams.get("code_challenge"),
    );
    // And it was never on the callback URL in a form anybody reading that URL could use.
    expect(state).not.toContain(verifier);
    // A stored client was registered with this deployment's own callback, so that is what the
    // vendor is told the code was sent to.
    expect(asked[0]?.params.get("redirect_uri")).toBe(
      "https://openbot.example/api/plugins/oauth/callback",
    );
  });

  /**
   * The first listing a `user-oauth` MCP server can ever have.
   *
   * Notion lists on a person's grant and on nothing else, and the add that used to refresh it at
   * once could only write a refusal into `lastError`, so it no longer does. This is the first moment
   * anybody holds a grant, so this is where the listing runs — as that person.
   */
  test("the server's tools are refreshed as the person who just connected", async () => {
    const recorded: Recorded[] = [];
    const refreshed: { serverId: string; actorId: string | undefined }[] = [];
    const hono = app({ recorded, refreshed });
    const state = await sealConnectState(
      { userId: "user-1", serverId: "notion", verifier: "v-1" },
      KEY,
    );

    await withWillingVendor(async () => {
      const response = await hono.request(callbackUrl(state));
      expect(response.headers.get("location")).toBe(
        "https://app.example/settings/connected-accounts/notion",
      );
    });

    expect(recorded).toHaveLength(1);
    expect(refreshed).toEqual([{ serverId: "notion", actorId: "user-1" }]);
  });

  test("a listing that fails leaves the connection stored and the person sent to it", async () => {
    const recorded: Recorded[] = [];
    const hono = app({
      recorded,
      refreshTools: async () => {
        throw new Error("the vendor listed nothing");
      },
    });
    const state = await sealConnectState(
      { userId: "user-1", serverId: "notion", verifier: "v-1" },
      KEY,
    );
    const said: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => {
      said.push(args.map(String).join(" "));
    };

    try {
      await withWillingVendor(async () => {
        const response = await hono.request(callbackUrl(state));
        expect(response.status).toBe(302);
        // Connected, because they are: the grant is in the vault whatever the listing said.
        expect(response.headers.get("location")).toBe(
          "https://app.example/settings/connected-accounts/notion",
        );
      });
    } finally {
      console.error = realError;
    }

    expect(recorded).toHaveLength(1);
    expect(
      said.find((line) =>
        line.includes("oauth-connection-tools-not-refreshed"),
      ),
    ).toBeDefined();
  });
});

/**
 * A callback that came through the platform's relay.
 *
 * A platform-provided client was registered at the vendor with the relay's address, so the vendor
 * sends the person there; the relay reads the deployment id in front of the state and forwards the
 * whole request here. Two things follow. The id is routing and has to be stripped before the state
 * is read — it is not something this deployment sealed. And the redemption has to tell the vendor
 * the redirect URI the code was actually sent to, which is the relay and not this deployment.
 */
describe("a consent that came back through the platform's relay", () => {
  // No secret, deliberately and permanently: the platform holds it, and redeems for us.
  const ENV_CLIENT: Client = {
    clientId: "platform-google",
    clientSecret: "",
    source: "env",
  };
  const PROXY = {
    url: "https://www.hypernoesis.ai/api/plugins/oauth/token",
    bearer: "usage-token",
  };

  test("the deployment id in front of the state is stripped, and the state read", async () => {
    const recorded: Recorded[] = [];
    const hono = app({ recorded, deploymentId: "inst1" });
    const sealed = await sealConnectState(
      { userId: "user-1", serverId: "notion", verifier: "v-1" },
      KEY,
    );

    await withWillingVendor(async () => {
      const response = await hono.request(callbackUrl(`inst1.${sealed}`));
      expect(response.headers.get("location")).toBe(
        "https://app.example/settings/connected-accounts/notion",
      );
    });

    expect(recorded).toEqual([
      {
        serverId: "notion",
        userId: "user-1",
        refreshToken: "rt-1",
        scope: "read",
      },
    ]);
  });

  test("a bare state still reads, so a stored client's direct callback is untouched", async () => {
    const recorded: Recorded[] = [];
    const hono = app({ recorded, deploymentId: "inst1" });
    const sealed = await sealConnectState(
      { userId: "user-1", serverId: "notion", verifier: "v-1" },
      KEY,
    );

    await withWillingVendor(async () => {
      const response = await hono.request(callbackUrl(sealed));
      expect(response.headers.get("location")).toBe(
        "https://app.example/settings/connected-accounts/notion",
      );
    });
    expect(recorded).toHaveLength(1);
  });

  /**
   * The code goes to the platform, not the vendor, and the secret goes nowhere.
   *
   * The form is the one the vendor would get — grant, code, client id, the relay as the redirect
   * URI, the PKCE verifier — with no `client_secret` in it, sent to the platform's token endpoint
   * under the usage bearer. The platform adds the secret it alone holds and forwards it; what comes
   * back is the vendor's answer, which is why the grant is recorded exactly as a direct one is.
   */
  test("a platform client's code is redeemed at the platform's proxy, with the bearer and no secret", async () => {
    const recorded: Recorded[] = [];
    const hono = app({
      recorded,
      oauthClientFor: async () => ENV_CLIENT,
      externalRedirectUri: RELAY,
      deploymentId: "inst1",
      tokenProxy: PROXY,
    });
    const sealed = await sealConnectState(
      { userId: "user-1", serverId: "google-drive", verifier: "v-1" },
      KEY,
    );

    const asked = await withWillingVendor(async (asked) => {
      const response = await hono.request(callbackUrl(`inst1.${sealed}`));
      expect(response.headers.get("location")).toBe(
        "https://app.example/settings/connected-accounts/google-drive",
      );
      return asked;
    });

    expect(asked).toHaveLength(1);
    expect(asked[0]?.url).toBe(PROXY.url);
    expect(asked[0]?.authorization).toBe("Bearer usage-token");
    expect(asked[0]?.params.get("grant_type")).toBe("authorization_code");
    expect(asked[0]?.params.get("code")).toBe("code-1");
    expect(asked[0]?.params.get("client_id")).toBe("platform-google");
    expect(asked[0]?.params.get("redirect_uri")).toBe(RELAY);
    expect(asked[0]?.params.get("code_verifier")).toBe("v-1");
    expect(asked[0]?.params.has("client_secret")).toBe(false);
    expect(recorded).toEqual([
      {
        serverId: "google-drive",
        userId: "user-1",
        refreshToken: "rt-1",
        scope: "read",
      },
    ]);
  });

  test("a stored client redeems at the vendor, with its secret and no bearer, relay or not", async () => {
    const recorded: Recorded[] = [];
    const hono = app({
      recorded,
      oauthClientFor: async () => ({
        clientId: "pasted",
        clientSecret: "pasted-secret",
        source: "stored",
      }),
      externalRedirectUri: RELAY,
      deploymentId: "inst1",
      tokenProxy: PROXY,
    });
    const sealed = await sealConnectState(
      { userId: "user-1", serverId: "google-drive", verifier: "v-1" },
      KEY,
    );

    const asked = await withWillingVendor(async (asked) => {
      await hono.request(callbackUrl(sealed));
      return asked;
    });

    expect(asked[0]?.url).toBe("https://oauth2.googleapis.com/token");
    expect(asked[0]?.authorization).toBeNull();
    expect(asked[0]?.params.get("client_secret")).toBe("pasted-secret");
    expect(recorded).toHaveLength(1);
  });

  test("a stored client on a deployment with a relay configured still names its own callback", async () => {
    const recorded: Recorded[] = [];
    const hono = app({
      recorded,
      oauthClientFor: async () => ({
        clientId: "pasted",
        clientSecret: "s",
        source: "stored",
      }),
      externalRedirectUri: RELAY,
      deploymentId: "inst1",
    });
    const sealed = await sealConnectState(
      { userId: "user-1", serverId: "google-drive", verifier: "v-1" },
      KEY,
    );

    const asked = await withWillingVendor(async (asked) => {
      await hono.request(callbackUrl(sealed));
      return asked;
    });

    expect(asked[0]?.params.get("redirect_uri")).toBe(
      "https://openbot.example/api/plugins/oauth/callback",
    );
  });
});

/**
 * The vendor sent somebody back with a refusal instead of a code.
 *
 * Google answers a cancelled consent, or a Testing-mode app meeting an account that is not a test
 * user, with `?error=access_denied&state=…`. There is nothing to redeem and nothing to write, and
 * the person is owed the same page every other failure sends them to rather than a 500.
 */
describe("a consent the vendor refused", () => {
  test("ends at Settings, asks the vendor nothing, and writes nothing", async () => {
    const recorded: Recorded[] = [];
    const hono = app({ recorded });
    const state = await sealConnectState(
      { userId: "user-1", serverId: "google-drive", verifier: "v-1" },
      KEY,
    );
    const said: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => {
      said.push(args.map(String).join(" "));
    };

    try {
      const asked = await withWillingVendor(async (asked) => {
        const response = await hono.request(
          `${CALLBACK}?error=access_denied&state=${encodeURIComponent(state)}`,
        );
        expect(response.status).toBe(302);
        expect(response.headers.get("location")).toBe(FAILED);
        return asked;
      });
      expect(asked).toEqual([]);
    } finally {
      console.error = realError;
    }

    expect(recorded).toEqual([]);
    // Named in the log, because "declined" and "the app was refused" are different afternoons.
    const line = said.find((line) => line.includes("oauth-consent-refused"));
    expect(line).toContain("access_denied");
    expect(line).not.toContain(state);
  });
});

describe("a consent that outlived the person's access", () => {
  /*
   * THE HOLE THIS CLOSES. Removing somebody deny-lists their address, deletes their sessions and
   * retires the credentials they had already granted — and none of that reaches a consent already in
   * flight at the vendor, because a state is good for ten minutes and the callback has no session to
   * check. Completed, that consent used to write a fresh, live refresh token belonging to somebody
   * who no longer has access, which nothing downstream would ever revoke because nothing knew it
   * existed.
   */
  test("writes nothing, and does not even ask the vendor", async () => {
    const recorded: Recorded[] = [];
    const asked: string[] = [];
    const hono = app({
      recorded,
      personHasAccess: async (userId) => {
        asked.push(userId);
        return false;
      },
    });
    const state = await sealConnectState(
      { userId: "removed-user", serverId: "notion", verifier: "v-1" },
      KEY,
    );

    const requests = await withWillingVendor(async (requests) => {
      const response = await hono.request(callbackUrl(state));
      expect(response.headers.get("location")).toBe(FAILED);
      return requests;
    });

    expect(recorded).toEqual([]);
    expect(asked).toEqual(["removed-user"]);
    // Refused before the code was redeemed, so the deployment never even holds the token it would
    // have had to throw away.
    expect(requests).toEqual([]);
  });

  test("a user id that names nobody is the same refusal", async () => {
    const recorded: Recorded[] = [];
    const hono = app({ recorded, personHasAccess: async () => false });
    const state = await sealConnectState(
      { userId: "never-existed", serverId: "notion", verifier: "v-1" },
      KEY,
    );

    await withWillingVendor(async () => {
      const response = await hono.request(callbackUrl(state));
      expect(response.headers.get("location")).toBe(FAILED);
    });
    expect(recorded).toEqual([]);
  });
});

describe("a consent this deployment did not start", () => {
  test("a state altered on the way back is refused, and nothing is written", async () => {
    const recorded: Recorded[] = [];
    const hono = app({ recorded });
    const sealed = await sealConnectState(
      { userId: "user-1", serverId: "notion", verifier: "v-1" },
      KEY,
    );
    const at = Math.floor(sealed.length / 2);
    const tampered = `${sealed.slice(0, at)}${sealed[at] === "A" ? "B" : "A"}${sealed.slice(at + 1)}`;

    await withWillingVendor(async () => {
      const response = await hono.request(callbackUrl(tampered));
      expect(response.headers.get("location")).toBe(FAILED);
    });
    expect(recorded).toEqual([]);
  });

  test("a state left in a tab too long is refused, and nothing is written", async () => {
    const recorded: Recorded[] = [];
    const hono = app({ recorded });
    // Sealed as if the flow had started half an hour ago: the expiry rides inside the state, so this
    // is the same value the browser would still be holding.
    const stale = await sealConnectState(
      { userId: "user-1", serverId: "notion", verifier: "v-1" },
      KEY,
      Date.now() - 30 * 60_000,
    );

    await withWillingVendor(async () => {
      const response = await hono.request(callbackUrl(stale));
      expect(response.headers.get("location")).toBe(FAILED);
    });
    expect(recorded).toEqual([]);
  });
});

/**
 * The vendor answered the consent screen and then could not be reached for the redemption.
 *
 * Every other refusal here is one of our own checks saying no before the network is touched, which
 * is why nothing caught this: the vendor in these tests is either willing or never asked. A vendor
 * that is reachable enough to send somebody back and unreachable a moment later is the ordinary
 * shape of an outage, and it lands on somebody who has just consented.
 */
describe("a vendor that could not be reached for the redemption", () => {
  async function sealed(): Promise<string> {
    return await sealConnectState(
      { userId: "user-1", serverId: "notion", verifier: "v-1" },
      KEY,
    );
  }

  /**
   * The signal is inspected rather than ignored, which is the difference between proving the catch
   * runs and proving it runs on the failure it was written for. A real timeout rejects because the
   * request was already on the wire when `AbortSignal.timeout` fired, so a stub that never looked at
   * `init.signal` would pass just as happily against code that had forgotten to pass one.
   *
   * What is still not exercised is the fifteen seconds themselves: the deadline is a literal in the
   * source, and waiting it out is not a test anybody would run. The signal being present and unfired
   * at the moment of the call is the part that can be checked here.
   */
  async function withUnreachableVendor(
    reject: () => never,
    run: () => Promise<void>,
    seen?: { signals: (AbortSignal | undefined)[] },
  ): Promise<void> {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      seen?.signals.push(init?.signal ?? undefined);
      return reject();
    }) as unknown as typeof fetch;
    try {
      await run();
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  test("a connection failure ends at Settings, not on a 500", async () => {
    const recorded: Recorded[] = [];
    const hono = app({ recorded });
    const state = await sealed();

    await withUnreachableVendor(
      () => {
        throw new TypeError(
          "Unable to connect. Is the computer able to access the url?",
        );
      },
      async () => {
        const response = await hono.request(callbackUrl(state));
        // Both halves of the promise the handler makes, and the status is the half that was broken:
        // a throw out of the redemption left Hono answering 500 with no Location at all.
        expect(response.status).toBe(302);
        expect(response.headers.get("location")).toBe(FAILED);
      },
    );
    expect(recorded).toEqual([]);
  });

  test("a token endpoint that never answers ends the same way", async () => {
    const recorded: Recorded[] = [];
    const hono = app({ recorded });
    const state = await sealed();
    const seen = { signals: [] as (AbortSignal | undefined)[] };

    await withUnreachableVendor(
      () => {
        throw new DOMException("The operation timed out.", "TimeoutError");
      },
      async () => {
        const response = await hono.request(callbackUrl(state));
        expect(response.status).toBe(302);
        expect(response.headers.get("location")).toBe(FAILED);
      },
      seen,
    );

    // The deadline was armed and had not fired when the request went out, which is what makes this
    // a timeout rather than a rejection that happened to arrive first.
    expect(seen.signals[0]).toBeInstanceOf(AbortSignal);
    expect(seen.signals[0]?.aborted).toBe(false);
    expect(recorded).toEqual([]);
  });

  /**
   * Quiet to the person, not quiet to the deployment.
   *
   * The redirect above is deliberately the same one every other refusal produces, which is what
   * makes this test necessary: from the outside a vendor that is down and a vendor that said no are
   * now indistinguishable, so the only place the difference survives is the log. Before the refusal
   * was caught at all, the framework's own handler printed it on the way to a 500; catching it
   * without putting a line back would have paid for the redirect with the outage nobody can see.
   */
  test("the deployment is told, even though the person is only sent back", async () => {
    const recorded: Recorded[] = [];
    const hono = app({ recorded });
    const state = await sealed();
    const said: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => {
      said.push(args.map(String).join(" "));
    };

    try {
      await withUnreachableVendor(
        () => {
          throw new TypeError("Unable to connect.");
        },
        async () => {
          const response = await hono.request(callbackUrl(state));
          expect(response.status).toBe(302);
          expect(response.headers.get("location")).toBe(FAILED);
        },
      );
    } finally {
      console.error = realError;
    }

    const line = said.find((said) =>
      said.includes("oauth-token-endpoint-unreachable"),
    );
    expect(line).toBeDefined();
    // Which vendor, so an operator reading this knows where to look, and the cause.
    expect(line).toContain("mcp.notion.com");
    expect(line).toContain("Unable to connect.");
    expect(recorded).toEqual([]);
  });
});

/**
 * The last thing that can fail, and the one the redemption fix did not reach.
 *
 * Everything before this point answers a failure with the same redirect. Writing the grant did not:
 * a vault that will not take it threw past the handler, and the person who had just consented got
 * the same bare 500 that an unreachable vendor used to give them. It is the identical shape one step
 * later, so it gets the identical answer.
 */
describe("a grant the vault would not take", () => {
  test("a refused write ends at Settings, and no half-connection is claimed", async () => {
    const recorded: Recorded[] = [];
    const hono = app({
      recorded,
      recordConnection: async () => {
        throw new Error("could not reach the database");
      },
    });
    const state = await sealConnectState(
      { userId: "user-1", serverId: "notion", verifier: "v-1" },
      KEY,
    );
    const said: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => {
      said.push(args.map(String).join(" "));
    };

    try {
      await withWillingVendor(async () => {
        const response = await hono.request(callbackUrl(state));
        expect(response.status).toBe(302);
        expect(response.headers.get("location")).toBe(FAILED);
      });
    } finally {
      console.error = realError;
    }

    expect(recorded).toEqual([]);
    // Told, for the same reason the unreachable vendor is: this one is the deployment's own fault,
    // and the person is being handed the sentence that says nothing about which.
    expect(
      said.find((line) => line.includes("oauth-connection-not-recorded")),
    ).toBeDefined();
  });
});

/**
 * A pinned endpoint that is not an address.
 *
 * `fetch` refuses a malformed URL by throwing the same kind of error a refused connection does, so
 * the catch that made the vendor's outage quiet would make this quiet in exactly the same words.
 * The person still gets the ordinary refusal, because there is nothing else to give them, but the
 * log has to say which of the two it was: one is somebody else's outage and the other is this
 * deployment's own catalogue, and only one of them is worth waking up for.
 */
describe("a token endpoint that is not a usable address", () => {
  test("is refused like any other, and named as ours in the log", async () => {
    const said: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => {
      said.push(args.map(String).join(" "));
    };

    try {
      expect(
        await redeemAuthorizationCode({
          tokenUrl: "not a url",
          clientId: "dyn-1",
          clientSecret: "",
          code: "code-1",
          redirectUri: "https://openbot.example/api/plugins/oauth/callback",
          verifier: "v-1",
        }),
      ).toBeNull();
    } finally {
      console.error = realError;
    }

    expect(
      said.find((line) => line.includes("oauth-token-endpoint-unusable")),
    ).toBeDefined();
    expect(
      said.find((line) => line.includes("oauth-token-endpoint-unreachable")),
    ).toBeUndefined();
  });
});

/**
 * A check on this route that raised instead of answering.
 *
 * CRITERION. Every way out of `GET /oauth/callback` is a redirect. There is no request to this
 * endpoint that ends without a `Location`.
 *
 * REASON. The route's own header says every failure ends the same way — back at Settings with a
 * word about what happened, and nothing written — and it was true of every failure the handler
 * ASKED for and of none of the failures its questions could raise. `personHasAccess` reaches the
 * people store and `oauthClientFor` reaches the vault, and either throwing put the person who had
 * just consented at another company on a bodyless 500 with no `Location` at all: no page, no
 * notice, nothing to press, and a browser left on this API's origin, which locally serves no pages
 * whatsoever. It is the exact answer this route was written to make impossible, and
 * `redeemAuthorizationCode`'s own guard against the same thing names it in as many words.
 */
describe("a callback whose own checks failed", () => {
  test("an access check that raised still ends at Settings", async () => {
    const recorded: Recorded[] = [];
    const hono = app({
      recorded,
      personHasAccess: async () => {
        throw new Error("could not reach the people store");
      },
    });
    const state = await sealConnectState(
      { userId: "user-1", serverId: "notion", verifier: "v-1" },
      KEY,
    );
    const said: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => {
      said.push(args.map(String).join(" "));
    };

    try {
      await withWillingVendor(async (asked) => {
        const response = await hono.request(callbackUrl(state));
        expect(response.status).toBe(302);
        expect(response.headers.get("location")).toBe(FAILED);
        // Refused before the code was redeemed, exactly as a deny-listed person is: a check that
        // could not be made is not a check that passed.
        expect(asked).toEqual([]);
      });
    } finally {
      console.error = realError;
    }

    expect(recorded).toEqual([]);
    // Told, for the reason the refused vault write is told: this one is the deployment's own fault
    // and the person is being handed a sentence that deliberately says nothing about which.
    expect(
      said.find((line) => line.includes("oauth-callback-failed")),
    ).toBeDefined();
  });

  test("a vault that would not answer for the client ends the same way", async () => {
    const recorded: Recorded[] = [];
    const hono = app({
      recorded,
      oauthClientFor: async () => {
        throw new Error("could not reach the vault");
      },
    });
    const state = await sealConnectState(
      { userId: "user-1", serverId: "notion", verifier: "v-1" },
      KEY,
    );
    const realError = console.error;
    console.error = () => {};

    try {
      await withWillingVendor(async () => {
        const response = await hono.request(callbackUrl(state));
        expect(response.status).toBe(302);
        expect(response.headers.get("location")).toBe(FAILED);
      });
    } finally {
      console.error = realError;
    }

    expect(recorded).toEqual([]);
  });
});
