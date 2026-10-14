// Its own file so a test can reach it without the Playwright import `profiles.ts` carries.

/** Enough of a page for the choice. Keeps this file independent of what else is on one. */
export type OpenPage = { isClosed(): boolean };

/**
 * The page a Bot is on: the open page opened or switched to most recently.
 *
 * The newest open page wins, so a window the site opens becomes the one being watched and driven,
 * and closing it falls back to whatever is still open rather than to a page that has gone.
 * `rankOf` is when a page was last opened or switched to (`computer_tabs`), so a tab the Bot chose
 * stays chosen until something newer opens; pages it does not rank keep their order in the list.
 */
export function chooseLivePage<T extends OpenPage>(
  opened: readonly T[],
  rankOf: (page: T) => number = () => 0,
): T | undefined {
  let best: T | undefined;
  let bestRank = Number.NEGATIVE_INFINITY;
  for (const page of opened) {
    if (page.isClosed()) continue;
    const rank = rankOf(page);
    // `>=`, so among pages of equal rank the later one in the list wins.
    if (rank >= bestRank) {
      best = page;
      bestRank = rank;
    }
  }
  return best;
}

/** Enough of a page to follow it: whether it is open, and word when it closes. */
export type FollowedPage = OpenPage & {
  on(event: "close", listener: () => void): unknown;
};

/** Enough of a browser to hear about every page it opens. */
export type FollowedContext<P> = {
  pages(): P[];
  on(event: "page", listener: (page: P) => void): unknown;
};

/** The page a Bot is on, kept current as pages open, close and are switched to. */
export type LivePage<P> = {
  /** The page the Bot is on now. */
  readonly page: P;
  /** Choose again from what is open. Called on every opening and closing, and before a read. */
  retarget(): void;
  /**
   * Make this page the live one (`computer_tabs` switch) and bring it forward, even when it already
   * was the live one: a person who switches to the tab they are on still means to see it.
   */
  choose(page: P): Promise<void>;
};

/**
 * Follow which page a Bot is on, and bring each page that becomes it forward.
 *
 * Forward means in front of the person watching: a window the site opens, a tab the Bot switches to
 * and the page it falls back to when one closes all become the live page, and a live page left in a
 * background tab, or in a window behind another, is one the person sees nothing of. Nothing else
 * puts it there: the browser opens a site's window or a reopened tab wherever it opens it, and a
 * window manager may place a window a program opened without a click behind the focused one. That
 * is how a visit happened in a second window behind the one the person was watching.
 *
 * `bringForward` is asked only when the live page changes (and by `choose`), never on a read, so a
 * person who has put another window in front is not overruled by the Bot looking at its own page. It
 * must not reject.
 */
export function followLivePage<P extends FollowedPage>(
  context: FollowedContext<P>,
  first: P,
  hooks: {
    bringForward: (page: P) => Promise<void>;
    changed?: (page: P) => void;
  },
): LivePage<P> {
  const rank = new WeakMap<P, number>();
  let ranked = 0;
  let current = first;

  /** Answers the bringing forward it started, when the live page changed. */
  const retarget = (): Promise<void> | undefined => {
    const next = chooseLivePage(
      context.pages(),
      (candidate) => rank.get(candidate) ?? 0,
    );
    if (!next || next === current) return undefined;
    current = next;
    hooks.changed?.(next);
    return hooks.bringForward(next);
  };

  // Without this the Bot stays pinned to the page it launched with, so a sign-in the site opens in
  // a new window is neither shown to the person taking the wheel nor reachable by input.
  context.on("page", (opened) => {
    ranked += 1;
    rank.set(opened, ranked);
    retarget();
    // A popup closes itself when it succeeds, and the live page must move back to the opener rather
    // than leave a closed page to be read as a dead browser.
    opened.on("close", retarget);
  });
  // Pages already open (the launch page, tabs reopened after a restart) came before the listener
  // above: each falls back the same way when it closes, and the newest of them is live from the start.
  for (const open of new Set([first, ...context.pages()]))
    open.on("close", retarget);
  retarget();

  return {
    get page() {
      return current;
    },
    retarget,
    choose(page) {
      ranked += 1;
      rank.set(page, ranked);
      return (
        retarget() ??
        (page === current ? hooks.bringForward(page) : Promise.resolve())
      );
    },
  };
}
