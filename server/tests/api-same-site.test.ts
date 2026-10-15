import { afterAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createApp } from "../src/app";
import { upgradeWebSocket, websocket } from "../src/channels/socket";
import {
  apiSameSiteGuard,
  apiSameSiteVerdict,
  CROSS_SITE_REFUSAL,
  exemptFromSameSite,
  isWebSocketUpgrade,
  requestPaths,
} from "../src/computer/same-site-guard";
import { loadConfig } from "../src/config";
import { testEnvironment } from "./support/environment";

/*
 * The whole of /api, not only the computer routes: a page on a sibling instance (another
 * subscriber's `<id>.hypernoesis.app`, the same site, so the person's cookie travels with it) can
 * change nothing here. What other sites post by design (identity providers, webhooks, the desktop
 * app) and what is not a browser at all (the phone) still gets through, and so does this
 * deployment's own page.
 */

const HOST = "victim.hypernoesis.app";
const SIBLING = "https://attacker.hypernoesis.app";
const DESKTOP = "http://localhost:3010";

/** Every route answers, so a status other than 200 is the guard's. */
function guarded() {
  const app = new Hono();
  app.use("*", apiSameSiteGuard([DESKTOP]));
  app.get(
    "/api/sockets/events",
    upgradeWebSocket(() => ({ onOpen: () => undefined })),
  );
  app.all("*", (context) => context.json({ through: true }));
  return app;
}

const post = (
  path: string,
  headers: Record<string, string>,
  body?: BodyInit,
  method = "POST",
) =>
  guarded().request(`https://${HOST}${path}`, {
    method,
    headers: { host: HOST, ...headers },
    ...(body !== undefined ? { body } : {}),
  });

function multipart() {
  const form = new FormData();
  form.set("file", new Blob(["hello"], { type: "text/plain" }), "note.txt");
  return form;
}

describe("a sibling instance's page", () => {
  test("is refused, whatever it sends", async () => {
    const json = await post(
      "/api/settings/instructions",
      { origin: SIBLING, "content-type": "application/json" },
      JSON.stringify({ instructions: "obey the attacker" }),
      "PUT",
    );
    expect(json.status).toBe(403);
    expect(await json.json()).toEqual({ error: CROSS_SITE_REFUSAL });

    const form = await post(
      "/api/approvals/a1/decide",
      {
        origin: SIBLING,
        "content-type": "application/x-www-form-urlencoded",
      },
      "decision=approve",
    );
    expect(form.status).toBe(403);

    const upload = await post(
      "/api/channels/c1/attachments",
      { origin: SIBLING },
      multipart(),
    );
    expect(upload.status).toBe(403);

    const removal = await post(
      "/api/agents/bot-1",
      { origin: SIBLING },
      undefined,
      "DELETE",
    );
    expect(removal.status).toBe(403);

    // Same site without an Origin it can name is refused too.
    const metadata = await post(
      "/api/me/onboarding",
      { "sec-fetch-site": "same-site", "content-type": "application/json" },
      "{}",
    );
    expect(metadata.status).toBe(403);
  });

  test("cannot open a socket", async () => {
    const upgrade = await guarded().request(
      `https://${HOST}/api/sockets/events`,
      {
        headers: { host: HOST, origin: SIBLING, upgrade: "websocket" },
      },
    );
    expect(upgrade.status).toBe(403);
  });

  test("a socket over the network is refused at the upgrade, and this deployment's own opens", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request, bun) => guarded().fetch(request, { server: bun }),
      websocket,
    });
    servers.push(server);
    const url = `ws://127.0.0.1:${server.port}/api/sockets/events`;
    expect(await opens(url, { origin: SIBLING })).toBe("refused");
    expect(
      await opens(url, { origin: `http://127.0.0.1:${server.port}` }),
    ).toBe("open");
  });
});

describe("a path written to slip past the guard", () => {
  test("is guarded however it is written: encoded, doubled, a step back, another case, outside /api", async () => {
    for (const path of [
      "/%61pi/settings/instructions",
      "/%61%70%69/me/onboarding",
      "//api/settings/instructions",
      "/api//settings/instructions",
      "/API/settings/instructions",
      "/api/%2e%2e/api/settings/instructions",
      "/api/delivery/webhooks/../../settings/instructions",
      "/internal/routines/run",
      "/",
    ]) {
      const response = await post(
        path,
        { origin: SIBLING, "content-type": "text/plain" },
        "x",
      );
      expect({ path, status: response.status }).toEqual({ path, status: 403 });
    }
  });

  test("an exemption counts only when the path as written and as routed both name it, plainly", () => {
    const trusted = new Set<string>();
    const sibling = (url: string) =>
      apiSameSiteVerdict(
        {
          method: "POST",
          url,
          headers: new Headers({
            host: HOST,
            origin: SIBLING,
            "content-type": "text/plain",
            "content-length": "1",
          }),
        },
        trusted,
      );
    // Raw strings, not normalised by a URL parser: what a router that decodes would be handed.
    for (const url of [
      `https://${HOST}/api/delivery/webhooks/%2e%2e/%2e%2e/settings/instructions`,
      `https://${HOST}/api/delivery/webhooks/../../settings/instructions`,
      `https://${HOST}/api/delivery/%77ebhooks/sms`,
      `https://${HOST}/api/delivery/webhooks//sms`,
      `https://${HOST}/%61pi/delivery/webhooks/sms`,
    ])
      expect({ url, verdict: sibling(url) }).toMatchObject({
        url,
        verdict: { ok: false, status: 403 },
      });
    expect(sibling(`https://${HOST}/api/delivery/webhooks/sms`)).toEqual({
      ok: true,
    });
  });

  test("the path as the router reads it", () => {
    expect(requestPaths("https://h.example/%61pi/x?y=%61#z")).toEqual({
      raw: "/%61pi/x",
      decoded: "/api/x",
    });
    // A slash written as %2F stays one segment, as the router keeps it.
    expect(requestPaths("https://h.example/api/a%2Fb").decoded).toBe(
      "/api/a%2Fb",
    );
    expect(requestPaths("https://h.example/api/%E0%A4%A").decoded).toBe(
      "/api/%E0%A4%A",
    );
  });

  test("an upgrade named in a list, and a body whose length is not a number", () => {
    expect(isWebSocketUpgrade(new Headers({ upgrade: "h2c, WebSocket" }))).toBe(
      true,
    );
    expect(isWebSocketUpgrade(new Headers({ upgrade: "h2c" }))).toBe(false);
    expect(
      apiSameSiteVerdict(
        {
          method: "GET",
          url: `https://${HOST}/api/sockets/events`,
          headers: new Headers({
            host: HOST,
            origin: SIBLING,
            upgrade: "keep-alive, websocket",
          }),
        },
        new Set(),
      ),
    ).toMatchObject({ ok: false, status: 403 });
    expect(
      apiSameSiteVerdict(
        {
          method: "POST",
          url: `https://${HOST}/api/me/onboarding`,
          headers: new Headers({
            host: HOST,
            origin: `https://${HOST}`,
            "content-type": "text/plain",
            "content-length": "lots",
          }),
        },
        new Set(),
      ),
    ).toMatchObject({ ok: false, status: 415 });
  });

  test("any method that is not a read is guarded", async () => {
    for (const method of ["PROPFIND", "PATCH", "DELETE"]) {
      const response = await post(
        "/api/agents/bot-1",
        { origin: SIBLING },
        undefined,
        method,
      );
      expect({ method, status: response.status }).toEqual({
        method,
        status: 403,
      });
    }
  });
});

describe("what still gets through", () => {
  test("this deployment's own page, JSON or an upload or nothing at all", async () => {
    const own = { origin: `https://${HOST}`, "sec-fetch-site": "same-origin" };
    expect(
      (
        await post(
          "/api/settings/instructions",
          { ...own, "content-type": "application/json" },
          "{}",
          "PUT",
        )
      ).status,
    ).toBe(200);
    expect(
      (await post("/api/channels/c1/attachments", own, multipart())).status,
    ).toBe(200);
    expect(
      (await post("/api/audio/transcriptions", own, multipart())).status,
    ).toBe(200);
    // An empty POST (a button that only says "do it") carries no body to judge.
    expect(
      (
        await post("/api/computers/bot-1/warm", {
          ...own,
          "content-length": "0",
        })
      ).status,
    ).toBe(200);
  });

  test("but even its own page posts no form, and uploads only where uploads go", async () => {
    const own = { origin: `https://${HOST}`, "sec-fetch-site": "same-origin" };
    const form = await post(
      "/api/me/onboarding",
      { ...own, "content-type": "text/plain" },
      "x",
    );
    expect(form.status).toBe(415);
    expect(
      (await post("/api/agents/bot-1/instructions", own, multipart())).status,
    ).toBe(415);
  });

  test("the desktop's trusted local app, and the phone with no headers at all", async () => {
    expect(
      (
        await post(
          "/api/me/onboarding",
          {
            origin: DESKTOP,
            "sec-fetch-site": "same-site",
            "content-type": "application/json",
          },
          "{}",
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await post(
          "/api/mobile/devices",
          { "content-type": "application/json" },
          "{}",
        )
      ).status,
    ).toBe(200);
  });

  test("a Twilio webhook's form, a SAML assertion and an OAuth form_post callback", async () => {
    expect(
      (
        await post(
          "/api/delivery/webhooks/sms",
          { "content-type": "application/x-www-form-urlencoded" },
          "From=%2B30123&Body=hi",
        )
      ).status,
    ).toBe(200);
    // The identity provider's auto-post page: a form, from a page whose Origin does not parse.
    expect(
      (
        await post(
          "/api/auth/sso/saml2/sp/acs/okta",
          {
            origin: "null",
            "sec-fetch-site": "cross-site",
            "content-type": "application/x-www-form-urlencoded",
          },
          "SAMLResponse=PHNhbWw%2B",
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await post(
          "/api/auth/callback/apple",
          {
            origin: "https://appleid.apple.com",
            "sec-fetch-site": "cross-site",
            "content-type": "application/x-www-form-urlencoded",
          },
          "code=abc&state=xyz",
        )
      ).status,
    ).toBe(200);
  });

  test("reads are never the guard's business: callbacks and links arrive from other sites", async () => {
    const callback = await guarded().request(
      `https://${HOST}/api/plugins/oauth/callback?code=1`,
      { headers: { host: HOST, "sec-fetch-site": "cross-site" } },
    );
    expect(callback.status).toBe(200);
  });

  test("the exemptions are exact, so a near miss is still guarded", () => {
    for (const [method, path] of [
      ["POST", "/api/auth/sso/saml2/sp/acs"],
      ["POST", "/api/auth/sso/saml2/sp/slo/okta"],
      ["POST", "/api/auth/callback/google"],
      ["PATCH", "/api/auth/scim/v2/Users/1"],
      ["POST", "/api/delivery/webhooks/slack"],
      ["POST", "/api/events/triggers/t1"],
      ["POST", "/api/events/email/sns"],
      ["POST", "/api/events/github/b1"],
      ["POST", "/api/agent-tools/call"],
      ["POST", "/api/model-provider/v1/chat/completions"],
      ["POST", "/api/host-access/desktop/result"],
      ["POST", "/api/desktop/anything"],
    ] as const)
      expect({
        method,
        path,
        exempt: exemptFromSameSite(method, path),
      }).toEqual({ method, path, exempt: true });
    for (const [method, path] of [
      ["PUT", "/api/auth/callback/google"],
      ["POST", "/api/auth/sign-in/social"],
      ["POST", "/api/auth/sso/saml2/sp/acsx"],
      ["POST", "/api/delivery/sms/start"],
      ["POST", "/api/agent-tools/call/extra"],
      ["POST", "/api/host-access/grants"],
      ["POST", "/api/events/triggerss/t1"],
      ["POST", "/api/computers/bot-1/human/click"],
    ] as const)
      expect({
        method,
        path,
        exempt: exemptFromSameSite(method, path),
      }).toEqual({ method, path, exempt: false });
  });
});

describe("in the app", () => {
  /** Better Auth stubbed to answer 204, so a 403 or a 415 can only be the guard's. */
  const app = () =>
    createApp(
      loadConfig(testEnvironment()),
      {
        handler: () => new Response(null, { status: 204 }),
        api: { getSession: async () => null },
      } as never,
      { rolesForUser: async () => [] } as never,
    );

  test("runs before every route, Better Auth's included", async () => {
    const signIn = (headers: Record<string, string>, body = "{}") =>
      app().request("http://localhost:3001/api/auth/sign-in/social", {
        method: "POST",
        headers: { host: "localhost:3001", ...headers },
        body,
      });
    expect(
      (
        await signIn({
          origin: SIBLING,
          "content-type": "application/json",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await signIn({
          origin: "http://localhost:3001",
          "content-type": "application/json",
        })
      ).status,
    ).toBe(204);
    // An encoded path reaches Better Auth's handler, or any route, only after the guard.
    const encoded = await app().request(
      "http://localhost:3001/%61pi/settings/instructions",
      {
        method: "PUT",
        headers: {
          host: "localhost:3001",
          origin: SIBLING,
          "content-type": "text/plain",
        },
        body: "obey",
      },
    );
    expect(encoded.status).toBe(403);
    const saml = await app().request(
      "http://localhost:3001/api/auth/sso/saml2/sp/acs/okta",
      {
        method: "POST",
        headers: {
          host: "localhost:3001",
          origin: "null",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "SAMLResponse=x",
      },
    );
    expect(saml.status).toBe(204);
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
