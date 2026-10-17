import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "playwright";
import {
  createDesktopSessions,
  type DesktopSessionsOptions,
} from "../src/desktop-sessions";
import {
  createDisplayNumbers,
  type DisplaySize,
  startFreshDisplay,
} from "../src/virtual-display";
import { DISPLAY_GONE, openXInput, xtestInput } from "../src/x-input";

/**
 * Each Bot's desktop on a real X server, with a real headed Chromium on each.
 *
 * `desktop-sessions.test.ts` covers the decisions with fake displays; this covers what only a real
 * one can: that two Bots get two displays, that a browser launched with a Bot's display is on that
 * display and no other (each display here has its own size, and each browser sees its own), that
 * taking one Bot's display away ends that Bot's browser and leaves the other's drawing, and that a
 * pointer whose display dies does not take this process with it (Xlib's default is exit(1)). XFCE is
 * not on the CI runner, so the session on each display is a stand-in; the X servers, the browsers
 * and the XTEST connections are real.
 *
 * Asked for by name, like the other real-browser tests, and only where Xvfb is installed (the CI
 * job's `playwright install --with-deps` installs it; a Mac has none). The XTEST part needs libXtst,
 * which CI installs and asks for with `OPENBOT_COMPUTER_XTEST=1`; elsewhere it is skipped, saying so:
 *
 *   OPENBOT_COMPUTER_BROWSER=1 bun test tests/desktop-sessions-live.test.ts
 */
const asked =
  process.env.OPENBOT_COMPUTER_BROWSER === "1" &&
  process.platform === "linux" &&
  Bun.which("Xvfb") !== null;
const xtestRequired = process.env.OPENBOT_COMPUTER_XTEST === "1";

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

/** Real X servers on fresh numbers, each its own size in turn, and stand-in sessions on them. */
function realDesktops(sizes: DisplaySize[]) {
  const numbers = createDisplayNumbers({ first: 400 });
  let started = 0;
  const options: DesktopSessionsOptions = {
    size: sizes[0] ?? { width: 1024, height: 768 },
    max: 4,
    idleMs: 0,
    log: () => undefined,
    // Each display its own size, so a browser can say which one it is on.
    startDisplay: () =>
      startFreshDisplay(
        sizes[started++ % sizes.length] ?? { width: 1024, height: 768 },
        numbers,
      ),
    startDesktop: async (botId) => ({
      ready: false,
      browserRequestDir: join(root, botId),
      stop: async () => undefined,
    }),
    openInput: openXInput,
    startCast: () => {
      throw new Error("not watched");
    },
    capture: async () => Buffer.alloc(0),
    blank: async () => Buffer.alloc(0),
    inUse: () => ({ browser: false, watched: false }),
    vacate: async () => undefined,
  };
  return createDesktopSessions(options);
}

/** Kill an X server from outside, as a crash would: no stop, no warning. */
function killXServer(display: string) {
  Bun.spawnSync(["pkill", "-KILL", "-f", `Xvfb ${display} `]);
}

describe.skipIf(!asked)("each Bot's desktop on a real X server", () => {
  test("two Bots get two displays, and each browser is on its own", async () => {
    const { chromium } = await import("playwright");
    const { browserEnvironment } = await import("../src/profiles");
    const desktops = realDesktops([
      { width: 1024, height: 768 },
      { width: 1280, height: 800 },
    ]);
    const browsers: Browser[] = [];
    try {
      const a = await desktops.use("bot-a");
      const b = await desktops.use("bot-b");
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
      const screenWidth = async (browser: Browser) => {
        // No viewport: Playwright's default one (1280 wide) would also stand in for the screen.
        const page = await browser.newPage({ viewport: null });
        const width = await page.evaluate(() => screen.width);
        await page.close();
        return width;
      };
      // Each browser sees the screen of its own Bot's display, and not the other's.
      expect(await screenWidth(onA)).toBe(1024);
      expect(await screenWidth(onB)).toBe(1280);

      // Bot B's display goes: its browser goes with it, and Bot A's carries on.
      const lostB = disconnects(onB, 15_000);
      await desktops.stop("bot-b", "test");
      expect(await lostB).toBe(true);
      expect(onA.isConnected()).toBe(true);
      const page = await onA.newPage();
      await page.goto("data:text/html,<p>still here</p>");
      expect(await page.textContent("p")).toBe("still here");

      // A display number is not handed out again: Bot B's next desktop is on a new one.
      const b2 = await desktops.use("bot-b");
      expect(b2.display).not.toBe(b.display);
      expect(b2.display).not.toBe(a.display);

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

  test("a pointer whose display dies refuses input instead of exiting the process", async () => {
    const desktops = realDesktops([{ width: 1024, height: 768 }]);
    try {
      const desktop = await desktops.use("bot-x");
      let input: Awaited<ReturnType<typeof xtestInput>>;
      try {
        input = await xtestInput(desktop.display);
      } catch (error) {
        if (xtestRequired) throw error;
        console.warn(
          `XTEST is not available here, so this part is skipped: ${String(error)}`,
        );
        return;
      }
      await input.move(10, 10);

      killXServer(desktop.display);
      await Bun.sleep(300);
      // Xlib finds the connection gone on the next flush. Without the exit handler the process
      // would end here, and this test with it.
      let refused: unknown;
      for (let n = 0; n < 5 && !refused; n++) {
        await input.move(20 + n, 20).catch((error: unknown) => {
          refused = error;
        });
      }
      expect(refused).toBeInstanceOf(Error);
      expect((refused as Error).message).toBe(DISPLAY_GONE);
      await expect(input.key("a", true)).rejects.toThrow(DISPLAY_GONE);
      // Closing it says nothing to the dead server, and returns.
      input.close();
    } finally {
      await desktops.stopAll();
    }
  }, 30_000);

  test("a desktop whose display is killed is taken down, its pointer abandoned, and the process lives", async () => {
    const desktops = realDesktops([{ width: 1024, height: 768 }]);
    try {
      const desktop = await desktops.use("bot-y");
      let pointer: Awaited<ReturnType<typeof desktops.input>>;
      try {
        pointer = await desktops.input("bot-y");
        await pointer.move(5, 5);
      } catch (error) {
        if (xtestRequired) throw error;
        console.warn(
          `No pointer could be opened here, so this part is skipped: ${String(error)}`,
        );
        return;
      }

      killXServer(desktop.display);
      const deadline = Date.now() + 10_000;
      while (desktops.get("bot-y") && Date.now() < deadline)
        await Bun.sleep(50);
      expect(desktops.get("bot-y")).toBeUndefined();
      await desktops.stop("bot-y", "waiting for the teardown");
      // Abandoned: closed to its holder, and nothing was said to the dead server.
      await pointer.move(1, 1);
      pointer.close();

      // The next use starts a new desktop on a new display.
      const next = await desktops.use("bot-y");
      expect(next.display).not.toBe(desktop.display);
    } finally {
      await desktops.stopAll();
    }
  }, 30_000);
});
