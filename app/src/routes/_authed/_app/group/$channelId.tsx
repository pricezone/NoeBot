import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useCallback } from "react";
import { BotPanel } from "@/components/bot-panel/bot-panel";
import { useBotPanel } from "@/components/bot-panel/use-bot-panel";
import { BotPausedBanner } from "@/components/bot-profile/pause-banner";
import { GroupChat } from "@/components/channels/group-chat";
import { ChatHeader } from "@/components/chat/chat-header";
import { DetailPanel } from "@/components/layout/detail-panel";
import { type BotPanelTab, botPanelSearchSchema } from "@/lib/bot-panel";
import { channelQueryOptions } from "@/lib/channels/queries";
import { groupQueryOptions } from "@/lib/groups";

/** The bot panel's width beside the conversation. */
const BOT_PANEL_WIDTH = 320;

/** A conversation with several Bots. The channel is an ordinary channel with more than one Bot. */
export const Route = createFileRoute("/_authed/_app/group/$channelId")({
  validateSearch: botPanelSearchSchema,
  component: RouteComponent,
});

function RouteComponent() {
  const { channelId } = Route.useParams();
  const { panel } = Route.useSearch();
  const navigate = Route.useNavigate();
  const channel = useQuery(channelQueryOptions(channelId));
  // The same query the transcript reads, for the Bots' names; one request serves both.
  const group = useQuery(groupQueryOptions(channelId));
  const agentIds = channel.data?.agentIds ?? [];
  const name = channel.data?.name ?? "Group";
  const participants =
    group.data?.bots ?? agentIds.map((id) => ({ id, name: id }));

  const setPanel = useCallback(
    (tab: BotPanelTab | undefined) =>
      void navigate({
        search: (previous) => ({ ...previous, panel: tab }),
      }),
    [navigate],
  );
  // A group has no one computer to ask for attention, and no Library or Computer tab.
  const botPanel = useBotPanel({ computerAgentId: undefined, panel, setPanel });
  const hasBots = agentIds.length > 0;

  return (
    <DetailPanel
      chromeless
      onClose={botPanel.close}
      onOverlayChange={botPanel.onOverlayChange}
      open={botPanel.demanded && hasBots}
      preferOpen={botPanel.storedOpen && hasBots}
      detailWidth={BOT_PANEL_WIDTH}
      detail={
        hasBots ? (
          <BotPanel
            agentId={agentIds[0] ?? ""}
            key={channelId}
            name={name}
            onTabChange={botPanel.setTab}
            participants={participants}
            tab={botPanel.tab}
          />
        ) : null
      }
    >
      <ChatHeader
        agentIds={agentIds}
        name={name}
        onPill={botPanel.openDetails}
        onToggle={botPanel.toggle}
        panelOpen={botPanel.isOpen && hasBots}
      />
      {agentIds.map((agentId) => (
        <BotPausedBanner agentId={agentId} key={agentId} />
      ))}
      {/* Remounted per channel so one group's transcript never flashes in another. */}
      <GroupChat channelId={channelId} key={channelId} />
    </DetailPanel>
  );
}
