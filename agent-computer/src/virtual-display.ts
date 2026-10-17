import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { Readable } from "node:stream";
import type { BrowserMode } from "./browser-mode";

export type DisplayProcess = {
  /** The display allocated by this exact Xvfb process, reported through -displayfd. */
  ready: Promise<string>;
  exited: Promise<number>;
  kill: (signal?: NodeJS.Signals) => boolean;
};

export type DisplayRuntime = {
  spawn: (command: string, args: string[]) => DisplayProcess;
  wait: (milliseconds: number) => Promise<void>;
};

export type VirtualDisplay = {
  name: string;
  /** The screen Xvfb was asked for, which is what a desktop frame and a desktop click are measured in. */
  size: DisplaySize;
  /** Resolves for both normal shutdown and a display that failed while the computer was running. */
  terminated: Promise<{ code: number; expected: boolean }>;
  stop: () => Promise<void>;
};

const READY_BUDGET_MS = 5_000;
const STOP_BUDGET_MS = 2_000;

export type DisplaySize = { width: number; height: number };

/** What a page-only headed browser has always had: the viewport, and nothing around it. */
export const PAGE_DISPLAY_SIZE: DisplaySize = { width: 1280, height: 800 };
/** A desktop has a panel and a terminal to fit beside the page, so it starts larger. */
export const DESKTOP_DISPLAY_SIZE: DisplaySize = { width: 1440, height: 900 };

const MIN_DISPLAY = { width: 800, height: 600 };
const MAX_DISPLAY = { width: 4096, height: 4096 };

/**
 * The screen size an operator asked for, as `WIDTHxHEIGHT`.
 *
 * Refused rather than defaulted when it is set and wrong: a desktop that comes up at a size nobody
 * asked for is a deployment failure that reads as a layout bug, and the operator who typed the value
 * is the one person who can fix it. Unset or blank takes the default for the mode.
 */
export function displaySizeFromEnv(
  raw: string | undefined,
  desktop: boolean,
): DisplaySize {
  const value = raw?.trim();
  if (!value) return desktop ? DESKTOP_DISPLAY_SIZE : PAGE_DISPLAY_SIZE;
  const match = /^(\d{3,4})x(\d{3,4})$/i.exec(value);
  if (!match) {
    throw new Error(
      `COMPUTER_DISPLAY_SIZE must be WIDTHxHEIGHT, such as 1440x900, not ${JSON.stringify(value)}.`,
    );
  }
  const size = {
    width: Number.parseInt(match[1] ?? "", 10),
    height: Number.parseInt(match[2] ?? "", 10),
  };
  if (
    size.width < MIN_DISPLAY.width ||
    size.height < MIN_DISPLAY.height ||
    size.width > MAX_DISPLAY.width ||
    size.height > MAX_DISPLAY.height
  ) {
    throw new Error(
      `COMPUTER_DISPLAY_SIZE must be between ${MIN_DISPLAY.width}x${MIN_DISPLAY.height} and ${MAX_DISPLAY.width}x${MAX_DISPLAY.height}, not ${value}.`,
    );
  }
  return size;
}

async function allocatedDisplay(stream: Readable): Promise<string> {
  let response = "";
  for await (const chunk of stream) {
    response += String(chunk);
    if (response.length > 32) {
      throw new Error("Xvfb returned an invalid display number.");
    }
    if (response.includes("\n")) break;
  }

  const number = response.trim();
  if (!/^\d+$/.test(number)) {
    throw new Error("Xvfb returned an invalid display number.");
  }
  return `:${number}`;
}

const systemRuntime: DisplayRuntime = {
  spawn(command, args) {
    const child = spawn(command, args, {
      // fd 3 is private to this child. Xvfb writes its selected display there only after that display
      // is ready, so a stale socket or another X server can never satisfy our readiness check.
      stdio: ["ignore", "ignore", "inherit", "pipe"],
    });
    const exited = new Promise<number>((resolve) => {
      child.once("exit", (code) => resolve(code ?? 1));
      child.once("error", () => resolve(1));
    });
    const displayFd = child.stdio[3] as Readable | null;
    if (!displayFd)
      throw new Error("Xvfb did not expose its display descriptor.");
    return {
      ready: allocatedDisplay(displayFd),
      exited,
      kill: (signal) => child.kill(signal),
    };
  },
  wait: (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

async function stop(
  process: DisplayProcess,
  runtime: DisplayRuntime,
): Promise<void> {
  process.kill("SIGTERM");
  const stopped = await Promise.race([
    process.exited.then(() => true),
    runtime.wait(STOP_BUDGET_MS).then(() => false),
  ]);
  if (!stopped) {
    process.kill("SIGKILL");
    await process.exited;
  }
}

/** Start the local-only X display a headed computer needs. */
export async function startVirtualDisplay(
  mode: BrowserMode,
  runtime: DisplayRuntime = systemRuntime,
  size: DisplaySize = PAGE_DISPLAY_SIZE,
  /**
   * The display number to take, rather than the lowest free one. Xvfb still reports readiness on
   * the descriptor, and exits if that number is taken.
   */
  number?: number,
): Promise<VirtualDisplay | null> {
  if (mode === "headless") return null;

  const displayProcess = runtime.spawn("Xvfb", [
    ...(number === undefined ? [] : [`:${number}`]),
    "-displayfd",
    "3",
    "-screen",
    "0",
    `${size.width}x${size.height}x24`,
    "-nolisten",
    "tcp",
    "-ac",
  ]);
  let stopping = false;
  let exitCode: number | undefined;
  const exited = displayProcess.exited.then((code) => {
    exitCode = code;
    return code;
  });
  const terminated = exited.then((code) => ({ code, expected: stopping }));

  let name: string;
  try {
    name = await Promise.race([
      displayProcess.ready,
      exited.then((code) => {
        throw new Error(
          `The virtual display exited before it became ready (exit ${code}).`,
        );
      }),
      runtime.wait(READY_BUDGET_MS).then(() => {
        throw new Error(
          `The virtual display did not become ready within ${READY_BUDGET_MS}ms.`,
        );
      }),
    ]);
    if (!/^:\d+$/.test(name)) {
      throw new Error("Xvfb returned an invalid display number.");
    }
    if (number !== undefined && name !== `:${number}`) {
      throw new Error(
        `Xvfb took ${name}, not the :${number} it was asked for.`,
      );
    }
  } catch (error) {
    if (exitCode === undefined) {
      stopping = true;
      await stop(displayProcess, runtime);
    }
    throw error;
  }

  return {
    name,
    size,
    terminated,
    stop: async () => {
      if (stopping || exitCode !== undefined) return;
      stopping = true;
      await stop(displayProcess, runtime);
    },
  };
}

/**
 * Display numbers that are never handed out twice in this process.
 *
 * `-displayfd` alone gives the lowest free number, so a display that has just gone is the next one
 * handed out. With a display per Bot that is a hazard, not a saving: a Chromium still connecting to
 * the Bot display that went, or the old desktop's session restarting on it, would land on another
 * Bot's new screen. So numbers only go up, from well above the ones a person's own X server uses,
 * skipping any another server holds (its lock file says so), and wrapping only after tens of
 * thousands.
 */
export function createDisplayNumbers({
  first = 100,
  last = 30_000,
  taken = (number: number) => existsSync(`/tmp/.X${number}-lock`),
}: {
  first?: number;
  last?: number;
  taken?: (number: number) => boolean;
} = {}) {
  let next = first;
  return (): number => {
    for (let tries = 0; tries <= last - first; tries++) {
      const number = next;
      next = next >= last ? first : next + 1;
      if (!taken(number)) return number;
    }
    throw new Error("No display number is free.");
  };
}

/**
 * Start an X display on a number never used before in this process, trying the next number when
 * one is taken from under it (another X server started between the check and the bind).
 */
export async function startFreshDisplay(
  size: DisplaySize,
  numbers: () => number,
  {
    runtime = systemRuntime,
    attempts = 4,
  }: { runtime?: DisplayRuntime; attempts?: number } = {},
): Promise<VirtualDisplay> {
  let failure: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const display = await startVirtualDisplay(
        "headed",
        runtime,
        size,
        numbers(),
      );
      if (display) return display;
    } catch (error) {
      failure = error;
    }
  }
  throw failure instanceof Error
    ? failure
    : new Error("The virtual display could not be started.");
}
