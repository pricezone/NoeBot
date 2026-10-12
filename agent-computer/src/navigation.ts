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
 * Validate the destination before goto and the resulting page before callers read its content.
 *
 * A page that arrived but is still loading when the deadline passes is answered as `stillLoading`
 * rather than thrown. Parser-blocking scripts hold `DOMContentLoaded` back for as long as their host
 * takes, and a slow analytics host is enough to miss a 30-second deadline on a page that is otherwise
 * on screen and usable. Thrown, that timeout reached the Bot as a failure, the Bot navigated again
 * into the same wait, and a turn spent minutes on one page. Only when the browser actually moved to
 * a web page, though: a deadline missed before anything arrived is still a failed navigation.
 */
export async function navigateWebPage(
  page: Pick<Page, "goto" | "url">,
  url: string,
  backend: Backend,
  timeoutMs: number,
): Promise<{
  response: Awaited<ReturnType<Page["goto"]>>;
  stillLoading: boolean;
}> {
  const parsed = parseNavigateUrl(url);
  if (!parsed.ok) throw new Error(parsed.error);
  const before = page.url();
  let response: Awaited<ReturnType<Page["goto"]>> = null;
  let stillLoading = false;
  try {
    response = await page.goto(parsed.url, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });
  } catch (error) {
    const arrived = page.url();
    if (
      !(error instanceof Error && error.name === "TimeoutError") ||
      arrived === before ||
      !/^https?:\/\//i.test(arrived)
    )
      throw error;
    stillLoading = true;
  }
  assertPageAccess(backend, page.url());
  return { response, stillLoading };
}
