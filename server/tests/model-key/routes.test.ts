import { describe, expect, test } from "bun:test";
import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables } from "../../src/auth/guards";
import { createModelKeyRoutes } from "../../src/model-key/routes";

/**
 * The Keys page's read of the model key: who learns what, and that the secret is never on the
 * wire. The vault is a fake that answers a live row or none; the environment is a plain object.
 */

function signedIn(
  role: "user" | "admin",
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

function harness(input: {
  role: "user" | "admin";
  live?: { id: string } | null;
  environment?: Record<string, string | undefined>;
  metered?: boolean;
}) {
  const routes = createModelKeyRoutes({
    requireUser: signedIn(input.role),
    model: { provider: "openai", defaultModel: "gpt-5.4" },
    keyId: "model-api-key",
    metered: input.metered ?? false,
    billingUrl: input.metered ? "https://www.example/billing" : null,
    store: { findLiveByKey: async () => input.live ?? null },
    environment: input.environment ?? {},
  });
  const app = new Hono().route("/api/settings/model-key", routes);
  return (path = "") =>
    app.request(`http://openbot.test/api/settings/model-key${path}`);
}

describe("GET /api/settings/model-key", () => {
  test("a member learns the provider and model, and nothing about where the key is", async () => {
    const request = harness({
      role: "user",
      live: { id: "cred-1" },
      environment: { OPENAI_API_KEY: "sk-live-secret" },
    });
    const response = await request();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      provider: "openai",
      model: "gpt-5.4",
      metered: false,
      billingUrl: null,
    });
    expect(JSON.stringify(body)).not.toContain("sk-live-secret");
  });

  test("an administrator learns the source: the vault first, the environment next, else none", async () => {
    const vault = await (
      await harness({
        role: "admin",
        live: { id: "cred-1" },
        environment: { OPENAI_API_KEY: "sk-live-secret" },
      })()
    ).json();
    expect(vault).toMatchObject({
      keyId: "model-api-key",
      source: "vault",
      credentialId: "cred-1",
    });
    expect(JSON.stringify(vault)).not.toContain("sk-live-secret");

    const environment = await (
      await harness({
        role: "admin",
        live: null,
        environment: { OPENAI_API_KEY: "sk-live-secret" },
      })()
    ).json();
    expect(environment).toMatchObject({
      source: "environment",
      credentialId: null,
    });
    expect(JSON.stringify(environment)).not.toContain("sk-live-secret");

    const none = await (
      await harness({
        role: "admin",
        live: null,
        environment: { OPENAI_API_KEY: "  " },
      })()
    ).json();
    expect(none).toMatchObject({ source: "none", credentialId: null });
  });

  test("a metered deployment says so, with the billing page", async () => {
    const body = await (
      await harness({ role: "admin", metered: true })()
    ).json();
    expect(body).toMatchObject({
      metered: true,
      billingUrl: "https://www.example/billing",
    });
  });
});
