import { spawn } from "node:child_process";
import { readlink } from "node:fs/promises";
import { join } from "node:path";
import { xdotoolEnvironment } from "./x-input";

/**
 * Which window of the desktop is where, for Clicky.
 *
 * The guardrails rate what is on the Bot's PAGE, but input on a desktop goes to whatever window the
 * X server puts under the pointer or behind the keyboard: the terminal, the file manager, another
 * Chrome. So before Clicky clicks, scrolls or types on a desktop, it asks the X server which window
 * would receive it and whether that window is the Bot's PAGE: the browser's own process (the
 * `_NET_WM_PID` it names against the browser's, from its profile's `SingletonLock`, or, naming none,
 * a Chrome class) AND the very top-level window the page is in, by its geometry against the page's
 * own `screenX`/`outerWidth`. The browser's bubbles (a permission's "Allow", save the password,
 * autofill) are windows of the same process and fail the second test. Any doubt is "other": the
 * caller then treats the place as outside the page, which is asked about every time.
 */

export type WindowCheck = "browser" | "other";

/** A window's place on the screen: where the page says its window is, or what X says. */
export type WindowRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/** How far apart (in pixels, each edge) two readings of one window may be: a frame's border. */
const GEOMETRY_TOLERANCE = 8;

/** `xdotool getwindowgeometry --shell`: `WINDOW=…`, `X=…`, `Y=…`, `WIDTH=…`, `HEIGHT=…`. */
export function parseGeometry(text: string | null): WindowRect | null {
  const values = new Map<string, number>();
  for (const line of (text ?? "").split("\n")) {
    const match = /^([A-Z]+)=(-?\d+)$/.exec(line.trim());
    if (match?.[1] && match[2] !== undefined)
      values.set(match[1], Number(match[2]));
  }
  const x = values.get("X");
  const y = values.get("Y");
  const width = values.get("WIDTH");
  const height = values.get("HEIGHT");
  if (
    x === undefined ||
    y === undefined ||
    width === undefined ||
    height === undefined
  )
    return null;
  return { x, y, width, height };
}

/** Whether two readings name the same window: every edge within a border's width. */
export function sameWindowRect(a: WindowRect, b: WindowRect): boolean {
  return (
    Math.abs(a.x - b.x) <= GEOMETRY_TOLERANCE &&
    Math.abs(a.y - b.y) <= GEOMETRY_TOLERANCE &&
    Math.abs(a.x + a.width - (b.x + b.width)) <= GEOMETRY_TOLERANCE &&
    Math.abs(a.y + a.height - (b.y + b.height)) <= GEOMETRY_TOLERANCE
  );
}

const XDOTOOL_TIMEOUT_MS = 1_500;

/** One `xdotool` (or `xprop`) call's output, or null when it failed or took too long. */
export function runX(
  display: string,
  command: "xdotool" | "xprop",
  args: string[],
): Promise<string | null> {
  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    const done = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        env: xdotoolEnvironment(display, process.env),
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done(null);
    }, XDOTOOL_TIMEOUT_MS);
    child.stdout?.on("data", (chunk: Buffer) => {
      output += String(chunk);
    });
    child.on("error", () => done(null));
    child.on("close", (code) => done(code === 0 ? output : null));
  });
}

/** `xdotool getmouselocation --shell`: `X=…`, `Y=…`, `SCREEN=…`, `WINDOW=…`, one per line. */
export function parseMouseLocation(
  text: string,
): { x: number; y: number; window: number } | null {
  const values = new Map<string, number>();
  for (const line of text.split("\n")) {
    const match = /^([A-Z]+)=(-?\d+)$/.exec(line.trim());
    if (match?.[1] && match[2] !== undefined)
      values.set(match[1], Number(match[2]));
  }
  const x = values.get("X");
  const y = values.get("Y");
  const window = values.get("WINDOW");
  if (x === undefined || y === undefined || window === undefined) return null;
  return { x, y, window };
}

/** A window id as xdotool prints it alone on a line. */
export function parseWindowId(text: string | null): number | null {
  const value = text?.trim();
  return value && /^\d+$/.test(value) ? Number(value) : null;
}

/** `WM_CLASS(STRING) = "chromium", "Chromium"`: whether it names a Chrome or Chromium window. */
export function isChromeClass(text: string | null): boolean {
  return Boolean(text && /=.*chrom/i.test(text));
}

/** The browser's main process, from the `SingletonLock` link Chromium leaves in its profile. */
export async function browserPid(profileDir: string): Promise<number | null> {
  const target = await readlink(join(profileDir, "SingletonLock")).catch(
    () => null,
  );
  const match = target ? /-(\d+)$/.exec(target) : null;
  return match?.[1] ? Number(match[1]) : null;
}

/**
 * Whether an X window is the one the Bot's page is in: the browser's process, and the top-level
 * window whose place on the screen is where the page says its window is. With no page to compare
 * with, no window is.
 */
async function isPageWindow(
  display: string,
  window: number,
  pid: number | null,
  page: WindowRect | null,
): Promise<boolean> {
  if (!page) return false;
  const owner = parseWindowId(
    await runX(display, "xdotool", ["getwindowpid", String(window)]),
  );
  const browser =
    owner !== null
      ? pid !== null && owner === pid
      : // A window that names no process: only ever a Chrome window at all.
        isChromeClass(
          await runX(display, "xprop", ["-id", String(window), "WM_CLASS"]),
        );
  if (!browser) return false;
  const geometry = parseGeometry(
    await runX(display, "xdotool", [
      "getwindowgeometry",
      "--shell",
      String(window),
    ]),
  );
  return geometry !== null && sameWindowRect(geometry, page);
}

/** The window under the pointer right now: the Bot's page, or something else. */
export async function windowUnderPointer(
  display: string,
  pid: number | null,
  page: WindowRect | null,
): Promise<WindowCheck> {
  const location = parseMouseLocation(
    (await runX(display, "xdotool", ["getmouselocation", "--shell"])) ?? "",
  );
  if (!location) return "other";
  return (await isPageWindow(display, location.window, pid, page))
    ? "browser"
    : "other";
}

/** The window with the keyboard right now: the Bot's page, or something else. */
export async function focusedWindow(
  display: string,
  pid: number | null,
  page: WindowRect | null,
): Promise<WindowCheck> {
  const window = parseWindowId(
    await runX(display, "xdotool", ["getwindowfocus"]),
  );
  if (window === null) return "other";
  return (await isPageWindow(display, window, pid, page)) ? "browser" : "other";
}
