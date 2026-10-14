import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keepFilters } from "../src/desktop-cast";
import {
  browserPid,
  isChromeClass,
  parseMouseLocation,
  parseWindowId,
} from "../src/screen-window";

/*
 * On a desktop, Clicky's input goes to whichever window the X server picks, so it checks that the
 * window is the Bot's browser; and the frame its model sees keeps only the Bot's page.
 */

describe("reading the X server's answers", () => {
  test("the pointer's window, from getmouselocation --shell", () => {
    expect(
      parseMouseLocation("X=640\nY=401\nSCREEN=0\nWINDOW=31457283\n"),
    ).toEqual({ x: 640, y: 401, window: 31457283 });
    expect(parseMouseLocation("X=1\nY=2\n")).toBeNull();
    expect(parseMouseLocation("")).toBeNull();
  });

  test("a window id alone on a line, and nothing else", () => {
    expect(parseWindowId("31457283\n")).toBe(31457283);
    expect(parseWindowId("")).toBeNull();
    expect(parseWindowId(null)).toBeNull();
    expect(parseWindowId("XGetWindowProperty failed")).toBeNull();
  });

  test("a Chrome window by its class", () => {
    expect(isChromeClass('WM_CLASS(STRING) = "chromium", "Chromium"')).toBe(
      true,
    );
    expect(
      isChromeClass('WM_CLASS(STRING) = "google-chrome", "Google-chrome"'),
    ).toBe(true);
    expect(
      isChromeClass('WM_CLASS(STRING) = "xfce4-terminal", "Xfce4-terminal"'),
    ).toBe(false);
    expect(isChromeClass(null)).toBe(false);
  });

  test("the browser's process from its profile's SingletonLock", async () => {
    const dir = await mkdtemp(join(tmpdir(), "singleton-"));
    try {
      expect(await browserPid(dir)).toBeNull();
      await symlink("computer-host-4242", join(dir, "SingletonLock"));
      expect(await browserPid(dir)).toBe(4242);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("the frame Clicky's model sees on a desktop", () => {
  const screen = { width: 1440, height: 900 };

  test("keeps the page's rectangle and blacks out the rest", () => {
    expect(
      keepFilters({ x: 0, y: 87, width: 1440, height: 813 }, screen),
    ).toEqual(["crop=1440:812:0:88", "pad=1440:900:0:88:black"]);
  });

  test("stays on the screen, and blacks out all of it with no page", () => {
    expect(
      keepFilters({ x: 1400, y: 880, width: 500, height: 500 }, screen),
    ).toEqual(["crop=40:20:1400:880", "pad=1440:900:1400:880:black"]);
    expect(keepFilters({ x: 0, y: 0, width: 0, height: 0 }, screen)).toEqual([
      "drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill",
    ]);
  });
});
