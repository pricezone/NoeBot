import { afterAll, describe, expect, test } from "bun:test";
import { createHmac, randomUUID } from "node:crypto";
import { and, eq, isNotNull } from "drizzle-orm";
import { Hono } from "hono";
import type { MobileLinkResponse } from "../../shared/mobile-link";
import { createAuth } from "../src/auth";
import {
  type AppVariables,
  type AuthService,
  createRequireUser,
  createRoleRepository,
} from "../src/auth/guards";
import type { MobileLinkedInput } from "../src/auth/signin-handoff";
import type { DeploymentConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import {
  agents,
  mobileDevices,
  pushDevices,
  sessions,
  users,
} from "../src/db/schema";
import { createMobileRoutes } from "../src/mobile/routes";
import { createMobileDeviceStore } from "../src/mobile/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * Linking a phone, end to end against Better Auth and the database: a phone's token and a browser's
 * are each refused by the other's endpoint, a token works once and only while it is fresh, the phone
 * is handed a Cookie header carrying both the session and "don't remember me" (a day, never slid),
 * nothing is handed out without somewhere to record the phone, and revoking the phone ends its
 * session.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const handoffSecret = "h".repeat(48);
const deploymentId = "abcdefghijkl";
const created: string[] = [];
const pairedBots: string[] = [];

afterAll(async () => {
  for (const email of created)
    await database.delete(users).where(eq(users.email, email));
  for (const botId of pairedBots)
    await database.delete(agents).where(eq(agents.id, botId));
  await database.$client.end({ timeout: 5 });
});

function configFor(email: string, baseUrl = "http://127.0.0.1:3000") {
  return {
    auth: {
      baseUrl,
      secret: "x".repeat(40),
      trustedOrigins: [],
      initialAdminEmails: [],
      allowedEmailDomains: [],
      google: { clientId: "id", clientSecret: "secret" },
      signInHandoff: { secret: handoffSecret, email },
    },
    deploymentId,
    keyEncryptionKey: Buffer.alloc(32, 7).toString("base64"),
  } as unknown as DeploymentConfig;
}

function mint(
  email: string,
  claims: Record<string, unknown> = {},
  key = handoffSecret,
): string {
  const iat = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({
      sub: email,
      iid: deploymentId,
      iat,
      exp: iat + 60,
      jti: randomUUID(),
      aud: "mobile",
      ...claims,
    }),
  ).toString("base64url");
  return `${payload}.${createHmac("sha256", key).update(payload).digest("base64url")}`;
}

function setup(
  options: { baseUrl?: string; hook?: "record" | "none" | "throw" } = {},
) {
  const email = `owner-${randomUUID()}@example.test`;
  created.push(email);
  const store = createMobileDeviceStore(database);
  const linked: MobileLinkedInput[] = [];
  const hook = options.hook ?? "record";
  const auth = createAuth(
    configFor(email, options.baseUrl),
    database,
    undefined,
    undefined,
    hook === "none"
      ? undefined
      : async (input) => {
          linked.push(input);
          if (hook === "throw") throw new Error("not recorded");
          return { deviceId: (await store.link(input)).deviceId };
        },
  );
  const base = options.baseUrl ?? "http://127.0.0.1:3000";
  const link = (
    token: string,
    device = { name: "Pixel 9", platform: "android" },
    previousDeviceId?: string,
  ) =>
    auth.handler(
      new Request(`${base}/api/auth/signin-handoff/mobile`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token,
          device,
          ...(previousDeviceId ? { previousDeviceId } : {}),
        }),
      }),
    );
  const session = (cookie: string) =>
    auth.api.getSession({ headers: new Headers({ cookie }) });
  return { email, auth, store, linked, link, session, base };
}

describe("POST /api/auth/signin-handoff/mobile", () => {
  test("a phone's token gives the phone a day's session and the exact Cookie header", async () => {
    const { email, link, linked, session } = setup();
    const response = await link(mint(email));
    expect(response.status).toBe(200);
    // Nothing for a native cookie jar to keep: the phone sends the header it is handed.
    expect(response.headers.getSetCookie()).toEqual([]);
    const body = (await response.json()) as MobileLinkResponse;
    expect(body.user.email).toBe(email);
    expect(body.deviceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.cookie).toMatch(
      /^better-auth\.session_token=[^;]+\.[^;]+; better-auth\.dont_remember=[^;]+$/,
    );
    const lifetime = Date.parse(body.expiresAt) - Date.now();
    expect(lifetime).toBeGreaterThan(23.9 * 60 * 60 * 1000);
    expect(lifetime).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
    expect(linked).toEqual([
      {
        userId: body.user.id,
        sessionId: expect.any(String),
        device: { name: "Pixel 9", platform: "android" },
      },
    ]);
    const signedIn = await session(body.cookie);
    expect(signedIn?.user.id).toBe(body.user.id);
    expect(signedIn?.session.id).toBe(linked[0]?.sessionId ?? "");
  });

  test("on https the cookies carry the host-only prefix", async () => {
    const { email, link, session } = setup({
      baseUrl: "https://abcdefghijkl.example.app",
    });
    const response = await link(mint(email));
    expect(response.status).toBe(200);
    const body = (await response.json()) as MobileLinkResponse;
    expect(body.cookie).toMatch(
      /^__Host-better-auth\.session_token=[^;]+; __Host-better-auth\.dont_remember=[^;]+$/,
    );
    expect((await session(body.cookie))?.user.id).toBe(body.user.id);
  });

  test("a browser's token is refused here, as JSON", async () => {
    const { email, link } = setup();
    const response = await link(mint(email, { aud: undefined }));
    expect(response.status).toBe(401);
    expect(response.headers.get("location")).toBeNull();
    expect(await response.json()).toMatchObject({ code: "handoff_refused" });
  });

  test("a phone's token is refused by the browser's endpoint", async () => {
    const { email, auth, base } = setup();
    const response = await auth.handler(
      new Request(
        `${base}/api/auth/signin-handoff?token=${encodeURIComponent(mint(email))}`,
      ),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("error=handoff_refused");
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  test("a token works once, only while fresh, and only for the admitted person", async () => {
    const { email, link } = setup();
    const token = mint(email);
    expect((await link(token)).status).toBe(200);
    const again = await link(token);
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ code: "handoff_replayed" });
    const iat = Math.floor(Date.now() / 1000) - 120;
    expect((await link(mint(email, { iat, exp: iat + 60 }))).status).toBe(401);
    expect((await link(mint("someone-else@example.test"))).status).toBe(401);
    expect((await link(mint(email, {}, "w".repeat(48)))).status).toBe(401);
    expect((await link(mint(email, { iid: "another" }))).status).toBe(401);
  });

  test("a body that is not a link request is a 400", async () => {
    const { email, link } = setup();
    const response = await link(mint(email), {
      name: "Pixel",
      platform: "symbian",
    });
    expect(response.status).toBe(400);
  });

  test("refused, with no session left behind, where the phone cannot be recorded", async () => {
    const without = setup({ hook: "none" });
    const refused = await without.link(mint(without.email));
    expect(refused.status).toBe(404);
    expect(await refused.json()).toMatchObject({
      code: "mobile_link_unavailable",
    });

    const failing = setup({ hook: "throw" });
    const response = await failing.link(mint(failing.email));
    expect(response.status).toBe(404);
    expect(failing.linked).toHaveLength(1);
    const left = await database
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.id, failing.linked[0]?.sessionId ?? ""));
    expect(left).toEqual([]);
  });
});

describe("/api/mobile/devices", () => {
  function routes(
    auth: ReturnType<typeof createAuth>,
    store = createMobileDeviceStore(database),
  ) {
    return new Hono<{ Variables: AppVariables }>().route(
      "/api/mobile",
      createMobileRoutes({
        store,
        requireUser: createRequireUser(
          auth as unknown as AuthService,
          createRoleRepository(database),
        ),
        canUseComputer: async () => false,
      }),
    );
  }

  test("lists the phone as current, refuses what is not the person's, and revoking signs it out", async () => {
    const { email, auth, link, session } = setup();
    const phone = (await (
      await link(mint(email))
    ).json()) as MobileLinkResponse;
    const app = routes(auth);
    const headers = {
      cookie: phone.cookie,
      "content-type": "application/json",
    };

    const listed = await app.request("http://x/api/mobile/devices", {
      headers,
    });
    expect(listed.status).toBe(200);
    const { devices } = (await listed.json()) as {
      devices: { id: string; current: boolean; name: string }[];
    };
    expect(devices).toEqual([
      expect.objectContaining({
        id: phone.deviceId,
        name: "Pixel 9",
        current: true,
        clickyBotId: null,
        pushEnabled: false,
      }),
    ]);

    for (const body of [
      { clickyBotId: "a-bot-this-person-cannot-use" },
      { pushDeviceId: "somebody-elses-registration" },
      { other: true },
    ]) {
      const refused = await app.request(
        `http://x/api/mobile/devices/${phone.deviceId}`,
        { method: "PUT", headers, body: JSON.stringify(body) },
      );
      expect({ body, status: refused.status }).toEqual({ body, status: 400 });
    }
    const missing = await app.request("http://x/api/mobile/devices/nope", {
      method: "PUT",
      headers,
      body: JSON.stringify({ clickyBotId: null }),
    });
    expect(missing.status).toBe(404);

    const revoked = await app.request(
      `http://x/api/mobile/devices/${phone.deviceId}`,
      { method: "DELETE", headers },
    );
    expect(revoked.status).toBe(204);
    expect(await session(phone.cookie)).toBeNull();
    const [row] = await database
      .select()
      .from(mobileDevices)
      .where(eq(mobileDevices.id, phone.deviceId));
    expect(row?.revokedAt).not.toBeNull();
    expect(row?.sessionId).toBeNull();
    // Signed out, the phone can no longer ask.
    const after = await app.request("http://x/api/mobile/devices", { headers });
    expect(after.status).toBe(401);
  });

  test("linking again with its own id keeps the phone's row, its push and its pairing, and signs the old session out", async () => {
    const { email, link, session } = setup();
    const first = (await (
      await link(mint(email))
    ).json()) as MobileLinkResponse;
    // The person paired this phone's Clicky with a computer and let it notify them.
    const botId = `pairing-bot-${randomUUID()}`;
    const pushId = randomUUID();
    await database.insert(agents).values({
      id: botId,
      name: "Paired",
      type: "built_in",
      configuration: {},
    });
    pairedBots.push(botId);
    await database.insert(pushDevices).values({
      id: pushId,
      ownerUserId: first.user.id,
      token: `ExponentPushToken[${randomUUID()}]`,
      projectId: randomUUID(),
      platform: "android",
    });
    await database
      .update(mobileDevices)
      .set({ clickyBotId: botId, pushDeviceId: pushId })
      .where(eq(mobileDevices.id, first.deviceId));

    const second = (await (
      await link(
        mint(email),
        { name: "Pixel 9 Pro", platform: "android" },
        first.deviceId,
      )
    ).json()) as MobileLinkResponse;
    expect(second.deviceId).toBe(first.deviceId);
    expect(await session(first.cookie)).toBeNull();
    const signedIn = await session(second.cookie);
    expect(signedIn?.user.id).toBe(first.user.id);
    const [row] = await database
      .select()
      .from(mobileDevices)
      .where(eq(mobileDevices.id, first.deviceId));
    expect(row).toMatchObject({
      name: "Pixel 9 Pro",
      platform: "android",
      clickyBotId: botId,
      pushDeviceId: pushId,
      sessionId: signedIn?.session.id,
      revokedAt: null,
    });
  });

  test("an id that is not this person's phone, or a revoked one, is ignored: the phone is new", async () => {
    const owner = setup();
    const owned = (await (
      await owner.link(mint(owner.email))
    ).json()) as MobileLinkResponse;
    // Somebody else's phone id: a new row for them, and the owner's phone untouched.
    const stranger = setup();
    const theirs = await stranger.link(
      mint(stranger.email),
      { name: "Pixel 9", platform: "android" },
      owned.deviceId,
    );
    expect(theirs.status).toBe(200);
    const strangers = (await theirs.json()) as MobileLinkResponse;
    expect(strangers.deviceId).not.toBe(owned.deviceId);
    expect((await owner.session(owned.cookie))?.user.id).toBe(owned.user.id);
    // An id that names nothing at all answers exactly the same way.
    const unknown = (await (
      await owner.link(
        mint(owner.email),
        { name: "Pixel 9", platform: "android" },
        randomUUID(),
      )
    ).json()) as MobileLinkResponse;
    expect(unknown.deviceId).not.toBe(owned.deviceId);
    expect((await owner.session(owned.cookie))?.user.id).toBe(owned.user.id);
    // A revoked phone stays revoked; linking with its id is a new phone.
    await owner.store.revoke(owned.user.id, owned.deviceId);
    const after = (await (
      await owner.link(
        mint(owner.email),
        { name: "Pixel 9", platform: "android" },
        owned.deviceId,
      )
    ).json()) as MobileLinkResponse;
    expect(after.deviceId).not.toBe(owned.deviceId);
    const [revoked] = await database
      .select({ revokedAt: mobileDevices.revokedAt })
      .from(mobileDevices)
      .where(eq(mobileDevices.id, owned.deviceId));
    expect(revoked?.revokedAt).not.toBeNull();
  });

  test("two phones of the same model are two phones, both signed in", async () => {
    const { email, link, session } = setup();
    const iphone = { name: "iPhone", platform: "ios" };
    const first = (await (
      await link(mint(email), iphone)
    ).json()) as MobileLinkResponse;
    const second = (await (
      await link(mint(email), iphone)
    ).json()) as MobileLinkResponse;
    expect(second.deviceId).not.toBe(first.deviceId);
    expect((await session(first.cookie))?.user.id).toBe(first.user.id);
    expect((await session(second.cookie))?.user.id).toBe(first.user.id);
    // Even once the first one's day is over, the second is never merged into it.
    await database
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(sessions.userId, first.user.id));
    const third = (await (
      await link(mint(email), iphone)
    ).json()) as MobileLinkResponse;
    expect([first.deviceId, second.deviceId]).not.toContain(third.deviceId);
    const rows = await database
      .select({ id: mobileDevices.id })
      .from(mobileDevices)
      .innerJoin(users, eq(users.id, mobileDevices.userId))
      .where(and(eq(users.email, email), isNotNull(mobileDevices.sessionId)));
    expect(rows).toHaveLength(3);
  });
});
