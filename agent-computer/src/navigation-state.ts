/**
 * Whether the Bot's page has moved on, for Clicky watching a person's progress.
 *
 * After a person clicks, types or presses Enter, Clicky asks `/elements/state` every so often whether
 * the page changed under them, and looks again when it has (`server/src/clicky/service.ts`). The
 * answer has to be cheap and must not disturb anything: no snapshot, no look at the page beyond its
 * address and title. So the browser is listened to instead. Every navigation of a page's main frame
 * is heard here, and one counts once the address has stayed put for a moment, so a redirect chain
 * (a search, then its result, then a sign-in hop) is one change rather than three. A navigation
 * request that has started but not landed yet counts as "not settled", so a look waits for it.
 *
 * Takes only the shapes it listens to, so a test drives it with its own fake pages.
 */

/** How long an address must stay put before a navigation counts as one. */
export const NAVIGATION_SETTLE_MS = 800;
/** How long a navigation that never lands is waited on before it is forgotten. */
export const NAVIGATION_PENDING_LIMIT_MS = 10_000;

type Frame = { url(): string };
type Request = { isNavigationRequest(): boolean; frame(): unknown };
export type FollowedPage = {
  mainFrame(): unknown;
  url(): string;
  on(event: "framenavigated", listener: (frame: Frame) => void): unknown;
  on(event: "request", listener: (request: Request) => void): unknown;
  on(event: "requestfailed", listener: (request: Request) => void): unknown;
};
export type FollowedContext = {
  pages(): FollowedPage[];
  on(event: "page", listener: (page: FollowedPage) => void): unknown;
};

/** What `/elements/state` answers, besides the title. */
export type NavigationState = {
  url: string;
  /** Goes up by one for every settled navigation, and when the page shown becomes another tab. */
  navigationId: number;
  /** False while a navigation is on its way or has only just landed. */
  settled: boolean;
};

export function createNavigationTracker(
  options: {
    settleMs?: number;
    pendingLimitMs?: number;
    now?: () => number;
  } = {},
) {
  const settleMs = options.settleMs ?? NAVIGATION_SETTLE_MS;
  const pendingLimitMs = options.pendingLimitMs ?? NAVIGATION_PENDING_LIMIT_MS;
  const now = options.now ?? Date.now;
  type Track = {
    navigationId: number;
    settling: ReturnType<typeof setTimeout> | null;
    loadingSince: number | null;
    shown: unknown;
  };
  const tracks = new Map<string, Track>();
  const followed = new WeakSet<object>();

  const trackOf = (botId: string): Track => {
    let track = tracks.get(botId);
    if (!track) {
      track = {
        navigationId: 0,
        settling: null,
        loadingSince: null,
        shown: null,
      };
      tracks.set(botId, track);
    }
    return track;
  };

  const follow = (botId: string, page: FollowedPage) => {
    if (followed.has(page)) return;
    followed.add(page);
    page.on("framenavigated", (frame) => {
      if (frame !== page.mainFrame()) return;
      const track = trackOf(botId);
      track.loadingSince = null;
      if (track.settling) clearTimeout(track.settling);
      track.settling = setTimeout(() => {
        track.settling = null;
        track.navigationId += 1;
      }, settleMs);
      (track.settling as { unref?: () => void }).unref?.();
    });
    page.on("request", (request) => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame())
        trackOf(botId).loadingSince = now();
    });
    page.on("requestfailed", (request) => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame())
        trackOf(botId).loadingSince = null;
    });
  };

  return {
    /** Every page of a browser, those open now and those it opens later. */
    attach(botId: string, context: FollowedContext): void {
      if (followed.has(context)) return;
      followed.add(context);
      context.on("page", (page) => follow(botId, page));
      for (const page of context.pages()) follow(botId, page);
    },

    /** Where `page`, the page the Bot is on, is now. */
    state(botId: string, page: FollowedPage): NavigationState {
      const track = trackOf(botId);
      // Another tab coming to the front is a change of page for whoever is watching.
      if (track.shown !== null && track.shown !== page) track.navigationId += 1;
      track.shown = page;
      const loading =
        track.loadingSince !== null &&
        now() - track.loadingSince < pendingLimitMs;
      return {
        url: page.url(),
        navigationId: track.navigationId,
        settled: track.settling === null && !loading,
      };
    },

    /** The count alone, for a Bot whose browser is not open. */
    navigationId(botId: string): number {
      return tracks.get(botId)?.navigationId ?? 0;
    },

    forget(botId: string): void {
      const track = tracks.get(botId);
      if (track?.settling) clearTimeout(track.settling);
      if (track) {
        track.settling = null;
        track.loadingSince = null;
        track.shown = null;
      }
    },
  };
}
