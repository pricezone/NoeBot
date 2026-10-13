import type { Page } from "playwright";
import type { BrowserRuntime } from "./browser-runtime";
import { parseNavigateUrl } from "./request-validation";

type Backend = BrowserRuntime["backend"];
export type PagePurpose = "read" | "navigate";

/** Navigation can leave an unreadable Chrome error/local page, but cannot inspect it. */
export function assertPageAccess(
  backend: Backend,
  url: string,
  purpose: PagePurpose = "read",
): void {
  if (purpose === "navigate") return;
  if (
    backend === "local-chrome" &&
    url !== "about:blank" &&
    !/^https?:\/\//i.test(url)
  ) {
    throw new Error(
      "Local Chrome computer tools can access only web pages. Use the approved host-access tools for local files.",
    );
  }
}

/**
 * Why a site could not be opened, as the Bot should hear it.
 *
 * These are the site's failures, not the computer's: the browser asked and the network or the site
 * said no. Reported as such (`siteError` on the response, a 502 from the computer and a site error
 * at the server) with what to do next, rather than as an unavailable computer, which sent the Bot
 * to wait for a repair that was never coming, or as Chrome's own `net::` code, which it cannot act on.
 */
export type SiteProblem =
  | "dns"
  | "refused"
  | "timeout"
  | "certificate"
  | "network"
  | "blocked"
  | "redirects"
  | "aborted";

export type SiteFailure = Error & {
  name: "SiteError";
  problem: SiteProblem;
  /** Chrome's own code, such as `net::ERR_NAME_NOT_RESOLVED`, for logs and the trail. */
  code: string;
};

const SITE_FAILURES: Array<[RegExp, SiteProblem, string]> = [
  [
    /ERR_NAME_NOT_RESOLVED|ERR_NAME_RESOLUTION_FAILED/,
    "dns",
    "That address does not exist: the site's name could not be found. Check the spelling, or search for the site instead.",
  ],
  [
    /ERR_CONNECTION_REFUSED|ERR_ADDRESS_UNREACHABLE/,
    "refused",
    "The site refused the connection: it is down or not accepting visitors at that address. Try again later, or try another address for it.",
  ],
  [
    /ERR_CONNECTION_TIMED_OUT|ERR_TIMED_OUT/,
    "timeout",
    "The site did not answer in time. It may be down or very slow; try again in a moment, or try another page.",
  ],
  [
    /ERR_CERT_|ERR_SSL_|ERR_BAD_SSL_CLIENT_AUTH_CERT|SSL_PROTOCOL_ERROR/,
    "certificate",
    "The site's security certificate is not valid, so the browser refused to open it. Do not try to get around this; tell the person.",
  ],
  [
    /ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED|ERR_BLOCKED_BY_CLIENT|ERR_BLOCKED_BY_ADMINISTRATOR/,
    "blocked",
    "The connection to that site was refused on the way out: this computer's network rules may not allow it, or the site cannot be reached from here. Tell the person rather than retrying.",
  ],
  [
    /ERR_UNSAFE_PORT/,
    "blocked",
    "The browser will not open that port: it is reserved for other services and refused for safety. Check the address.",
  ],
  [
    /ERR_TOO_MANY_REDIRECTS/,
    "redirects",
    "The site keeps redirecting in a loop, so the page never arrives. Try its home page instead.",
  ],
  [
    /ERR_ABORTED|Download is starting/,
    "aborted",
    "The page was cancelled before it loaded, usually because the address is a file download rather than a page.",
  ],
  [
    /ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_EMPTY_RESPONSE|ERR_HTTP2_|ERR_QUIC_|ERR_NETWORK_|ERR_CONNECTION_FAILED/,
    "network",
    "The connection to the site broke off. Try again in a moment.",
  ],
];

/** The site failure a navigation error describes, or undefined for anything else. */
export function siteFailureOf(error: unknown): SiteFailure | undefined {
  const message = error instanceof Error ? error.message : String(error);
  for (const [pattern, problem, hint] of SITE_FAILURES) {
    if (!pattern.test(message)) continue;
    const code =
      message.match(/net::ERR_[A-Z0-9_]+/)?.[0] ??
      (problem === "aborted" ? "download" : problem);
    return Object.assign(new Error(`${hint} (${code})`), {
      name: "SiteError" as const,
      problem,
      code,
    });
  }
  return undefined;
}

export function isSiteFailure(error: unknown): error is SiteFailure {
  return error instanceof Error && error.name === "SiteError";
}

/** What navigating needs of a page, so a test can stand in for one. */
export type NavigablePage = Pick<Page, "goto" | "url"> &
  Partial<Pick<Page, "waitForLoadState">>;

/**
 * How long a navigation waits for the document once the site has answered.
 *
 * The answer arriving (commit) is what proves the site is there; after that, parser-blocking
 * scripts on a slow host can hold DOMContentLoaded back for as long as they like, and a page that
 * is on screen is better read now than waited thirty seconds for. Past this the page is handed back
 * as it is, marked loading.
 */
export const DOCUMENT_WAIT_MS = 10_000;

/**
 * Validate the destination before goto and the resulting page before callers read its content.
 *
 * Two waits, not one. The navigation waits only for the site to answer (`commit`), up to the full
 * deadline; then for the document, up to {@link DOCUMENT_WAIT_MS}. A document still loading after
 * that is answered as `stillLoading` rather than thrown: thrown, the Bot was told the navigation
 * failed, navigated again into the same wait, and a turn spent minutes on one slow page. A site
 * that never answered at all, or that the network refused, is still a failure, as a site error with
 * a hint where Chrome said why.
 */
/**
 * How long the first attempt waits for the site to answer before a second attempt is made.
 *
 * Measured on a subscriber's server: a site behind several anycast addresses answered in under two
 * seconds on one connection and not at all within thirty on another, and the very next attempt was
 * answered at once. One connection that never answers is usually one bad route, not a dead site, so
 * after this the navigation is started again on a fresh connection, within the same overall deadline.
 */
export const FIRST_ANSWER_MS = 12_000;

function isTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

function seconds(ms: number): string {
  const n = Math.max(1, Math.round(ms / 1000));
  return `${n} second${n === 1 ? "" : "s"}`;
}

/** A navigation nobody answered, as a site error with what to do, never Playwright's own words. */
function noAnswer(timeoutMs: number): SiteFailure {
  return Object.assign(
    new Error(
      `The site did not answer within ${seconds(timeoutMs)}, even on a second try. It may be down or very slow; try again in a moment, or try another page. (timeout)`,
    ),
    {
      name: "SiteError" as const,
      problem: "timeout" as const,
      code: "timeout",
    },
  );
}

export async function navigateWebPage(
  page: NavigablePage,
  url: string,
  backend: Backend,
  timeoutMs: number,
  {
    documentWaitMs = DOCUMENT_WAIT_MS,
    firstAnswerMs = FIRST_ANSWER_MS,
  }: { documentWaitMs?: number; firstAnswerMs?: number } = {},
): Promise<{
  response: Awaited<ReturnType<Page["goto"]>>;
  stillLoading: boolean;
}> {
  const parsed = parseNavigateUrl(url);
  if (!parsed.ok) throw new Error(parsed.error);
  const before = page.url();
  const started = Date.now();
  let response: Awaited<ReturnType<Page["goto"]>> = null;
  let stillLoading = false;
  const go = (timeout: number) =>
    page.goto(parsed.url, { waitUntil: "commit", timeout });
  try {
    try {
      response = await go(Math.min(firstAnswerMs, timeoutMs));
    } catch (first) {
      const left = timeoutMs - (Date.now() - started);
      // Nothing arrived on that connection: start again on a fresh one, within the same deadline.
      if (!isTimeout(first) || page.url() !== before || left < 1_000)
        throw first;
      response = await go(left);
    }
  } catch (error) {
    const arrived = page.url();
    if (
      error instanceof Error &&
      error.name === "TimeoutError" &&
      arrived !== before &&
      /^https?:\/\//i.test(arrived)
    ) {
      stillLoading = true;
    } else {
      throw (
        siteFailureOf(error) ?? (isTimeout(error) ? noAnswer(timeoutMs) : error)
      );
    }
  }
  if (!stillLoading && page.waitForLoadState) {
    try {
      await page.waitForLoadState("domcontentloaded", {
        timeout: documentWaitMs,
      });
    } catch (error) {
      // A timeout is a slow page, answered as one. Anything else (the page navigated on again, or a
      // script closed it) leaves whatever is there now for the caller to read.
      if (error instanceof Error && error.name === "TimeoutError")
        stillLoading = true;
    }
  }
  assertPageAccess(backend, page.url());
  return { response, stillLoading };
}
