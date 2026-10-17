import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "playwright";
import { createDesktopSessions } from "../src/desktop-sessions";
import { startVirtualDisplay } from "../src/virtual-display";

/**
 * Each Bot's desktop on a real X server, with a real headed Chromium on each.
 *
 * `desktop-sessions.test.ts` covers the decisions with fake displays; this covers what only a real
 * one can: that `-displayfd` hands two Bots two different displays, and that a browser launched with
 * a Bot's display is on that display and no other, so taking one Bot's display away ends that Bot's
 * browser and leaves the other's drawing. XFCE is not on the CI runner, so the session on each
 * display is a stand-in; the X servers and the browsers are real.
 *
 * Asked for by name, like the other real-browser tests, and only where Xvfb is installed (the CI
 * job's `playwright install --with-deps` installs it; a Mac has none):
 *
 *   OPENBOT_COMPUTER_BROWSER=1 bun test tests/desktop-sessions-live.test.ts
 */
const asked =
  process.env.OPENBOT_COMPUTER_BROWSER === "1" &&
  process.platform === "linux" &&
  Bun.which("Xvfb") !== null;

let root = "";

beforeAll(async () => {
  if (!asked) return;
  root = await mkdtemp(join(tmpdir(), "agent-computer-desktops-"));
});

afterAll(async () => {
  if (!asked) return;
  await rm(root, { recursive: true, force: true });
});

/** Whether a browser goes away within the time, which is what losing its display does to it. */
function disconnects(browser: Browser, ms: number): Promise<boolean> {
  if (!browser.isConnected()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    browser.once("disconnected", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

describe.skipIf(!asked)("each Bot's desktop on a real X server", () => {
  test("two Bots get two displays, and each browser is on its own", async () => {
    const { chromium } = await import("playwright");
    const { browserEnvironment } = await import("../src/profiles");
    const desktops = createDesktopSessions({
      size: { width: 1024, height: 768 },
      max: 4,
      idleMs: 0,
      log: () => undefined,
      startDisplay: async (size) => {
        const display = await startVirtualDisplay("headed", undefined, size);
        if (!display) throw new Error("No display was started.");
        return display;
      },
      startDesktop: async (botId) => ({
        ready: false,
        browserRequestDir: join(root, botId),
        stop: async () => undefined,
      }),
      openInput: async () => {
        throw new Error("not driven");
      },
      startCast: () => {
        throw new Error("not watched");
      },
      capture: async () => Buffer.alloc(0),
      inUse: () => ({ browser: false, watched: false }),
      vacate: async () => undefined,
    });
    const browsers: Browser[] = [];
    try {
      const [a, b] = await Promise.all([
        desktops.use("bot-a"),
        desktops.use("bot-b"),
      ]);
      expect(a.display).toMatch(/^:\d+$/);
      expect(b.display).toMatch(/^:\d+$/);
      expect(a.display).not.toBe(b.display);

      for (const desktop of [a, b]) {
        browsers.push(
          await chromium.launch({
            headless: false,
            env: browserEnvironment(desktop.display),
          }),
        );
      }
      const [onA, onB] = browsers;
      if (!onA || !onB) throw new Error("A browser did not start.");

      // Bot B's display goes: its browser goes with it, and Bot A's carries on.
      const lostB = disconnects(onB, 15_000);
      await desktops.stop("bot-b", "test");
      expect(await lostB).toBe(true);
      expect(onA.isConnected()).toBe(true);
      const page = await onA.newPage();
      await page.goto("data:text/html,<p>still here</p>");
      expect(await page.textContent("p")).toBe("still here");
      expect(await page.evaluate(() => screen.width)).toBe(1024);

      // And shutdown takes the rest.
      const lostA = disconnects(onA, 15_000);
      await desktops.stopAll();
      expect(await lostA).toBe(true);
      expect(desktops.list()).toEqual([]);
    } finally {
      await Promise.all(
        browsers.map((browser) => browser.close().catch(() => undefined)),
      );
      await desktops.stopAll();
    }
  }, 60_000);
});
