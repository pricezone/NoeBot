import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { botDesktopDirectories, desktopEnvironment } from "../src/desktop";
import { createSessions } from "../src/sessions";
import { startDesktopCast } from "../src/desktop-cast";
import {
  chooseDesktopToClose,
  createDesktopSessions,
  DESKTOP_LOST,
  DESKTOP_MADE_ROOM,
  type DesktopSessionsOptions,
  type DesktopUse,
  DesktopNotRunningError,
  DesktopsFullError,
  blankFrames,
  defaultDesktopCap,
  memoryBytes,
} from "../src/desktop-sessions";
import type { DisplaySize } from "../src/virtual-display";
import type { XInput } from "../src/x-input";

const SIZE = { width: 1440, height: 900 };
const MB = 1024 * 1024;

/** What the fake X servers, sessions, pointers and grabbers saw, in one place. */
function fakeComputer(overrides: Partial<DesktopSessionsOptions> = {}) {
  let nextDisplay = 10;
  let clock = 1_000;
  const displays: {
    name: string;
    stopped: boolean;
    die: (code: number) => void;
  }[] = [];
  const sessions: { botId: string; display: string; stopped: boolean }[] = [];
  const inputs: {
    display: string;
    calls: string[];
    closed: boolean;
    abandoned: boolean;
  }[] = [];
  /** What happened, in order, where the order is the point. */
  const events: string[] = [];
  const hints: { quick: boolean }[] = [];
  const blanks: DisplaySize[] = [];
  const docks: { dir: string; closed: boolean; open: () => Promise<void> }[] =
    [];
  const captures: string[] = [];
  const vacated: { botId: string; message: string }[] = [];
  const opened: string[] = [];
  const use = new Map<string, DesktopUse>();
  const grabbers: { args: string[] }[] = [];

  /** ffmpeg, as far as the cast can tell. */
  const spawnImpl = ((_command: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      args,
      exitCode: null as number | null,
      signalCode: null as string | null,
      kill(signal?: string) {
        child.signalCode = signal ?? "SIGTERM";
        child.emit("exit", null);
        return true;
      },
    });
    grabbers.push(child);
    return child;
  }) as unknown as typeof import("node:child_process").spawn;

  const openInput = async (display: string): Promise<XInput> => {
    const seen = {
      display,
      calls: [] as string[],
      closed: false,
      abandoned: false,
    };
    inputs.push(seen);
    return {
      move: async (x, y) => void seen.calls.push(`move ${x},${y}`),
      button: async (button, press) =>
        void seen.calls.push(`${press ? "press" : "release"} ${button}`),
      key: async (keysym, press) =>
        void seen.calls.push(`${press ? "down" : "up"} ${keysym}`),
      type: async (text) => void seen.calls.push(`type ${text}`),
      close: () => {
        seen.closed = true;
        events.push(`input closed ${display}`);
      },
      abandon: () => {
        seen.abandoned = true;
        events.push(`input abandoned ${display}`);
      },
    };
  };

  const options: DesktopSessionsOptions = {
    size: SIZE,
    max: 4,
    idleMs: 10 * 60_000,
    sweepEveryMs: 3_600_000,
    now: () => clock,
    log: () => undefined,
    startDisplay: async (size: DisplaySize) => {
      const name = `:${nextDisplay++}`;
      let settle: (result: { code: number; expected: boolean }) => void = () =>
        undefined;
      const terminated = new Promise<{ code: number; expected: boolean }>(
        (resolve) => {
          settle = resolve;
        },
      );
      const record = {
        name,
        stopped: false,
        die: (code: number) => settle({ code, expected: false }),
      };
      displays.push(record);
      return {
        name,
        size,
        terminated,
        stop: async () => {
          record.stopped = true;
          settle({ code: 0, expected: true });
        },
      };
    },
    startDesktop: async (botId, display, hint) => {
      const record = { botId, display, stopped: false };
      sessions.push(record);
      hints.push(hint);
      return {
        ready: true,
        browserRequestDir: `/run/desktops/${botId}/openbot-desktop`,
        stop: async () => {
          record.stopped = true;
          events.push(`session stopped ${display}`);
        },
      };
    },
    openInput,
    startCast: (castOptions) => startDesktopCast(castOptions, spawnImpl),
    capture: async (display) => {
      captures.push(display);
      return Buffer.from(display);
    },
    watchDock: async (dir, open) => {
      const record = { dir, closed: false, open };
      docks.push(record);
      return {
        close: () => {
          record.closed = true;
        },
      };
    },
    openBrowser: async (botId) => {
      opened.push(botId);
    },
    inUse: (botId) => use.get(botId) ?? { browser: false, watched: false },
    vacate: async (botId, message) => {
      vacated.push({ botId, message });
      events.push(`vacated ${botId}`);
    },
    blank: async (size) => {
      blanks.push(size);
      return Buffer.from(`black ${size.width}x${size.height}`);
    },
    ...overrides,
  };
  const desktops = createDesktopSessions(options);
  return {
    desktops,
    displays,
    sessions,
    inputs,
    docks,
    captures,
    vacated,
    opened,
    use,
    grabbers,
    events,
    hints,
    blanks,
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

describe("a desktop for each Bot", () => {
  test("two Bots get two displays, each with its own session and dock", async () => {
    const fake = fakeComputer();
    const a = await fake.desktops.use("bot-a");
    const b = await fake.desktops.use("bot-b");

    expect(a.display).toBe(":10");
    expect(b.display).toBe(":11");
    expect(fake.sessions.map((s) => [s.botId, s.display])).toEqual([
      ["bot-a", ":10"],
      ["bot-b", ":11"],
    ]);
    expect(fake.docks.map((dock) => dock.dir)).toEqual([
      "/run/desktops/bot-a/openbot-desktop",
      "/run/desktops/bot-b/openbot-desktop",
    ]);
    // The Chrome button on a Bot's dock opens that Bot's browser.
    await fake.docks[1]?.open();
    expect(fake.opened).toEqual(["bot-b"]);

    // Asked again, and many times at once, it is the same desktop.
    const again = await Promise.all([
      fake.desktops.use("bot-a"),
      fake.desktops.use("bot-a"),
    ]);
    expect(again.map((d) => d.display)).toEqual([":10", ":10"]);
    expect(fake.displays).toHaveLength(2);
    await fake.desktops.stopAll();
  });

  test("starts one desktop for callers that ask at the same moment", async () => {
    const fake = fakeComputer();
    const started = await Promise.all([
      fake.desktops.use("bot-a"),
      fake.desktops.use("bot-a"),
      fake.desktops.capture("bot-a"),
    ]);
    expect(fake.displays).toHaveLength(1);
    expect(started[0]).toMatchObject({ display: ":10" });
    expect(started[1]).toMatchObject({ display: ":10" });
    await fake.desktops.stopAll();
  });

  test("a viewer streams only its Bot's display, and its input reaches only that display", async () => {
    const fake = fakeComputer();
    const castA = await fake.desktops.cast("bot-a", () => undefined);
    const castB = await fake.desktops.cast("bot-b", () => undefined);

    const grabbed = fake.grabbers.map(
      (grabber) => grabber.args[grabber.args.indexOf("-i") + 1],
    );
    expect(grabbed).toEqual([":10", ":11"]);

    await castA.send({ type: "mouse", event: "pressed", x: 5, y: 6 });
    await castA.send({ type: "text", text: "hello" });
    expect(fake.inputs.map((input) => input.display)).toEqual([":10"]);
    expect(fake.inputs[0]?.calls).toEqual([
      "move 5,6",
      "press 1",
      "type hello",
    ]);

    await castB.send({ type: "text", text: "other" });
    expect(fake.inputs.map((input) => input.display)).toEqual([":10", ":11"]);
    expect(fake.inputs[0]?.calls).not.toContain("type other");

    await castA.stop();
    await castB.stop();
    await fake.desktops.stopAll();
  });

  test("screen input goes to the Bot's own running desktop, and never starts one", async () => {
    const fake = fakeComputer();
    await expect(fake.desktops.input("bot-a")).rejects.toBeInstanceOf(
      DesktopNotRunningError,
    );
    expect(fake.displays).toHaveLength(0);

    await fake.desktops.use("bot-a");
    await fake.desktops.use("bot-b");
    const pointer = await fake.desktops.input("bot-b");
    await pointer.move(1, 2);
    // Opened once and kept.
    expect(await fake.desktops.input("bot-b")).toBe(pointer);
    expect(fake.inputs.map((input) => input.display)).toEqual([":11"]);

    await fake.desktops.stop("bot-b", "test");
    expect(fake.inputs[0]?.closed).toBe(true);
    await fake.desktops.stopAll();
  });

  test("nothing starts until something needs the screen", async () => {
    const fake = fakeComputer();
    expect(fake.desktops.get("bot-a")).toBeUndefined();
    expect(fake.desktops.list()).toEqual([]);
    expect(fake.displays).toHaveLength(0);

    const frame = await fake.desktops.capture("bot-a");
    expect(String(frame)).toBe(":10");
    expect(fake.captures).toEqual([":10"]);
    expect(fake.desktops.get("bot-a")).toMatchObject({
      botId: "bot-a",
      display: ":10",
      ready: true,
      size: SIZE,
    });
    await fake.desktops.stopAll();
  });

  test("the Bot's browser closing takes its desktop with it, all of it", async () => {
    const fake = fakeComputer();
    await fake.desktops.use("bot-a");
    await fake.desktops.input("bot-a");
    fake.desktops.browserClosed("bot-a");
    // Out of the map at once: nothing finds the desktop on its way out.
    expect(fake.desktops.get("bot-a")).toBeUndefined();
    await fake.desktops.stop("bot-a", "waiting for the close above");

    expect(fake.displays[0]?.stopped).toBe(true);
    expect(fake.sessions[0]?.stopped).toBe(true);
    expect(fake.docks[0]?.closed).toBe(true);
    expect(fake.inputs[0]?.closed).toBe(true);
    // Its browser was the one that closed; nothing else is taken off it.
    expect(fake.vacated).toEqual([]);
  });

  test("a desktop somebody is watching, or one kept, outlives its browser", async () => {
    const fake = fakeComputer({ keep: (botId) => botId === "kept" });
    await fake.desktops.use("watched");
    await fake.desktops.use("kept");
    fake.use.set("watched", { browser: false, watched: true });

    fake.desktops.browserClosed("watched");
    fake.desktops.browserClosed("kept");
    expect(fake.desktops.get("watched")?.display).toBe(":10");
    expect(fake.desktops.get("kept")?.display).toBe(":11");
    await fake.desktops.stopAll();
  });

  test("a desktop is started again only once the one before it has gone", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let stops = 0;
    const fake = fakeComputer({
      startDesktop: async (botId) => ({
        ready: true,
        browserRequestDir: `/run/${botId}`,
        stop: async () => {
          stops++;
          await held;
        },
      }),
    });
    await fake.desktops.use("bot-a");
    const stopping = fake.desktops.stop("bot-a", "test");
    const next = fake.desktops.use("bot-a");
    await Bun.sleep(5);
    expect(fake.displays).toHaveLength(1);
    release();
    await stopping;
    expect((await next).display).toBe(":11");
    expect(stops).toBe(1);
    await fake.desktops.stopAll();
  });
});

describe("idle desktops", () => {
  test("are stopped once nothing has used them for the idle time", async () => {
    const fake = fakeComputer();
    await fake.desktops.use("bot-a");
    fake.tick(10 * 60_000 - 1);
    await fake.desktops.sweepIdleNow();
    expect(fake.desktops.get("bot-a")).toBeDefined();
    fake.tick(1);
    await fake.desktops.sweepIdleNow();
    expect(fake.desktops.get("bot-a")).toBeUndefined();
    expect(fake.displays[0]?.stopped).toBe(true);
  });

  test("are not idle while their browser runs or someone watches, and count from when that ended", async () => {
    const fake = fakeComputer({ keep: (botId) => botId === "kept" });
    await fake.desktops.use("browsing");
    await fake.desktops.use("watched");
    await fake.desktops.use("kept");
    fake.use.set("browsing", { browser: true, watched: false });
    fake.use.set("watched", { browser: false, watched: true });

    fake.tick(60 * 60_000);
    await fake.desktops.sweepIdleNow();
    expect(fake.desktops.list().map((d) => d.botId)).toEqual([
      "browsing",
      "watched",
      "kept",
    ]);

    // The browser closes without a word (a person closed its window): idle from now, not from before.
    fake.use.delete("browsing");
    fake.tick(5 * 60_000);
    await fake.desktops.sweepIdleNow();
    expect(fake.desktops.get("browsing")).toBeDefined();
    fake.tick(5 * 60_000);
    await fake.desktops.sweepIdleNow();
    expect(fake.desktops.get("browsing")).toBeUndefined();
    expect(fake.desktops.get("kept")).toBeDefined();
    await fake.desktops.stopAll();
  });

  test("an idle time of zero keeps them", async () => {
    const fake = fakeComputer({ idleMs: 0 });
    await fake.desktops.use("bot-a");
    fake.tick(24 * 60 * 60_000);
    await fake.desktops.sweepIdleNow();
    expect(fake.desktops.get("bot-a")).toBeDefined();
    await fake.desktops.stopAll();
  });
});

describe("the cap on desktops", () => {
  test("makes room by closing the least recently used one nobody is watching", async () => {
    const fake = fakeComputer({ max: 2 });
    await fake.desktops.use("bot-a");
    fake.tick(1);
    await fake.desktops.use("bot-b");
    fake.tick(1);
    // Used again, so bot-b is now the one quiet longest.
    await fake.desktops.use("bot-a");
    fake.tick(1);

    const c = await fake.desktops.use("bot-c");
    expect(c.display).toBe(":12");
    expect(fake.desktops.list().map((d) => d.botId)).toEqual([
      "bot-a",
      "bot-c",
    ]);
    // Its browser was put away and its viewer told before its display went.
    expect(fake.vacated).toEqual([
      { botId: "bot-b", message: DESKTOP_MADE_ROOM },
    ]);
    expect(fake.displays[1]?.stopped).toBe(true);
    await fake.desktops.stopAll();
  });

  test("closes an idle desktop before one with a browser, and never a watched or kept one", () => {
    const use = new Map<string, DesktopUse>([
      ["browsing-old", { browser: true, watched: false }],
      ["idle-new", { browser: false, watched: false }],
      ["watched-oldest", { browser: false, watched: true }],
      ["kept-oldest", { browser: false, watched: false }],
    ]);
    const inUse = (botId: string) =>
      use.get(botId) ?? { browser: false, watched: false };
    const keep = (botId: string) => botId === "kept-oldest";
    const running = [
      { botId: "kept-oldest", usedAt: 0 },
      { botId: "watched-oldest", usedAt: 1 },
      { botId: "browsing-old", usedAt: 2 },
      { botId: "idle-new", usedAt: 3 },
    ];
    expect(chooseDesktopToClose(running, inUse, keep)).toBe("idle-new");
    use.set("idle-new", { browser: true, watched: false });
    expect(chooseDesktopToClose(running, inUse, keep)).toBe("browsing-old");
    use.set("browsing-old", { browser: true, watched: true });
    use.set("idle-new", { browser: true, watched: true });
    expect(chooseDesktopToClose(running, inUse, keep)).toBeUndefined();
  });

  test("refuses a new desktop when every one is being watched", async () => {
    const fake = fakeComputer({ max: 1 });
    await fake.desktops.use("bot-a");
    fake.use.set("bot-a", { browser: true, watched: true });
    await expect(fake.desktops.use("bot-b")).rejects.toBeInstanceOf(
      DesktopsFullError,
    );
    expect(fake.displays).toHaveLength(1);
    expect(fake.desktops.get("bot-a")).toBeDefined();
    await fake.desktops.stopAll();
  });

  test("counts desktops still starting, so two Bots at once cannot both overshoot it", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fake = fakeComputer({
      max: 1,
      startDesktop: async (botId) => {
        await held;
        return {
          ready: true,
          browserRequestDir: `/run/${botId}`,
          stop: async () => undefined,
        };
      },
    });
    const a = fake.desktops.use("bot-a");
    // bot-a is starting and is not running yet, so there is nothing to close for bot-b.
    await expect(fake.desktops.use("bot-b")).rejects.toBeInstanceOf(
      DesktopsFullError,
    );
    release();
    expect((await a).display).toBe(":10");
    await fake.desktops.stopAll();
  });

  test("defaults to one desktop per 512 MB above a 1 GB floor, and always at least one", () => {
    expect(defaultDesktopCap(512 * MB)).toBe(1);
    expect(defaultDesktopCap(2048 * MB)).toBe(2);
    expect(defaultDesktopCap(4096 * MB)).toBe(6);
    expect(defaultDesktopCap(8192 * MB)).toBe(14);
  });

  test("reads the container's memory limit when it is below the machine's", () => {
    const files = new Map([["/sys/fs/cgroup/memory.max", `${2048 * MB}\n`]]);
    const read = (path: string) => {
      const found = files.get(path);
      if (found === undefined) throw new Error("absent");
      return found;
    };
    expect(memoryBytes(read, 16384 * MB)).toBe(2048 * MB);
    files.set("/sys/fs/cgroup/memory.max", "max\n");
    expect(memoryBytes(read, 16384 * MB)).toBe(16384 * MB);
    expect(memoryBytes(() => "", 4096 * MB)).toBe(4096 * MB);
  });
});

describe("a desktop that ends", () => {
  test("whose display dies is taken down, its Bot's browser and viewer told, and comes back on next use", async () => {
    const fake = fakeComputer();
    await fake.desktops.use("bot-a");
    fake.displays[0]?.die(1);
    await Bun.sleep(5);
    expect(fake.desktops.get("bot-a")).toBeUndefined();
    await fake.desktops.stop("bot-a", "waiting for the teardown");
    expect(fake.vacated).toEqual([{ botId: "bot-a", message: DESKTOP_LOST }]);
    expect(fake.sessions[0]?.stopped).toBe(true);

    expect((await fake.desktops.use("bot-a")).display).toBe(":11");
    await fake.desktops.stopAll();
  });

  test("shutdown stops every desktop, and starts no more", async () => {
    const fake = fakeComputer();
    await fake.desktops.use("bot-a");
    await fake.desktops.use("bot-b");
    await fake.desktops.input("bot-a");
    await fake.desktops.stopAll();

    expect(fake.displays.map((d) => d.stopped)).toEqual([true, true]);
    expect(fake.sessions.map((s) => s.stopped)).toEqual([true, true]);
    expect(fake.docks.map((d) => d.closed)).toEqual([true, true]);
    expect(fake.inputs.map((i) => i.closed)).toEqual([true]);
    expect(fake.desktops.list()).toEqual([]);
    await expect(fake.desktops.use("bot-c")).rejects.toThrow("shutting down");
  });

  test("a start failing leaves no X server behind", async () => {
    const fake = fakeComputer({
      startDesktop: async () => {
        throw new Error("no session");
      },
    });
    await expect(fake.desktops.use("bot-a")).rejects.toThrow("no session");
    expect(fake.displays[0]?.stopped).toBe(true);
    expect(fake.desktops.get("bot-a")).toBeUndefined();
    await fake.desktops.stopAll();
  });
});

describe("where each Bot's desktop lives", () => {
  test("a home and a runtime directory of its own", () => {
    const source = { XDG_RUNTIME_DIR: "/run/user/1001" };
    const a = botDesktopDirectories("bot-a", { home: "/home/pwuser", source });
    const b = botDesktopDirectories("bot-b", { home: "/home/pwuser", source });
    expect(a).toEqual({
      home: "/home/pwuser/.openbot-desktops/bot-a",
      runtimeDir: "/run/user/1001/openbot-desktops/bot-a",
    });
    expect(b.home).not.toBe(a.home);
    expect(b.runtimeDir).not.toBe(a.runtimeDir);

    // The session runs with them, so its settings, its bus and its dock's requests are its own.
    const env = desktopEnvironment(":10", source, a.home, a.runtimeDir);
    expect(env).toMatchObject({
      DISPLAY: ":10",
      HOME: a.home,
      XDG_CONFIG_HOME: `${a.home}/.config`,
      XDG_RUNTIME_DIR: a.runtimeDir,
    });
  });

  test("a computer for one Bot keeps that Bot's desktop where its one desktop always was", () => {
    const source = { XDG_RUNTIME_DIR: "/run/user/1001" };
    expect(
      botDesktopDirectories("only-bot", {
        home: "/home/pwuser",
        source,
        own: true,
      }),
    ).toEqual({ home: "/home/pwuser", runtimeDir: "/run/user/1001" });
  });

  test("refuses an id that is not a plain name, since it becomes a path", () => {
    expect(() => botDesktopDirectories("../escape")).toThrow();
    expect(() => botDesktopDirectories("a/b")).toThrow();
  });
});

describe("which desktop gives way at the cap", () => {
  test("not one whose browser is still launching, over one whose browser has been quiet for an hour", async () => {
    const fake = fakeComputer({ max: 2 });
    await fake.desktops.use("old-browser");
    fake.use.set("old-browser", {
      browser: true,
      watched: false,
      usedAt: 1_000,
    });
    fake.tick(60 * 60_000);
    // Its browser's launch asked for the desktop (displayFor) and is still running: not live yet,
    // but launching, which index.ts reports as a browser (profiles.isLaunching).
    await fake.desktops.use("launching");
    fake.use.set("launching", { browser: true, watched: false, usedAt: null });
    fake.tick(1);

    await fake.desktops.use("newcomer");
    expect(fake.desktops.list().map((d) => d.botId)).toEqual([
      "launching",
      "newcomer",
    ]);
    expect(fake.vacated).toEqual([
      { botId: "old-browser", message: DESKTOP_MADE_ROOM },
    ]);
    await fake.desktops.stopAll();
  });

  test("among desktops with browsers, the Bot that used its browser least recently, whatever the sweep stamped", async () => {
    const fake = fakeComputer({ max: 2 });
    await fake.desktops.use("busy");
    await fake.desktops.use("quiet");
    fake.use.set("busy", { browser: true, watched: false, usedAt: 1_000 });
    fake.use.set("quiet", { browser: true, watched: false, usedAt: 1_000 });
    fake.tick(1_000);
    // The sweep finds both in use at the same instant; that must not decide which is busier.
    await fake.desktops.sweepIdleNow();
    fake.tick(25 * 60_000);
    // "busy" goes on acting through its browser; "quiet" has done nothing since.
    fake.use.set("busy", {
      browser: true,
      watched: false,
      usedAt: 1_000 + 25 * 60_000,
    });

    await fake.desktops.use("newcomer");
    expect(fake.desktops.list().map((d) => d.botId)).toEqual([
      "busy",
      "newcomer",
    ]);
    expect(fake.vacated.map((v) => v.botId)).toEqual(["quiet"]);
    await fake.desktops.stopAll();
  });

  test("says whether a display is still the Bot's, so a browser launched onto one that went is launched again", async () => {
    const fake = fakeComputer({ max: 1 });
    const first = await fake.desktops.use("bot-a");
    expect(fake.desktops.current("bot-a", first.display)).toBe(true);
    // Closed to make room while bot-a's browser was still launching onto it.
    await fake.desktops.use("bot-b");
    expect(fake.desktops.current("bot-a", first.display)).toBe(false);
    // Numbers are not handed out again, so the display bot-a's browser was given is nobody's now.
    expect(fake.desktops.get("bot-b")?.display).not.toBe(first.display);
    await fake.desktops.stopAll();
  });
});

describe("a desktop somebody is on", () => {
  /** The same wiring index.ts has: sessions say who is watching, a closing browser goes through them. */
  function wired(desktop: boolean) {
    const sessions = createSessions({ isLive: () => false, desktop });
    const fake = fakeComputer({
      inUse: (botId) => ({ browser: false, watched: sessions.watching(botId) }),
    });
    /** What profiles.ts does when it closes a browser: onClosed, the close, then afterClosed. */
    const closeBrowser = async (botId: string) => {
      await sessions.browserClosed(botId, "The computer stopped.");
      fake.desktops.browserClosed(botId);
      // Whatever the close set going, let it finish.
      await Bun.sleep(5);
    };
    return { sessions, fake, closeBrowser };
  }

  test("keeps its screen, and the person on it, when the browser closes", async () => {
    const { sessions, fake, closeBrowser } = wired(true);
    await fake.desktops.use("bot-a");
    const told: string[] = [];
    const socket = { socket: 1 };
    sessions.for("bot-a").viewer.claim(socket, (reason) => told.push(reason));

    // Browser closed while the browser idle sweep ran: Chrome goes, the desktop does not.
    fake.desktops.browserClosed("bot-a");
    await sessions.browserClosed("bot-a", "The computer stopped.");
    fake.desktops.browserClosed("bot-a");
    expect(fake.desktops.get("bot-a")).toBeDefined();
    expect(sessions.get("bot-a")?.viewer.occupied()).toBe(true);
    expect(told).toEqual([]);

    // They close the screen and go: the next close of the browser takes the desktop.
    await sessions.get("bot-a")?.viewer.release(socket);
    await closeBrowser("bot-a");
    expect(fake.desktops.get("bot-a")).toBeUndefined();
  });

  test("counts a person holding the wheel as on it, screen open or not", async () => {
    const { sessions, fake, closeBrowser } = wired(true);
    await fake.desktops.use("bot-a");
    const session = sessions.for("bot-a");
    const help = session.control.requestHelp(
      "Sign in, please.",
      "call-1",
    ).request;
    if (!help) throw new Error("no request");
    await session.control.take(help.id);
    expect(sessions.watching("bot-a")).toBe(true);

    await closeBrowser("bot-a");
    expect(fake.desktops.get("bot-a")).toBeDefined();
    // And it is never closed to make room either.
    expect(
      chooseDesktopToClose([{ botId: "bot-a", usedAt: 0 }], (botId) => ({
        browser: false,
        watched: sessions.watching(botId),
      })),
    ).toBeUndefined();
    await fake.desktops.stopAll();
  });

  test("on a page screen the viewer still comes down with the browser, as before", async () => {
    const sessions = createSessions({ isLive: () => false, desktop: false });
    const told: string[] = [];
    sessions
      .for("bot-a")
      .viewer.claim({ socket: 1 }, (reason) => told.push(reason));
    await sessions.browserClosed("bot-a", "The computer stopped.");
    expect(sessions.get("bot-a")?.viewer.occupied()).toBe(false);
    expect(told).toEqual(["The computer stopped."]);
  });
});

describe("a display that dies with pointers open on it", () => {
  test("abandons every pointer before anything speaks to it, and stops the session before the browser is put away", async () => {
    const fake = fakeComputer();
    await fake.desktops.use("bot-a");
    await fake.desktops.input("bot-a");
    const cast = await fake.desktops.cast("bot-a", () => undefined);
    await cast.send({ type: "mouse", event: "moved", x: 1, y: 1 });
    expect(fake.inputs.map((i) => i.display)).toEqual([":10", ":10"]);

    fake.displays[0]?.die(1);
    await Bun.sleep(5);
    await fake.desktops.stop("bot-a", "waiting for the teardown");

    // Abandoned, never closed: closing a pointer on a dead display is what makes Xlib exit.
    expect(fake.inputs.map((i) => [i.abandoned, i.closed])).toEqual([
      [true, false],
      [true, false],
    ]);
    expect(fake.events).toEqual([
      "input abandoned :10",
      "input abandoned :10",
      "session stopped :10",
      "vacated bot-a",
    ]);
    // The live screen stopping afterwards (its viewer told) closes nothing on the dead display.
    await cast.stop();
    expect(fake.inputs.some((i) => i.closed)).toBe(false);
  });

  test("a pointer closed with the desktop on an ordinary stop is closed, not abandoned", async () => {
    const fake = fakeComputer();
    await fake.desktops.use("bot-a");
    await fake.desktops.input("bot-a");
    await fake.desktops.stop("bot-a", "test");
    expect(fake.inputs.map((i) => [i.abandoned, i.closed])).toEqual([
      [false, true],
    ]);
  });
});

describe("a frame that would show nothing", () => {
  test("is made black without starting a desktop, or closing another to make room", async () => {
    const fake = fakeComputer({ max: 1 });
    await fake.desktops.use("other");
    const frame = await fake.desktops.capture(
      "no-page",
      { width: 640, height: 400 },
      { x: 0, y: 0, width: 0, height: 0 },
    );
    expect(String(frame)).toBe("black 640x400");
    expect(fake.desktops.get("no-page")).toBeUndefined();
    expect(fake.desktops.get("other")).toBeDefined();
    expect(fake.captures).toEqual([]);
    // Unscaled, the screen's own size.
    await fake.desktops.capture("no-page", null, {
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    });
    expect(fake.blanks.at(-1)).toEqual(SIZE);
    await fake.desktops.stopAll();
  });

  test("blank frames come from ffmpeg's colour source, once per size", async () => {
    const calls: string[][] = [];
    const spawnImpl = ((_command: string, args: string[]) => {
      calls.push(args);
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
      });
      setTimeout(() => {
        child.stdout.write(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
        child.emit("close", 0);
      }, 0);
      return child;
    }) as unknown as typeof import("node:child_process").spawn;
    const blank = blankFrames(spawnImpl);
    const one = await blank({ width: 320, height: 200 });
    const again = await blank({ width: 320, height: 200 });
    expect(one.length).toBe(4);
    expect(again).toBe(one);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("color=c=black:s=320x200");
    expect(calls[0]).not.toContain("x11grab");
  });
});

describe("the idle sweep", () => {
  test("takes down the record it judged, never a desktop restarted while it was busy", async () => {
    let releaseA: () => void = () => undefined;
    const aStops = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let firstA = true;
    const fake = fakeComputer({
      startDesktop: async (botId) => {
        const holdThisOne = botId === "bot-a" && firstA;
        if (botId === "bot-a") firstA = false;
        return {
          ready: true,
          browserRequestDir: `/run/${botId}`,
          stop: async () => {
            if (holdThisOne) await aStops;
          },
        };
      },
    });
    await fake.desktops.use("bot-a");
    await fake.desktops.use("bot-b");
    fake.tick(11 * 60_000);
    // Both idle. The sweep stops bot-a first and waits on it.
    const sweeping = fake.desktops.sweepIdleNow();
    await Bun.sleep(5);
    // Meanwhile bot-b's desktop is stopped and started again: a new one, just used.
    await fake.desktops.stop("bot-b", "test");
    const fresh = await fake.desktops.use("bot-b");
    releaseA();
    await sweeping;
    expect(fake.desktops.get("bot-a")).toBeUndefined();
    expect(fake.desktops.get("bot-b")?.display).toBe(fresh.display);
    await fake.desktops.stopAll();
  });
});

describe("a window manager that does not come up", () => {
  test("is not waited for in full again until one does", async () => {
    let ready = false;
    const fake = fakeComputer({
      startDesktop: async (botId, _display, hint) => {
        fakeHints.push(hint);
        return {
          ready,
          browserRequestDir: `/run/${botId}`,
          stop: async () => undefined,
        };
      },
    });
    const fakeHints: { quick: boolean }[] = [];
    await fake.desktops.use("bot-a");
    await fake.desktops.use("bot-b");
    ready = true;
    await fake.desktops.use("bot-c");
    await fake.desktops.use("bot-d");
    expect(fakeHints.map((h) => h.quick)).toEqual([false, true, true, false]);
    await fake.desktops.stopAll();
  });
});
