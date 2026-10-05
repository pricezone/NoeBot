import { type ChildProcess, spawn } from "node:child_process";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DisplaySize } from "./virtual-display";

/**
 * The desktop around the Bot's browser.
 *
 * A page-only live screen shows what the Bot is reading and nothing else. The desktop shows the
 * computer: the browser as a window, the shell as a terminal the person can watch, a panel with a
 * menu and a clock. It is what a person expects of "the Bot's computer" when they open the screen,
 * and it is what lets them take the wheel on something other than the one page the Bot had open.
 *
 * XFCE, because it is the lightest desktop that still looks like one: a window manager, a panel and
 * a wallpaper for a few hundred megabytes of image and well under that of memory. It runs on the
 * same Xvfb the headed browser already uses, started by `virtual-display.ts`, as the same user.
 *
 * ONE DESKTOP PER COMPUTER PROCESS, which on the one-container image is one per deployment: every Bot
 * on the computer shares it, the same way they share the browser process and the shell today. A
 * per-Bot desktop is the same change as a per-Bot computer and arrives with it.
 *
 * Supervised, not merely started. The session and the terminal are restarted when they die, with a
 * short pause so a desktop that cannot start does not spin, and a cap so one that keeps dying is
 * eventually left dead and said so rather than restarted for ever.
 */

/** Where the panel and the dock sit, and the space left to put windows in. */
export type DesktopLayout = {
  /** XFCE's default top panel: the menu, the task list, the clock. */
  panelHeight: number;
  /** XFCE's default bottom dock of launchers. */
  dockHeight: number;
  /** Where the browser window goes: the top of the work area. */
  browser: { x: number; y: number; width: number; height: number };
  /** Where the terminal goes: the strip under the browser, measured in character cells. */
  terminal: { x: number; y: number; columns: number; rows: number };
};

/*
 * XFCE's own defaults, which `default.xml` below asks for: a 26-pixel top panel and a 48-pixel dock
 * at the bottom, each with a few pixels of margin the window manager keeps clear.
 */
const PANEL_HEIGHT = 30;
const DOCK_HEIGHT = 52;
/** What a window manager adds above a window it is asked to place. */
const TITLE_BAR = 26;
/** The browser gets most of the work area; the terminal gets what is left. */
const BROWSER_SHARE = 0.68;
/** xfce4-terminal's default font, DejaVu Sans Mono at 12 points, measured on a 96 dpi display. */
const CELL_WIDTH = 9.6;
const CELL_HEIGHT = 19;
const GAP = 4;

/** How the screen is divided. Pure, so the browser's launch arguments can be derived from it. */
export function desktopLayout(size: DisplaySize): DesktopLayout {
  const workTop = PANEL_HEIGHT;
  const workBottom = size.height - DOCK_HEIGHT;
  const workHeight = workBottom - workTop;
  const browserHeight = Math.round(workHeight * BROWSER_SHARE);
  const terminalTop = workTop + browserHeight + GAP;
  const terminalPixels = workBottom - terminalTop - TITLE_BAR - GAP;
  return {
    panelHeight: PANEL_HEIGHT,
    dockHeight: DOCK_HEIGHT,
    browser: { x: 0, y: workTop, width: size.width, height: browserHeight },
    terminal: {
      x: 0,
      y: terminalTop,
      columns: Math.max(40, Math.floor((size.width - 2 * GAP) / CELL_WIDTH)),
      rows: Math.max(3, Math.floor(terminalPixels / CELL_HEIGHT)),
    },
  };
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

/** XFCE's own default panel: a top bar and a bottom dock. Copied so the panel never has to ask. */
const DEFAULT_PANEL_CONFIG = "/etc/xdg/xfce4/panel/default.xml";

/**
 * What the session needs on disk before it starts.
 *
 * The panel, started with no configuration of its own, opens a dialog asking whether to use the
 * default one, and a dialog on a desktop nobody is sitting at is a desktop with no panel. Copying the
 * default answers the question the way the button would. Only when nothing is there, so a desktop a
 * person has rearranged stays rearranged across a restart.
 *
 * The runtime directory is where the session bus puts its socket. It has to exist and be ours.
 */
export async function prepareDesktopHome(
  env: Record<string, string>,
): Promise<void> {
  const runtimeDir = env.XDG_RUNTIME_DIR;
  if (runtimeDir) {
    await mkdir(runtimeDir, { recursive: true, mode: 0o700 }).catch(
      () => undefined,
    );
  }
  const configHome = env.XDG_CONFIG_HOME;
  if (!configHome) return;
  const channels = join(configHome, "xfce4", "xfconf", "xfce-perchannel-xml");
  await mkdir(channels, { recursive: true }).catch(() => undefined);
  const panel = join(channels, "xfce4-panel.xml");
  await copyFile(DEFAULT_PANEL_CONFIG, panel, 1 /* COPYFILE_EXCL */).catch(
    () => undefined,
  );
  /*
   * No saved session, no session saving. XFCE otherwise asks on the way out whether to save, and
   * restores whatever was open on the way in, neither of which a desktop that is restarted by a
   * supervisor wants: the supervisor decides what is open.
   */
  const session = join(channels, "xfce4-session.xml");
  await writeFile(
    session,
    `<?xml version="1.0" encoding="UTF-8"?>
<channel name="xfce4-session" version="1.0">
  <property name="general" type="empty">
    <property name="SaveOnExit" type="bool" value="false"/>
    <property name="PromptOnLogout" type="bool" value="false"/>
  </property>
</channel>
`,
    { flag: "wx" },
  ).catch(() => undefined);
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
  layout: DesktopLayout;
  /** Whether the window manager answered, which is what makes a desktop a desktop. */
  ready: boolean;
  stop: () => Promise<void>;
};

/** How long the window manager gets to appear before the computer carries on without waiting. */
const WM_BUDGET_MS = 20_000;
const WM_POLL_MS = 250;
/** A dead session or terminal comes back after this, and gives up after too many deaths in a row. */
const RESTART_DELAY_MS = 2_000;
const MAX_RESTARTS = 5;
const STOP_BUDGET_MS = 3_000;

/**
 * Start the desktop on `display`, and keep it there.
 *
 * `shellLog` is the file the terminal window tails: the Bot's shell, as it happens, read-only.
 */
export async function startDesktop(
  {
    display,
    size,
    shellLog,
    home = homedir(),
    source = process.env,
  }: {
    display: string;
    size: DisplaySize;
    shellLog: string;
    home?: string;
    source?: NodeJS.ProcessEnv;
  },
  runtime: DesktopRuntime = systemRuntime,
): Promise<Desktop> {
  const env = desktopEnvironment(display, source, home);
  const layout = desktopLayout(size);
  await prepareDesktopHome(env);
  // The terminal tails this; made first so it tails a file rather than complaining about one.
  await writeFile(shellLog, "", { flag: "a" }).catch(() => undefined);

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
   * The window manager is what the browser's `--window-position` and the terminal's geometry are
   * addressed to; before it is up, a window lands wherever the X server puts it. Waited for, within
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

  const { terminal } = layout;
  supervise("terminal", "xfce4-terminal", [
    // Its own process, so the exit we supervise is the window's. Without this it hands the window to
    // a shared terminal server and exits at once, which the supervisor would read as a crash.
    "--disable-server",
    "--title=Bot shell",
    "--hide-menubar",
    `--geometry=${terminal.columns}x${terminal.rows}+${terminal.x}+${terminal.y}`,
    `--command=tail -n +1 -F ${shellLog}`,
  ]);

  return {
    layout,
    ready,
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
