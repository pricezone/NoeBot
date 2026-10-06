import { createFileRoute, useLocation } from "@tanstack/react-router";
import { useEffect } from "react";
import { BotsSection } from "@/components/settings/bots-section";
import { ResponsibilitiesSection } from "@/components/settings/responsibilities-section";
import { RoutinesSection } from "@/components/settings/routines-section";
import {
  SettingsBlock,
  SettingsPage,
} from "@/components/settings/settings-page";
import { TeamBotsSection } from "@/components/settings/team-bots-section";

/**
 * Everything about the Bots on one page, in four blocks the old sidebar listed as four pages:
 * Bots, Team Bots (`#team`), Responsibilities (`#responsibilities`), Routines (`#routines`). The
 * retired URLs redirect here with the hash, and the hash is what the page scrolls to on arrival.
 */
export const Route = createFileRoute("/_authed/_app/settings/bots")({
  component: RouteComponent,
});

/**
 * How long the page keeps following the hash while the blocks above it fill in. Every list on this
 * page has answered well within this on any server that answers at all; past it, a scroll that
 * still moved would be a page jumping under somebody who has started reading.
 */
const SETTLE_MS = 3000;

function RouteComponent() {
  const hash = useLocation({ select: (location) => location.hash });
  /*
   * The entry's key, so following the same hash link again while this page is already open scrolls
   * again. The hash alone does not change then, and an effect keyed on it alone would not re-run.
   * Two selects rather than one returning an object, because a fresh object every read is a
   * re-render every read.
   */
  const entryKey = useLocation({
    select: (location) => location.state.__TSR_key,
  });
  /*
   * Scroll to the block the hash names. An effect rather than the browser's own anchor handling,
   * because the modal's body is its own scroller and a client-side navigation to a hash never
   * reaches the browser as a page load.
   *
   * AND KEEP SCROLLING WHILE THE PAGE ABOVE THE TARGET IS STILL GROWING. The page has no loader:
   * on the first commit the Bots block is empty, Team Bots is fetching and Responsibilities is one
   * line of "Loading…". One scroll at that moment lands on the target, and then each list arrives
   * and pushes it down, so an old /routines bookmark ended somewhere in the middle of
   * Responsibilities. The page body is watched with a ResizeObserver and the target re-aligned on
   * every change in its height, until the person takes the scroller over themselves (a wheel,
   * a touch, a key, a pointer on the scrollbar) or the lists have had long enough.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: entryKey is read by nothing inside; it is here so following the same hash link again scrolls again.
  useEffect(() => {
    if (!hash) return;
    const target = document.getElementById(hash);
    if (!target) return;
    const scroll = () => target.scrollIntoView({ block: "start" });
    scroll();
    // The SettingsPage column holding every block, whose height is what the lists change.
    const body = target.parentElement;
    if (!body || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(scroll);
    observer.observe(body);
    const stop = () => observer.disconnect();
    // The modal's scrolling body: the place the person's own scrolling lands.
    const scroller = body.parentElement;
    const handoffs = ["wheel", "touchstart", "keydown", "pointerdown"] as const;
    for (const type of handoffs) {
      scroller?.addEventListener(type, stop, { once: true, passive: true });
    }
    const timeout = window.setTimeout(stop, SETTLE_MS);
    return () => {
      stop();
      window.clearTimeout(timeout);
      for (const type of handoffs) scroller?.removeEventListener(type, stop);
    };
  }, [hash, entryKey]);

  return (
    <SettingsPage
      description="What each of your Bots is doing, what it needs from you, and what it does on its own."
      title="Bots"
    >
      <SettingsBlock id="bots" title="Your Bots">
        <BotsSection />
      </SettingsBlock>
      <SettingsBlock
        description="Bots your teammates published, and the ones you share. Each chat with a Team Bot is private to the person having it."
        id="team"
        title="Team Bots"
      >
        <TeamBotsSection />
      </SettingsBlock>
      <SettingsBlock
        description="Give a Bot a lasting goal, follow its progress, and decide when it should work."
        id="responsibilities"
        title="Responsibilities"
      >
        <ResponsibilitiesSection />
      </SettingsBlock>
      <SettingsBlock
        description="What a Bot does on a schedule, without being asked each time. Made and changed by talking to a Bot — this only shows what is standing, and lets you stop one."
        id="routines"
        title="Routines"
      >
        <RoutinesSection />
      </SettingsBlock>
    </SettingsPage>
  );
}
