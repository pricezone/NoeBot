import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import type { Page } from "playwright";

/**
 * Asked for by name, like follows-popup.test.ts: it launches a real Chromium.
 *
 *   cd agent-computer && bunx playwright install chromium
 *   OPENBOT_COMPUTER_BROWSER=1 bun test tests/front-page.test.ts
 */
const asked = process.env.OPENBOT_COMPUTER_BROWSER === "1";
const LAUNCH_TIMEOUT_MS = 120_000;

const html = (title: string, body: string) =>
  new Response(`<!doctype html><title>${title}</title><body>${body}</body>`, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });

const site = Bun.serve({
  port: 0,
  fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === "/visited") return html("VISITED", "<p>the site</p>");
    return html(
      "OPENER",
      `<a id="blank" href="/visited" target="_blank">open the site</a>`,
    );
  },
});
const origin = `http://127.0.0.1:${site.port}`;

afterAll(() => {
  site.stop(true);
});

async function settle(read: () => Promise<string>, wanted: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if ((await read()).includes(wanted)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Which browser window a page is in, as Chromium numbers them. */
async function windowOf(page: Page): Promise<number> {
  const client = await page.context().newCDPSession(page);
  try {
    return (await client.send("Browser.getWindowForTarget")).windowId;
  } finally {
    await client.detach().catch(() => undefined);
  }
}

describe.skipIf(!asked)("the page a Bot is on, in front", () => {
  test(
    "a page opened with target=_blank becomes the live page, a tab of the same window, brought to the front",
    async () => {
      const { createProfiles } = await import("../src/profiles");
      const root = await mkdtemp(join(tmpdir(), "openbot-profiles-"));
      const profiles = createProfiles(root);
      const bot = "front-test";
      const url = async () => (await profiles.page(bot)).url();

      const opener = await profiles.page(bot);
      /*
       * Every page Playwright drives reports itself visible and focused, front or not: it turns on
       * DevTools focus emulation for each one, and that keeps a background tab rendering as if shown.
       * So whether a page was put in front is read from the call that puts it there, on the real page
       * objects this browser hands out, rather than from the page's own idea of its visibility.
       */
      const prototype = Object.getPrototypeOf(opener) as {
        bringToFront: (this: Page) => Promise<void>;
      };
      const bringToFront = prototype.bringToFront;
      const fronted: Page[] = [];
      prototype.bringToFront = function (this: Page) {
        fronted.push(this);
        return bringToFront.call(this);
      };
      try {
        await opener.goto(`${origin}/opener`, {
          waitUntil: "domcontentloaded",
        });

        await opener.click("#blank");
        await settle(url, "/visited");
        const visited = await profiles.page(bot);
        expect(visited.url()).toContain("/visited");
        expect(visited).not.toBe(opener);
        // The defect: it opened, and nothing brought it in front of the window the person watched.
        expect(fronted.at(-1)).toBe(visited);
        // A tab of the window the person is already watching, not a second window behind it.
        expect(await windowOf(visited)).toBe(await windowOf(opener));
        expect(
          await visited.evaluate(() => ({
            visibility: document.visibilityState,
            focused: document.hasFocus(),
          })),
        ).toEqual({ visibility: "visible", focused: true });

        // Closing it puts the page it falls back to in front again.
        await visited.close();
        await settle(url, "/opener");
        expect(await url()).toContain("/opener");
        expect(fronted.at(-1)).toBe(opener);

        // So does switching to a tab that is already the live one (`computer_tabs` switch).
        const before = fronted.length;
        await profiles.activate(bot, opener);
        expect(fronted.length).toBe(before + 1);
        expect(fronted.at(-1)).toBe(opener);
      } finally {
        prototype.bringToFront = bringToFront;
        await profiles.stop(bot).catch(() => undefined);
        await rm(root, { recursive: true, force: true }).catch(() => undefined);
      }
    },
    LAUNCH_TIMEOUT_MS,
  );
});
