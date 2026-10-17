import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const original = { ...process.env };
afterEach(() => {
  for (const name of [
    "COMPUTER_BROWSER_BACKEND",
    "COMPUTER_BROWSER_MODE",
    "COMPUTER_SANDBOX",
  ]) {
    if (original[name] === undefined) delete process.env[name];
    else process.env[name] = original[name];
  }
});

// The root CI install deliberately excludes this separately deployed package's dependencies.
describe.skipIf(
  !existsSync(join(import.meta.dir, "../node_modules/playwright/package.json")),
)("persistent launch options", () => {
  test.each(["managed", "local-chrome"])(
    "%s passes the runtime to the persistent launcher",
    async (backend) => {
      const { chromium } = await import("playwright");
      process.env.COMPUTER_BROWSER_BACKEND = backend;
      delete process.env.COMPUTER_BROWSER_MODE;
      delete process.env.COMPUTER_SANDBOX;
      const launch = spyOn(
        chromium,
        "launchPersistentContext",
      ).mockImplementation(async () => {
        throw new Error("launch inspected without starting a browser");
      });
      const { createProfiles } = await import(
        `../src/profiles?launch-options=${backend}`
      );
      const root = await mkdtemp(join(tmpdir(), "openbot-launch-options-"));
      const profiles = createProfiles(root);
      try {
        await expect(profiles.page("bot-one")).rejects.toThrow(
          "launch inspected",
        );
        expect(launch).toHaveBeenCalledTimes(1);
        const [directory, options] = launch.mock.calls[0]!;
        expect(directory).toBe(join(root, "bot-one"));
        expect(options?.channel).toBe(
          backend === "managed" ? "chromium" : "chrome",
        );
        expect(options?.headless).toBe(backend === "managed");
        expect(options?.handleSIGINT).toBe(false);
        expect(options?.handleSIGTERM).toBe(false);
        expect(options?.ignoreDefaultArgs).toEqual(["--enable-automation"]);
        if (backend === "local-chrome") {
          expect(options?.chromiumSandbox).toBe(true);
          expect(options?.args).not.toContain("--password-store=basic");
          expect(options?.args).not.toContain("--no-sandbox");
          // A person's own Chrome keeps that person's language.
          expect(options?.args).not.toContain("--lang=en-US");
          expect(options?.args).not.toContain("--accept-lang=en-US,en");
        } else {
          expect(options?.args).toContain("--lang=en-US");
          expect(options?.args).toContain("--accept-lang=en-US,en");
        }
      } finally {
        await profiles.closeAll();
        launch.mockRestore();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test("a Bot with its own desktop launches its browser on that desktop's display", async () => {
    const { chromium } = await import("playwright");
    delete process.env.COMPUTER_BROWSER_BACKEND;
    delete process.env.COMPUTER_BROWSER_MODE;
    const launch = spyOn(
      chromium,
      "launchPersistentContext",
    ).mockImplementation(async () => {
      throw new Error("launch inspected without starting a browser");
    });
    const { createProfiles } = await import(
      "../src/profiles?launch-options=display"
    );
    const root = await mkdtemp(join(tmpdir(), "openbot-launch-display-"));
    const asked: string[] = [];
    const profiles = createProfiles(root, undefined, undefined, {
      displayFor: async (botId: string) => {
        asked.push(botId);
        return botId === "bot-one" ? ":41" : ":42";
      },
    });
    const plain = createProfiles(join(root, "plain"));
    try {
      await expect(profiles.page("bot-one")).rejects.toThrow("inspected");
      await expect(profiles.page("bot-two")).rejects.toThrow("inspected");
      await expect(plain.page("bot-three")).rejects.toThrow("inspected");
      expect(asked).toEqual(["bot-one", "bot-two"]);
      const envs = launch.mock.calls.map(([, options]) => options?.env);
      expect(envs[0]?.DISPLAY).toBe(":41");
      expect(envs[1]?.DISPLAY).toBe(":42");
      // Only the display changes: the home, and the font cache in it, are the computer's.
      expect(envs[0]?.HOME).toBe(process.env.HOME);
      // Without a desktop of its own a browser launches as it always has.
      expect(envs[2]).toBeUndefined();
    } finally {
      await profiles.closeAll();
      await plain.closeAll();
      launch.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a launch in progress is reported as one, so its desktop is not taken for idle", async () => {
    const { chromium } = await import("playwright");
    delete process.env.COMPUTER_BROWSER_BACKEND;
    delete process.env.COMPUTER_BROWSER_MODE;
    let fail: (error: Error) => void = () => undefined;
    const launch = spyOn(
      chromium,
      "launchPersistentContext",
    ).mockImplementation(
      () =>
        new Promise((_, reject) => {
          fail = reject;
        }),
    );
    const { createProfiles } = await import(
      "../src/profiles?launch-options=launching"
    );
    const root = await mkdtemp(join(tmpdir(), "openbot-launching-"));
    const profiles = createProfiles(root);
    try {
      expect(profiles.isLaunching("bot-one")).toBe(false);
      const page = profiles.page("bot-one");
      await Bun.sleep(20);
      expect(profiles.isLaunching("bot-one")).toBe(true);
      expect(profiles.isLive("bot-one")).toBe(false);
      expect(profiles.usedAt("bot-one")).toBeNull();
      fail(new Error("launch inspected"));
      await expect(page).rejects.toThrow("inspected");
      expect(profiles.isLaunching("bot-one")).toBe(false);
    } finally {
      await profiles.closeAll();
      launch.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a browser launched onto a desktop that was replaced meanwhile is closed and launched again", async () => {
    const { chromium } = await import("playwright");
    delete process.env.COMPUTER_BROWSER_BACKEND;
    delete process.env.COMPUTER_BROWSER_MODE;
    let closes = 0;
    let calls = 0;
    const launch = spyOn(
      chromium,
      "launchPersistentContext",
    ).mockImplementation(async () => {
      calls++;
      if (calls === 1)
        return {
          close: async () => {
            closes++;
          },
        } as unknown as Awaited<
          ReturnType<typeof chromium.launchPersistentContext>
        >;
      throw new Error("second launch inspected");
    });
    const { createProfiles } = await import(
      "../src/profiles?launch-options=replaced"
    );
    const root = await mkdtemp(join(tmpdir(), "openbot-replaced-"));
    // The first desktop goes while the first launch runs; the second is the Bot's own.
    const displays = [":101", ":102"];
    const profiles = createProfiles(root, undefined, undefined, {
      displayFor: async () => displays.shift() ?? ":103",
      displayCurrent: (_botId: string, display: string) => display !== ":101",
    });
    try {
      await expect(profiles.page("bot-one")).rejects.toThrow("second launch");
      expect(calls).toBe(2);
      expect(closes).toBe(1);
      const envs = launch.mock.calls.map(
        ([, options]) => options?.env?.DISPLAY,
      );
      expect(envs).toEqual([":101", ":102"]);
    } finally {
      await profiles.closeAll();
      launch.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });
});
