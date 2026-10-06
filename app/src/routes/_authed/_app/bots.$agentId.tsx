import { createFileRoute, redirect } from "@tanstack/react-router";
import { conversationWith } from "@/components/settings/bots-section";
import {
  type ChannelSummary,
  channelListQueryOptions,
} from "@/lib/channels/queries";

/**
 * `/bots/$agentId` was a Bot's profile page. The profile is the chat's own panel now, so the old
 * address opens the Bot's newest conversation with that panel showing, or a fresh conversation
 * with the Bot when there is none yet.
 *
 * The roster is ensured rather than fetched, so a link followed from inside the app reads the
 * sidebar's cache and redirects without a round trip. If it cannot be read at all, the honest
 * fallback is a new conversation: `/channel/new` knows how to say a Bot is out of reach, and a
 * redirect to a conversation guessed from nothing would not.
 */
export const Route = createFileRoute("/_authed/_app/bots/$agentId")({
  beforeLoad: async ({ context, params }) => {
    let channels: ChannelSummary[] | undefined;
    try {
      const pages = await context.queryClient.ensureInfiniteQueryData(
        channelListQueryOptions(),
      );
      channels = pages.pages.flatMap((page) => page.channels);
    } catch {
      channels = undefined;
    }
    const target = conversationWith(params.agentId, channels);
    if (target.to === "/channel/$channelId") {
      throw redirect({
        to: target.to,
        params: target.params,
        search: { panel: "details" },
        replace: true,
      });
    }
    throw redirect({ ...target, replace: true });
  },
});
