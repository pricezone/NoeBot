import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHROME_ICON_PATH,
  DESKTOP_GTK_CSS,
  desktopConfigFiles,
  desktopConfigXml,
  desktopEnvironment,
  dockLaunchers,
  launcherDesktopEntry,
  panelConfigXml,
  prepareDesktopHome,
  WALLPAPER_PATH,
  xfwm4ConfigXml,
} from "../src/desktop";

/** One `<property name="…" … value="…"/>` value, as written. */
function property(xml: string, name: string): string | undefined {
  return xml.match(
    new RegExp(`<property name="${name}" type="[a-z]+" value="([^"]*)"`),
  )?.[1];
}

describe("the dock", () => {
  const launchers = dockLaunchers("/workspace");
  const panel = panelConfigXml(launchers);

  test("is one panel at the bottom centre, with no top bar", () => {
    const panels = panel.match(
      /<property name="panels" type="array">\s*((?:<value [^>]*\/>\s*)+)/,
    )?.[1];
    expect(panels?.match(/<value /g)).toHaveLength(1);
    expect(panel).toContain('<property name="panel-1" type="empty">');
    expect(panel).not.toContain("panel-2");
    expect(property(panel, "position")).toBe("p=10;x=0;y=0");
    expect(property(panel, "mode")).toBe("0");
  });

  test("slides away from a window that overlaps it and reserves no space", () => {
    expect(property(panel, "autohide-behavior")).toBe("1");
    expect(property(panel, "enable-struts")).toBe("false");
  });

  test("draws no frame: a solid background, fully transparent", () => {
    expect(property(panel, "background-style")).toBe("1");
    const rgba = panel
      .match(
        /<property name="background-rgba" type="array">([\s\S]*?)<\/property>/,
      )?.[1]
      ?.match(/value="([^"]*)"/g);
    expect(rgba).toHaveLength(4);
    expect(rgba?.[3]).toBe('value="0"');
  });

  test("holds exactly Google Chrome, Xfce Terminal and Thunar File Manager, as launchers", () => {
    expect(launchers.map((launcher) => launcher.name)).toEqual([
      "Google Chrome",
      "Xfce Terminal",
      "Thunar File Manager",
    ]);
    expect(launchers.map((launcher) => launcher.exec)).toEqual([
      "openbot-browser",
      "xfce4-terminal --working-directory=/workspace",
      "thunar /workspace",
    ]);
    expect(launchers[0]?.icon).toBe(CHROME_ICON_PATH);
    const ids = panel
      .match(
        /<property name="plugin-ids" type="array">([\s\S]*?)<\/property>/,
      )?.[1]
      ?.match(/value="(\d+)"/g);
    expect(ids).toEqual(['value="1"', 'value="2"', 'value="3"']);
    expect(panel.match(/value="launcher"/g)).toHaveLength(3);
    for (const launcher of launchers) {
      expect(panel).toContain(
        `<value type="string" value="${launcher.file}"/>`,
      );
    }
  });

  test("tooltips are the launcher's name alone: no comment for the panel to add a second line from", () => {
    for (const launcher of launchers) {
      const entry = launcherDesktopEntry(launcher);
      expect(entry).toContain(`\nName=${launcher.name}\n`);
      expect(entry).not.toMatch(/^Comment=/m);
    }
  });

  test("opens the terminal and the file manager wherever the workspace is", () => {
    const elsewhere = dockLaunchers("/srv/work");
    expect(elsewhere[1]?.exec).toBe(
      "xfce4-terminal --working-directory=/srv/work",
    );
    expect(elsewhere[2]?.exec).toBe("thunar /srv/work");
  });
});

describe("the desktop and the window manager", () => {
  test("show the wallpaper, zoomed, and no desktop icons", () => {
    const xml = desktopConfigXml(WALLPAPER_PATH);
    expect(xml).toContain('<property name="monitorscreen" type="empty">');
    expect(property(xml, "last-image")).toBe(WALLPAPER_PATH);
    expect(property(xml, "image-style")).toBe("5");
    expect(property(xml, "style")).toBe("0");
  });

  test("composite, which the transparent dock needs", () => {
    const xml = xfwm4ConfigXml();
    expect(property(xml, "use_compositing")).toBe("true");
    expect(
      property(xfwm4ConfigXml({ compositing: false }), "use_compositing"),
    ).toBe("false");
    expect(property(xml, "workspace_count")).toBe("1");
  });
});

/**
 * The stylesheet's rules as selector → declarations, one map per rule, so a test can ask what a
 * selector sets without depending on the file's whitespace or the order of its rules.
 */
function cssRules(css: string): Map<string, Map<string, string>> {
  const rules = new Map<string, Map<string, string>>();
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const [, selectors = "", body = ""] of withoutComments.matchAll(
    /([^{}]+)\{([^{}]*)\}/g,
  )) {
    const declarations = new Map<string, string>();
    for (const declaration of body.split(";")) {
      const colon = declaration.indexOf(":");
      if (colon < 0) continue;
      declarations.set(
        declaration.slice(0, colon).trim(),
        declaration.slice(colon + 1).trim(),
      );
    }
    for (const selector of selectors.split(",")) {
      rules.set(selector.trim().replace(/\s+/g, " "), declarations);
    }
  }
  return rules;
}

describe("the dock's hover and tooltips", () => {
  const rules = cssRules(DESKTOP_GTK_CSS);
  const rule = (selector: string) => rules.get(selector) ?? new Map();

  test("a launcher under the pointer sits on a light rounded square, with no frame at rest", () => {
    const button = rule(".xfce4-panel button");
    expect(button.get("border")).toBe("none");
    expect(button.get("border-radius")).toBe("10px");
    expect(button.get("background-color")).toBe("transparent");
    // The theme draws its hover with these, not with a colour; left unset, the theme still decides.
    expect(button.get("background-image")).toBe("none");
    expect(button.get("box-shadow")).toBe("none");
    for (const state of [":hover", ":active", ":checked"]) {
      expect(rule(`.xfce4-panel button${state}`).get("background-color")).toBe(
        "rgba(255, 255, 255, 0.18)",
      );
    }
  });

  test("a tooltip is a dark rounded label in white, with no border or shadow", () => {
    for (const selector of ["tooltip", "tooltip.background"]) {
      const tooltip = rule(selector);
      expect(tooltip.get("background-color")).toBe("#1f1f1f");
      expect(tooltip.get("border-radius")).toBe("8px");
      expect(tooltip.get("border")).toBe("none");
      expect(tooltip.get("box-shadow")).toBe("none");
    }
    expect(rule("tooltip decoration").get("box-shadow")).toBe("none");
    expect(rule("tooltip decoration").get("border-radius")).toBe("8px");
    expect(rule("tooltip *").get("color")).toBe("#ffffff");
    expect(rule("tooltip *").get("padding")).toBe("0");
    // With the tooltip box's own fixed 6px margin: 6px above and below, 10px either side.
    expect(rule("tooltip label").get("padding")).toBe("0 4px");
  });

  test("the launcher's icon is kept out of its tooltip, and the label takes back the gap", () => {
    expect(rule("tooltip image").get("margin")).toBe("-32px");
    expect(rule("tooltip image").get("opacity")).toBe("0");
    expect(rule("tooltip image + label").get("margin-left")).toBe("-6px");
  });
});

describe("preparing the desktop's home", () => {
  test("writes every file, over whatever an older image left", async () => {
    const home = await mkdtemp(join(tmpdir(), "openbot-desktop-"));
    try {
      const env = desktopEnvironment(":1", {}, home);
      env.XDG_RUNTIME_DIR = join(home, "run");
      const files = desktopConfigFiles({
        configHome: env.XDG_CONFIG_HOME ?? "",
        workspace: "/workspace",
      });
      const panel = files.find((file) => file.path.endsWith("xfce4-panel.xml"));
      expect(panel).toBeDefined();
      await Bun.write(panel?.path ?? "", "<stale/>");

      await prepareDesktopHome(env, "/workspace");

      for (const file of files) {
        expect(await readFile(file.path, "utf8")).toBe(file.content);
      }
      expect(files.map((file) => file.path.slice(home.length))).toEqual([
        "/.config/xfce4/xfconf/xfce-perchannel-xml/xfce4-panel.xml",
        "/.config/xfce4/xfconf/xfce-perchannel-xml/xfce4-desktop.xml",
        "/.config/xfce4/xfconf/xfce-perchannel-xml/xfwm4.xml",
        "/.config/xfce4/xfconf/xfce-perchannel-xml/xfce4-session.xml",
        "/.config/gtk-3.0/gtk.css",
        "/.config/xfce4/panel/launcher-1/noebot-chrome.desktop",
        "/.config/xfce4/panel/launcher-2/noebot-terminal.desktop",
        "/.config/xfce4/panel/launcher-3/noebot-files.desktop",
      ]);
      const chrome = await readFile(files[5]?.path ?? "", "utf8");
      expect(chrome).toContain("Exec=openbot-browser\n");
      expect(chrome).toContain(`Icon=${CHROME_ICON_PATH}\n`);
      expect(chrome).toContain("Name=Google Chrome\n");
      expect(
        await readFile(join(home, ".config", "gtk-3.0", "gtk.css"), "utf8"),
      ).toBe(DESKTOP_GTK_CSS);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
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
