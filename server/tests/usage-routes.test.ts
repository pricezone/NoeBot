import { describe, expect, spyOn, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { createApp } from "../src/app";
import type { AppVariables } from "../src/auth/guards";
import { loadConfig } from "../src/config";
import {
  createUsageRoutes,
  USAGE_CACHE_TTL_MS,
  type Usage,
} from "../src/usage/routes";
import { testEnvironment } from "./support/environment";

const user: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", {
    id: "user-1",
    email: "person@example.com",
    role: "user",
  });
  await next();
};
const signedOut: MiddlewareHandler<{ Variables: AppVariables }> = (context) =>
  context.json({ error: "Authentication required." }, 401);

const usage = {
  url: "https://platform.example/v1/noebot/usage",
  token: "platform-bearer-token",
};
const answer: Usage = {
  period: { from: "2026-09-06T00:00:00.000Z", to: "2026-10-06T00:00:00.000Z" },
  week: { credits: 1240, requests: 31 },
  month: { credits: 4875, requests: 118 },
  balance: 10_125,
};

/**
 * A platform whose answers are scripted, and a clock the test turns by hand.
 *
 * Each call shifts the next scripted reply off the front; the last one repeats. A reply can be a
 * body, a status to answer with, or a throw to stand in for a dead host.
 */
function platform(replies: (Usage | number | unknown | Error)[]) {
  const calls: Request[] = [];
  let clock = Date.parse("2026-10-06T12:00:00Z");
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(new Request(input, init));
    const reply = replies.length > 1 ? replies.shift() : replies[0];
    if (reply instanceof Error) throw reply;
    if (typeof reply === "number") {
      return new Response("upstream failure", { status: reply });
    }
    return Response.json(reply);
  }) as typeof fetch;
  return {
    calls,
    fetchImpl,
    now: () => clock,
    advance(ms: number) {
      clock += ms;
    },
  };
}

describe("GET /api/usage", () => {
  test("requires a signed-in person before asking the platform anything", async () => {
    const upstream = platform([answer]);
    const app = createUsageRoutes(signedOut, usage, upstream);

    const response = await app.request("/");

    expect(response.status).toBe(401);
    expect(upstream.calls).toHaveLength(0);
  });

  test("answers with the platform's figures, read with the bearer and never stored in the browser", async () => {
    const upstream = platform([answer]);
    const app = createUsageRoutes(user, usage, upstream);

    const response = await app.request("/");

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ usage: answer });
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]?.url).toBe(usage.url);
    expect(upstream.calls[0]?.headers.get("authorization")).toBe(
      "Bearer platform-bearer-token",
    );
    // The bearer is for the platform, not the person. It must not come back in the answer.
    expect(
      JSON.stringify(await app.request("/").then((r) => r.json())),
    ).not.toContain("platform-bearer-token");
  });

  test("serves one answer for a minute, then asks again", async () => {
    const later: Usage = { ...answer, week: { credits: 1300, requests: 33 } };
    const upstream = platform([answer, later]);
    const app = createUsageRoutes(user, usage, upstream);

    await app.request("/");
    upstream.advance(USAGE_CACHE_TTL_MS - 1);
    await expect(
      app.request("/").then((response) => response.json()),
    ).resolves.toEqual({ usage: answer });
    expect(upstream.calls).toHaveLength(1);

    upstream.advance(2);
    await expect(
      app.request("/").then((response) => response.json()),
    ).resolves.toEqual({ usage: later });
    expect(upstream.calls).toHaveLength(2);
  });

  test("shares one upstream call between readers that arrive together", async () => {
    const upstream = platform([answer]);
    const app = createUsageRoutes(user, usage, upstream);

    const responses = await Promise.all([
      app.request("/"),
      app.request("/"),
      app.request("/"),
    ]);

    expect(responses.map((response) => response.status)).toEqual([
      200, 200, 200,
    ]);
    expect(upstream.calls).toHaveLength(1);
  });

  test("keeps serving the last good answer when the platform stops answering", async () => {
    const upstream = platform([answer, new Error("ECONNREFUSED")]);
    const app = createUsageRoutes(user, usage, upstream);

    await app.request("/");
    upstream.advance(USAGE_CACHE_TTL_MS + 1);
    const response = await app.request("/");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ usage: answer });
    expect(upstream.calls).toHaveLength(2);
  });

  test("tells the person the meter is unavailable when nothing has ever been answered", async () => {
    const upstream = platform([new Error("ECONNREFUSED")]);
    const app = createUsageRoutes(user, usage, upstream);

    const response = await app.request("/");

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Usage is not available right now. Please retry shortly.",
    });
  });

  test("treats a refusal and an unexpected shape as the platform failing", async () => {
    const refused = createUsageRoutes(
      user,
      usage,
      platform([401 as unknown as Usage]),
    );
    expect((await refused.request("/")).status).toBe(503);

    const drifted = createUsageRoutes(
      user,
      usage,
      platform([{ week: { credits: "lots" } } as unknown as Usage]),
    );
    expect((await drifted.request("/")).status).toBe(503);
  });
});

describe("usage configuration", () => {
  test("reads the endpoint and bearer together, and the billing page beside them", () => {
    const config = loadConfig(
      testEnvironment({
        OPENBOT_USAGE_URL: usage.url,
        OPENBOT_USAGE_TOKEN: usage.token,
        OPENBOT_BILLING_URL:
          "https://www.hypernoesis.ai/dashboard/settings/billing",
      }),
    );

    expect(config.usage).toEqual(usage);
    expect(config.billingUrl).toBe(
      "https://www.hypernoesis.ai/dashboard/settings/billing",
    );
  });

  test("is off, with a warning, when only one half of the pair is set", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(
        loadConfig(testEnvironment({ OPENBOT_USAGE_URL: usage.url })).usage,
      ).toBeUndefined();
      expect(
        loadConfig(testEnvironment({ OPENBOT_USAGE_TOKEN: usage.token })).usage,
      ).toBeUndefined();
      // Counted by message: the test environment's example encryption key warns too.
      expect(
        warn.mock.calls.filter(([message]) =>
          String(message).startsWith(
            "OPENBOT_USAGE_URL and OPENBOT_USAGE_TOKEN",
          ),
        ),
      ).toHaveLength(2);
    } finally {
      warn.mockRestore();
    }
    expect(loadConfig(testEnvironment()).usage).toBeUndefined();
    expect(loadConfig(testEnvironment()).billingUrl).toBeUndefined();
  });

  test("refuses an endpoint or billing page that is not a URL", () => {
    expect(() =>
      loadConfig(
        testEnvironment({
          OPENBOT_USAGE_URL: "not a url",
          OPENBOT_USAGE_TOKEN: usage.token,
        }),
      ),
    ).toThrow("OPENBOT_USAGE_URL must be a valid URL");
    expect(() =>
      loadConfig(testEnvironment({ OPENBOT_BILLING_URL: "billing" })),
    ).toThrow("OPENBOT_BILLING_URL must be a valid URL");
  });
});

describe("usage capability", () => {
  test("is projected as a boolean and a link, never the endpoint or the bearer", async () => {
    const app = createApp(
      loadConfig(
        testEnvironment({
          OPENBOT_USAGE_URL: usage.url,
          OPENBOT_USAGE_TOKEN: usage.token,
          OPENBOT_BILLING_URL:
            "https://www.hypernoesis.ai/dashboard/settings/billing",
        }),
      ),
    );

    const response = await app.request("http://openbot.local/api/capabilities");
    const body = await response.text();
    const parsed = JSON.parse(body);

    expect(parsed.usage).toBe(true);
    expect(parsed.billingUrl).toBe(
      "https://www.hypernoesis.ai/dashboard/settings/billing",
    );
    expect(body).not.toContain("platform-bearer-token");
    expect(body).not.toContain("platform.example");
  });

  test("is off, with no route behind it, when the deployment is not metered", async () => {
    const app = createApp(loadConfig(testEnvironment()));

    const capabilities = await app
      .request("http://openbot.local/api/capabilities")
      .then((response) => response.json());
    expect(capabilities.usage).toBe(false);
    expect(capabilities.billingUrl).toBeNull();

    // Nothing is mounted: the answer is the app's own not-found, not a 503 from a route that has
    // nothing to ask.
    const response = await app.request("http://openbot.local/api/usage");
    expect(response.status).not.toBe(503);
  });
});
