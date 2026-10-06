import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useCallback, useEffect } from "react";
import { hasUnseenActivity } from "@/components/app-sidebar/app-sidebar";
import { BotPanel } from "@/components/bot-panel/bot-panel";
import { useBotPanel } from "@/components/bot-panel/use-bot-panel";
import { BotPausedBanner } from "@/components/bot-profile/pause-banner";
import { ChannelChat } from "@/components/channels/channel-chat";
import { ChatHeader } from "@/components/chat/chat-header";
import { DetailPanel } from "@/components/layout/detail-panel";
import { rememberLastBot } from "@/lib/agents/last-bot";
import { type BotPanelTab, botPanelSearchSchema } from "@/lib/bot-panel";
import { markChannelReadMutationOptions } from "@/lib/channels/mutations";
import {
  type AgentChannel,
  channelListQueryOptions,
  channelQueryOptions,
} from "@/lib/channels/queries";

/** The bot panel's width beside the conversation. */
const BOT_PANEL_WIDTH = 320;

export const Route = createFileRoute("/_authed/_app/channel/$channelId")({
  validateSearch: botPanelSearchSchema,
  component: RouteComponent,
});

function RouteComponent() {
  const { channelId } = Route.useParams();
  const { panel } = Route.useSearch();
  const channel = useQuery(channelQueryOptions(channelId));
  const navigate = Route.useNavigate();
  /** Channel routing currently supports one coworker. */
  const agentId = channel.data?.agentIds[0];
  const name = channel.data?.name ?? "Channel";

  /*
   * This is the Bot home returns to next time (`lib/landing.ts`). Only a conversation with one
   * Bot counts: a group's first participant is not "the Bot you were with", and the group route
   * this one redirects to is not where a landing should go.
   */
  const isWithOneBot = channel.data?.agentIds.length === 1;
  useEffect(() => {
    if (agentId && isWithOneBot) rememberLastBot(agentId);
  }, [agentId, isWithOneBot]);

  const queryClient = useQueryClient();
  const markRead = useMutation(markChannelReadMutationOptions(queryClient));
  /*
   * This channel's roster summary, read out of the same infinite query the sidebar renders.
   * The detail query deliberately knows nothing about activity; the roster is where the socket
   * keeps lastMessageAt live, so it is the one honest source for "has something new been said".
   */
  const roster = useInfiniteQuery(channelListQueryOptions());
  const summary = roster.data?.find((row) => row.id === channelId);

  /*
   * Opening the channel marks it read; the Bot replying while it is open marks it read again.
   * One effect covers both: the dep changes on navigation and on every activity patch, and the
   * unseen check keeps it from writing a row per render. No dependency on the mutation object —
   * its identity changes per render and the effect must not re-fire for that.
   *
   * Keyed on primitives, deliberately. The optimistic mark-read patch changes the summary OBJECT's
   * identity without changing these values, so an object dep would re-fire the effect on its own
   * write — and when lastMessageAt sits ahead of this browser's clock (another device wrote it),
   * that re-fire loops into a PUT per render. Primitives hold still under the patch: one PUT.
   */
  const unseen = summary !== undefined && hasUnseenActivity(summary);
  const markReadMutate = markRead.mutate;
  useEffect(() => {
    if (unseen) {
      markReadMutate(channelId);
    }
  }, [channelId, unseen, markReadMutate]);

  const setPanel = useCallback(
    (tab: BotPanelTab | undefined) =>
      void navigate({
        search: (previous) => ({ ...previous, panel: tab }),
      }),
    [navigate],
  );
  const botPanel = useBotPanel({ computerAgentId: agentId, panel, setPanel });

  return (
    <DetailPanel
      chromeless
      onClose={botPanel.close}
      onOverlayChange={botPanel.onOverlayChange}
      open={botPanel.demanded && agentId !== undefined}
      preferOpen={botPanel.storedOpen && agentId !== undefined}
      detailWidth={BOT_PANEL_WIDTH}
      detail={
        agentId === undefined ? null : (
          <BotPanel
            agentId={agentId}
            key={agentId}
            name={name}
            onTabChange={botPanel.setTab}
            tab={botPanel.tab}
          />
        )
      }
    >
      <ChatHeader
        agentIds={channel.data?.agentIds ?? []}
        name={name}
        onPill={botPanel.openDetails}
        onToggle={botPanel.toggle}
        panelOpen={botPanel.isOpen && agentId !== undefined}
      />
      {agentId && channel.data?.agentIds.length === 1 ? (
        <BotPausedBanner agentId={agentId} />
      ) : null}
      <ChannelBody
        channel={channel.data}
        isPending={channel.isPending}
        hasError={Boolean(channel.error)}
      />
    </DetailPanel>
  );
}

/**
 * A channel with exactly one coworker is its CopilotKit chat. One with several is a group, which
 * redirects to its shared transcript at `/group/$channelId`.
 */
function ChannelBody({
  channel,
  isPending,
  hasError,
}: {
  channel: AgentChannel | undefined;
  isPending: boolean;
  hasError: boolean;
}) {
  // Nothing while the channel loads: a placeholder inside a local round-trip is a flicker.
  if (isPending) return null;
  if (hasError || !channel) {
    return (
      <p className="p-8 text-sm text-destructive" role="alert">
        Could not load this channel.
      </p>
    );
  }

  const runtimeAgentId =
    channel.agentIds.length === 1 ? channel.agentIds[0] : undefined;
  // Two or more Bots is a group conversation, with its own shared transcript. Every link to a
  // channel lands here, so this is the one redirect they all need.
  if (!runtimeAgentId) {
    return (
      <Navigate
        params={{ channelId: channel.id }}
        replace
        to="/group/$channelId"
      />
    );
  }

  // Remount on channel changes so CopilotKit agent/thread state cannot leak between channels.
  return (
    <ChannelChat
      channel={channel}
      key={channel.id}
      runtimeAgentId={runtimeAgentId}
    />
  );
}
