import { IconSearch } from "@tabler/icons-react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type * as React from "react";
import { useEffect, useId, useState } from "react";
import { ChannelAvatar } from "@/components/channels/avatar";
import { useSettingsNav } from "@/components/settings/settings-nav";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { channelListQueryOptions } from "@/lib/channels/queries";
import { cn } from "@/lib/utils";
import { botLandingTarget } from "./bot-target";
import {
  botLines,
  type PaletteItem,
  paletteGroups,
  settingTitle,
} from "./palette-items";

/**
 * The search the sidebar's magnifier opens, and Mod+K from anywhere the sidebar is: a box, and
 * under it every Bot and every Settings section, narrowed as you type. Drawn the way Grok Bot draws
 * its own: one card, the box across the top, one row per result with a face or an icon, the row
 * under the pointer or the arrow keys filled in.
 *
 * It used to be an inline filter over the conversations. That filter could only find what the
 * roster had already loaded, and a person reaching for the magnifier is usually looking for a Bot
 * or a setting rather than a line of an old chat. What the rows are is ./palette-items.ts.
 *
 * Keyboard: the caret stays in the box the whole time. Up and Down move the filled row, Enter
 * opens it, Escape closes. The box is a combobox pointing at the filled row through
 * `aria-activedescendant`, so a screen reader follows the arrows without focus ever leaving it.
 */
export function SearchPalette({
  open,
  onOpenChange,
  onNavigate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** After a row was chosen and the navigation started: the phone's sidebar sheet closes here. */
  onNavigate?: () => void;
}) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        className="top-[18svh] w-[calc(100%-2rem)] max-w-[560px] translate-y-0 gap-0 overflow-hidden rounded-2xl p-0"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">Search</DialogTitle>
        {/* Mounted with the popup, so every opening starts from an empty box and the first row. */}
        <PaletteBody
          onChosen={() => {
            onOpenChange(false);
            onNavigate?.();
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

function PaletteBody({ onChosen }: { onChosen: () => void }) {
  const navigate = useNavigate();
  const agents = useQuery(agentListQueryOptions()).data;
  const channels = useInfiniteQuery(channelListQueryOptions()).data;
  const isAdmin = useQuery(currentUserQueryOptions()).data?.role === "admin";
  const settings = useSettingsNav();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const optionId = (index: number) => `${listId}-option-${index}`;

  const groups = paletteGroups({
    query,
    bots: agents,
    channels,
    settings,
    isAdmin,
  });
  const items = groups.flatMap((group) => group.items);
  // Clamped on read rather than reset on write, so a list that shrank under the filled row (a Bot
  // deleted while the popup is open) fills its last row instead of none.
  const activeIndex = Math.min(active, items.length - 1);

  // The filled row stays in view while the arrows walk past the bottom of the scroller.
  useEffect(() => {
    if (activeIndex < 0) return;
    document
      .getElementById(`${listId}-option-${activeIndex}`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, listId]);

  const choose = (item: PaletteItem | undefined) => {
    if (!item) return;
    onChosen();
    if (item.kind === "bot") {
      void navigate(botLandingTarget(item.bot.id, channels, agents));
    } else if (item.kind === "hidden-chat") {
      void navigate({
        // Two or more Bots is a group conversation, with its own route, as on the roster row.
        to:
          item.channel.agentIds.length > 1
            ? "/group/$channelId"
            : "/channel/$channelId",
        params: { channelId: item.channel.id },
      });
    } else {
      void navigate({ to: item.setting.to });
    }
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive(Math.min(activeIndex + 1, items.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive(Math.max(activeIndex - 1, 0));
    } else if (event.key === "Enter") {
      // Not while an IME is composing: that Enter accepts the composition, it is not a choice.
      if (event.nativeEvent.isComposing) return;
      event.preventDefault();
      choose(items[activeIndex]);
    }
  };

  let index = -1;
  return (
    <>
      <div className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-5">
        <IconSearch
          aria-hidden
          className="size-[18px] shrink-0 text-muted-foreground"
        />
        <input
          aria-activedescendant={
            activeIndex >= 0 ? optionId(activeIndex) : undefined
          }
          aria-autocomplete="list"
          aria-controls={listId}
          aria-expanded
          aria-label="Search Bots and Settings"
          autoComplete="off"
          // Base UI focuses the first tabbable element in the popup, which is this one.
          className="h-full min-w-0 flex-1 bg-transparent text-[16px] text-foreground outline-none placeholder:text-muted-foreground"
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          placeholder="Search"
          role="combobox"
          spellCheck={false}
          type="text"
          value={query}
        />
      </div>
      <div
        aria-label="Results"
        className="max-h-[min(440px,60svh)] overflow-y-auto p-2"
        id={listId}
        role="listbox"
      >
        {items.length === 0 ? (
          <p className="px-3 py-6 text-center text-[14px] text-muted-foreground">
            No Bots or settings match “{query.trim()}”.
          </p>
        ) : null}
        {groups.map((group) => (
          // No visible heading, as in Grok Bot's popup: the rows say what they are. The group still
          // names itself to a screen reader.
          // biome-ignore lint/a11y/useSemanticElements: a listbox may own only options and groups, and a fieldset is neither.
          <div aria-label={group.label} key={group.id} role="group">
            {group.items.map((item) => {
              index += 1;
              const at = index;
              return (
                // biome-ignore lint/a11y/useKeyWithClickEvents: the keyboard path is the box's own (arrows and Enter, through aria-activedescendant); focus never moves to an option.
                <div
                  aria-selected={at === activeIndex}
                  className={cn(
                    "flex min-h-[52px] cursor-default items-center gap-3 rounded-xl px-3 py-1.5",
                    at === activeIndex && "bg-muted",
                  )}
                  id={optionId(at)}
                  key={item.key}
                  onClick={() => choose(item)}
                  // Keeps the caret in the box: a click must not move focus before it lands.
                  onMouseDown={(event) => event.preventDefault()}
                  // Movement, not entry: a list scrolling under a still pointer must not steal the
                  // row the arrow keys just filled.
                  onMouseMove={() => {
                    if (at !== activeIndex) setActive(at);
                  }}
                  role="option"
                  tabIndex={-1}
                >
                  <PaletteRow item={item} />
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </>
  );
}

function PaletteRow({ item }: { item: PaletteItem }) {
  if (item.kind === "setting") {
    const Icon = item.setting.icon;
    return (
      <>
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          {Icon ? <Icon className="size-4" /> : null}
        </span>
        <TwoLines primary={settingTitle(item.setting)} secondary="Settings" />
      </>
    );
  }
  if (item.kind === "hidden-chat") {
    const { channel } = item;
    return (
      <>
        <span className="shrink-0">
          <ChannelAvatar participantIds={channel.agentIds} size={28} />
        </span>
        <TwoLines
          label="Hidden"
          primary={channel.name}
          secondary={
            channel.summary || channel.lastMessage || "New conversation"
          }
        />
      </>
    );
  }
  const { label, description } = botLines(item.bot);
  return (
    <>
      <span className="shrink-0">
        <ChannelAvatar participantIds={[item.bot.id]} size={28} />
      </span>
      <TwoLines label={label} primary={item.bot.name} secondary={description} />
    </>
  );
}

/** A name, an optional small label beside it, and one muted line under it. */
function TwoLines({
  primary,
  label,
  secondary,
}: {
  primary: string;
  label?: string | null;
  secondary: string | null;
}) {
  return (
    <div className="min-w-0 flex-1">
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 truncate text-[15px] leading-5 text-foreground">
          {primary}
        </span>
        {label ? (
          <span className="min-w-0 max-w-[55%] shrink-[2] truncate rounded-md border border-border bg-muted/60 px-1.5 text-[12px] leading-5 text-muted-foreground">
            {label}
          </span>
        ) : null}
      </div>
      {secondary ? (
        <div className="truncate text-[14px] leading-5 text-muted-foreground">
          {secondary}
        </div>
      ) : null}
    </div>
  );
}
