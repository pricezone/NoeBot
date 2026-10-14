import { expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import type { ComputerGateway } from "../src/computer/gateway";
import type { PolicyStore } from "../src/computer/policy-store";
import { createComputerRoutes } from "../src/computer/routes";

/*
 * Content that arrives after a delay is waited for on the page, not with a sleep in the shell: the
 * read route hands the words and the wait to the gateway, and asks for nothing when it is not given.
 */
const actor: AuthenticatedActor = {
  id: "user-1",
  email: "member@openbot.test",
  role: "user",
};
const asActor: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", actor);
  await next();
};

function harness() {
  const asked: unknown[] = [];
  const gateway = {
    provider: { isolation: "per-bot" },
    read: async (_botId: string, options?: unknown) => {
      asked.push(options);
      return { url: "https://example.com/", title: "Example", text: "Hello" };
    },
  } as unknown as ComputerGateway;
  const routes = createComputerRoutes(
    gateway,
    {} as PolicyStore,
    asActor,
    async () => true,
  );
  return { routes, asked };
}

test("a read with waitFor passes the words and the wait to the gateway", async () => {
  const { routes, asked } = harness();
  const response = await routes.request(
    "http://openbot.test/bot-9/read?waitFor=Hello%20World!&timeoutSeconds=8",
  );
  expect(response.status).toBe(200);
  expect(asked).toEqual([{ waitFor: "Hello World!", timeoutMs: 8000 }]);
});

test("a plain read asks the gateway to wait for nothing", async () => {
  const { routes, asked } = harness();
  await routes.request("http://openbot.test/bot-9/read");
  await routes.request("http://openbot.test/bot-9/read?waitFor=%20%20");
  expect(asked).toEqual([{}, {}]);
});
