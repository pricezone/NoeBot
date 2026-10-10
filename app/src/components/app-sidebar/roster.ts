import type { ChannelSummary } from "@/lib/channels/queries";

/**
 * The rules the roster is drawn by, with no component around them.
 *
 * Pure functions on channel summaries: which rows match a search, which come first, which carry
 * the unread dot. They used to live inside `app-sidebar.tsx`, which re-exports them still, so the
 * channel route and the tests that pin each rule keep their import; they are here so the rules can
 * be read, and proved, without the sidebar's queries, socket and animation around them.
 */

/**
 * The roster, narrowed to what the person typed.
 *
 * Matches the channel's name, its summary, and the last message, because those are the things the
 * row can actually show — searching against something invisible returns results a person cannot
 * account for. The last message is included because it is still what the second line draws until the
 * conversation has been named. Message history beyond that line is not here to search: it lives in
 * the thread store, and reaching for it is a server endpoint rather than a filter.
 *
 * An empty query returns the input array unchanged rather than a copy, so typing and clearing does
 * not hand `AnimatePresence` a new array identity and restage the whole list.
 */
export function matchingChannels(
  channels: ChannelSummary[] | undefined,
  query: string,
): ChannelSummary[] {
  if (!channels) {
    return [];
  }
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return channels;
  }
  return channels.filter((channel) =>
    [channel.name, channel.summary, channel.lastMessage].some((field) =>
      field?.toLowerCase().includes(needle),
    ),
  );
}

/**
 * Pinned channels first, everything else after, newest activity first within each group.
 *
 * The mirror of a server rule, not the rule itself: the roster query orders pinned-first and its
 * cursor carries the pin, so a pinned channel arrives on page one however long ago it was last
 * spoken in. Sorting here as well is for what happens between refetches — the socket patches a pin
 * onto a loaded row without moving it, and re-sorts a page by recency alone — which is the same
 * reason `byRecency` in use-channel-events.ts mirrors the recency rule. A stable partition, so the
 * recency order inside each group is whatever arrived.
 */
export function pinnedFirst(channels: ChannelSummary[]): ChannelSummary[] {
  return [...channels].sort((a, b) => Number(b.pinned) - Number(a.pinned));
}

/**
 * Whether a Bot has said something this member has not had on screen yet.
 *
 * A Bot's message, and only a Bot's: your own message carries a null agent id and reading your own
 * words needs no marker. ISO-8601 strings compare correctly as strings, which is the same bet the
 * server's recency sort already makes.
 */
export function hasUnseenActivity(channel: ChannelSummary): boolean {
  if (channel.lastMessageAgentId === null || channel.lastMessageAt === null) {
    return false;
  }
  return (
    channel.lastReadAt === null || channel.lastMessageAt > channel.lastReadAt
  );
}

/** Unseen activity somewhere you are not looking. The open channel never shows the dot. */
export function isUnread(
  channel: ChannelSummary,
  openChannelId: string | undefined,
): boolean {
  return channel.id !== openChannelId && hasUnseenActivity(channel);
}

/**
 * Whether this member has the row hidden from their sidebar right now.
 *
 * Hidden is a stamp, not a switch: it holds only while nothing newer has been said. The socket
 * patches `lastMessageAt` the moment somebody speaks, so a hidden conversation comes back on its
 * own without anybody un-hiding it — which is the point of hiding rather than deleting. Strictly
 * newer, because the server stamps no earlier than the last message it had. Any message counts, the
 * person's own included: writing in a conversation found through the search is wanting it back.
 */
export function isHiddenFromSidebar(channel: ChannelSummary): boolean {
  const { hiddenAt } = channel;
  if (hiddenAt === undefined || hiddenAt === null) return false;
  return channel.lastMessageAt === null || channel.lastMessageAt <= hiddenAt;
}

/** A section heading and the rows filed under it, in the order the sidebar draws them. */
export type RosterSection<Section extends { id: string }> = {
  section: Section;
  channels: ChannelSummary[];
};

/**
 * The roster cut the way the sidebar draws it: pinned rows, then each section, then the rest.
 *
 * PINNED STAYS ON TOP. A pin was the one way to keep a conversation at the top before sections
 * existed, and it still is: a pinned row is drawn in the pinned group whichever section it is filed
 * under, and goes back to its section when it is unpinned. A row filed under a section this list
 * does not hold (deleted in another tab, or not loaded yet) is drawn ungrouped rather than nowhere.
 * Hidden rows are in none of the groups.
 *
 * Every group keeps the order the rows arrived in, which is the server's recency order, and the
 * sections keep the order given, which is theirs.
 */
export function sidebarRoster<Section extends { id: string }>(
  channels: readonly ChannelSummary[] | undefined,
  sections: readonly Section[] | undefined,
): {
  pinned: ChannelSummary[];
  sections: RosterSection<Section>[];
  ungrouped: ChannelSummary[];
} {
  const grouped = new Map<string, ChannelSummary[]>(
    (sections ?? []).map((section) => [section.id, []]),
  );
  const pinned: ChannelSummary[] = [];
  const ungrouped: ChannelSummary[] = [];
  for (const channel of channels ?? []) {
    if (isHiddenFromSidebar(channel)) continue;
    if (channel.pinned) {
      pinned.push(channel);
      continue;
    }
    const section = channel.sectionId ? grouped.get(channel.sectionId) : null;
    (section ?? ungrouped).push(channel);
  }
  return {
    pinned,
    sections: (sections ?? []).map((section) => ({
      section,
      channels: grouped.get(section.id) ?? [],
    })),
    ungrouped,
  };
}
