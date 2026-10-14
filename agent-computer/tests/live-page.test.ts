import { describe, expect, test } from "bun:test";
import { chooseLivePage, followLivePage } from "../src/live-page";

// A popup OAuth sign-in is the case this exists for: the page a Bot was pinned to at launch is not
// the page the person taking the wheel needs to see, and the popup closes itself when it succeeds.
const page = (closed = false) => ({ isClosed: () => closed });

describe("choosing the page a Bot is on", () => {
  test("one page is that page", () => {
    const only = page();
    expect(chooseLivePage([only])).toBe(only);
  });

  test("a window the site opens becomes the live one", () => {
    const opener = page();
    const popup = page();
    expect(chooseLivePage([opener, popup])).toBe(popup);
  });

  test("closing that window falls back to the opener", () => {
    const opener = page();
    const popup = page(true);
    expect(chooseLivePage([opener, popup])).toBe(opener);
  });

  test("a closed opener is not chosen while another page is open", () => {
    const opener = page(true);
    const popup = page();
    expect(chooseLivePage([opener, popup])).toBe(popup);
  });

  test("nothing open is nothing to choose", () => {
    expect(chooseLivePage([page(true), page(true)])).toBeUndefined();
    expect(chooseLivePage([])).toBeUndefined();
  });
});

/** A page as the follower sees it, counting how often it was brought to the front. */
function tab(name: string) {
  let closed = false;
  const onClose: (() => void)[] = [];
  const self = {
    name,
    fronted: 0,
    isClosed: () => closed,
    on: (_event: "close", listener: () => void) => {
      onClose.push(listener);
    },
    bringToFront: async () => {
      self.fronted += 1;
    },
    close: () => {
      closed = true;
      for (const listener of onClose) listener();
    },
  };
  return self;
}
type Tab = ReturnType<typeof tab>;

/** A browser that opens pages the way Playwright reports them: listed, then announced. */
function browser(...open: Tab[]) {
  const pages = [...open];
  const onPage: ((page: Tab) => void)[] = [];
  return {
    pages: () => pages,
    on: (_event: "page", listener: (page: Tab) => void) => {
      onPage.push(listener);
    },
    open: (page: Tab) => {
      pages.push(page);
      for (const listener of onPage) listener(page);
    },
  };
}

/** The follower as profiles.ts builds it in a headless browser: forward is `bringToFront`. */
const follow = (context: ReturnType<typeof browser>, first: Tab) =>
  followLivePage(context, first, {
    bringForward: (page) => page.bringToFront(),
  });

describe("bringing the page a Bot is on forward", () => {
  test("a window the site opens becomes the live page and is brought to the front", () => {
    const opener = tab("opener");
    const context = browser(opener);
    const live = follow(context, opener);
    const popup = tab("popup");

    context.open(popup);

    expect(live.page).toBe(popup);
    // The defect: the new window opened behind the one in front and nothing raised it.
    expect(popup.fronted).toBe(1);
    expect(opener.fronted).toBe(0);
  });

  test("when that window closes, the page it falls back to comes to the front", () => {
    const opener = tab("opener");
    const context = browser(opener);
    const live = follow(context, opener);
    const popup = tab("popup");
    context.open(popup);

    popup.close();

    expect(live.page).toBe(opener);
    expect(opener.fronted).toBe(1);
  });

  test("looking at the live page again brings nothing forward", () => {
    const opener = tab("opener");
    const context = browser(opener);
    const live = follow(context, opener);
    context.open(tab("popup"));

    live.retarget();
    live.retarget();

    expect(context.pages().map((page) => page.fronted)).toEqual([0, 1]);
  });

  test("switching to a tab brings it forward, even the tab that is already live", async () => {
    const opener = tab("opener");
    const context = browser(opener);
    const live = follow(context, opener);
    const popup = tab("popup");
    context.open(popup);

    await live.choose(opener);
    expect(live.page).toBe(opener);
    expect(opener.fronted).toBe(1);

    await live.choose(opener);
    expect(opener.fronted).toBe(2);
    expect(popup.fronted).toBe(1);
  });

  test("a browser reopened on its saved tabs shows the page the Bot was on", () => {
    const first = tab("first");
    const last = tab("last");
    const context = browser(first, tab("middle"), last);

    const live = follow(context, first);

    expect(live.page).toBe(last);
    expect(last.fronted).toBe(1);
    expect(first.fronted).toBe(0);
  });
});
