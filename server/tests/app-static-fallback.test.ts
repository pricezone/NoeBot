import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { testEnvironment } from "./support/environment";

/**
 * The deployed image serves the built app from the same process (`APP_DIST_DIR`), behind a
 * catch-all that answers every unclaimed `/api` path with a 404 so an unmatched API call never gets
 * the app's HTML. Anything mounted onto the app AFTER `createApp` returns sits behind that catch-all:
 * unreachable in production, while passing in development (no dist dir) and in a test that mounts
 * the sub-app alone — which is exactly how the Bot templates shipped answering 404. This boots the
 * app the way the image does and asks for the sub-app `createApp` takes by reference.
 */
async function appServingBuiltFiles() {
  const root = await mkdtemp(join(tmpdir(), "openbot-dist-"));
  await writeFile(
    join(root, "index.html"),
    "<!doctype html><title>Noë Bot</title>",
  );
  const botTemplates = new Hono().get("/", (context) =>
    context.json({ templates: [] }),
  );
  // createApp takes positional dependencies; `coworker` is the third-to-last parameter, before
  // `selfHostBanner` and `health`. Placed by the function's own arity so an appended parameter
  // cannot shift it.
  const args: never[] = Array.from({ length: createApp.length }) as never[];
  args[0] = loadConfig(testEnvironment({ APP_DIST_DIR: root })) as never;
  args[createApp.length - 3] = { botTemplates } as never;
  return createApp(...args);
}

describe("the static fallback and the sub-apps handed to createApp", () => {
  test("Bot templates answer under /api/bot-templates on a server that serves the built app", async () => {
    const app = await appServingBuiltFiles();
    const response = await app.request("http://openbot.test/api/bot-templates");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ templates: [] });
  });

  test("an unclaimed /api path is still a 404, never the app's HTML", async () => {
    const app = await appServingBuiltFiles();
    const response = await app.request("http://openbot.test/api/nope");
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type") ?? "").not.toContain(
      "text/html",
    );
  });

  test("a deep link gets the app's index.html", async () => {
    const app = await appServingBuiltFiles();
    const response = await app.request("http://openbot.test/some/deep/link");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("Noë Bot");
  });
});
