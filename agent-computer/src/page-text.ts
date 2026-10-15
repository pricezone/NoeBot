/**
 * Reading a page: its text the way a person sees it, and hints for the snapshot.
 *
 * Out of `index.ts` so a real-browser test can call exactly what the computer calls (that file
 * launches a browser as it is imported).
 */
import type { Frame, Page } from "playwright";
import { cutAtCodeUnits } from "./aria-snapshot";
import { SENSITIVE_FIELD_SELECTOR } from "./secret-masking";

/** How long one frame may take to hand over its text before it is left out. */
const FRAME_TEXT_MS = 1_500;
/** How many frames are read, and how much of each, so an ad-heavy page cannot flood the extract. */
const FRAME_LIMIT = 10;
const FRAME_TEXT_LIMIT = 3_000;

/**
 * One document's visible text, its open shadow roots included. Runs in the page.
 *
 * `innerText` leaves out what is not rendered (scripts, styles, hidden sections) but stops at a
 * shadow root, and web components put whole forms behind one; their text is added after. The text of
 * anything that holds a secret (`selector`: a password or code field, an editable area a secret was
 * typed into) is taken out of it: it is never read.
 */
function documentText(selector: string): string {
  const body = document.body;
  if (!body) return "";
  const hidden: string[] = [];
  const collect = (root: Document | ShadowRoot) => {
    for (const element of Array.from(root.querySelectorAll(selector))) {
      const text = (
        (element as HTMLElement).innerText ??
        element.textContent ??
        ""
      ).trim();
      if (text) hidden.push(text);
    }
  };
  collect(document);
  const parts = [body.innerText ?? ""];
  const visit = (root: Document | ShadowRoot, depth: number) => {
    if (depth > 4) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let node = walker.nextNode() as Element | null;
    while (node) {
      const shadow = (node as Element).shadowRoot;
      if (shadow) {
        collect(shadow);
        for (const child of Array.from(shadow.children)) {
          if (/^(SCRIPT|STYLE|TEMPLATE|SLOT)$/.test(child.tagName)) continue;
          const text = (child as HTMLElement).innerText?.trim();
          if (text) parts.push(text);
        }
        visit(shadow, depth + 1);
      }
      node = walker.nextNode() as Element | null;
    }
  };
  visit(document, 0);
  let text = parts.join("\n");
  // Longest first, so a secret that contains a shorter one is taken out whole.
  for (const secret of hidden.sort((a, b) => b.length - a.length))
    text = text.split(secret).join("");
  return text;
}

/**
 * A child frame's text, if it is big enough to be content rather than an ad or a tracker, with what
 * holds a secret taken out as above.
 */
function frameText(selector: string): string {
  if (innerWidth < 80 || innerHeight < 40) return "";
  let text = document.body?.innerText ?? "";
  const hidden = Array.from(document.querySelectorAll(selector))
    .map((element) =>
      ((element as HTMLElement).innerText ?? element.textContent ?? "").trim(),
    )
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  for (const secret of hidden) text = text.split(secret).join("");
  return text;
}

async function within<T>(work: Promise<T>, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), FRAME_TEXT_MS);
  });
  try {
    return await Promise.race([work.catch(() => fallback), late]);
  } finally {
    clearTimeout(timer);
  }
}

function hostOf(frame: Frame): string {
  try {
    return new URL(frame.url()).host || "frame";
  } catch {
    return "frame";
  }
}

/**
 * The page as text, the way a reader sees it, including what is inside its frames (same-origin and
 * cross-origin alike: a bank's statement, an embedded form) and its open shadow roots.
 */
export async function readablePageText(
  target: Pick<Page, "evaluate" | "frames" | "mainFrame">,
  limit: number,
): Promise<{ text: string; truncated: boolean }> {
  const main = target.mainFrame();
  const children = target
    .frames()
    .filter((frame) => frame !== main && frame.url() !== "about:blank")
    .slice(0, FRAME_LIMIT);
  const [own, ...framed] = await Promise.all([
    target.evaluate(documentText, SENSITIVE_FIELD_SELECTOR),
    ...children.map((frame) =>
      within(frame.evaluate(frameText, SENSITIVE_FIELD_SELECTOR), ""),
    ),
  ]);
  const sections = [own ?? ""];
  for (const [index, text] of framed.entries()) {
    const trimmed = text.trim();
    const frame = children[index];
    if (!trimmed || !frame) continue;
    sections.push(
      `[frame ${hostOf(frame)}]\n${cutAtCodeUnits(trimmed, FRAME_TEXT_LIMIT)}`,
    );
  }
  const collapsed = sections
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return {
    /*
     * Cut between characters, not through one: `slice` counts UTF-16 code units and an emoji is
     * two, so a limit between the halves hands the Bot a character that is not on the page.
     */
    text: cutAtCodeUnits(collapsed, limit),
    truncated: collapsed.length > limit,
  };
}

/**
 * Text of the plain elements a page made clickable by markup: an onclick attribute, or a tab stop.
 *
 * Playwright marks `cursor: pointer` in its snapshot but not these, so the snapshot parser is
 * handed their text and lists a matching `generic` as clickable. Runs in the page.
 */
function clickableTexts(): string[] {
  const texts: string[] = [];
  const native = "a, button, input, select, textarea, summary, option, label";
  for (const element of Array.from(
    document.querySelectorAll("[onclick], [tabindex]"),
  )) {
    if (element.matches(native) || element.getAttribute("role")) continue;
    const tabindex = element.getAttribute("tabindex");
    if (
      !element.hasAttribute("onclick") &&
      (tabindex === null || Number(tabindex) < 0)
    )
      continue;
    const text = ((element as HTMLElement).innerText ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
    if (text && text.length <= 200) texts.push(text);
    if (texts.length >= 300) break;
  }
  return texts;
}

export async function clickableHints(
  target: Pick<Page, "evaluate">,
): Promise<Set<string>> {
  return new Set(await target.evaluate(clickableTexts).catch(() => []));
}

/**
 * Wait for the page to settle after an action: the navigation it started committed and the DOM
 * quiet for a moment, within `budgetMs` in all. Never "network idle", which a page with a chat
 * widget or analytics beacon never reaches.
 *
 * Best effort by design: whatever is on screen when the budget runs out is what gets reported, and
 * the report says what it saw.
 */
export async function settlePage(
  target: Pick<Page, "waitForLoadState" | "evaluate" | "isClosed">,
  budgetMs = 1_500,
  quietMs = 200,
): Promise<void> {
  const deadline = Date.now() + budgetMs;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const left = deadline - Date.now();
    if (left <= 0 || target.isClosed()) return;
    try {
      await target.waitForLoadState("domcontentloaded", { timeout: left });
      await target.evaluate(
        ([quiet, budget]) =>
          new Promise<void>((resolve) => {
            const started = performance.now();
            let last = started;
            const observer = new MutationObserver(() => {
              last = performance.now();
            });
            observer.observe(document, {
              subtree: true,
              childList: true,
              attributes: true,
              characterData: true,
            });
            const check = () => {
              const now = performance.now();
              if (now - last >= quiet || now - started >= budget) {
                observer.disconnect();
                resolve();
              } else setTimeout(check, 50);
            };
            setTimeout(check, Math.min(quiet, 100));
          }),
        [quietMs, Math.max(0, deadline - Date.now())] as const,
      );
      return;
    } catch (error) {
      // The document changed under the wait (a navigation the action started): wait on the new one.
      if (
        error instanceof Error &&
        /Execution context was destroyed|navigation|frame was detached/i.test(
          error.message,
        )
      )
        continue;
      return;
    }
  }
}
