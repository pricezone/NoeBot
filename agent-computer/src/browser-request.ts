import { type FSWatcher, watch } from "node:fs";
import { chmod, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "playwright";
import { BROWSER_REQUEST_FILE } from "./desktop";

/**
 * The dock's Chrome button, on the computer's side.
 *
 * The button runs `openbot-browser`, which touches `open-browser` in `dir`. The desktop has no token
 * to ask the computer anything over HTTP, and is not given one, so a file in a directory only this
 * user can reach is the whole protocol: its appearance is the request, and nothing in it is read.
 *
 * Each request is consumed (the file removed) before `open` runs, so the next click creates it again
 * and is seen again, whether or not the platform reports a touch of a file that already exists.
 * Requests that arrive together are one request: a double click opens one browser.
 */
export async function watchBrowserRequests(
  dir: string,
  open: () => Promise<void> | void,
  {
    debounceMs = 150,
    stallMs = 45_000,
    pollMs = 2_000,
    events = true,
  }: {
    debounceMs?: number;
    stallMs?: number;
    pollMs?: number;
    /** Off only in a test, to stand for a platform that dropped every file event. */
    events?: boolean;
  } = {},
): Promise<{ close: () => void }> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // mkdir leaves an existing directory's mode alone.
  await chmod(dir, 0o700);
  const request = join(dir, BROWSER_REQUEST_FILE);
  // A click from before this process started is not a request to this one.
  await rm(request, { force: true });

  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let closed = false;
  /** A click that arrived while a browser was opening: handled when that finishes, not dropped. */
  let waiting = false;

  const handle = async (): Promise<void> => {
    timer = undefined;
    if (closed) return;
    if (running) {
      waiting = true;
      return;
    }
    const removed = await rm(request).then(
      () => true,
      () => false,
    );
    if (!removed) return;
    running = true;
    const started = Date.now();
    /*
     * Bounded. A request that never settles (a launch that hangs) used to hold `running` for good,
     * and every later click was dropped: the dock's Chrome button simply stopped working. Past the
     * budget the button answers again; the stalled attempt is left to finish or fail on its own.
     */
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const stalled = new Promise<"stalled">((resolve) => {
      watchdog = setTimeout(() => resolve("stalled"), stallMs);
    });
    try {
      const outcome = await Promise.race([
        Promise.resolve(open()).then(() => "opened" as const),
        stalled,
      ]);
      console.info(
        JSON.stringify({
          type:
            outcome === "opened"
              ? "computer-desktop-browser-opened"
              : "computer-desktop-browser-request-stalled",
          ms: Date.now() - started,
        }),
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          type: "computer-desktop-browser-request-failed",
          ms: Date.now() - started,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      clearTimeout(watchdog);
      running = false;
    }
    /*
     * Its file is still there, and no new event will say so: the platform reported it once, while
     * this was busy. Looked at again now, so a click during a slow launch still opens a browser.
     */
    if (waiting) {
      waiting = false;
      await handle();
    }
  };

  const soon = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void handle(), debounceMs);
  };
  /*
   * And looked for now and then, because a file event can be dropped (seen on macOS under load), and
   * a dropped event is a click that is never answered. Cheap: one failed unlink when there is none.
   */
  const poll = setInterval(() => {
    if (!running && !timer) void handle();
  }, pollMs);
  poll.unref?.();

  if (!events) {
    return {
      close() {
        closed = true;
        clearInterval(poll);
      },
    };
  }

  let watcher: FSWatcher;
  try {
    watcher = watch(dir, (_event, filename) => {
      if (filename && String(filename) !== BROWSER_REQUEST_FILE) return;
      soon();
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        type: "computer-desktop-browser-request-unwatched",
        dir,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return {
      close() {
        closed = true;
        clearInterval(poll);
      },
    };
  }
  watcher.on("error", () => undefined);

  return {
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      clearInterval(poll);
      watcher.close();
    },
  };
}

/** `work`, or a rejection once `ms` have passed: so a call into a browser that died cannot hang. */
export function within<T>(
  work: Promise<T>,
  ms: number,
  what: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${what} took longer than ${ms} ms`)),
      ms,
    );
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/** How long each step of bringing the browser forward may take. */
const STEP_MS = 5_000;

/**
 * Bring a browser window to the front, restoring it first if it was minimized.
 *
 * `bringToFront` activates the tab and asks the window manager for the window, which raises one that
 * is merely behind another; a minimized window has to be restored first, through the DevTools
 * protocol, since the desktop gives the computer no other handle on it. Every step is bounded: a
 * browser that is dying answers nothing, and the person's click should fail fast rather than wait.
 */
export async function raiseBrowserWindow(page: Page): Promise<void> {
  const client = await within(
    page.context().newCDPSession(page),
    STEP_MS,
    "Opening a DevTools session",
  );
  try {
    const { windowId, bounds } = await within(
      client.send("Browser.getWindowForTarget"),
      STEP_MS,
      "Finding the browser window",
    );
    if (bounds.windowState === "minimized") {
      await within(
        client.send("Browser.setWindowBounds", {
          windowId,
          bounds: { windowState: "normal" },
        }),
        STEP_MS,
        "Restoring the browser window",
      );
    }
  } finally {
    void client.detach().catch(() => undefined);
  }
  await within(page.bringToFront(), STEP_MS, "Raising the browser window");
}

/**
 * What every fresh browser opens on, unless the deployment says otherwise.
 *
 * English by name: Google picks its language from the address a request comes from rather than from
 * what the browser asks for, and the computers run in Germany, so a plain google.com greeted people
 * in German (measured: with `--accept-lang=en-US,en` alone it still answered in the local language).
 * `hl=en` settles it, and a search from that page stays English because Google's form carries `hl`
 * along. Every other site gets English from the browser itself (`LAUNCH_ARGS` in profiles.ts).
 */
export const DEFAULT_HOMEPAGE = "https://www.google.com/?hl=en";

/** The start page, from `COMPUTER_DESKTOP_HOMEPAGE` when it is an http(s) address. */
export function homepageFromEnv(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) return DEFAULT_HOMEPAGE;
  try {
    const url = new URL(trimmed);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.href
      : DEFAULT_HOMEPAGE;
  } catch {
    return DEFAULT_HOMEPAGE;
  }
}

/**
 * Whether a page the dock just brought up should go to the start page: only a blank one. A browser
 * the Bot is using is showing the Bot's page, and the person opening Chrome wants to see that.
 */
export function wantsHomepage(url: string): boolean {
  return url === "about:blank" || url === "";
}

/** What a start page that would not open leaves behind: one line for the log, never an error. */
export type StartPageFailure = {
  type: "computer-start-page-failed";
  homepage: string;
  error: string;
};

/**
 * Send a blank page to the start page; leave a page that is showing anything else alone.
 *
 * Only until the navigation commits, so a window comes forward, or a Bot gets its page, while the
 * start page is still loading. Never throws: a start page is a courtesy, and one that will not load
 * (no network, an egress policy that refuses it) must not fail the launch or the click that asked for
 * a browser. Bounded twice, because a browser that died behind Playwright's back answers nothing,
 * not even its own timeout.
 */
export async function openStartPage(
  page: Pick<Page, "goto" | "url">,
  homepage: string,
  log: (failure: StartPageFailure) => void = (failure) =>
    console.warn(JSON.stringify(failure)),
): Promise<void> {
  if (!wantsHomepage(page.url())) return;
  await within(
    page.goto(homepage, { waitUntil: "commit", timeout: 15_000 }),
    16_000,
    "Opening the start page",
  ).catch((error: unknown) =>
    log({
      type: "computer-start-page-failed",
      homepage,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
}
