import { expect, test } from "bun:test";
import type { Page } from "playwright";
import {
  assertPageAccess,
  isSiteFailure,
  type NavigablePage,
  navigateWebPage,
  type SiteFailure,
  siteFailureOf,
} from "../src/navigation";

function fixture() {
  let url = "https://example.com/";
  let failure = true;
  const visited: string[] = [];
  const page: Pick<Page, "goto" | "url"> = {
    url: () => url,
    async goto(target) {
      visited.push(target);
      if (failure) {
        failure = false;
        url = "chrome-error://chromewebdata/";
        throw new Error("net::ERR_CONNECTION_REFUSED");
      }
      url = target;
      return null;
    },
  };
  return { page, visited };
}

test("a failed navigation can recover from Chrome's internal error page without exposing it", async () => {
  const { page, visited } = fixture();
  await expect(
    navigateWebPage(page, "http://127.0.0.1:64110/", "local-chrome", 1000),
  ).rejects.toThrow("ERR_CONNECTION_REFUSED");
  expect(() => assertPageAccess("local-chrome", page.url())).toThrow(
    /only web pages/,
  );
  assertPageAccess("local-chrome", page.url(), "navigate");
  await navigateWebPage(
    page,
    "https://example.com/recovered",
    "local-chrome",
    1000,
  );
  expect(visited).toEqual([
    "http://127.0.0.1:64110/",
    "https://example.com/recovered",
  ]);
  expect(() => assertPageAccess("local-chrome", page.url())).not.toThrow();
});

test("navigation never accepts file/chrome targets or returns a nonweb redirect result", async () => {
  const { page, visited } = fixture();
  for (const url of [
    "file:///etc/passwd",
    "chrome://settings",
    "javascript:alert(1)",
  ]) {
    expect(() => assertPageAccess("local-chrome", url)).toThrow();
    await expect(
      navigateWebPage(page, url, "local-chrome", 1000),
    ).rejects.toThrow();
  }
  expect(visited).toHaveLength(0);
  const redirected: Pick<Page, "goto" | "url"> = {
    goto: async () => null,
    url: () => "file:///private/secret",
  };
  await expect(
    navigateWebPage(
      redirected,
      "https://example.com/redirect",
      "local-chrome",
      1000,
    ),
  ).rejects.toThrow(/only web pages/);
  expect(() => assertPageAccess("local-chrome", "about:blank")).not.toThrow();
});

/**
 * A page that arrived but is still loading when the deadline passes.
 *
 * A parser-blocking script on a slow host holds DOMContentLoaded back past the deadline while the
 * page itself is on screen. Thrown, the Bot was told the navigation failed and opened the page again
 * into the same wait. Answered as still loading, it reads what is there.
 */
function timingOut(arrives: boolean) {
  let url = "https://example.com/";
  const page: Pick<Page, "goto" | "url"> = {
    url: () => url,
    async goto(target) {
      if (arrives) url = target;
      const error = new Error("page.goto: Timeout 30000ms exceeded.");
      error.name = "TimeoutError";
      throw error;
    },
  };
  return page;
}

test("a page that arrived but is still loading is answered, not thrown", async () => {
  const result = await navigateWebPage(
    timingOut(true),
    "https://slow.example/login",
    "managed",
    1000,
  );
  expect(result).toEqual({ response: null, stillLoading: true });
});

test("a deadline missed before anything arrived is still a failed navigation", async () => {
  await expect(
    navigateWebPage(
      timingOut(false),
      "https://slow.example/login",
      "managed",
      1000,
    ),
  ).rejects.toThrow("The site did not answer within 1 second");
});

test("a navigation that loads in time says it is not still loading", async () => {
  const page: Pick<Page, "goto" | "url"> = {
    url: () => "https://example.com/done",
    goto: async () => null,
  };
  expect(
    await navigateWebPage(page, "https://example.com/done", "managed", 1000),
  ).toEqual({ response: null, stillLoading: false });
});

/** What the site said, as a site error with a hint: not Chrome's code and not a broken computer. */
test("network failures become site errors that say what to do", async () => {
  const failing = (message: string): NavigablePage => ({
    url: () => "about:blank",
    goto: async () => {
      throw new Error(
        `page.goto: ${message} at https://x.test/\nCall log:\n  - navigating`,
      );
    },
  });
  const cases: Array<[string, string]> = [
    ["net::ERR_NAME_NOT_RESOLVED", "dns"],
    ["net::ERR_CONNECTION_REFUSED", "refused"],
    ["net::ERR_CONNECTION_TIMED_OUT", "timeout"],
    ["net::ERR_CERT_AUTHORITY_INVALID", "certificate"],
    ["net::ERR_SSL_PROTOCOL_ERROR", "certificate"],
    ["net::ERR_TUNNEL_CONNECTION_FAILED", "blocked"],
    ["net::ERR_ABORTED", "aborted"],
    ["Download is starting", "aborted"],
    ["net::ERR_CONNECTION_RESET", "network"],
  ];
  for (const [message, problem] of cases) {
    let thrown: unknown;
    try {
      await navigateWebPage(
        failing(message),
        "https://x.test/",
        "managed",
        1000,
      );
    } catch (error) {
      thrown = error;
    }
    expect(isSiteFailure(thrown)).toBe(true);
    if (!isSiteFailure(thrown)) continue;
    expect(thrown.problem).toBe(problem as SiteFailure["problem"]);
    expect(thrown.message).not.toContain("Call log");
  }
  expect(siteFailureOf(new Error("Something else entirely"))).toBeUndefined();
});

test("the navigation waits for the site to answer, then a bounded time for the document", async () => {
  const waits: Array<{ state: string; timeout?: number }> = [];
  let waitUntil: string | undefined;
  const page: NavigablePage = {
    url: () => "https://slow.example/",
    goto: async (_url, options) => {
      waitUntil = options?.waitUntil;
      return null;
    },
    waitForLoadState: async (state, options) => {
      waits.push({ state: String(state), timeout: options?.timeout });
      const error = new Error("Timeout exceeded");
      error.name = "TimeoutError";
      throw error;
    },
  };
  const result = await navigateWebPage(
    page,
    "https://slow.example/",
    "managed",
    30_000,
    { documentWaitMs: 500 },
  );
  expect(waitUntil).toBe("commit");
  expect(waits).toEqual([{ state: "domcontentloaded", timeout: 500 }]);
  expect(result.stillLoading).toBe(true);
});

/** A page whose first `goto` never hears back, and whose later ones answer at once. */
function hangsOnce(hangs = 1) {
  let url = "about:blank";
  const timeouts: number[] = [];
  const page: Pick<Page, "goto" | "url"> = {
    url: () => url,
    goto: async (target, options) => {
      timeouts.push(options?.timeout ?? 0);
      if (timeouts.length <= hangs) {
        throw Object.assign(new Error("page.goto: Timeout exceeded."), {
          name: "TimeoutError",
        });
      }
      url = target;
      return null;
    },
  };
  return { page, timeouts };
}

test("a connection that never answers is tried again on a fresh one, within the same deadline", async () => {
  const { page, timeouts } = hangsOnce();

  const result = await navigateWebPage(
    page,
    "https://example.com/slow-route",
    "local-chrome",
    30_000,
    { firstAnswerMs: 50 },
  );

  expect(result.stillLoading).toBe(false);
  expect(page.url()).toBe("https://example.com/slow-route");
  expect(timeouts[0]).toBe(50);
  expect(timeouts).toHaveLength(2);
  // The second try gets what is left of the deadline, never more.
  expect(timeouts[1]).toBeLessThanOrEqual(30_000);
  expect(timeouts[1]).toBeGreaterThan(29_000);
});

test("a site that answers neither try is a site error in words, not Playwright's", async () => {
  const { page } = hangsOnce(2);

  const failure = await navigateWebPage(
    page,
    "https://example.com/down",
    "local-chrome",
    30_000,
    { firstAnswerMs: 50 },
  ).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).name).toBe("SiteError");
  expect((failure as Error).message).toContain(
    "did not answer within 30 seconds",
  );
  expect((failure as Error).message).not.toContain("page.goto");
});
