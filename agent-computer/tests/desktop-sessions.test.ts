import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { botDesktopDirectories, desktopEnvironment } from "../src/desktop";
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
  const inputs: { display: string; calls: string[]; closed: boolean }[] = [];
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
    const seen = { display, calls: [] as string[], closed: false };
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
    startDesktop: async (botId, display) => {
      const record = { botId, display, stopped: false };
      sessions.push(record);
      return {
        ready: true,
        browserRequestDir: `/run/desktops/${botId}/openbot-desktop`,
        stop: async () => {
          record.stopped = true;
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

  test("refuses an id that is not a plain name, since it becomes a path", () => {
    expect(() => botDesktopDirectories("../escape")).toThrow();
    expect(() => botDesktopDirectories("a/b")).toThrow();
  });
});
