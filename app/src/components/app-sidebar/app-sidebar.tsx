import { IconPlus, IconSearch, IconX } from "@tabler/icons-react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type * as React from "react";
import { useRef, useState } from "react";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import {
  type ChannelSummary,
  channelListQueryOptions,
} from "@/lib/channels/queries";
import { useChannelEvents } from "@/lib/channels/use-channel-events";
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
import { ConnectAppsButton } from "./connect-apps-button";
import { FeaturedBot } from "./featured-bot";
import { isUnread, matchingChannels, pinnedFirst } from "./roster";

/*
 * The roster's rules live in ./roster.ts; re-exported here because the channel route and the tests
 * that pin each rule import them from the sidebar, and a move should not be their problem.
 */
export {
  hasUnseenActivity,
  isUnread,
  matchingChannels,
  pinnedFirst,
} from "./roster";

/**
 * Cap layout animation because `layout` measures every animated row on each reorder.
 */
const MAX_ANIMATED_ROWS = 60;

/** The two round buttons in the header: card-coloured discs, the way Grok Bot draws them. */
const headerButtonClassName =
  "size-9 rounded-full bg-card text-foreground hover:bg-muted aria-expanded:bg-muted [&_svg]:size-5";

/**
 * A roster row that can animate.
 *
 * Two movements only: a channel that did not exist fades in, and a channel that was just spoken in
 * moves to the top. Nothing else animates, a roster that reacts to being read is a roster that
 * moves under the cursor.
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
  const shouldReduceMotion = useReducedMotion();
  // Whether this row is unread, as a boolean, for the same reason `Channel` computes `isOpen`
  // that way: navigating re-renders the rows whose answer changed, not the whole roster.
  const unread = useParams({
    strict: false,
    select: (params) =>
      isUnread(channel, (params as { channelId?: string }).channelId),
  });
  return (
    <motion.div
      animate={{ opacity: 1, transform: "translateY(0px)" }}
      initial={{
        opacity: 0,
        transform: shouldReduceMotion ? "none" : "translateY(-8px)",
      }}
      exit={{ opacity: 0 }}
      layout={animateOrder && !shouldReduceMotion ? "position" : false}
      transition={{ duration: ENTRANCE_SECONDS, ease: EASE_OUT }}
    >
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
      />
    </motion.div>
  );
}

/**
 * The left column: a search and a new-chat button, the person's own Bot, the conversations, and
 * at the foot the account menu beside the door to the Marketplace.
 *
 * No wordmark: the product's name is the tab title and the featured Bot is the brand's face. The
 * nine configuration links that used to fill the footer live in Settings and the Marketplace now,
 * reached from the two controls at the bottom and from the Mod+, and Mod+Shift+M shortcuts.
 */
export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const emphasis = useMessageListEmphasis();
  const channels = useInfiniteQuery(channelListQueryOptions());
  // One socket for the app, opened where the roster is kept live. Nothing else may open it.
  useChannelEvents();
  const [search, setSearch] = useState("");
  /*
   * The search box is hidden until asked for. Grok Bot's sidebar shows a magnifier and nothing
   * else, and the box takes a row a two-item roster would rather give to the conversations. It
   * stays while a filter is typed into it, whatever the toggle says, so a filter can never be in
   * force with nothing on screen to explain the missing rows.
   */
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInput = useRef<HTMLInputElement>(null);
  const scrollRoot = useRef<HTMLDivElement>(null);
  const searching = search.trim().length > 0;
  const searchVisible = searchOpen || searching;
  const visibleChannels = pinnedFirst(matchingChannels(channels.data, search));
  /*
   * FILTERING DOES NOT ANIMATE. Rows exit and relayout on every keystroke otherwise, which is a
   * list thrashing under somebody who is still typing — and the moving target is the very thing
   * they are trying to read. Order animation is for a channel that was just spoken in, which is
   * occasional; this is not.
   */
  const animateOrder =
    !searching && (channels.data?.length ?? 0) <= MAX_ANIMATED_ROWS;

  const toggleSearch = () => {
    if (searchVisible) {
      // Closing the box also drops the filter: a hidden filter is a roster missing rows for no
      // visible reason.
      setSearch("");
      setSearchOpen(false);
      return;
    }
    setSearchOpen(true);
    // After the box has rendered; the ref is empty until then.
    requestAnimationFrame(() => searchInput.current?.focus());
  };

  return (
    <Sidebar {...props}>
      <SidebarHeader className="flex-row items-center justify-end gap-2 px-4 pt-4 pb-0">
        <Button
          aria-label="Search channels"
          aria-expanded={searchVisible}
          className={headerButtonClassName}
          onClick={toggleSearch}
          size="icon-lg"
          variant="ghost"
        >
          {searchVisible ? <IconX /> : <IconSearch />}
        </Button>
        <Button
          aria-label="New chat"
          className={headerButtonClassName}
          size="icon-lg"
          variant="ghost"
          render={(buttonProps) => (
            <Link
              {...buttonProps}
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
            {searchVisible ? (
              <SidebarMenuItem className="pb-2">
                <InputGroup className="h-10 rounded-full bg-card text-sm">
                  <InputGroupInput
                    ref={searchInput}
                    aria-label="Search channels"
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Search..."
                    value={search}
                  />
                  <InputGroupAddon>
                    <IconSearch />
                  </InputGroupAddon>
                </InputGroup>
              </SidebarMenuItem>
            ) : null}
            <FeaturedBot />
            <div className="h-2 w-full" />
            {/* Bots that need you, or that you paused. See bot-profile/attention.tsx. */}
            <BotAttentionList />
            {/*
             * TWO DIFFERENT NOTHINGS, AND SAYING THE WRONG ONE IS ALARMING. A roster nobody has
             * used yet needs telling how to start. A roster that simply does not match what is in
             * the box has to say so and quote it back — told "you don't have channels yet" while
             * holding a typo, a person reads their conversations as gone.
             */}
            {searching && visibleChannels.length === 0 ? (
              <div className="py-4">
                <Empty className="border border-dashed min-h-[40dvh]">
                  <EmptyHeader>
                    <EmptyTitle>
                      {channels.hasNextPage
                        ? "No loaded channels match your search"
                        : "No channels match your search"}
                    </EmptyTitle>
                    <EmptyDescription className="text-pretty">
                      {channels.hasNextPage
                        ? "Load older conversations to search more of your history."
                        : `Nothing here is named “${search.trim()}”, and nobody has said it recently either.`}
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              </div>
            ) : null}
            {!searching && channels.data?.length === 0 ? (
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
              {visibleChannels.map((channel) => (
                <ChannelRow
                  emphasis={emphasis}
                  key={channel.id}
                  animateOrder={animateOrder}
                  channel={channel}
                />
              ))}
            </AnimatePresence>
            <ChannelPagination
              query={channels}
              scrollRoot={scrollRoot}
              searching={searching}
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
  );
}
