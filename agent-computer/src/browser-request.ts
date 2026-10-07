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
  }: { debounceMs?: number; stallMs?: number } = {},
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

  let watcher: FSWatcher;
  try {
    watcher = watch(dir, (_event, filename) => {
      if (filename && String(filename) !== BROWSER_REQUEST_FILE) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void handle(), debounceMs);
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        type: "computer-desktop-browser-request-unwatched",
        dir,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return { close: () => undefined };
  }
  watcher.on("error", () => undefined);

  return {
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      watcher.close();
    },
  };
}

/**
 * Bring a browser window to the front, restoring it first if it was minimized.
 *
 * `bringToFront` activates the tab and asks the window manager for the window, which raises one that
 * is merely behind another; a minimized window has to be restored first, through the DevTools
 * protocol, since the desktop gives the computer no other handle on it.
 */
export async function raiseBrowserWindow(page: Page): Promise<void> {
  const client = await page.context().newCDPSession(page);
  try {
    const { windowId, bounds } = await client.send(
      "Browser.getWindowForTarget",
    );
    if (bounds.windowState === "minimized") {
      await client.send("Browser.setWindowBounds", {
        windowId,
        bounds: { windowState: "normal" },
      });
    }
  } finally {
    await client.detach().catch(() => undefined);
  }
  await page.bringToFront();
}
