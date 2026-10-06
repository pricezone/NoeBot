import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { AccountSection } from "@/components/settings/account-section";
import { AppearanceSection } from "@/components/settings/appearance-section";
import { SettingsPage } from "@/components/settings/settings-page";
import { StandingInstructions } from "@/components/settings/standing-instructions";
import {
  SettingsCard,
  SettingsRow,
  SettingsSection,
} from "@/components/ui/settings-rows";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { brand } from "@/lib/brand";
import { formatHotkey, HOTKEYS } from "@/lib/hotkeys/hotkeys";

export const Route = createFileRoute("/_authed/_app/settings/")({
  component: RouteComponent,
});

/**
 * The first page of Settings: who you are, how the app looks, what every Bot is told, and the
 * keys. The account lives here rather than on a page of its own because there is one identity per
 * deployment and two facts about it; a page would be mostly empty.
 */
function RouteComponent() {
  const { data: user } = useQuery(currentUserQueryOptions());
  return (
    <SettingsPage
      description={`How ${brand.productName} looks and behaves for you.`}
      title="General"
    >
      <AccountSection />
      <AppearanceSection />
      {/*
       * Below the appearance preferences, because it is the only thing on this page that changes
       * what a coworker says rather than what this browser looks like.
       */}
      <StandingInstructions />
      {/*
       * Drawn from the same registry the listeners match against, so this list is what the keys
       * actually do rather than what somebody remembered they did. Read-only on purpose: these
       * are not rebindable, and a row with nothing to click says so by having nothing to click.
       */}
      <SettingsSection label="Keyboard shortcuts">
        <SettingsCard>
          {HOTKEYS.map((hotkey) => (
            <SettingsRow
              key={hotkey.id}
              label={hotkey.label}
              description={hotkey.description}
              control={
                <span className="flex gap-1">
                  {formatHotkey(hotkey.combo).map((part) => (
                    <kbd
                      className="rounded-md border bg-muted px-1.5 py-0.5 font-sans text-xs text-muted-foreground"
                      key={part}
                    >
                      {part}
                    </kbd>
                  ))}
                </span>
              }
            />
          ))}
        </SettingsCard>
      </SettingsSection>
      {/*
       * The gallery is still a page, at its old URL, but it is reading material for whoever governs
       * what a Bot may draw, so only an administrator is pointed at it; everybody else can reach it
       * by its address.
       */}
      {user?.role === "admin" ? (
        <SettingsSection label="More">
          <SettingsCard>
            <SettingsRow
              label="Component gallery"
              description="What a Bot can draw on screen."
              href={{ to: "/settings/components-gallery" }}
            />
          </SettingsCard>
        </SettingsSection>
      ) : null}
    </SettingsPage>
  );
}
