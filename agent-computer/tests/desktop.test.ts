import { describe, expect, test } from "bun:test";
import { desktopEnvironment, desktopLayout } from "../src/desktop";

describe("the desktop layout", () => {
  test("puts the browser under the panel and the terminal under the browser, all on screen", () => {
    const layout = desktopLayout({ width: 1440, height: 900 });

    expect(layout.browser.x).toBe(0);
    expect(layout.browser.y).toBe(layout.panelHeight);
    expect(layout.browser.width).toBe(1440);
    expect(layout.terminal.y).toBeGreaterThan(
      layout.browser.y + layout.browser.height,
    );
    // The terminal, title bar included, ends above the dock.
    expect(layout.terminal.y + 26 + layout.terminal.rows * 19).toBeLessThan(
      900 - layout.dockHeight,
    );
    expect(layout.terminal.columns * 9.6).toBeLessThanOrEqual(1440);
    expect(layout.terminal.rows).toBeGreaterThanOrEqual(8);
  });

  test("keeps a readable terminal on a small screen", () => {
    const layout = desktopLayout({ width: 800, height: 600 });
    expect(layout.terminal.rows).toBeGreaterThanOrEqual(3);
    expect(layout.terminal.columns).toBeGreaterThanOrEqual(40);
    expect(layout.browser.height).toBeGreaterThan(300);
  });
});

describe("the environment the desktop runs with", () => {
  test("carries the display and the locale, and nothing the deployment keeps secret", () => {
    const env = desktopEnvironment(
      ":7",
      {
        PATH: "/usr/bin",
        LANG: "en_GB.UTF-8",
        LC_ALL: "C.UTF-8",
        COMPUTER_TOKEN: "secret",
        KEY_ENCRYPTION_KEY: "secret",
        OPENAI_API_KEY: "secret",
        XDG_RUNTIME_DIR: "/run/user/1001",
      },
      "/home/pwuser",
    );

    expect(env).toEqual({
      DISPLAY: ":7",
      HOME: "/home/pwuser",
      PATH: "/usr/bin",
      LANG: "en_GB.UTF-8",
      LC_ALL: "C.UTF-8",
      XDG_RUNTIME_DIR: "/run/user/1001",
      XDG_CONFIG_HOME: "/home/pwuser/.config",
      XDG_CACHE_HOME: "/home/pwuser/.cache",
      XDG_DATA_HOME: "/home/pwuser/.local/share",
      NO_AT_BRIDGE: "1",
    });
    expect(JSON.stringify(env)).not.toContain("secret");
  });

  test("makes up a runtime directory when the deployment set none", () => {
    const env = desktopEnvironment(":1", {}, "/home/pwuser");
    expect(env.XDG_RUNTIME_DIR).toMatch(/^\/tmp\/openbot-runtime-/);
    expect(env.PATH).toContain("/usr/bin");
    expect(env.LANG).toBe("C.UTF-8");
  });
});
