import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import {
  DEFAULT_HOMEPAGE,
  homepageFromEnv,
  openStartPage,
  type StartPageFailure,
  wantsHomepage,
  watchBrowserRequests,
  within,
} from "../src/browser-request";
import { BROWSER_REQUEST_FILE } from "../src/desktop";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "openbot-browser-request-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function waitFor(check: () => boolean, budgetMs = 3_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!check() && Date.now() < deadline) await Bun.sleep(20);
}

describe("the dock's Chrome button", () => {
  test("keeps its directory to this user", async () => {
    const dir = join(root, "openbot-desktop");
    const watcher = await watchBrowserRequests(dir, () => undefined);
    try {
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
    } finally {
      watcher.close();
    }
  });

  test("opens the browser once for a burst of clicks, and again for the next click", async () => {
    const dir = join(root, "openbot-desktop");
    let opened = 0;
    const watcher = await watchBrowserRequests(
      dir,
      () => {
        opened++;
      },
      { debounceMs: 50 },
    );
    try {
      const request = join(dir, BROWSER_REQUEST_FILE);
      await writeFile(request, "");
      await writeFile(request, "");
      await waitFor(() => opened > 0);
      await Bun.sleep(200);
      expect(opened).toBe(1);

      await writeFile(request, "");
      await waitFor(() => opened > 1);
      expect(opened).toBe(2);
    } finally {
      watcher.close();
    }
  });

  test("ignores a request left from before it started", async () => {
    const dir = join(root, "openbot-desktop");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, BROWSER_REQUEST_FILE), "");
    let opened = 0;
    const watcher = await watchBrowserRequests(
      dir,
      () => {
        opened++;
      },
      { debounceMs: 20 },
    );
    try {
      await Bun.sleep(200);
      expect(opened).toBe(0);
    } finally {
      watcher.close();
    }
  });
});

test("a request that never finishes does not stop the button answering", async () => {
  const dir = join(root, "openbot-desktop");
  let asked = 0;
  const watcher = await watchBrowserRequests(
    dir,
    () => {
      asked++;
      // The first never settles, like a browser launch that hangs.
      return asked === 1 ? new Promise<void>(() => undefined) : undefined;
    },
    { debounceMs: 20, stallMs: 150 },
  );
  try {
    const request = join(dir, BROWSER_REQUEST_FILE);
    await writeFile(request, "");
    await waitFor(() => asked === 1);
    await Bun.sleep(300);
    await writeFile(request, "");
    await waitFor(() => asked === 2);
    expect(asked).toBe(2);
  } finally {
    watcher.close();
  }
});

test("a click while a browser is opening is answered when it has opened", async () => {
  const dir = join(root, "openbot-desktop");
  let asked = 0;
  let finishFirst: () => void = () => undefined;
  const watcher = await watchBrowserRequests(
    dir,
    () => {
      asked++;
      // The first is a slow launch, still going when the person clicks again.
      return asked === 1
        ? new Promise<void>((resolve) => {
            finishFirst = resolve;
          })
        : undefined;
    },
    { debounceMs: 20 },
  );
  try {
    const request = join(dir, BROWSER_REQUEST_FILE);
    await writeFile(request, "");
    await waitFor(() => asked === 1);
    await writeFile(request, "");
    await Bun.sleep(150);
    expect(asked).toBe(1);

    finishFirst();
    await waitFor(() => asked === 2);
    expect(asked).toBe(2);
  } finally {
    watcher.close();
  }
});

test("a click whose file event never arrives is still answered", async () => {
  const dir = join(root, "openbot-desktop");
  let opened = 0;
  const watcher = await watchBrowserRequests(
    dir,
    () => {
      opened++;
    },
    // No file events at all: every one of them dropped.
    { debounceMs: 20, pollMs: 100, events: false },
  );
  try {
    await writeFile(join(dir, BROWSER_REQUEST_FILE), "");
    await waitFor(() => opened === 1);
    expect(opened).toBe(1);
  } finally {
    watcher.close();
  }
});

describe("the start page", () => {
  test("is Google unless the deployment names another http(s) page", () => {
    expect(homepageFromEnv(undefined)).toBe(DEFAULT_HOMEPAGE);
    expect(homepageFromEnv("  ")).toBe(DEFAULT_HOMEPAGE);
    expect(homepageFromEnv("https://duckduckgo.com")).toBe(
      "https://duckduckgo.com/",
    );
    expect(homepageFromEnv("javascript:alert(1)")).toBe(DEFAULT_HOMEPAGE);
    expect(homepageFromEnv("not a url")).toBe(DEFAULT_HOMEPAGE);
  });

  test("replaces only a blank page, never one the Bot is using", () => {
    expect(wantsHomepage("about:blank")).toBe(true);
    expect(wantsHomepage("")).toBe(true);
    expect(wantsHomepage("https://mail.example.com/inbox")).toBe(false);
  });

  test("asks Google for English, since it answers in the language of the server's country", () => {
    expect(new URL(DEFAULT_HOMEPAGE).hostname).toBe("www.google.com");
    expect(DEFAULT_HOMEPAGE).toContain("hl=en");
    // Read back unchanged, so the Home button and the start page are the same address.
    expect(homepageFromEnv(undefined)).toBe("https://www.google.com/?hl=en");
  });
});

/** A page that records where it was sent and, unless told to fail, goes there. */
function fakePage(start: string, failure?: Error) {
  let url = start;
  const visits: Array<{ target: string; options: unknown }> = [];
  const page: Pick<Page, "goto" | "url"> = {
    url: () => url,
    async goto(target, options) {
      visits.push({ target, options });
      if (failure) throw failure;
      url = target;
      return null;
    },
  };
  return { page, visits };
}

describe("opening the start page", () => {
  test("sends a blank page there once, only until the navigation commits", async () => {
    const { page, visits } = fakePage("about:blank");
    const failures: StartPageFailure[] = [];
    await openStartPage(page, DEFAULT_HOMEPAGE, (failure) =>
      failures.push(failure),
    );
    expect(visits).toEqual([
      {
        target: DEFAULT_HOMEPAGE,
        options: { waitUntil: "commit", timeout: 15_000 },
      },
    ]);
    expect(page.url()).toBe(DEFAULT_HOMEPAGE);
    expect(failures).toEqual([]);

    // Already there, so a second call (the dock after a launch) goes nowhere.
    await openStartPage(page, DEFAULT_HOMEPAGE);
    expect(visits).toHaveLength(1);
  });

  test("leaves a page that is already on a site alone", async () => {
    const { page, visits } = fakePage("https://mail.example.com/inbox");
    await openStartPage(page, DEFAULT_HOMEPAGE);
    expect(visits).toEqual([]);
    expect(page.url()).toBe("https://mail.example.com/inbox");
  });

  test("says so, and does not throw, when the start page will not open", async () => {
    const { page, visits } = fakePage(
      "about:blank",
      new Error("net::ERR_TUNNEL_CONNECTION_FAILED"),
    );
    const failures: StartPageFailure[] = [];
    await expect(
      openStartPage(page, DEFAULT_HOMEPAGE, (failure) =>
        failures.push(failure),
      ),
    ).resolves.toBeUndefined();
    expect(visits).toHaveLength(1);
    expect(failures).toEqual([
      {
        type: "computer-start-page-failed",
        homepage: DEFAULT_HOMEPAGE,
        error: "net::ERR_TUNNEL_CONNECTION_FAILED",
      },
    ]);
  });
});

test("a call into a browser that never answers fails after its budget", async () => {
  const started = Date.now();
  await expect(
    within(new Promise<void>(() => undefined), 50, "Raising the window"),
  ).rejects.toThrow("Raising the window took longer than 50 ms");
  expect(Date.now() - started).toBeLessThan(1_000);
  expect(await within(Promise.resolve(7), 50, "Quick")).toBe(7);
});
