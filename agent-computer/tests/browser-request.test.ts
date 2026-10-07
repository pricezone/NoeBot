import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchBrowserRequests } from "../src/browser-request";
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
