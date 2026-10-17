/**
 * The tabs a Bot had open when its browser was put away, and opening them again.
 *
 * A browser nobody has touched for a while is closed (the idle sweep), and so is the least recently
 * used one when too many are running (the cap). Closing loses no sign-ins: those are in the profile
 * and in `session-cookies.ts`. It did lose the pages. The next launch opened on the start page, so a
 * Bot that had three tabs open on a supplier's portal came back to Google, and the person who opened
 * its screen after lunch saw a different computer from the one they left. A computer should resume
 * where it left off; this is that half.
 *
 * So the addresses of the open tabs are written beside the profile when one of those closes takes the
 * browser, and the next launch opens them instead of the start page. Only web pages (http and
 * https), at most ten, never a username or password written into an address. The file is taken when
 * it is read, so a page that brings the browser down cannot do it on every launch after.
 *
 * WHERE IT LIVES IS THE ISOLATION AND THE RESET, as for the session cookies: inside the Bot's own
 * profile directory, 0600, so no other Bot's launch reads it and a reset deletes it with the logins.
 *
 * Imports Playwright's types only, so the rules here are testable without a browser installed.
 */

import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "playwright";
import { within } from "./browser-request";

/** In the profile directory, beside the session cookies. */
export const SAVED_TABS_FILE = "openbot-open-tabs.json";

/** How many tabs come back. A Bot with forty open is better served by the ten it used last. */
export const MAX_SAVED_TABS = 10;

/** How long reopening one tab may take before the launch carries on without it. */
const REOPEN_TIMEOUT_MS = 15_000;

/**
 * The address worth reopening, or null.
 *
 * Only a web page: `about:blank`, a `chrome://` page and Chrome's own error page are not somewhere a
 * Bot went, and a `file:` or `data:` address is not one to replay. Credentials written into the
 * address are dropped rather than stored.
 */
export function reopenableUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  url.username = "";
  url.password = "";
  return url.href;
}

/**
 * The tabs to keep, in the order to open them again.
 *
 * The page the Bot was on goes last, because the newest open page is the live one
 * (`chooseLivePage`), so reopening in this order puts the Bot back on the page it left. One copy of
 * each address, and the newest {@link MAX_SAVED_TABS} when there are more, which always includes
 * that page.
 */
export function tabsToSave(
  open: readonly string[],
  current?: string,
): string[] {
  const live = current === undefined ? null : reopenableUrl(current);
  const others = open
    .map(reopenableUrl)
    .filter((url): url is string => url !== null && url !== live);
  const ordered = [...new Set(others), ...(live ? [live] : [])];
  return ordered.slice(-MAX_SAVED_TABS);
}

/** What the file holds. */
export function serialiseSavedTabs(tabs: readonly string[]): string {
  return JSON.stringify({ version: 1, tabs });
}

/** The tabs a file names, checked again: it is on a volume, and a file can be edited by hand. */
export function parseSavedTabs(raw: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const tabs =
    parsed && typeof parsed === "object" && "tabs" in parsed
      ? (parsed as { tabs?: unknown }).tabs
      : undefined;
  if (!Array.isArray(tabs)) return [];
  return tabsToSave(
    tabs.filter((tab): tab is string => typeof tab === "string"),
  );
}

/**
 * Write the list, or remove it when there is nothing to keep.
 *
 * Beside the file and renamed over it, so a pod killed mid-write leaves no half of one; 0600 again
 * after the rename, which keeps the temporary file's permissions.
 */
export async function saveTabs(
  profileDir: string,
  tabs: readonly string[],
): Promise<void> {
  const file = join(profileDir, SAVED_TABS_FILE);
  if (tabs.length === 0) {
    await rm(file, { force: true });
    return;
  }
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, serialiseSavedTabs(tabs), { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * The saved tabs, removed as they are read. None when there is no file or it cannot be read.
 *
 * Taken rather than read, because the list is for one launch: a later launch after this one has its
 * own tabs or none, and a list left behind would reopen pages the Bot had long since closed.
 */
export async function takeSavedTabs(profileDir: string): Promise<string[]> {
  const file = join(profileDir, SAVED_TABS_FILE);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return [];
  }
  await rm(file, { force: true }).catch(() => undefined);
  return parseSavedTabs(raw);
}

/** What a tab that would not open leaves behind: one line for the log, never an error. */
export type TabNotReopened = {
  type: "computer-tab-not-reopened";
  url: string;
  error: string;
};

/** Enough of a page to open an address in it. */
export type ReopeningPage = Pick<Page, "goto"> &
  Partial<Pick<Page, "waitForURL">>;

/**
 * Open the saved tabs: the first in the page the launch opened with, the rest in new tabs, in order.
 *
 * Only until each navigation commits, like the start page, so a slow site does not hold the launch
 * for its whole load. Never throws: a tab that will not open (the site is down, the network policy
 * now refuses it) is logged and left on its error page, and the others still open. The policy has
 * not been stepped around: every one of these requests goes through the same egress filter as the
 * Bot's own. Answers how many committed.
 */
export async function reopenTabs<P extends ReopeningPage>(
  context: { newPage(): Promise<P> },
  first: P,
  tabs: readonly string[],
  log: (failure: TabNotReopened) => void = (failure) =>
    console.warn(JSON.stringify(failure)),
): Promise<number> {
  const pages: P[] = [];
  for (let index = 0; index < tabs.length; index += 1) {
    pages.push(index === 0 ? first : await context.newPage());
  }
  const opened = await Promise.all(
    pages.map(async (page, index) => {
      const url = tabs[index] ?? "";
      try {
        await within(
          page.goto(url, { waitUntil: "commit", timeout: REOPEN_TIMEOUT_MS }),
          REOPEN_TIMEOUT_MS + 1_000,
          "Reopening a tab",
        );
        return true;
      } catch (error) {
        log({
          type: "computer-tab-not-reopened",
          url,
          error: error instanceof Error ? error.message : String(error),
        });
        // The error page Chromium commits a moment later is a navigation too; let it in now, as the
        // start page does, so it cannot cut short the first page the Bot opens next.
        await page
          .waitForURL?.((next) => next.protocol === "chrome-error:", {
            waitUntil: "commit",
            timeout: 2_000,
          })
          .catch(() => undefined);
        return false;
      }
    }),
  );
  return opened.filter(Boolean).length;
}
