import type { Message } from "@ag-ui/core";
import { IconPlus, IconUsersGroup } from "@tabler/icons-react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { type MouseEvent, useRef, useState } from "react";
import { ChannelAvatar } from "@/components/channels/avatar";
import { personBubbleScheme } from "@/components/channels/bubbles";
import {
  canSend,
  MAX_GROUP_RECIPIENTS,
  type Recipient,
} from "@/components/channels/compose-state";
import { ConversationView } from "@/components/channels/conversation-view";
import {
  firstRunGreeting,
  seedMessage,
} from "@/components/channels/transcript-messages";
import { SidebarToggle } from "@/components/layout/sidebar-toggle";
import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  useComboboxAnchor,
} from "@/components/ui/combobox";
import { defaultAgentProfile } from "@/lib/agents/default-agent";
import { quickCreateAgentMutationOptions } from "@/lib/agents/mutations";
import {
  type AgentProfile,
  agentListQueryOptions,
  agentQueryOptions,
} from "@/lib/agents/queries";
import {
  type AgentChannel,
  channelKeys,
  channelListQueryOptions,
} from "@/lib/channels/queries";
import { useStartChannel } from "@/lib/channels/start";
import { createGroupMutationOptions, postGroupMessage } from "@/lib/groups";
import { useSkillCommands } from "@/lib/plugins/skill-commands";
import { newId } from "../../../../lib/new-id";

/**
 * Creates the channel on first send. The selected coworker stays in the URL so profile links and
 * reloads preserve the pending recipient without creating an empty channel.
 */
/** What `GET /api/agents/:id` answers for a Bot this person cannot see. */
const AGENT_NOT_FOUND = "Agent not found.";

/**
 * The "Create new Bot" and "Create group chat" rows at the top of the To: menu. They are buttons,
 * not combobox items: the items are Bots, and picking one answers the field, whereas these two
 * change what the field is for — one makes a Bot and opens its conversation, the other turns the
 * field into a list of Bots for a group. They sit above the Bot list so the menu offers them before
 * a name is typed.
 */
const ACTION_ROW_CLASS =
  "flex h-10 w-full items-center gap-2 rounded-lg px-2 text-left text-[15px] hover:bg-muted disabled:opacity-60";
const ACTION_BADGE_CLASS =
  "flex size-6 items-center justify-center rounded-full bg-muted";

/**
 * A row in the menu is taken with the mouse. A mousedown would move focus off the input and close
 * the menu before the click lands, so focus stays put until the row has acted.
 */
const keepFocus = (event: MouseEvent) => event.preventDefault();

/**
 * Whether what is typed narrows the Bot list. Base UI leaves the list unfiltered while the input
 * still holds the chosen Bot's name (opening the menu again shows every Bot), and the action rows
 * follow the same rule: they are shown until the person starts typing a name of their own.
 */
function isFilteringBots(typed: string, chosen: AgentProfile | undefined) {
  const query = typed.trim();
  if (query === "") return false;
  return query.toLocaleLowerCase() !== chosen?.name.toLocaleLowerCase();
}

/** `?compose=1` and `?group=1`, however the router decoded them: a number, a string or a boolean. */
function isOn(value: unknown): boolean {
  return value === 1 || value === "1" || value === true;
}

/**
 * - `agent`: the Bot the field is already answered with, from a profile link or a reload.
 * - `compose`: the sidebar's +. Nobody is preselected and the To: menu opens, so the first thing
 *   asked is who the conversation is with, rather than the default Bot answering for the person.
 * - `group`: the field starts as a list of Bots for a group conversation; `/group/new` lands here.
 */
type ChannelNewSearch = { agent?: string; compose?: 1; group?: 1 };

export const Route = createFileRoute("/_authed/_app/channel/new")({
  validateSearch: (search: Record<string, unknown>): ChannelNewSearch => ({
    ...(typeof search.agent === "string" ? { agent: search.agent } : {}),
    ...(isOn(search.compose) ? { compose: 1 as const } : {}),
    ...(isOn(search.group) ? { group: 1 as const } : {}),
  }),
  component: RouteComponent,
});

const toRecipient = (profile: AgentProfile): Recipient => ({
  id: profile.id,
  name: profile.name,
});

/** One Bot in the To: menu: its face, its name, and what it does. */
function BotRowContent({ bot }: { bot: AgentProfile }) {
  return (
    <>
      <ChannelAvatar participantIds={[bot.id]} size={24} />
      {bot.name}
      <span className="ml-1 truncate text-muted-foreground">{bot.title}</span>
    </>
  );
}

function RouteComponent() {
  const { agent, compose, group } = Route.useSearch();
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();
  const { startChosen, pending } = useStartChannel();
  const quickCreate = useMutation(quickCreateAgentMutationOptions(queryClient));
  const createGroup = useMutation(createGroupMutationOptions(queryClient));
  const { data: profiles, isError: rosterError } = useQuery(
    agentListQueryOptions(),
  );
  const channels = useInfiniteQuery(channelListQueryOptions());

  const [error, setError] = useState<string | null>(null);
  // Optimistic seed shown before the first channel record exists.
  const [sent, setSent] = useState<Message | null>(null);
  // What the To: input holds, so the action rows can step aside once a name is being typed.
  const [typed, setTyped] = useState("");
  /*
   * Group mode: the field holds a list of Bots as chips rather than one Bot. Local rather than in
   * the URL, because the chips are, and a reload that kept the mode and lost the Bots in it would
   * be a half-restored form.
   */
  const [groupMode, setGroupMode] = useState(group === 1);
  const [members, setMembers] = useState<AgentProfile[]>([]);
  const chipsAnchor = useComboboxAnchor();
  /**
   * A group created by a send whose first line then failed to post. Kept so the retry posts into
   * that group instead of making a second one with the same Bots; keyed by the Bots, so a retry
   * after changing them starts a fresh group.
   */
  const createdGroup = useRef<{ key: string; channel: AgentChannel } | null>(
    null,
  );

  // Stale or private `?agent=` values are ignored because the roster is permission-filtered.
  const listed = profiles?.find((profile) => profile.id === agent);
  /**
   * Hidden coworkers are omitted from the roster but may still be valid recipients from a profile
   * link, so fetch the URL-selected coworker when it is absent from the visible list.
   */
  const {
    data: fetched,
    isError: detailError,
    error: detailFailure,
    isPending: detailPending,
  } = useQuery({
    ...agentQueryOptions(agent ?? ""),
    enabled: Boolean(agent) && profiles !== undefined && !listed,
    retry: false,
  });
  const fromUrl = listed ?? (fetched?.id === agent ? fetched : undefined);
  // `compose` asks the question rather than answering it with the default Bot.
  const chosen =
    fromUrl ?? (agent || compose ? undefined : defaultAgentProfile(profiles));
  const needsUrlAgentDetail =
    Boolean(agent) && profiles !== undefined && !listed;
  const waitingForUrlAgent =
    needsUrlAgentDetail && detailPending && !detailError;
  const urlAgentDetailFailed = needsUrlAgentDetail && detailError && !fetched;
  const loadError =
    rosterError && profiles === undefined
      ? "Coworkers couldn't be loaded."
      : urlAgentDetailFailed
        ? /*
           * The server's 404 sentence (agents/routes.ts `mapStoreError`) means this person cannot see
           * the Bot: a shared Team Bot link lands here once it is unpublished or undescribed. Any
           * other failure is a load that can be retried, and says so.
           */
          detailFailure?.message === AGENT_NOT_FOUND
          ? "This Bot isn't available to you. It may be unpublished, not shared with you, or not described yet."
          : "Coworker couldn't be loaded."
        : null;
  const recipients: Recipient[] = groupMode
    ? members.map(toRecipient)
    : chosen
      ? [toRecipient(chosen)]
      : [];
  // A group has no one Bot whose skills the `/` menu could offer.
  const skillCommands = useSkillCommands(groupMode ? "" : (chosen?.id ?? ""));
  const showActions = !isFilteringBots(typed, chosen);
  /*
   * Somebody who has never had a conversation, which is where onboarding lands a new person. Only
   * once the list has loaded and holds nothing at all: a list still loading, or one that failed,
   * says nothing about whether they have channels, and anybody with one must never be greeted as
   * new. Their first send opens the conversation on the Computer tab, whose screenshot poll is
   * what starts the Bot's browser, so the greeting's promise is kept.
   */
  const firstRun =
    channels.isSuccess && channels.data.length === 0 && !channels.hasNextPage;

  /**
   * "Create new Bot": made in one click, and its conversation opened at once. The Bot speaks first
   * there, in a turn the server started; see `server/src/agents/first-turn.ts`.
   */
  const createBot = async () => {
    setError(null);
    try {
      const { channel } = await quickCreate.mutateAsync();
      await navigate({
        to: "/channel/$channelId",
        params: { channelId: channel.id },
      });
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not create the Bot.",
      );
    }
  };

  /**
   * Turn the field into a list of Bots, starting with `bot` when one asked for it ("Add to group
   * chat" on its row). A Bot the URL already chose comes along as the first chip: the person picked
   * it and is now adding to it. The default Bot does not — nobody picked that one.
   */
  const startGroupMode = (bot?: AgentProfile) => {
    const kept = fromUrl && fromUrl.id !== bot?.id ? [fromUrl] : [];
    setMembers([...kept, ...(bot ? [bot] : [])]);
    setTyped("");
    setGroupMode(true);
  };

  /**
   * Two or more Bots: the group is made with them, in the order they were added (the order they
   * answer in), named by the server from their names; the first line is posted into it; and the
   * group opens. Its transcript polls for the Bots' answers on its own.
   */
  const startGroup = async (agentIds: string[], text: string) => {
    const key = agentIds.join("\n");
    const channel =
      createdGroup.current?.key === key
        ? createdGroup.current.channel
        : await createGroup.mutateAsync(agentIds);
    createdGroup.current = { key, channel };
    queryClient.setQueryData(channelKeys.detail(channel.id), channel);
    await postGroupMessage(channel.id, { id: newId(), text, agentId: null });
    createdGroup.current = null;
    await navigate({
      to: "/group/$channelId",
      params: { channelId: channel.id },
      replace: true,
    });
  };

  if (profiles === undefined && !rosterError) return null;

  return (
    <div className="flex h-full flex-col">
      <div className="h-12 border-b border-border sticky top-0 flex flex-row px-2 items-center">
        <SidebarToggle className="mr-1" />
        <span className="text-sm text-muted-foreground">To:</span>
        {groupMode ? (
          <Combobox
            // Group mode is a choice the person just made, so the list is open and waiting.
            defaultOpen
            autoHighlight
            multiple
            items={profiles ?? []}
            isItemEqualToValue={(item: AgentProfile, value: AgentProfile) =>
              item.id === value.id
            }
            itemToStringLabel={(item: AgentProfile) => item.name}
            itemToStringValue={(item: AgentProfile) => item.id}
            // Kept in the order they were added; past the cap a further pick is not taken.
            onValueChange={(next: AgentProfile[]) =>
              setMembers(next.slice(0, MAX_GROUP_RECIPIENTS))
            }
            value={members}
          >
            <ComboboxChips
              ref={chipsAnchor}
              className="min-h-0 flex-1 border-none bg-transparent py-0 focus-within:ring-0 dark:bg-transparent"
            >
              {members.map((member) => (
                <ComboboxChip key={member.id}>{member.name}</ComboboxChip>
              ))}
              <ComboboxChipsInput
                aria-label="Add Bots"
                autoFocus
                className="h-8 bg-transparent text-sm"
                placeholder="Add Bots…"
              />
            </ComboboxChips>
            <ComboboxContent
              anchor={chipsAnchor}
              className="min-w-0 max-w-lg"
              sideOffset={12}
            >
              <ComboboxEmpty>No agents found.</ComboboxEmpty>
              <ComboboxList>
                {(item: AgentProfile) => (
                  <ComboboxItem key={item.id} value={item} className="h-10">
                    <BotRowContent bot={item} />
                  </ComboboxItem>
                )}
              </ComboboxList>
            </ComboboxContent>
          </Combobox>
        ) : (
          <Combobox
            // Do not auto-open when the recipient came from the URL; the field is already answered.
            defaultOpen={!chosen && !loadError && !waitingForUrlAgent}
            autoHighlight
            items={profiles ?? []}
            isItemEqualToValue={(item: AgentProfile, value: AgentProfile) =>
              item.id === value.id
            }
            itemToStringLabel={(item: AgentProfile) => item.name}
            itemToStringValue={(item: AgentProfile) => item.id}
            onInputValueChange={(next) => setTyped(next)}
            onValueChange={(next) => {
              // Recipient changes are not separate navigation history entries. Cleared on a `+`
              // screen, the field stays unanswered rather than falling back to the default Bot.
              void navigate({
                replace: true,
                search: next
                  ? { agent: next.id }
                  : compose
                    ? { compose: 1 }
                    : {},
              });
            }}
            value={chosen ?? null}
          >
            <ComboboxInput
              // The popup opening is not enough on its own: typing filters through this input, so
              // the caret starts here whenever the recipient question is still open. Same condition
              // as `defaultOpen` — a recipient from the URL means the composer takes focus instead.
              autoFocus={!chosen}
              /*
               * Read from the field itself as well: clearing the whole selection in one keystroke
               * does not always reach `onInputValueChange`, and the rows above the Bot list stayed
               * hidden on a field that was visibly empty.
               */
              onChange={(event) => setTyped(event.currentTarget.value)}
              placeholder="Start a chat with…"
              // InputGroup owns focus rings via `has-[…:focus-visible]`; disable that wrapper ring here.
              className="border-none w-full bg-transparent! text-sm has-[[data-slot=input-group-control]:focus-visible]:ring-0"
            />
            {/* Allow max-w to constrain the popup even though its anchor is full-width. */}
            <ComboboxContent className="min-w-0 max-w-lg" sideOffset={12}>
              {showActions ? (
                <div className="border-b border-border p-1">
                  <button
                    aria-busy={quickCreate.isPending}
                    className={ACTION_ROW_CLASS}
                    disabled={quickCreate.isPending}
                    onClick={() => void createBot()}
                    onMouseDown={keepFocus}
                    type="button"
                  >
                    <span className={ACTION_BADGE_CLASS}>
                      <IconPlus className="size-4" />
                    </span>
                    Create new Bot
                  </button>
                  <button
                    className={ACTION_ROW_CLASS}
                    onClick={() => startGroupMode()}
                    onMouseDown={keepFocus}
                    type="button"
                  >
                    <span className={ACTION_BADGE_CLASS}>
                      <IconUsersGroup className="size-4" />
                    </span>
                    Create group chat
                  </button>
                </div>
              ) : null}
              <ComboboxEmpty>No agents found.</ComboboxEmpty>
              <ComboboxList>
                {(item: AgentProfile) => (
                  <ComboboxItem
                    key={item.id}
                    value={item}
                    className="group/bot h-10"
                  >
                    <BotRowContent bot={item} />
                    {/*
                     * Shown on the row under the pointer. A button inside the option rather than
                     * the option itself, so it must keep the option from taking the click too:
                     * Base UI selects on the click, and on a mouseup that began elsewhere.
                     */}
                    <button
                      className="ml-auto shrink-0 rounded-md px-1.5 py-0.5 text-[13px] text-muted-foreground opacity-0 hover:text-foreground group-hover/bot:opacity-100 group-data-highlighted/bot:opacity-100"
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        startGroupMode(item);
                      }}
                      onMouseDown={keepFocus}
                      onMouseUp={(event) => event.stopPropagation()}
                      tabIndex={-1}
                      type="button"
                    >
                      Add to group chat
                    </button>
                  </ComboboxItem>
                )}
              </ComboboxList>
            </ComboboxContent>
          </Combobox>
        )}
      </div>
      <ConversationView
        // Choosing a coworker answers the "To:" field, so the message is what remains: the caret
        // lands in the composer the moment a recipient exists, whether picked here or in the URL.
        autoFocus
        // Commands must be loaded before the first channel message is sent.
        commands={skillCommands}
        disabled={
          Boolean(loadError) || waitingForUrlAgent || recipients.length === 0
        }
        // The greeting is local: drawn here, never sent to the model and never stored.
        messages={sent ? [sent] : firstRun ? [firstRunGreeting()] : []}
        // The first message is already in the colour of the Bot it is going to.
        personScheme={personBubbleScheme(
          chosen
            ? [{ seed: chosen.avatarSeed, color: chosen.avatarColor }]
            : [],
        )}
        notice={
          loadError || error ? (
            <p className="pb-2 text-sm text-destructive" role="alert">
              {loadError ?? error}
            </p>
          ) : null
        }
        onSubmit={async (draft) => {
          const recipient = recipients[0];
          if (!recipient || !canSend(recipients, draft.text, groupMode)) return;

          setError(null);
          setSent(seedMessage(draft.text, newId()));

          try {
            if (recipients.length > 1) {
              await startGroup(
                recipients.map((member) => member.id),
                draft.text,
              );
            } else {
              // Recorded, then started: a coworker picked here is as much a choice as an `@` on
              // the home screen, and the trail has to say so for both. One Bot in group mode is
              // the same conversation, so it starts the same way.
              await startChosen(
                recipient.id,
                draft.text,
                firstRun ? { panel: "computer" } : undefined,
              );
            }
          } catch (caught) {
            // Preserve the unsent draft when channel creation fails.
            setSent(null);
            setError(
              caught instanceof Error
                ? caught.message
                : "Could not start the conversation.",
            );
            throw caught;
          }
        }}
        pending={pending || createGroup.isPending}
      />
    </div>
  );
}
