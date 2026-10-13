import { afterEach, describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import {
  type ComputerGateway,
  createComputerGateway,
} from "../src/computer/gateway";
import type { PolicyStore } from "../src/computer/policy-store";
import {
  type ComputerProvider,
  createSharedComputerProvider,
} from "../src/computer/provider";
import { createComputerRoutes } from "../src/computer/routes";
import type { ComputerState } from "../src/computer/schema";

/**
 * Whether a Bot's browser is running, said without starting it.
 *
 * The panel draws a computer whose browser has stopped as asleep, the way Grok's does, and wakes it
 * only when somebody asks. It can only do that if something tells it the browser has stopped without
 * the telling being the thing that starts it: a screenshot is a launch. `/status` is the read that
 * starts nothing, so it carries the answer.
 */

const servers: { stop(closeActiveConnections?: boolean): void }[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

const noAudit: AuditStore = { insert: async () => undefined };

describe("the status route", () => {
  test("asks for the browser and passes it on", async () => {
    const asked: unknown[] = [];
    const gateway = {
      status: async (botId: string, options?: { browser?: boolean }) => {
        asked.push(options);
        return { botId, state: "ready", browser: "stopped" };
      },
    } as unknown as ComputerGateway;
    const asActor: MiddlewareHandler<{ Variables: AppVariables }> = async (
      context,
      next,
    ) => {
      context.set("actor", {
        id: "u1",
        email: "person@openbot.test",
        role: "user",
      });
      await next();
    };
    const app = new Hono<{ Variables: AppVariables }>().route(
      "/api/computers",
      createComputerRoutes(
        gateway,
        {} as PolicyStore,
        asActor,
        async () => true,
      ),
    );

    const response = await app.request("http://t/api/computers/noe/status");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      botId: "noe",
      state: "ready",
      browser: "stopped",
    });
    expect(asked).toEqual([{ browser: true }]);
  });
});

describe("the shared computer", () => {
  function serveHealth(browser: unknown) {
    const seen: { path: string; bot: string | null }[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        seen.push({
          path: url.pathname,
          bot: request.headers.get("x-openbot-bot-id"),
        });
        return Response.json(
          browser === undefined ? { status: "ok" } : { status: "ok", browser },
        );
      },
    });
    servers.push(server);
    return { baseUrl: `http://127.0.0.1:${server.port}`, seen };
  }

  test("reads this Bot's browser off /health, which starts nothing", async () => {
    const stopped = serveHealth(false);
    expect(
      await createSharedComputerProvider({ baseUrl: stopped.baseUrl }).status(
        "noe",
      ),
    ).toEqual({ botId: "noe", state: "ready", browser: "stopped" });
    // One read, of /health, for this Bot: never a screenshot.
    expect(stopped.seen).toEqual([{ path: "/health", bot: "noe" }]);

    const running = serveHealth(true);
    expect(
      await createSharedComputerProvider({ baseUrl: running.baseUrl }).status(
        "noe",
      ),
    ).toMatchObject({ browser: "running" });
  });

  test("a computer from before the field says nothing rather than guessing", async () => {
    const old = serveHealth(undefined);
    expect(
      await createSharedComputerProvider({ baseUrl: old.baseUrl }).status(
        "noe",
      ),
    ).toEqual({ botId: "noe", state: "ready" });
  });
});

describe("a computer per Bot", () => {
  function gatewayFor(state: ComputerState, health: () => Response) {
    const requests: string[] = [];
    const provider: ComputerProvider = {
      name: "test",
      isolation: "per-bot",
      locate: async () => "http://agent-computer:4100",
      status: async (botId) => ({ botId, state }),
      stop: async () => ({ wasRunning: false }),
      reset: async () => ({ cleared: false }),
      list: async () => [],
    };
    const fetchImpl = (async (url: string) => {
      requests.push(new URL(url).pathname);
      return health();
    }) as unknown as typeof fetch;
    const gateway = createComputerGateway({
      provider,
      fetchImpl,
      auditStore: noAudit,
      policy: () => undefined,
    });
    return { gateway, requests };
  }

  test("a computer that is up is asked its /health", async () => {
    const { gateway, requests } = gatewayFor("ready", () =>
      Response.json({ status: "ok", browser: false }),
    );
    expect(await gateway.status("noe", { browser: true })).toEqual({
      botId: "noe",
      state: "ready",
      browser: "stopped",
    });
    expect(requests).toEqual(["/health"]);
  });

  test("a computer that is not up has no browser running, and is not dialled", async () => {
    for (const state of ["absent", "starting"] as const) {
      const { gateway, requests } = gatewayFor(state, () =>
        Response.json({ browser: true }),
      );
      expect(await gateway.status("noe", { browser: true })).toEqual({
        botId: "noe",
        state,
        browser: "stopped",
      });
      expect(requests).toEqual([]);
    }
  });

  test("unknown is left out: unreachable, or a /health that fails", async () => {
    const unreachable = gatewayFor("unreachable", () => Response.json({}));
    expect(
      await unreachable.gateway.status("noe", { browser: true }),
    ).not.toHaveProperty("browser");

    const failing = gatewayFor("ready", () =>
      Response.json({ error: "boom" }, { status: 500 }),
    );
    expect(
      await failing.gateway.status("noe", { browser: true }),
    ).not.toHaveProperty("browser");
  });

  test("without asking, status is what it was: no extra call", async () => {
    const { gateway, requests } = gatewayFor("ready", () =>
      Response.json({ browser: true }),
    );
    expect(await gateway.status("noe")).toEqual({
      botId: "noe",
      state: "ready",
    });
    expect(requests).toEqual([]);
  });
});
