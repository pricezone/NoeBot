import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { AgentDialog } from "@/components/agents/agent-dialog";
import { AvatarChooser } from "@/components/agents/avatar-chooser";
import { ChannelAvatar } from "@/components/channels/avatar";
import { Tabs, TabsList, TabsPanel, TabsTrigger } from "@/components/ui/tabs";
import { agentQueryOptions } from "@/lib/agents/queries";
import { BOT_PANEL_TABS, type BotPanelTab } from "@/lib/bot-panel";
import { brand } from "@/lib/brand";
import { ComputerTab } from "./computer-tab";
import { DetailsTab, ParticipantsTab } from "./details-tab";
import { LibraryTab } from "./library-tab";

export type BotPanelParticipant = { id: string; name: string };

const TAB_LABEL: Record<BotPanelTab, string> = {
  details: "Details",
  library: "Library",
  computer: "Computer",
};

/**
 * The panel beside a conversation: who you are talking to, and three tabs on it.
 *
 * Details is who the Bot is and what it does for you; Library is what it has to work with;
 * Computer is its screen. The tab is the caller's — it is in the URL, so a link can open a Bot on
 * its screen — and so is closing, which the shell's floating X does. The header draws the Bot at
 * 60px with its name and its title under it; a Bot with no title shows "Add a label", and either
 * line opens the Bot's dialog on General, where the title is edited.
 *
 * A group — `participants` given — has no one Bot to have a library or a screen, so it shows the
 * stacked avatars, the group's name, and Details alone, listing the Bots in it.
 */
export function BotPanel({
  agentId,
  name,
  tab,
  onTabChange,
  participants,
  openComputer,
  onComputerOpened,
}: {
  agentId: string;
  name: string;
  tab: BotPanelTab;
  onTabChange: (tab: BotPanelTab) => void;
  /** The Bots in a group; given, the panel is the group's and shows Details only. */
  participants?: BotPanelParticipant[];
  /** Open the Bot's screen full-window as soon as it mounts (`?record=true`). */
  openComputer?: boolean;
  /** Called once the full-window viewer has opened for `openComputer`, so the page can forget it. */
  onComputerOpened?: () => void;
}) {
  const isGroup = participants !== undefined;
  const tabs: readonly BotPanelTab[] = isGroup ? ["details"] : BOT_PANEL_TABS;
  // A tab the group does not have lands on the one it does.
  const shown: BotPanelTab = tabs.includes(tab) ? tab : "details";

  return (
    <div className="flex flex-col gap-4 px-4 pt-6 pb-6">
      {isGroup ? (
        <GroupHeader name={name} participants={participants} />
      ) : (
        <BotHeader agentId={agentId} name={name} />
      )}
      <Tabs
        className="gap-4"
        onValueChange={(next) => {
          if (
            typeof next === "string" &&
            BOT_PANEL_TABS.includes(next as BotPanelTab)
          )
            onTabChange(next as BotPanelTab);
        }}
        value={shown}
      >
        {isGroup ? null : (
          <TabsList
            activateOnFocus
            aria-label="Bot panel"
            className="w-full"
            variant="segmented"
          >
            {tabs.map((id) => (
              <TabsTrigger key={id} value={id}>
                {TAB_LABEL[id]}
              </TabsTrigger>
            ))}
          </TabsList>
        )}
        <TabsPanel value="details">
          {isGroup ? (
            <ParticipantsTab participants={participants} />
          ) : (
            <DetailsTab agentId={agentId} />
          )}
        </TabsPanel>
        {isGroup ? null : (
          <>
            <TabsPanel value="library">
              <LibraryTab agentId={agentId} />
            </TabsPanel>
            {/*
             * Kept mounted behind the other tabs rather than torn down, so coming back to the screen
             * does not start from a blank frame; `paused` stops its polling meanwhile.
             */}
            <TabsPanel keepMounted value="computer">
              <ComputerTab
                agentId={agentId}
                name={name}
                onOpened={onComputerOpened}
                openExpanded={openComputer}
                paused={shown !== "computer"}
              />
            </TabsPanel>
          </>
        )}
      </Tabs>
    </div>
  );
}

/**
 * The Bot at 96px, its name, and its title — or an invitation to give it one.
 *
 * The avatar is where its look is changed: a pencil on hover, a click opens the chooser
 * (`AvatarChooser`), for whoever the server says may. Until the profile is in, the seed's face.
 */
function BotHeader({ agentId, name }: { agentId: string; name: string }) {
  const [managing, setManaging] = useState(false);
  const agent = useQuery(agentQueryOptions(agentId));
  const title = agent.data?.title.trim() ?? "";

  return (
    <header className="flex flex-col items-center gap-1 text-center">
      <div className="mb-2">
        {agent.data ? (
          <AvatarChooser agentId={agentId} profile={agent.data} size={96} />
        ) : (
          <brand.Avatar name={name} seed={agentId} size={96} />
        )}
      </div>
      <h2 className="w-full text-balance text-[18px] font-semibold leading-tight tracking-tight">
        {name}
      </h2>
      {agent.isPending ? null : (
        <button
          aria-label={title ? `Edit ${name}'s label` : `Add a label to ${name}`}
          className="max-w-full truncate rounded-md px-1 text-[13px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
          onClick={() => setManaging(true)}
          type="button"
        >
          {title || "Add a label"}
        </button>
      )}
      <AgentDialog
        agentId={agentId}
        onClose={() => setManaging(false)}
        open={managing}
      />
    </header>
  );
}

/** The group's Bots stacked, and the group's name. */
function GroupHeader({
  name,
  participants,
}: {
  name: string;
  participants: BotPanelParticipant[];
}) {
  return (
    <header className="flex flex-col items-center gap-1 text-center">
      <div className="mb-2">
        <ChannelAvatar
          participantIds={participants.map((participant) => participant.id)}
          size={60}
        />
      </div>
      <h2 className="w-full text-balance text-[18px] font-semibold leading-tight tracking-tight">
        {name}
      </h2>
      <p className="text-[13px] text-muted-foreground">
        {participants.length} {participants.length === 1 ? "Bot" : "Bots"}
      </p>
    </header>
  );
}
