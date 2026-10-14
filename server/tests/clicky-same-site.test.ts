import { afterAll, describe, expect, test } from "bun:test";
import { Hono, type MiddlewareHandler } from "hono";
import { createApp } from "../src/app";
import type { AppVariables } from "../src/auth/guards";
import { createChannelEventHub } from "../src/channels/events";
import { websocket } from "../src/channels/socket";
import { createClickyHub } from "../src/clicky/hub";
import { createClickyRoutes } from "../src/clicky/routes";
import {
  type ClickyPreferences,
  createClickyService,
} from "../src/clicky/service";
import { createInMemoryClickyStore } from "../src/clicky/store";
import type { ComputerGateway } from "../src/computer/gateway";
import type { PolicyStore } from "../src/computer/policy-store";
import { createComputerRoutes } from "../src/computer/routes";
import {
  CROSS_SITE_REFUSAL,
  checkSameSite,
  deploymentOrigins,
  sameSiteGuard,
} from "../src/computer/same-site-guard";
import { type DeploymentConfig, loadConfig } from "../src/config";
import { createMobileRoutes } from "../src/mobile/routes";
import type { MobileDeviceStore } from "../src/mobile/store";
import { testEnvironment } from "./support/environment";

/*
 * A sibling instance (another subscriber's `<id>.hypernoesis.app`) is the same site, so the person's
 * cookies travel with requests its pages make. Nothing it makes may reach the computer routes (the
 * person's input, the live sockets) or the phones; this deployment's own pages, its trusted local
 * app, and the phone (no Origin, no fetch metadata) still do.
 */

const HOST = "victim.hypernoesis.app";
const trusted = new Set(["http://localhost:3010"]);

function request(
  headers: Record<string, string>,
  method = "GET",
  url = `https://${HOST}/api/computers/bot-1/control`,
) {
  return new Request(url, {
    method,
    headers: { host: HOST, ...headers },
  });
}

describe("checkSameSite", () => {
  test("this deployment's own pages, its trusted app and the phone pass", () => {
    for (const headers of [
      {},
      { origin: `https://${HOST}`, "sec-fetch-site": "same-origin" },
      { "sec-fetch-site": "same-origin" },
      { "sec-fetch-site": "none" },
      // The desktop's local app on another port is same-site, and trusted by name.
      { origin: "http://localhost:3010", "sec-fetch-site": "same-site" },
    ])
      expect({
        headers,
        verdict: checkSameSite(request(headers), trusted),
      }).toEqual({ headers, verdict: { ok: true } });
  });

  test("a sibling instance, any other origin, or a same-site request without one is refused", () => {
    for (const headers of [
      { origin: "https://attacker.hypernoesis.app" },
      {
        origin: "https://attacker.hypernoesis.app",
        "sec-fetch-site": "same-site",
      },
      { "sec-fetch-site": "same-site" },
      { "sec-fetch-site": "cross-site" },
      { origin: "null" },
      { origin: "not a url" },
    ])
      expect({
        headers,
        verdict: checkSameSite(request(headers), trusted),
      }).toEqual({
        headers,
        verdict: { ok: false, status: 403, error: CROSS_SITE_REFUSAL },
      });
  });

  test("a body that is not JSON is refused, and a POST with none is fine", () => {
    const post = (headers: Record<string, string>) =>
      checkSameSite(request(headers, "POST"), trusted);
    expect(
      post({ "content-type": "text/plain", "content-length": "20" }),
    ).toMatchObject({ ok: false, status: 415 });
    expect(
      post({
        "content-type": "application/x-www-form-urlencoded",
        "content-length": "5",
      }),
    ).toMatchObject({ ok: false, status: 415 });
    expect(
      post({ "content-type": "application/json", "content-length": "20" }),
    ).toEqual({ ok: true });
    expect(
      post({
        "content-type": "application/json; charset=utf-8",
        "transfer-encoding": "chunked",
      }),
    ).toEqual({ ok: true });
    expect(post({ "content-length": "0" })).toEqual({ ok: true });
    expect(post({})).toEqual({ ok: true });
  });

  test("the origins a deployment trusts: its sign-in, public and app URLs and TRUSTED_ORIGINS", () => {
    expect(
      deploymentOrigins({
        auth: {
          baseUrl: "https://victim.hypernoesis.app/",
          trustedOrigins: ["http://localhost:3010", "openbotmobile://"],
        },
        publicUrl: "https://victim.hypernoesis.app",
        appUrl: undefined,
      } as unknown as Pick<DeploymentConfig, "auth" | "publicUrl" | "appUrl">),
    ).toEqual([
      "https://victim.hypernoesis.app",
      "https://victim.hypernoesis.app",
      "http://localhost:3010",
    ]);
  });
});

const asPerson: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", {
    id: "user-1",
    email: "person@openbot.test",
    role: "user",
  });
  await next();
};

const preferences = async (): Promise<ClickyPreferences> => ({
  locale: "en",
  guidance: "brief",
  actionPolicy: "ask_each",
  autoActivate: true,
});

function computerApp() {
  const inputs: unknown[] = [];
  const store = createInMemoryClickyStore();
  const hub = createClickyHub({ load: (u, b) => store.load(u, b) });
  const service = createClickyService({
    store,
    hub,
    preferences,
    gateway: {
      elements: async () => ({
        screen: { width: 1000, height: 500 },
        mode: "page" as const,
        url: "",
        elements: [],
      }),
      writeFile: async () => ({ path: "", bytes: 0, appended: false }),
    },
  });
  const gateway = {
    humanInput: async (_botId: string, input: unknown) => {
      inputs.push(input);
      return { action: "human_click", url: "" };
    },
  } as unknown as ComputerGateway;
  const routes = createComputerRoutes(
    gateway,
    {} as PolicyStore,
    asPerson,
    async () => true,
    undefined,
    undefined,
    createClickyRoutes({ service, hub }),
    sameSiteGuard(["http://localhost:3010"]),
  );
  return {
    inputs,
    app: new Hono<{ Variables: AppVariables }>().route(
      "/api/computers",
      routes,
    ),
  };
}

describe("the computer routes", () => {
  test("refuse a sibling's request for the person's mouse, and carry this deployment's own", async () => {
    const { app, inputs } = computerApp();
    const click = (headers: Record<string, string>, body = '{"x":1,"y":2}') =>
      app.request(`https://${HOST}/api/computers/bot-1/human/click`, {
        method: "POST",
        headers: { host: HOST, ...headers },
        body,
      });
    expect(
      (
        await click({
          origin: "https://attacker.hypernoesis.app",
          "content-type": "application/json",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await click({
          "sec-fetch-site": "same-site",
          "content-type": "application/json",
        })
      ).status,
    ).toBe(403);
    // The form-shaped post a page anywhere can send without asking.
    expect((await click({ "content-type": "text/plain" })).status).toBe(415);
    expect(inputs).toEqual([]);
    const own = await click({
      origin: `https://${HOST}`,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    });
    expect(own.status).toBe(200);
    expect(inputs).toHaveLength(1);
  });

  test("refuse a sibling's Clicky command", async () => {
    const { app } = computerApp();
    const response = await app.request(
      `https://${HOST}/api/computers/bot-1/clicky/commands`,
      {
        method: "POST",
        headers: {
          host: HOST,
          origin: "https://attacker.hypernoesis.app",
          "content-type": "text/plain",
        },
        body: JSON.stringify({ type: "set_mode", mode: "act" }),
      },
    );
    expect(response.status).toBe(403);
  });
});

const servers: { stop: (force?: boolean) => void }[] = [];
afterAll(() => {
  for (const server of servers) server.stop(true);
});

function opens(url: string, headers: Record<string, string>) {
  return new Promise<"open" | "refused">((resolve) => {
    const socket = new WebSocket(url, { headers } as unknown as string[]);
    socket.addEventListener("open", () => {
      socket.close();
      resolve("open");
    });
    socket.addEventListener("error", () => resolve("refused"));
    socket.addEventListener("close", () => resolve("refused"));
  });
}

describe("the Clicky socket", () => {
  test("refuses the upgrade from another site, and opens for this deployment's own page", async () => {
    const { app } = computerApp();
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request, bun) => app.fetch(request, { server: bun }),
      websocket,
    });
    servers.push(server);
    const url = `ws://127.0.0.1:${server.port}/api/computers/bot-1/clicky/events`;
    expect(
      await opens(url, { origin: "https://attacker.hypernoesis.app" }),
    ).toBe("refused");
    expect(await opens(url, { "sec-fetch-site": "same-site" })).toBe("refused");
    expect(
      await opens(url, { origin: `http://127.0.0.1:${server.port}` }),
    ).toBe("open");
    // The phone: no Origin, no fetch metadata.
    expect(await opens(url, {})).toBe("open");
  });
});

describe("/api/mobile", () => {
  test("refuses a sibling's request to sign a phone out", async () => {
    const revoked: string[] = [];
    const store = {
      revoke: async (_user: string, id: string) => {
        revoked.push(id);
        return { sessionId: null, sessionToken: null };
      },
      deviceForToken: async () => null,
    } as unknown as MobileDeviceStore;
    const app = new Hono<{ Variables: AppVariables }>().route(
      "/api/mobile",
      createMobileRoutes({
        store,
        requireUser: asPerson,
        canUseComputer: async () => true,
        sameSite: sameSiteGuard([]),
      }),
    );
    const refused = await app.request(`https://${HOST}/api/mobile/devices/d1`, {
      method: "DELETE",
      headers: { host: HOST, origin: "https://attacker.hypernoesis.app" },
    });
    expect(refused.status).toBe(403);
    expect(revoked).toEqual([]);
    const own = await app.request(`https://${HOST}/api/mobile/devices/d1`, {
      method: "DELETE",
      headers: { host: HOST },
    });
    expect(own.status).toBe(204);
    expect(revoked).toEqual(["d1"]);
  });
});

describe("the roster's live socket (/api/channels/events)", () => {
  test("opens for this deployment's own page, and not for a sibling instance's", async () => {
    const auth = {
      handler: () => new Response(null, { status: 204 }),
      api: {
        getSession: async () => ({
          user: { id: "user-1", email: "person@openbot.test" },
        }),
      },
    };
    const app = createApp(
      loadConfig(testEnvironment()),
      auth as never,
      { rolesForUser: async () => ["user"] } as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {} as never,
      createChannelEventHub(),
    );
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request, bun) => app.fetch(request, { server: bun }),
      websocket,
    });
    servers.push(server);
    const url = `ws://127.0.0.1:${server.port}/api/channels/events`;
    expect(
      await opens(url, { origin: `http://127.0.0.1:${server.port}` }),
    ).toBe("open");
    expect(
      await opens(url, { origin: "https://attacker.hypernoesis.app" }),
    ).toBe("refused");
    expect(await opens(url, { "sec-fetch-site": "same-site" })).toBe("refused");
    // The desktop's local app, trusted by name, on another port of the same machine.
    expect(
      await opens(url, {
        origin: "http://localhost:3010",
        "sec-fetch-site": "same-site",
      }),
    ).toBe("open");
  });
});
