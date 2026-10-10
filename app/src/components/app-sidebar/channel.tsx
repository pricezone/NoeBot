import {
  IconBellCheck,
  IconBellRinging,
  IconCheck,
  IconCopy,
  IconEdit,
  IconEyeOff,
  IconFolder,
  IconFolderMinus,
  IconFolderPlus,
  IconPin,
  IconPinnedOff,
  IconPlus,
  IconTrash,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { memo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { readLastBot } from "@/lib/agents/last-bot";
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  deleteChannelMutationOptions,
  markChannelReadMutationOptions,
  markChannelUnreadMutationOptions,
  setChannelHiddenMutationOptions,
  setChannelPinnedMutationOptions,
} from "@/lib/channels/mutations";
import { channelListQueryOptions } from "@/lib/channels/queries";
import {
  createSectionMutationOptions,
  MAX_SECTION_NAME_LENGTH,
  sectionListQueryOptions,
  setChannelSectionMutationOptions,
} from "@/lib/channels/sections";
import { landingTarget } from "@/lib/landing";
import type { MessageListEmphasis } from "@/lib/settings/message-list";
import { useTypedReveal } from "@/lib/typed-reveal";
import { ChannelItemContent } from "./channel-item-content";
import { NameDialog } from "./name-dialog";
import { RenameBotDialog } from "./rename-bot-dialog";

/**
 * The menu's rows, drawn the way Grok Bot draws its own: roomier than the app's other menus, with
 * the icon a size up, because this one is opened on a row the size of a finger and read at a glance.
 */
const MENU_ITEM_CLASS =
  "gap-2.5 rounded-lg px-2.5 py-2 text-[15px] [&_svg:not([class*='size-'])]:size-[18px]";

/** The dialog the row has open, if any. One at a time, so one state rather than three booleans. */
type RowDialog = "delete" | "new-section" | "rename-bot";

/**
 * Memoized roster row. `use-channel-events` preserves unchanged row identity, and
 * `content-visibility` keeps off-screen rows cheap without virtualization.
 *
 * Right-click opens the row's menu, in Grok Bot's order: Pin, Move to new section, Mark as Unread;
 * Rename Bot; Copy conversation ID; Hide from sidebar, Delete. Deleting is confirmed in a dialog
 * that names the channel, because the row it was invoked on is one of several identical-looking
 * rows. Every marker the menu sets (pin, section, read, hidden) is the caller's own and nobody
 * else's in the conversation.
 */
export const Channel = memo(function Channel({
  channelId,
  participantIds,
  name,
  summary,
  lastMessage,
  lastMessageAt,
  pinned,
  unread,
  busy,
  emphasis,
  canMarkUnread = false,
  sectionId = null,
}: {
  channelId: string;
  participantIds: string[];
  name: string;
  /** What the conversation is about, once named. The channel name only says which Bot it is. */
  summary?: string;
  /** Used as the thread title until the conversation has been named. */
  lastMessage?: string;
  lastMessageAt?: string;
  pinned: boolean;
  unread: boolean;
  busy: boolean;
  emphasis: MessageListEmphasis;
  /**
   * Whether the last thing said here is a Bot's, which is the only kind of message the unread dot
   * is for (`hasUnseenActivity`). Mark as Unread is greyed out otherwise: there is nothing it could
   * bring back, and the server would refuse it.
   */
  canMarkUnread?: boolean;
  /** Which of this person's sections the row is filed under, or null. */
  sectionId?: string | null;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  // Whether this row's channel is the one on screen, as a boolean, so navigating between
  // channels re-renders the two rows whose answer changed rather than the whole roster.
  const isOpen = useParams({
    strict: false,
    select: (params) =>
      (params as { channelId?: string }).channelId === channelId,
  });
  /* Types in only on arrival; an already-named row draws it outright. */
  const revealed = useTypedReveal(summary);
  const threadTitle = revealed.text || lastMessage || "New conversation";
  const setPinned = useMutation(setChannelPinnedMutationOptions(queryClient));
  const deleteChannel = useMutation(deleteChannelMutationOptions(queryClient));
  const markRead = useMutation(markChannelReadMutationOptions(queryClient));
  const markUnread = useMutation(markChannelUnreadMutationOptions(queryClient));
  const setHidden = useMutation(setChannelHiddenMutationOptions(queryClient));
  const setSection = useMutation(setChannelSectionMutationOptions(queryClient));
  const createSection = useMutation(createSectionMutationOptions(queryClient));
  const [dialog, setDialog] = useState<RowDialog | null>(null);
  /**
   * Why something asked of this row did not take, said on the row it was asked of.
   *
   * Pinning used to fail in total silence: the menu closed, the pin did not move, and nothing on
   * screen accounted for it — which reads as the app ignoring the click. A refusal is said where
   * the person was looking, the row, rather than in a toast in a corner, and is replaced by the
   * next attempt. Every action in the menu reports here.
   */
  const [problem, setProblem] = useState<string | null>(null);
  /** A Bot can be renamed from its own conversation only: a group's row names several. */
  const botId = participantIds.length === 1 ? participantIds[0] : undefined;
  const bot = useQuery({
    ...agentListQueryOptions(),
    // Read from the cache the sidebar already holds, never fetched on a row's behalf.
    enabled: false,
    select: (agents) => agents.find((agent) => agent.id === botId),
  }).data;
  // Unknown is allowed, and left to the server: a Bot shared with you may not be in your list.
  const canRenameBot = botId !== undefined && bot?.canManage !== false;

  /** Report a failed mutation on the row, replacing whatever it said before. */
  const reportTo = { onError: (thrown: Error) => setProblem(thrown.message) };

  /*
   * Away first when this row's channel is the one on screen.
   *
   * For a delete, the roster invalidates the moment it lands, so this row — and the dialog living
   * inside it — unmounts while the rest of the work is still owed; navigating afterwards ran in a
   * component that was already gone, leaving somebody looking at a conversation that no longer
   * exists. For Mark as Unread, the open channel marks itself read the instant its dot comes back
   * (`routes/_authed/_app/channel/$channelId.tsx`), so staying would undo the click on the spot.
   * Leaving before asking is safe in the other direction: a refusal puts them on the roster with
   * the channel still in it, and says why.
   *
   * Where to is decided here, not by `/`. Home redirects to a conversation (`lib/landing.ts`) from
   * the cached roster, and at this point the roster still holds this channel. The channel route
   * also just recorded this Bot as the last one used, so the newest conversation with it, the one
   * home would pick, is usually this very channel: going to `/` sent the person straight back into
   * it. So the same rule runs on the roster minus this channel, and the result replaces the history
   * entry rather than stacking on it, so Back does not return to a conversation that is about to
   * be gone or read. `/` remains the last resort, for a cache with nothing to land on.
   */
  const leaveIfOpen = async () => {
    if (!isOpen) return;
    const pages = queryClient.getQueryData(channelListQueryOptions().queryKey);
    const target = landingTarget({
      lastBotId: readLastBot(),
      channels: pages?.pages
        .flatMap((page) => page.channels)
        .filter((channel) => channel.id !== channelId),
      agents: queryClient.getQueryData(agentListQueryOptions().queryKey),
    });
    await navigate(
      target ? { ...target, replace: true } : { to: "/", replace: true },
    );
  };

  const confirmDelete = async () => {
    await leaveIfOpen();
    try {
      await deleteChannel.mutateAsync(channelId);
    } catch {
      // The error is on the mutation and rendered in the dialog; leaving it open says "not done".
      return;
    }
    setDialog(null);
  };

  const copyConversationId = async () => {
    try {
      await navigator.clipboard.writeText(channelId);
      toast("Conversation ID copied");
    } catch {
      // No clipboard in this context: an insecure origin, or a permission the browser refused.
      setProblem("This browser did not allow copying to the clipboard.");
    }
  };

  return (
    <>
      <ContextMenu
        onOpenChange={(open) => {
          // A refusal from a previous attempt is not news about the next one.
          if (open) setProblem(null);
        }}
      >
        <ContextMenuTrigger>
          <Link
            // Two or more Bots is a group conversation, which has its own shared transcript.
            to={
              participantIds.length > 1
                ? "/group/$channelId"
                : "/channel/$channelId"
            }
            params={{ channelId }}
            type="button"
            className="flex h-16 w-full flex-row items-center gap-3 rounded-xl px-3 hover:bg-foreground/5 [contain-intrinsic-size:auto_4rem] [content-visibility:auto]"
            activeProps={{
              className: "bg-foreground/8",
            }}
          >
            <ChannelItemContent
              participantIds={participantIds}
              name={name}
              title={summary || lastMessage || "New conversation"}
              displayedTitle={threadTitle}
              lastMessageAt={lastMessageAt}
              emphasis={emphasis}
              busy={busy}
              unread={unread}
              pinned={pinned}
              revealing={revealed.typing}
            />
          </Link>
        </ContextMenuTrigger>
        <ContextMenuContent className="min-w-60 rounded-2xl p-1.5">
          <ContextMenuItem
            className={MENU_ITEM_CLASS}
            onClick={() =>
              setPinned.mutate({ channelId, pinned: !pinned }, reportTo)
            }
          >
            {pinned ? <IconPinnedOff /> : <IconPin />}
            {pinned ? "Unpin" : "Pin"}
          </ContextMenuItem>
          <ContextMenuSub>
            <ContextMenuSubTrigger className={MENU_ITEM_CLASS}>
              <IconFolderPlus />
              Move to new section
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className="min-w-52 rounded-2xl p-1.5">
              <SectionChoices
                currentSectionId={sectionId}
                onChoose={(next) =>
                  setSection.mutate({ channelId, sectionId: next }, reportTo)
                }
                onNewSection={() => setDialog("new-section")}
              />
            </ContextMenuSubContent>
          </ContextMenuSub>
          {unread ? (
            <ContextMenuItem
              className={MENU_ITEM_CLASS}
              onClick={() => markRead.mutate(channelId, reportTo)}
            >
              <IconBellCheck />
              Mark as Read
            </ContextMenuItem>
          ) : (
            <ContextMenuItem
              className={MENU_ITEM_CLASS}
              disabled={!canMarkUnread}
              onClick={() => {
                void leaveIfOpen().then(() =>
                  markUnread.mutate(channelId, reportTo),
                );
              }}
            >
              <IconBellRinging />
              Mark as Unread
            </ContextMenuItem>
          )}
          {botId !== undefined ? (
            <>
              <ContextMenuSeparator className="mx-1" />
              <ContextMenuItem
                className={MENU_ITEM_CLASS}
                disabled={!canRenameBot}
                onClick={() => setDialog("rename-bot")}
              >
                <IconEdit />
                Rename Bot
              </ContextMenuItem>
            </>
          ) : null}
          <ContextMenuSeparator className="mx-1" />
          <ContextMenuItem
            className={MENU_ITEM_CLASS}
            onClick={() => void copyConversationId()}
          >
            <IconCopy />
            Copy conversation ID
          </ContextMenuItem>
          <ContextMenuSeparator className="mx-1" />
          <ContextMenuItem
            className={MENU_ITEM_CLASS}
            onClick={() =>
              setHidden.mutate(
                { channelId, hidden: true },
                {
                  ...reportTo,
                  onSuccess: () => toast("Chat hidden. Search still finds it."),
                },
              )
            }
          >
            <IconEyeOff />
            Hide from sidebar
          </ContextMenuItem>
          <ContextMenuItem
            className={MENU_ITEM_CLASS}
            variant="destructive"
            onClick={() => {
              // A refusal from a previous attempt is not news about this one.
              deleteChannel.reset();
              setDialog("delete");
            }}
          >
            <IconTrash />
            Delete
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {problem ? (
        <p className="px-2 pb-1 text-destructive text-xs" role="alert">
          {problem}
        </p>
      ) : null}
      {dialog === "new-section" ? (
        <NameDialog
          description={`“${name}” moves into it.`}
          label="Section name"
          maxLength={MAX_SECTION_NAME_LENGTH}
          onClose={() => setDialog(null)}
          onSubmit={async (sectionName) => {
            const section = await createSection.mutateAsync(sectionName);
            await setSection.mutateAsync({ channelId, sectionId: section.id });
          }}
          submitLabel="Create"
          title="New section"
        />
      ) : null}
      {dialog === "rename-bot" && botId !== undefined ? (
        <RenameBotDialog
          agentId={botId}
          currentName={bot?.name ?? name}
          onClose={() => setDialog(null)}
        />
      ) : null}
      <Dialog
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
        open={dialog === "delete"}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {name}?</DialogTitle>
            <DialogDescription>
              The conversation will no longer appear for anyone in it.
            </DialogDescription>
          </DialogHeader>
          {deleteChannel.error ? (
            <p className="text-destructive text-sm">
              {deleteChannel.error.message}
            </p>
          ) : null}
          <DialogFooter>
            <Button onClick={() => setDialog(null)} size="sm" variant="ghost">
              Cancel
            </Button>
            <Button
              disabled={deleteChannel.isPending}
              onClick={() => {
                void confirmDelete();
              }}
              size="sm"
              variant="destructive"
            >
              {deleteChannel.isPending ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
});

/**
 * The "Move to new section" submenu: this person's sections, then a new one, then out of the one
 * the chat is in. Its own component so the sections are only read while the submenu is open,
 * rather than by every row of the roster on every render.
 */
function SectionChoices({
  currentSectionId,
  onChoose,
  onNewSection,
}: {
  currentSectionId: string | null;
  onChoose: (sectionId: string | null) => void;
  onNewSection: () => void;
}) {
  const sections = useQuery(sectionListQueryOptions()).data ?? [];
  return (
    <>
      {sections.map((section) => {
        const current = section.id === currentSectionId;
        return (
          <ContextMenuItem
            className={MENU_ITEM_CLASS}
            // Already there: shown so the list reads as "where this chat is", not offered as a move.
            disabled={current}
            key={section.id}
            onClick={() => onChoose(section.id)}
          >
            <IconFolder />
            <span className="min-w-0 flex-1 truncate">{section.name}</span>
            {current ? <IconCheck aria-label="Current section" /> : null}
          </ContextMenuItem>
        );
      })}
      {sections.length > 0 ? <ContextMenuSeparator className="mx-1" /> : null}
      <ContextMenuItem className={MENU_ITEM_CLASS} onClick={onNewSection}>
        <IconPlus />
        New section…
      </ContextMenuItem>
      {currentSectionId !== null ? (
        <ContextMenuItem
          className={MENU_ITEM_CLASS}
          onClick={() => onChoose(null)}
        >
          <IconFolderMinus />
          Remove from section
        </ContextMenuItem>
      ) : null}
    </>
  );
}
