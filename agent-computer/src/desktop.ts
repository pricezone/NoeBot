import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * The desktop around the Bot's browser.
 *
 * A page-only live screen shows what the Bot is reading and nothing else. The desktop shows the
 * computer: a wallpaper, a dock with the browser, a terminal and a file manager, and whatever of them
 * is open. It is what a person expects of "the Bot's computer" when they open the screen, and it is
 * what lets them take the wheel on something other than the one page the Bot had open.
 *
 * Kept deliberately bare, like Grok's: no menu bar, no desktop icons, three launchers and no frame
 * around them. The browser opens maximized and the dock slides out of its way, so while the Bot is
 * browsing the screen is the page. The Bot's shell commands are a tool of their own and are shown in
 * the app's activity log, not typed into a window here; the dock's terminal is for the person.
 *
 * XFCE, because it is the lightest desktop that still looks like one: a window manager, a panel and
 * a wallpaper for a few hundred megabytes of image and well under that of memory. It runs on the
 * same Xvfb the headed browser already uses, started by `virtual-display.ts`, as the same user.
 *
 * ONE DESKTOP PER COMPUTER PROCESS, which on the one-container image is one per deployment: every Bot
 * on the computer shares it, the same way they share the browser process and the shell today. A
 * per-Bot desktop is the same change as a per-Bot computer and arrives with it.
 *
 * Supervised, not merely started. The session is restarted when it dies, with a short pause so a
 * desktop that cannot start does not spin, and a cap so one that keeps dying is eventually left dead
 * and said so rather than restarted for ever.
 */

/** The wallpaper the image ships, rendered from `docker/desktop/wallpaper.svg`. */
export const WALLPAPER_PATH = "/usr/share/backgrounds/noebot/wallpaper.png";
/** The dock's Chrome icon, rendered from `docker/desktop/chrome.svg`, as a PNG the panel can draw. */
export const CHROME_ICON_PATH = "/usr/share/pixmaps/noebot-chrome.png";

/**
 * Where the dock's Chrome button leaves its request, under the runtime directory.
 *
 * The desktop holds no `COMPUTER_TOKEN`, on purpose (see `desktopEnvironment`), so it cannot ask the
 * computer for a browser over HTTP. `openbot-browser`, which the image installs and the button runs,
 * touches a file here instead, and `browser-request.ts` watches for it.
 */
export const BROWSER_REQUEST_DIR = "openbot-desktop";
export const BROWSER_REQUEST_FILE = "open-browser";

/** One button on the dock. */
export type DockLauncher = {
  /** The panel plugin id, which also names the directory the launcher reads its file from. */
  id: number;
  file: string;
  name: string;
  comment: string;
  exec: string;
  icon: string;
};

/**
 * The dock: the browser, a terminal and a file manager, and nothing else.
 *
 * Icons are PNG files or theme names that resolve to PNG: the image has no SVG loader for GTK, and a
 * launcher whose icon cannot be loaded draws as a blank square.
 */
export function dockLaunchers(workspace: string): DockLauncher[] {
  return [
    {
      id: 1,
      file: "noebot-chrome.desktop",
      name: "Chrome",
      comment: "Open the Bot's browser",
      exec: "openbot-browser",
      icon: CHROME_ICON_PATH,
    },
    {
      id: 2,
      file: "noebot-terminal.desktop",
      name: "Terminal",
      comment: "Open a terminal in the workspace",
      exec: `xfce4-terminal --working-directory=${workspace}`,
      icon: "org.xfce.terminal",
    },
    {
      id: 3,
      file: "noebot-files.desktop",
      name: "File Manager",
      comment: "Browse the workspace",
      exec: `thunar ${workspace}`,
      icon: "org.xfce.filemanager",
    },
  ];
}

/** The `.desktop` entry a launcher plugin reads. */
export function launcherDesktopEntry(launcher: DockLauncher): string {
  return `[Desktop Entry]
Version=1.0
Type=Application
Name=${launcher.name}
Comment=${launcher.comment}
Exec=${launcher.exec}
Icon=${launcher.icon}
Terminal=false
StartupNotify=false
`;
}

/**
 * The panel: one dock at the bottom centre, and no top bar.
 *
 * - `autohide-behavior` 1 is XFCE's "intelligently": the dock slides down out of the way while a
 *   window overlaps it, which a maximized browser always does, and comes back when the pointer
 *   reaches the bottom edge or the window goes. `popdown-speed` is the slide.
 * - `background-style` 1 is a solid colour, and the colour is fully transparent: the icons, no frame.
 *   That needs the compositor, which `xfwm4ConfigXml` turns on.
 * - No struts, so a maximized window takes the whole screen rather than stopping above a dock
 *   that is about to hide.
 * - `position` `p=10` is bottom centre; `length` 1 with `length-adjust` is "as long as its icons".
 */
export function panelConfigXml(launchers: DockLauncher[]): string {
  const ids = launchers
    .map((launcher) => `        <value type="int" value="${launcher.id}"/>`)
    .join("\n");
  const plugins = launchers
    .map(
      (
        launcher,
      ) => `    <property name="plugin-${launcher.id}" type="string" value="launcher">
      <property name="items" type="array">
        <value type="string" value="${launcher.file}"/>
      </property>
      <property name="show-label" type="bool" value="false"/>
    </property>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<channel name="xfce4-panel" version="1.0">
  <property name="configver" type="int" value="2"/>
  <property name="panels" type="array">
    <value type="int" value="1"/>
    <property name="dark-mode" type="bool" value="true"/>
    <property name="panel-1" type="empty">
      <property name="position" type="string" value="p=10;x=0;y=0"/>
      <property name="position-locked" type="bool" value="true"/>
      <property name="mode" type="uint" value="0"/>
      <property name="nrows" type="uint" value="1"/>
      <property name="size" type="uint" value="56"/>
      <property name="icon-size" type="uint" value="44"/>
      <property name="length" type="uint" value="1"/>
      <property name="length-adjust" type="bool" value="true"/>
      <property name="autohide-behavior" type="uint" value="1"/>
      <property name="popdown-speed" type="uint" value="25"/>
      <property name="enable-struts" type="bool" value="false"/>
      <property name="background-style" type="uint" value="1"/>
      <property name="background-rgba" type="array">
        <value type="double" value="0"/>
        <value type="double" value="0"/>
        <value type="double" value="0"/>
        <value type="double" value="0"/>
      </property>
      <property name="enter-opacity" type="uint" value="100"/>
      <property name="leave-opacity" type="uint" value="100"/>
      <property name="plugin-ids" type="array">
${ids}
      </property>
    </property>
  </property>
  <property name="plugins" type="empty">
${plugins}
  </property>
</channel>
`;
}

/**
 * The desktop itself: the wallpaper, zoomed to fill whatever size the screen is, and no icons.
 *
 * `monitorscreen` is what xfdesktop calls Xvfb's one output. The grey under the image is what shows
 * if the image is missing, instead of XFCE's blue.
 */
export function desktopConfigXml(wallpaper: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<channel name="xfce4-desktop" version="1.0">
  <property name="backdrop" type="empty">
    <property name="screen0" type="empty">
      <property name="monitorscreen" type="empty">
        <property name="workspace0" type="empty">
          <property name="color-style" type="int" value="0"/>
          <property name="rgba1" type="array">
            <value type="double" value="0.62"/>
            <value type="double" value="0.62"/>
            <value type="double" value="0.62"/>
            <value type="double" value="1"/>
          </property>
          <property name="image-style" type="int" value="5"/>
          <property name="last-image" type="string" value="${wallpaper}"/>
        </property>
      </property>
    </property>
    <property name="single-workspace-mode" type="bool" value="true"/>
    <property name="single-workspace-number" type="int" value="0"/>
  </property>
  <property name="desktop-icons" type="empty">
    <property name="style" type="int" value="0"/>
  </property>
</channel>
`;
}

/**
 * The window manager: compositing on, which the transparent dock depends on, new windows centred,
 * one workspace, and no shadow drawn around the dock. `COMPUTER_DESKTOP_COMPOSITING=off` turns the
 * compositor off, to measure what it costs; the dock then draws its background.
 */
export function xfwm4ConfigXml({
  compositing = true,
}: {
  compositing?: boolean;
} = {}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<channel name="xfwm4" version="1.0">
  <property name="general" type="empty">
    <property name="use_compositing" type="bool" value="${compositing}"/>
    <property name="show_dock_shadow" type="bool" value="false"/>
    <property name="placement_mode" type="string" value="center"/>
    <property name="workspace_count" type="int" value="1"/>
  </property>
</channel>
`;
}

/**
 * No saved session, no session saving. XFCE otherwise asks on the way out whether to save, and
 * restores whatever was open on the way in, neither of which a desktop that is restarted by a
 * supervisor wants: the supervisor decides what is open.
 */
const SESSION_CONFIG_XML = `<?xml version="1.0" encoding="UTF-8"?>
<channel name="xfce4-session" version="1.0">
  <property name="general" type="empty">
    <property name="SaveOnExit" type="bool" value="false"/>
    <property name="PromptOnLogout" type="bool" value="false"/>
  </property>
</channel>
`;

/** Every file the session reads its look from, as paths under `configHome` and their contents. */
export function desktopConfigFiles({
  configHome,
  workspace,
  wallpaper = WALLPAPER_PATH,
  compositing = true,
}: {
  configHome: string;
  workspace: string;
  wallpaper?: string;
  compositing?: boolean;
}): { path: string; content: string }[] {
  const channels = join(configHome, "xfce4", "xfconf", "xfce-perchannel-xml");
  const launchers = dockLaunchers(workspace);
  return [
    {
      path: join(channels, "xfce4-panel.xml"),
      content: panelConfigXml(launchers),
    },
    {
      path: join(channels, "xfce4-desktop.xml"),
      content: desktopConfigXml(wallpaper),
    },
    {
      path: join(channels, "xfwm4.xml"),
      content: xfwm4ConfigXml({ compositing }),
    },
    { path: join(channels, "xfce4-session.xml"), content: SESSION_CONFIG_XML },
    ...launchers.map((launcher) => ({
      path: join(
        configHome,
        "xfce4",
        "panel",
        `launcher-${launcher.id}`,
        launcher.file,
      ),
      content: launcherDesktopEntry(launcher),
    })),
  ];
}

/**
 * The environment the desktop runs with.
 *
 * Built, not inherited. The computer process holds the deployment's secrets in the one-container
 * image, and a desktop session is a tree of processes any of which can be asked to print its
 * environment; the terminal is one of them. The same reason `shell.ts` keeps an allow list.
 */
export function desktopEnvironment(
  display: string,
  source: NodeJS.ProcessEnv,
  home: string,
): Record<string, string> {
  const env: Record<string, string> = {
    DISPLAY: display,
    HOME: home,
    PATH: source.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    LANG: source.LANG ?? "C.UTF-8",
    XDG_RUNTIME_DIR: runtimeDirectory(source),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    // No accessibility bus to reach; GTK says so loudly on every launch otherwise.
    NO_AT_BRIDGE: "1",
  };
  for (const name of ["LANGUAGE", "LC_ALL", "TERM"] as const) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/** Where the session bus and the like keep their sockets. The image creates one for the browser user. */
function runtimeDirectory(source: NodeJS.ProcessEnv): string {
  const configured = source.XDG_RUNTIME_DIR?.trim();
  if (configured) return configured;
  return join("/tmp", `openbot-runtime-${process.getuid?.() ?? "user"}`);
}

/**
 * What the session needs on disk before it starts.
 *
 * Written every time, not only when missing: the look is the computer's, and a file left from an
 * older image (or XFCE's own default panel, which an older image copied in) would otherwise win.
 *
 * The runtime directory is where the session bus puts its socket. It has to exist and be ours.
 */
export async function prepareDesktopHome(
  env: Record<string, string>,
  workspace: string,
  { compositing = true }: { compositing?: boolean } = {},
): Promise<void> {
  const runtimeDir = env.XDG_RUNTIME_DIR;
  if (runtimeDir) {
    await mkdir(runtimeDir, { recursive: true, mode: 0o700 }).catch(
      () => undefined,
    );
  }
  const configHome = env.XDG_CONFIG_HOME;
  if (!configHome) return;
  for (const file of desktopConfigFiles({
    configHome,
    workspace,
    compositing,
  })) {
    try {
      await mkdir(dirname(file.path), { recursive: true });
      await writeFile(file.path, file.content);
    } catch (error) {
      console.error(
        JSON.stringify({
          type: "computer-desktop-config-failed",
          path: file.path,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
}

export type DesktopRuntime = {
  spawn: (
    command: string,
    args: string[],
    env: Record<string, string>,
  ) => ChildProcess;
  run: (
    command: string,
    args: string[],
    env: Record<string, string>,
  ) => Promise<{ code: number; stdout: string }>;
  wait: (milliseconds: number) => Promise<void>;
};

const systemRuntime: DesktopRuntime = {
  spawn(command, args, env) {
    const child = spawn(command, args, {
      env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    /*
     * GTK and XFCE say a great deal on stderr that is not wrong, and a container log full of it hides
     * the line that is. The first few lines are kept, because the error that stops a desktop coming
     * up at all is in them; after that it is discarded.
     */
    let kept = 0;
    child.stderr?.on("data", (chunk: Buffer) => {
      if (kept >= 40) return;
      for (const line of String(chunk).split("\n")) {
        if (!line.trim() || kept >= 40) continue;
        kept++;
        console.warn(
          JSON.stringify({ type: "computer-desktop-stderr", command, line }),
        );
      }
    });
    child.on("error", () => undefined);
    return child;
  },
  run(command, args, env) {
    return new Promise((resolve) => {
      const child = spawn(command, args, {
        env,
        stdio: ["ignore", "pipe", "ignore"],
      });
      let stdout = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += String(chunk);
      });
      child.on("error", () => resolve({ code: -1, stdout }));
      child.on("close", (code) => resolve({ code: code ?? -1, stdout }));
    });
  },
  wait: (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

export type Desktop = {
  /** Whether the window manager answered, which is what makes a desktop a desktop. */
  ready: boolean;
  /** Where the dock's Chrome button leaves its request. See `BROWSER_REQUEST_DIR`. */
  browserRequestDir: string;
  stop: () => Promise<void>;
};

/** How long the window manager gets to appear before the computer carries on without waiting. */
const WM_BUDGET_MS = 20_000;
const WM_POLL_MS = 250;
/** A dead session comes back after this, and gives up after too many deaths in a row. */
const RESTART_DELAY_MS = 2_000;
const MAX_RESTARTS = 5;
const STOP_BUDGET_MS = 3_000;

/** Start the desktop on `display`, and keep it there. */
export async function startDesktop(
  {
    display,
    home = homedir(),
    source = process.env,
  }: {
    display: string;
    home?: string;
    source?: NodeJS.ProcessEnv;
  },
  runtime: DesktopRuntime = systemRuntime,
): Promise<Desktop> {
  const env = desktopEnvironment(display, source, home);
  await prepareDesktopHome(env, source.WORKSPACE_DIR?.trim() || "/workspace", {
    compositing:
      source.COMPUTER_DESKTOP_COMPOSITING?.trim().toLowerCase() !== "off",
  });

  let stopping = false;
  const supervised = new Map<string, ChildProcess>();

  /**
   * One process, kept running.
   *
   * Restarted after a pause when it exits on its own; counted, so a process that dies on arrival
   * every time stops being restarted after a few tries, with a line in the log saying so. The count
   * resets when a process has stayed up a while, so a desktop that failed once a day is not the same
   * as one that cannot start.
   */
  const supervise = (name: string, command: string, args: string[]): void => {
    let restarts = 0;
    const launch = () => {
      if (stopping) return;
      const startedAt = Date.now();
      const child = runtime.spawn(command, args, env);
      supervised.set(name, child);
      child.once("exit", (code) => {
        supervised.delete(name);
        if (stopping) return;
        if (Date.now() - startedAt > 60_000) restarts = 0;
        restarts++;
        console.error(
          JSON.stringify({
            type: "computer-desktop-exited",
            process: name,
            exitCode: code,
            restarting: restarts <= MAX_RESTARTS,
          }),
        );
        if (restarts > MAX_RESTARTS) return;
        void runtime.wait(RESTART_DELAY_MS).then(launch);
      });
    };
    launch();
  };

  supervise("session", "dbus-launch", ["--exit-with-session", "startxfce4"]);

  /*
   * The window manager is what the browser's `--start-maximized` is addressed to; before it is up,
   * a window lands wherever the X server puts it, at whatever size. Waited for, within
   * a budget: a desktop that never comes up is reported in the log and the browser still works
   * without it, as it did before there was a desktop.
   */
  const deadline = Date.now() + WM_BUDGET_MS;
  let ready = false;
  while (Date.now() < deadline && !stopping) {
    const probe = await runtime.run(
      "xprop",
      ["-root", "_NET_SUPPORTING_WM_CHECK"],
      env,
    );
    if (probe.code === 0 && /window id # 0x[0-9a-f]+/i.test(probe.stdout)) {
      ready = true;
      break;
    }
    await runtime.wait(WM_POLL_MS);
  }
  if (!ready) {
    console.error(
      JSON.stringify({
        type: "computer-desktop-not-ready",
        budgetMs: WM_BUDGET_MS,
      }),
    );
  }

  return {
    ready,
    browserRequestDir: join(env.XDG_RUNTIME_DIR, BROWSER_REQUEST_DIR),
    async stop() {
      if (stopping) return;
      stopping = true;
      const children = [...supervised.values()];
      for (const child of children) child.kill("SIGTERM");
      const exits = Promise.all(
        children.map(
          (child) =>
            new Promise<void>((resolve) => {
              if (child.exitCode !== null || child.signalCode !== null) {
                resolve();
                return;
              }
              child.once("exit", () => resolve());
            }),
        ),
      );
      const stopped = await Promise.race([
        exits.then(() => true),
        runtime.wait(STOP_BUDGET_MS).then(() => false),
      ]);
      if (!stopped) for (const child of children) child.kill("SIGKILL");
    },
  };
}
