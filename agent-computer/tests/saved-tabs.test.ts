import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_SAVED_TABS,
  parseSavedTabs,
  reopenableUrl,
  reopenTabs,
  SAVED_TABS_FILE,
  saveTabs,
  serialiseSavedTabs,
  tabsToSave,
  takeSavedTabs,
} from "../src/saved-tabs";

/**
 * A Bot's browser closed for being idle, or by the cap, comes back with the tabs it had.
 *
 * A Bot's computer should keep its pages across sleep and resume where it left off. The sign-ins
 * already survived a close; the pages did not, and a Bot that was three tabs into a supplier's
 * portal came back to the start page. These pin which tabs are kept, in what order, and that the
 * list is used once.
 *
 * The rules run everywhere. The browser half drives `createProfiles` itself, because nothing asks
 * this process for an idle close, and is asked for by name like session-cookies.test.ts, because it
 * launches a real Chromium the machine running `bun test` is not required to have:
 *
 *   cd agent-computer && bunx playwright install chromium
 *   OPENBOT_COMPUTER_BROWSER=1 bun test tests/saved-tabs.test.ts
 */
const asked = process.env.OPENBOT_COMPUTER_BROWSER === "1";
const LAUNCH_TIMEOUT_MS = 120_000;

const directories: string[] = [];
afterEach(async () => {
  for (const dir of directories.splice(0))
    await rm(dir, { recursive: true, force: true });
});

async function profile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "saved-tabs-"));
  directories.push(dir);
  return dir;
}

describe("which tabs are kept", () => {
  test("web pages only: no blank page, browser page, error page or local file", () => {
    expect(reopenableUrl("https://example.com/a")).toBe(
      "https://example.com/a",
    );
    expect(reopenableUrl("http://example.com/")).toBe("http://example.com/");
    for (const url of [
      "about:blank",
      "chrome://settings",
      "chrome-error://chromewebdata/",
      "file:///etc/passwd",
      "data:text/html,hi",
      "javascript:alert(1)",
      "",
      "not a url",
    ]) {
      expect(reopenableUrl(url)).toBeNull();
    }
  });

  test("a username or password written into an address is not stored", () => {
    expect(reopenableUrl("https://ann:hunter2@example.com/inbox")).toBe(
      "https://example.com/inbox",
    );
  });

  test("the page the Bot was on goes last, so reopening in order leaves it the live one", () => {
    expect(
      tabsToSave(
        ["https://a.example/", "https://b.example/", "https://c.example/"],
        "https://b.example/",
      ),
    ).toEqual([
      "https://a.example/",
      "https://c.example/",
      "https://b.example/",
    ]);
  });

  test("one copy of each address, and blank tabs dropped", () => {
    expect(
      tabsToSave([
        "https://a.example/",
        "about:blank",
        "https://a.example/",
        "https://b.example/",
      ]),
    ).toEqual(["https://a.example/", "https://b.example/"]);
  });

  test("at most ten, the newest, which always includes the Bot's own page", () => {
    const open = Array.from(
      { length: 14 },
      (_, index) => `https://site${index}.example/`,
    );
    const kept = tabsToSave(open, "https://site0.example/");
    expect(kept).toHaveLength(MAX_SAVED_TABS);
    expect(kept.at(-1)).toBe("https://site0.example/");
    expect(kept).not.toContain("https://site1.example/");
    expect(kept).toContain("https://site13.example/");
  });

  test("a file edited by hand is checked again on the way in", () => {
    expect(
      parseSavedTabs(
        JSON.stringify({
          version: 1,
          tabs: ["https://a.example/", "file:///etc/shadow", 7, null],
        }),
      ),
    ).toEqual(["https://a.example/"]);
    expect(parseSavedTabs("{not json")).toEqual([]);
    expect(parseSavedTabs(JSON.stringify({ tabs: "nope" }))).toEqual([]);
    expect(parseSavedTabs(serialiseSavedTabs(["https://b.example/"]))).toEqual([
      "https://b.example/",
    ]);
  });
});

describe("the list beside the profile", () => {
  test("is written 0600 and taken, once, by the next launch", async () => {
    const dir = await profile();
    await saveTabs(dir, ["https://a.example/", "https://b.example/"]);

    const file = join(dir, SAVED_TABS_FILE);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      version: 1,
      tabs: ["https://a.example/", "https://b.example/"],
    });

    expect(await takeSavedTabs(dir)).toEqual([
      "https://a.example/",
      "https://b.example/",
    ]);
    // Taken: the launch after this one has its own tabs, or the start page.
    expect(await takeSavedTabs(dir)).toEqual([]);
    expect(await stat(file).catch(() => null)).toBeNull();
  });

  test("nothing to keep removes an older list rather than leaving it to reopen", async () => {
    const dir = await profile();
    await saveTabs(dir, ["https://old.example/"]);
    await saveTabs(dir, []);
    expect(await takeSavedTabs(dir)).toEqual([]);
  });

  test("no file, or a broken one, is no tabs and the start page", async () => {
    const dir = await profile();
    expect(await takeSavedTabs(dir)).toEqual([]);
    await writeFile(join(dir, SAVED_TABS_FILE), "garbage");
    expect(await takeSavedTabs(dir)).toEqual([]);
  });
});

/** A page that records where it was sent, and fails for the addresses it is told to. */
function fakePage(failing: Set<string> = new Set()) {
  const page = {
    visited: [] as string[],
    async goto(url: string) {
      if (failing.has(url)) throw new Error("net::ERR_PROXY_CONNECTION_FAILED");
      page.visited.push(url);
      return null;
    },
    async waitForURL() {},
  };
  return page;
}

describe("opening them again", () => {
  test("the first in the launch's own page, the rest in new tabs, in order", async () => {
    const first = fakePage();
    const created: ReturnType<typeof fakePage>[] = [];
    const context = {
      async newPage() {
        const page = fakePage();
        created.push(page);
        return page;
      },
    };

    const opened = await reopenTabs(context, first, [
      "https://a.example/",
      "https://b.example/",
      "https://c.example/",
    ]);

    expect(opened).toBe(3);
    expect(first.visited).toEqual(["https://a.example/"]);
    expect(created.map((page) => page.visited)).toEqual([
      ["https://b.example/"],
      ["https://c.example/"],
    ]);
  });

  test("a tab that will not open is logged and the others still open", async () => {
    const failures: unknown[] = [];
    const failing = new Set(["https://down.example/"]);
    const first = fakePage(failing);
    const context = { newPage: async () => fakePage(failing) };

    const opened = await reopenTabs(
      context,
      first,
      ["https://down.example/", "https://up.example/"],
      (failure) => failures.push(failure),
    );

    expect(opened).toBe(1);
    expect(failures).toEqual([
      {
        type: "computer-tab-not-reopened",
        url: "https://down.example/",
        error: "net::ERR_PROXY_CONNECTION_FAILED",
      },
    ]);
  });
});

const site = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const { pathname } = new URL(request.url);
    return new Response(
      `<!doctype html><title>${pathname}</title><p>${pathname}</p>`,
      { headers: { "content-type": "text/html" } },
    );
  },
});
const origin = `http://127.0.0.1:${site.port}`;

afterAll(() => {
  site.stop(true);
});

describe.skipIf(!asked)("a real browser closed while idle", () => {
  test(
    "the idle sweep writes its tabs down and the next launch opens them, the Bot's page live; a stop does not",
    async () => {
      // Both read when `profiles.ts` loads, so this imports its own copy and puts them back after.
      const before = {
        idle: process.env.COMPUTER_BROWSER_IDLE_MS,
        home: process.env.COMPUTER_DESKTOP_HOMEPAGE,
      };
      process.env.COMPUTER_BROWSER_IDLE_MS = "1";
      process.env.COMPUTER_DESKTOP_HOMEPAGE = `${origin}/home`;
      const root = await mkdtemp(join(tmpdir(), "openbot-tabs-"));
      const bot = "saved-tabs-test";
      try {
        const { createProfiles } = (await import(
          `../src/profiles?tabs=${Date.now()}`
        )) as typeof import("../src/profiles");
        const profiles = createProfiles(root, () => undefined);
        try {
          const first = await profiles.page(bot);
          expect(first.url()).toBe(`${origin}/home`);
          await first.goto(`${origin}/inbox`);
          const second = await first.context().newPage();
          await second.goto(`${origin}/invoices`);
          // The newest page is the Bot's.
          expect((await profiles.page(bot)).url()).toBe(`${origin}/invoices`);

          // Past the timeout, so the sweep closes it.
          await new Promise((resolve) => setTimeout(resolve, 25));
          await profiles.sweepIdleNow();
          expect(profiles.liveCount()).toBe(0);
          expect(
            JSON.parse(
              await readFile(join(root, bot, SAVED_TABS_FILE), "utf8"),
            ),
          ).toEqual({
            version: 1,
            tabs: [`${origin}/inbox`, `${origin}/invoices`],
          });

          // The next launch opens them instead of the start page, and the list is gone.
          const woken = await profiles.page(bot);
          expect(woken.url()).toBe(`${origin}/invoices`);
          expect(
            woken
              .context()
              .pages()
              .map((page) => page.url()),
          ).toEqual([`${origin}/inbox`, `${origin}/invoices`]);
          expect(
            await stat(join(root, bot, SAVED_TABS_FILE)).catch(() => null),
          ).toBeNull();

          // A stop is somebody asking for the browser to go: nothing is written, and the next
          // launch is the start page.
          await profiles.stop(bot);
          expect(
            await stat(join(root, bot, SAVED_TABS_FILE)).catch(() => null),
          ).toBeNull();
          expect((await profiles.page(bot)).url()).toBe(`${origin}/home`);
        } finally {
          await profiles.closeAll();
        }
      } finally {
        for (const [name, value] of [
          ["COMPUTER_BROWSER_IDLE_MS", before.idle],
          ["COMPUTER_DESKTOP_HOMEPAGE", before.home],
        ] as const) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
        await rm(root, { recursive: true, force: true }).catch(() => undefined);
      }
    },
    LAUNCH_TIMEOUT_MS,
  );
});
