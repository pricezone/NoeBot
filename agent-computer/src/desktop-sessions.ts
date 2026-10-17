import { readFileSync } from "node:fs";
import { totalmem } from "node:os";
import type { Desktop } from "./desktop";
import type { StreamSettings } from "./desktop-cast";
import { numberFromEnv, settleWithin } from "./env";
import type { FrameMessage, Screencast } from "./screencast";
import type { DisplaySize, VirtualDisplay } from "./virtual-display";
import type { XInput } from "./x-input";

/**
 * Every Bot its own desktop.
 *
 * A desktop computer used to draw one X display with one XFCE session, and every Bot's browser was
 * one maximized window on it. The live screen streamed the whole display, so a person watching one
 * Bot saw whichever Bot's window was in front, and their hands reached every window on it: a person
 * could click into another Bot's browser. Here each Bot gets an X display of its own (its own Xvfb,
 * on a display number the X server picks with `-displayfd`), its own XFCE session with its own home,
 * runtime directory and session bus, and its browser on that display. A viewer streams the display
 * of the Bot it is watching and nothing else, and its input goes to that display and nothing else.
 *
 * STARTED ON FIRST USE: the live screen, the desktop preview, or the Bot's browser launching. A Bot
 * that only reads pages costs nothing here until something needs its screen.
 *
 * STOPPED with the Bot's browser: a stop, a reset, the browser cap and the browser idle sweep all
 * close the browser and then its desktop (`browserClosed`). A desktop left with no browser and nobody
 * watching (a person closed Chrome from its window and went away) is idle, and the sweep here stops
 * it after `idleMs`.
 *
 * CAPPED by memory. Each desktop is an X server and a handful of XFCE processes, and the Bot's
 * browser beside it, so a computer holds as many as its memory allows (`desktopCapFromEnv`). At the
 * cap a new one takes the place of the least recently used one that nobody is watching: idle ones
 * first, then one whose Bot has a browser, which is closed with its tabs kept, the same as the
 * browser cap does it. A computer whose every desktop is being watched refuses the new one and says
 * so, rather than start what its memory cannot hold.
 *
 * No Playwright here, so the decisions can be tested with fake displays (index.ts wires the real
 * ones).
 */

/** What callers see of one Bot's desktop. */
export type DesktopSession = {
  botId: string;
  /** The X display, as `:N`. */
  display: string;
  size: DisplaySize;
  /** Whether its window manager answered when it started. */
  ready: boolean;
  startedAt: string;
};

/** Whether a Bot's desktop is in use: its browser is running, or a person has its screen open. */
export type DesktopUse = { browser: boolean; watched: boolean };

type Rect = { x: number; y: number; width: number; height: number };

export type DesktopSessionsOptions = {
  /** Every desktop's screen size. */
  size: DisplaySize;
  /** How many desktops may run at once. See `desktopCapFromEnv`. */
  max: number;
  /** How long a desktop with no browser and nobody watching is kept. Zero keeps it. */
  idleMs: number;
  /** Start one X server. */
  startDisplay: (size: DisplaySize) => Promise<VirtualDisplay>;
  /** Start one Bot's XFCE session on its display. */
  startDesktop: (botId: string, display: string) => Promise<Desktop>;
  /** A pointer and keyboard on one display (x-input.ts). */
  openInput: (display: string) => Promise<XInput>;
  /** A live screen of one display (desktop-cast.ts). */
  startCast: (options: {
    display: string;
    size: DisplaySize;
    onFrame: (frame: FrameMessage) => void;
    input: (display: string) => Promise<XInput>;
    stream?: StreamSettings;
  }) => Screencast;
  /** One frame of one display (desktop-cast.ts). */
  capture: (
    display: string,
    size: DisplaySize,
    scale: DisplaySize | null,
    keep: Rect | null,
  ) => Promise<Buffer>;
  stream?: StreamSettings;
  /** Watch one desktop's dock for its Chrome button (browser-request.ts). */
  watchDock?: (
    dir: string,
    open: () => Promise<void>,
  ) => Promise<{ close: () => void }>;
  /** What the Chrome button on a Bot's dock does: that Bot's browser, opened or brought forward. */
  openBrowser?: (botId: string) => Promise<void>;
  inUse: (botId: string) => DesktopUse;
  /**
   * Take everything off a Bot's desktop before it goes for a reason the Bot did not choose (the cap,
   * or its display dying): tell whoever is watching, and close its browser with its tabs kept, so the
   * browser flushes its profile before the display under it goes.
   */
  vacate: (botId: string, message: string) => Promise<void>;
  /** A desktop never stopped by the cap, the idle sweep or its browser closing. */
  keep?: (botId: string) => boolean;
  sweepEveryMs?: number;
  now?: () => number;
  log?: (line: Record<string, unknown>) => void;
};

/** A desktop asked of a computer that is not running one for that Bot. */
export class DesktopNotRunningError extends Error {
  constructor() {
    super("The Bot's desktop is not running. Open its screen first.");
    this.name = "DesktopNotRunningError";
  }
}

/**
 * Every desktop the computer can hold is in use: being watched, kept, or still starting. A start in
 * flight is not waited for, because two starts waiting on each other would wait for ever.
 */
export class DesktopsFullError extends Error {
  constructor(max: number) {
    super(
      `This computer is already running ${max} desktop${max === 1 ? "" : "s"}, as many as its memory allows, and each of them is in use. Close another Bot's screen and try again.`,
    );
    this.name = "DesktopsFullError";
  }
}

/** Said to a person whose screen is closed to make room for another Bot's desktop. */
export const DESKTOP_MADE_ROOM =
  "This Bot's desktop was closed to make room for another Bot's. Open the screen again to bring it back.";
/** Said to a person whose Bot's display stopped on its own. */
export const DESKTOP_LOST =
  "This Bot's desktop stopped unexpectedly. Open the screen again to start it.";

/** How long making room may wait for a browser to close before its display is stopped anyway. */
const VACATE_BUDGET_MS = 15_000;
/** How long a desktop start that shutdown overtook is waited for. */
const SHUTDOWN_START_BUDGET_MS = 10_000;

const MEGABYTE = 1024 * 1024;
/** What one desktop and the browser on it are given, for the default cap. */
export const DESKTOP_MEMORY_BYTES = 512 * MEGABYTE;
/** What is kept back for everything else on the machine (the API, the database, the shell). */
export const DESKTOP_MEMORY_FLOOR_BYTES = 1024 * MEGABYTE;

/** One desktop per 512 MB above a 1 GB floor, and always at least one. */
export function defaultDesktopCap(memoryBytes: number): number {
  return Math.max(
    1,
    Math.floor(
      (memoryBytes - DESKTOP_MEMORY_FLOOR_BYTES) / DESKTOP_MEMORY_BYTES,
    ),
  );
}

/**
 * The memory this process may use: the machine's, or the container's limit when it has a lower one.
 *
 * `os.totalmem()` reads the host's memory inside a container, which on a large host would let a
 * small container start desktops it has no room for, so the cgroup limit is asked as well.
 */
export function memoryBytes(
  read: (path: string) => string = (path) => readFileSync(path, "utf8"),
  machine: number = totalmem(),
): number {
  let limit = machine;
  for (const path of [
    "/sys/fs/cgroup/memory.max",
    "/sys/fs/cgroup/memory/memory.limit_in_bytes",
  ]) {
    try {
      const value = read(path).trim();
      if (!/^\d+$/.test(value)) continue;
      const bytes = Number(value);
      if (bytes > 0 && bytes < limit) limit = bytes;
    } catch {
      // No cgroup here, or not this version of it.
    }
  }
  return limit;
}

/** `COMPUTER_MAX_DESKTOPS`, or the default for this much memory. */
export function desktopCapFromEnv(memory: number = memoryBytes()): number {
  return numberFromEnv("COMPUTER_MAX_DESKTOPS", defaultDesktopCap(memory));
}

/**
 * Which desktop gives way when a new one needs room: never one being watched or kept, idle ones
 * before ones with a running browser, and the least recently used of those.
 */
export function chooseDesktopToClose(
  running: Iterable<{ botId: string; usedAt: number }>,
  inUse: (botId: string) => DesktopUse,
  keep: (botId: string) => boolean = () => false,
): string | undefined {
  return [...running]
    .filter((entry) => !keep(entry.botId))
    .map((entry) => ({ ...entry, use: inUse(entry.botId) }))
    .filter((entry) => !entry.use.watched)
    .sort(
      (a, b) =>
        Number(a.use.browser) - Number(b.use.browser) || a.usedAt - b.usedAt,
    )[0]?.botId;
}

export function createDesktopSessions(options: DesktopSessionsOptions) {
  type Running = DesktopSession & {
    usedAt: number;
    virtual: VirtualDisplay;
    desktop: Desktop;
    dock?: { close: () => void };
    input?: Promise<XInput>;
    /** Its teardown, once begun: a desktop is taken down once, however many paths ask. */
    torn?: Promise<void>;
  };

  const now = options.now ?? Date.now;
  const log = options.log ?? ((line) => console.info(JSON.stringify(line)));
  const keep = options.keep ?? (() => false);
  const max = Math.max(1, options.max);

  const running = new Map<string, Running>();
  /** Starts in flight, so a Bot's desktop is started once however many callers ask at once. */
  const starting = new Map<string, Promise<Running>>();
  /** Stops in flight, so a desktop is never started again on top of the one going away. */
  const stopping = new Map<string, Promise<void>>();
  let closed = false;

  const view = (record: Running): DesktopSession => ({
    botId: record.botId,
    display: record.display,
    size: record.size,
    ready: record.ready,
    startedAt: record.startedAt,
  });

  /**
   * Take one desktop down: its dock, its pointer, its session, then its X server. Out of the map at
   * once, so nothing finds it on the way out; anything asking for that Bot's desktop meanwhile waits
   * for this and starts a fresh one.
   */
  const teardown = (
    record: Running,
    reason: string,
    message?: string,
  ): Promise<void> => {
    if (running.get(record.botId) === record) running.delete(record.botId);
    if (record.torn) return record.torn;
    const work = (async () => {
      if (message)
        await settleWithin(
          options.vacate(record.botId, message),
          VACATE_BUDGET_MS,
        );
      record.dock?.close();
      if (record.input) {
        const input = await record.input.catch(() => undefined);
        input?.close();
      }
      await record.desktop.stop().catch(() => undefined);
      await record.virtual.stop().catch(() => undefined);
      log({
        type: "computer-desktop-stopped",
        botId: record.botId,
        display: record.display,
        reason,
      });
    })();
    const held = Promise.all([stopping.get(record.botId), work]).then(
      () => undefined,
    );
    record.torn = held;
    stopping.set(record.botId, held);
    void held.then(() => {
      if (stopping.get(record.botId) === held) stopping.delete(record.botId);
    });
    return held;
  };

  /** Stop a Bot's desktop, or wait for the stop already under way. Whether one was running. */
  const stop = async (botId: string, reason: string): Promise<boolean> => {
    const record = running.get(botId);
    if (!record) {
      await stopping.get(botId);
      return false;
    }
    await teardown(record, reason);
    return true;
  };

  /** Make room for `botId`'s desktop under the cap, closing others' if it has to. */
  const makeRoom = async (botId: string): Promise<void> => {
    for (;;) {
      const occupied = new Set([...running.keys(), ...starting.keys()]);
      occupied.delete(botId);
      if (occupied.size < max) return;
      const victim = chooseDesktopToClose(
        [...running.values()].filter((record) => record.botId !== botId),
        options.inUse,
        keep,
      );
      const record = victim ? running.get(victim) : undefined;
      if (!record) throw new DesktopsFullError(max);
      log({
        type: "computer-desktop-making-room",
        botId: record.botId,
        for: botId,
        max,
      });
      await teardown(
        record,
        "the cap on running desktops was reached",
        DESKTOP_MADE_ROOM,
      );
    }
  };

  const start = async (botId: string): Promise<Running> => {
    const stoppingNow = stopping.get(botId);
    if (stoppingNow) await stoppingNow;
    if (closed) throw new Error("The computer is shutting down.");
    await makeRoom(botId);
    const startedAt = now();
    const virtual = await options.startDisplay(options.size);
    let desktop: Desktop;
    try {
      desktop = await options.startDesktop(botId, virtual.name);
    } catch (error) {
      await virtual.stop().catch(() => undefined);
      throw error;
    }
    const openBrowser = options.openBrowser;
    const dock =
      options.watchDock && openBrowser
        ? await options
            .watchDock(desktop.browserRequestDir, () => openBrowser(botId))
            .catch((error: unknown) => {
              log({
                type: "computer-desktop-dock-unwatched",
                botId,
                error: error instanceof Error ? error.message : String(error),
              });
              return undefined;
            })
        : undefined;
    if (closed) {
      dock?.close();
      await desktop.stop().catch(() => undefined);
      await virtual.stop().catch(() => undefined);
      throw new Error("The computer is shutting down.");
    }
    const record: Running = {
      botId,
      display: virtual.name,
      size: virtual.size,
      ready: desktop.ready,
      startedAt: new Date(startedAt).toISOString(),
      usedAt: now(),
      virtual,
      desktop,
      ...(dock ? { dock } : {}),
    };
    running.set(botId, record);
    // An X server that dies takes its browser and session with it; the next use starts a new one.
    void virtual.terminated.then(({ code, expected }) => {
      if (expected || running.get(botId) !== record) return;
      log({
        type: "computer-desktop-display-exited",
        botId,
        display: record.display,
        exitCode: code,
      });
      void teardown(record, "its display exited", DESKTOP_LOST);
    });
    log({
      type: "computer-desktop-started",
      botId,
      display: record.display,
      ready: record.ready,
      ms: now() - startedAt,
      running: running.size,
      max,
    });
    return record;
  };

  /** The Bot's desktop, started if it is not running, and marked as used. */
  const use = async (botId: string): Promise<Running> => {
    const existing = running.get(botId);
    if (existing) {
      existing.usedAt = now();
      return existing;
    }
    const inFlight = starting.get(botId);
    if (inFlight) return inFlight;
    const launch = start(botId);
    starting.set(botId, launch);
    try {
      return await launch;
    } finally {
      if (starting.get(botId) === launch) starting.delete(botId);
    }
  };

  /**
   * Stop desktops that have had no browser and nobody watching for `idleMs`. A desktop in use is
   * marked used each time this looks, so its idle time counts from when it stopped being used.
   */
  const sweepIdle = async (): Promise<void> => {
    const at = now();
    for (const record of [...running.values()]) {
      if (keep(record.botId)) continue;
      const state = options.inUse(record.botId);
      if (state.browser || state.watched) {
        record.usedAt = at;
        continue;
      }
      if (options.idleMs > 0 && at - record.usedAt >= options.idleMs)
        await stop(record.botId, "it had been idle");
    }
  };

  const sweep = setInterval(
    () => void sweepIdle().catch(() => undefined),
    options.sweepEveryMs ?? 60_000,
  );
  sweep.unref?.();

  return {
    max,

    /** The Bot's desktop, started if it is not running. */
    async use(botId: string): Promise<DesktopSession> {
      return view(await use(botId));
    },

    /** The Bot's desktop if it is running; never starts one. */
    get(botId: string): DesktopSession | undefined {
      const record = running.get(botId);
      return record ? view(record) : undefined;
    },

    /** A live screen of this Bot's display, and input that reaches this display only. */
    async cast(
      botId: string,
      onFrame: (frame: FrameMessage) => void,
    ): Promise<Screencast> {
      const record = await use(botId);
      return options.startCast({
        display: record.display,
        size: record.size,
        onFrame,
        input: options.openInput,
        ...(options.stream ? { stream: options.stream } : {}),
      });
    },

    /** One frame of this Bot's display, started if it is not running. */
    async capture(
      botId: string,
      scale: DisplaySize | null = null,
      keepRect: Rect | null = null,
    ): Promise<Buffer> {
      const record = await use(botId);
      return options.capture(record.display, record.size, scale, keepRect);
    },

    /**
     * The pointer and keyboard of this Bot's running desktop, for input carried out in screen space
     * (Clicky). Opened on first use and kept until the desktop stops. Never starts a desktop: input
     * is only ever for a screen somebody is looking at.
     */
    input(botId: string): Promise<XInput> {
      const record = running.get(botId);
      if (!record) return Promise.reject(new DesktopNotRunningError());
      record.usedAt = now();
      if (!record.input) {
        const opening = options.openInput(record.display);
        record.input = opening;
        // A display that could not be opened is asked again next time, not remembered as broken.
        opening.catch(() => {
          if (record.input === opening) record.input = undefined;
        });
      }
      return record.input;
    },

    /**
     * The Bot's browser was closed (a stop, a reset, the browser cap or its idle sweep): its desktop
     * goes too, unless it is kept or somebody still has the screen open, in which case it is idle and
     * the sweep decides. Called after the browser has closed, so it never loses its display first.
     */
    browserClosed(botId: string): void {
      if (keep(botId) || options.inUse(botId).watched) return;
      void stop(botId, "its browser was closed").catch(() => undefined);
    },

    stop,

    /** Run the idle sweep now. For tests, which should not wait a minute. */
    sweepIdleNow: sweepIdle,

    /** Every running desktop. For status. */
    list(): DesktopSession[] {
      return [...running.values()].map(view);
    },

    /** Stop every desktop, for shutdown: after the browsers, so none loses its display first. */
    async stopAll(): Promise<void> {
      closed = true;
      clearInterval(sweep);
      await Promise.all(
        [...starting.values()].map((launch) =>
          settleWithin(launch, SHUTDOWN_START_BUDGET_MS),
        ),
      );
      await Promise.all(
        [...running.values()].map((record) =>
          teardown(record, "the computer is shutting down"),
        ),
      );
      await Promise.all([...stopping.values()]);
    },
  };
}

export type DesktopSessions = ReturnType<typeof createDesktopSessions>;
