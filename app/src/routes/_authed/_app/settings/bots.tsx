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

function RouteComponent() {
  const hash = useLocation({ select: (location) => location.hash });
  /*
   * Scroll to the block the hash names. An effect rather than the browser's own anchor handling,
   * because the modal's body is its own scroller and a client-side navigation to a hash never
   * reaches the browser as a page load.
   */
  useEffect(() => {
    if (!hash) return;
    document.getElementById(hash)?.scrollIntoView({ block: "start" });
  }, [hash]);

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
