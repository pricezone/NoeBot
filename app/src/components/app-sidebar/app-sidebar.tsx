import { IconPlus, IconSearch } from "@tabler/icons-react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type * as React from "react";
import { useRef, useState } from "react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import {
  type ChannelSummary,
  channelListQueryOptions,
} from "@/lib/channels/queries";
import {
  type SidebarSection,
  sectionListQueryOptions,
} from "@/lib/channels/sections";
import { useChannelEvents } from "@/lib/channels/use-channel-events";
import { useHotkey } from "@/lib/hotkeys/use-hotkey";
import { EASE_OUT, ENTRANCE_SECONDS } from "@/lib/motion";
import { relativeTime } from "@/lib/relative-time";
import {
  type MessageListEmphasis,
  useMessageListEmphasis,
} from "@/lib/settings/message-list";
import { BotAttentionList } from "../bot-profile/attention";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { AccountMenu } from "./account-menu";
import { Channel } from "./channel";
import { ChannelPagination } from "./channel-pagination";
import { useCollapsedSections } from "./collapsed-sections";
import { ConnectAppsButton } from "./connect-apps-button";
import { FeaturedBot } from "./featured-bot";
import { isUnread, sidebarRoster } from "./roster";
import { SearchPalette } from "./search-palette";
import { SidebarSectionHeader } from "./sidebar-section";

/*
 * The roster's rules live in ./roster.ts; re-exported here because the channel route and the tests
 * that pin each rule import them from the sidebar, and a move should not be their problem.
 */
export {
  hasUnseenActivity,
  isHiddenFromSidebar,
  isUnread,
  matchingChannels,
  pinnedFirst,
  sidebarRoster,
} from "./roster";

/**
 * Cap layout animation because `layout` measures every animated row on each reorder.
 */
const MAX_ANIMATED_ROWS = 60;

/** The two round buttons in the header: card-coloured discs, the way Grok Bot draws them. */
const headerButtonClassName =
  "size-9 rounded-full bg-card text-foreground hover:bg-muted aria-expanded:bg-muted [&_svg]:size-5";

/** The motion every roster entry shares: fade in where it appears, glide when the order changes. */
function useRowMotion(animateOrder: boolean) {
  const shouldReduceMotion = useReducedMotion();
  return {
    animate: { opacity: 1, transform: "translateY(0px)" },
    initial: {
      opacity: 0,
      transform: shouldReduceMotion ? "none" : "translateY(-8px)",
    },
    exit: { opacity: 0 },
    layout: animateOrder && !shouldReduceMotion ? ("position" as const) : false,
    transition: { duration: ENTRANCE_SECONDS, ease: EASE_OUT },
  };
}

/**
 * A roster row that can animate.
 *
 * Two movements only: a channel that did not exist fades in, and a channel that was just spoken in
 * moves to the top. Nothing else animates, a roster that reacts to being read is a roster that
 * moves under the cursor. A chat moved into a section glides there, because it is the same row in
 * the same list (see `RosterEntry`).
 */
function ChannelRow({
  channel,
  animateOrder,
  emphasis,
}: {
  channel: ChannelSummary;
  animateOrder: boolean;
  emphasis: MessageListEmphasis;
}) {
  const rowMotion = useRowMotion(animateOrder);
  // Whether this row is unread, as a boolean, for the same reason `Channel` computes `isOpen`
  // that way: navigating re-renders the rows whose answer changed, not the whole roster.
  const unread = useParams({
    strict: false,
    select: (params) =>
      isUnread(channel, (params as { channelId?: string }).channelId),
  });
  return (
    <motion.div {...rowMotion}>
      <Channel
        emphasis={emphasis}
        channelId={channel.id}
        participantIds={channel.agentIds}
        name={channel.name}
        summary={channel.summary ?? undefined}
        lastMessage={channel.lastMessage ?? undefined}
        lastMessageAt={
          channel.lastMessageAt
            ? relativeTime(channel.lastMessageAt)
            : undefined
        }
        pinned={channel.pinned}
        unread={unread}
        busy={channel.busy ?? false}
        canMarkUnread={
          channel.lastMessageAgentId !== null && channel.lastMessageAt !== null
        }
        sectionId={channel.sectionId ?? null}
      />
    </motion.div>
  );
}

/**
 * One line of the roster as drawn: a conversation, a section's heading, or the rule between the
 * last section and the conversations filed under none.
 *
 * ONE FLAT LIST, NOT A LIST PER SECTION. Every entry is a keyed sibling in the same
 * `AnimatePresence`, so moving a chat from one section to another moves the same row — React keeps
 * the component, and with it any dialog that row has open, such as the "New section" one that
 * caused the move — instead of unmounting it from one list and mounting a stranger in another.
 */
type RosterEntry =
  | { kind: "channel"; key: string; channel: ChannelSummary }
  | {
      kind: "section";
      key: string;
      section: SidebarSection;
      collapsed: boolean;
      isEmpty: boolean;
    }
  | { kind: "rule"; key: string };

/**
 * The roster's entries in drawing order: pinned conversations, then each section's heading and,
 * unless it is folded, its conversations, then a rule and every conversation filed under none.
 */
function rosterEntries(
  channels: ChannelSummary[] | undefined,
  sections: SidebarSection[] | undefined,
  isCollapsed: (sectionId: string) => boolean,
): RosterEntry[] {
  const roster = sidebarRoster(channels, sections);
  const row = (channel: ChannelSummary): RosterEntry => ({
    kind: "channel",
    key: channel.id,
    channel,
  });
  return [
    ...roster.pinned.map(row),
    ...roster.sections.flatMap(({ section, channels: filed }) => {
      const collapsed = isCollapsed(section.id);
      return [
        {
          kind: "section" as const,
          key: `section:${section.id}`,
          section,
          collapsed,
          isEmpty: filed.length === 0,
        },
        ...(collapsed ? [] : filed.map(row)),
      ];
    }),
    // Without a rule the unfiled conversations read as the last section's.
    ...(roster.sections.length > 0 && roster.ungrouped.length > 0
      ? [{ kind: "rule" as const, key: "rule:ungrouped" }]
      : []),
    ...roster.ungrouped.map(row),
  ];
}

/** A section heading or the rule, moving with the rows around it. */
function RosterDecoration({
  animateOrder,
  children,
}: {
  animateOrder: boolean;
  children: React.ReactNode;
}) {
  const rowMotion = useRowMotion(animateOrder);
  return <motion.div {...rowMotion}>{children}</motion.div>;
}

/**
 * The left column: a search and a new-chat button, the person's own Bot, the conversations, and
 * at the foot the account menu beside the door to the Marketplace.
 *
 * No wordmark: the product's name is the tab title and the featured Bot is the brand's face. The
 * nine configuration links that used to fill the footer live in Settings and the Marketplace now,
 * reached from the two controls at the bottom and from the Mod+, and Mod+Shift+M shortcuts.
 *
 * The magnifier opens the search popup (./search-palette.tsx), as Mod+K does; the conversations
 * are drawn pinned first, then under this person's own sections, then the rest.
 */
export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const emphasis = useMessageListEmphasis();
  const channels = useInfiniteQuery(channelListQueryOptions());
  const sections = useQuery(sectionListQueryOptions());
  // One socket for the app, opened where the roster is kept live. Nothing else may open it.
  useChannelEvents();
  const { isMobile, setOpenMobile } = useSidebar();
  const [searchOpen, setSearchOpen] = useState(false);
  useHotkey("search", () => {
    setSearchOpen((open) => !open);
  });
  const { isCollapsed, toggle } = useCollapsedSections();
  const scrollRoot = useRef<HTMLDivElement>(null);
  const entries = rosterEntries(channels.data, sections.data, isCollapsed);
  const sectionIds = (sections.data ?? []).map((section) => section.id);
  const animateOrder = (channels.data?.length ?? 0) <= MAX_ANIMATED_ROWS;

  return (
    <>
      <Sidebar {...props}>
        <SidebarHeader className="flex-row items-center justify-end gap-2 px-4 pt-4 pb-0">
          <Button
            aria-label="Search"
            aria-haspopup="dialog"
            aria-expanded={searchOpen}
            className={headerButtonClassName}
            onClick={() => setSearchOpen(true)}
            size="icon-lg"
            variant="ghost"
          >
            <IconSearch />
          </Button>
          <Button
            aria-label="New chat"
            className={headerButtonClassName}
            size="icon-lg"
            variant="ghost"
            render={(buttonProps) => (
              <Link
                {...buttonProps}
                // `compose`: nobody preselected, and the To: menu opens on who to talk to.
                search={{ compose: 1 }}
                to="/channel/new"
                activeProps={{ className: "bg-muted" }}
              />
            )}
          >
            <IconPlus />
          </Button>
        </SidebarHeader>
        <SidebarContent ref={scrollRoot} className="scroll-fade-b">
          <SidebarMenu>
            <SidebarGroup className="gap-px px-3">
              <FeaturedBot />
              <div className="h-2 w-full" />
              {/* Bots that need you, or that you paused. See bot-profile/attention.tsx. */}
              <BotAttentionList />
              {channels.data?.length === 0 ? (
                <div className="py-4">
                  <Empty className="border border-dashed min-h-[40dvh]">
                    <EmptyHeader>
                      <EmptyTitle>You don't have channels yet</EmptyTitle>
                      <EmptyDescription className="text-pretty">
                        Start talking to agents and your channels will appear
                        here.
                      </EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                </div>
              ) : null}
              <AnimatePresence initial={false}>
                {entries.map((entry) => {
                  if (entry.kind === "channel") {
                    return (
                      <ChannelRow
                        emphasis={emphasis}
                        key={entry.key}
                        animateOrder={animateOrder}
                        channel={entry.channel}
                      />
                    );
                  }
                  if (entry.kind === "section") {
                    return (
                      <RosterDecoration
                        animateOrder={animateOrder}
                        key={entry.key}
                      >
                        <SidebarSectionHeader
                          collapsed={entry.collapsed}
                          isEmpty={entry.isEmpty}
                          onToggle={() => toggle(entry.section.id)}
                          section={entry.section}
                          sectionIds={sectionIds}
                        />
                      </RosterDecoration>
                    );
                  }
                  return (
                    <RosterDecoration
                      animateOrder={animateOrder}
                      key={entry.key}
                    >
                      <div className="mx-3 my-2 h-px bg-border" />
                    </RosterDecoration>
                  );
                })}
              </AnimatePresence>
              <ChannelPagination
                query={channels}
                scrollRoot={scrollRoot}
                // The search is a popup over the app now and filters nothing here, so the
                // roster never holds a filtered-down list for the sentinel to fall into.
                searching={false}
              />
            </SidebarGroup>
          </SidebarMenu>
        </SidebarContent>
        <SidebarFooter className="flex-row items-center gap-3 px-4 pt-2 pb-4">
          <AccountMenu />
          <ConnectAppsButton />
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>
      {/* Beside the sidebar, not in it: on a phone the sidebar is a sheet that may be shut. */}
      <SearchPalette
        onNavigate={() => {
          if (isMobile) setOpenMobile(false);
        }}
        onOpenChange={setSearchOpen}
        open={searchOpen}
      />
    </>
  );
}
