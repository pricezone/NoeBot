import type { Message } from "@ag-ui/core";
import { IconPlus, IconUsersGroup } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { ChannelAvatar } from "@/components/channels/avatar";
import { canSend, type Recipient } from "@/components/channels/compose-state";
import { ConversationView } from "@/components/channels/conversation-view";
import { seedMessage } from "@/components/channels/transcript-messages";
import { SidebarToggle } from "@/components/layout/sidebar-toggle";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import { defaultAgentProfile } from "@/lib/agents/default-agent";
import {
  type AgentProfile,
  agentListQueryOptions,
  agentQueryOptions,
} from "@/lib/agents/queries";
import { useStartChannel } from "@/lib/channels/start";
import { useSkillCommands } from "@/lib/plugins/skill-commands";
import { newId } from "../../../../lib/new-id";

/**
 * Creates the channel on first send. The selected coworker stays in the URL so profile links and
 * reloads preserve the pending recipient without creating an empty channel.
 */
/** What `GET /api/agents/:id` answers for a Bot this person cannot see. */
const AGENT_NOT_FOUND = "Agent not found.";

/**
 * The "Create new Bot" and "Create group chat" rows at the top of the To: menu. They are links,
 * not combobox items: the items are Bots, and picking one answers the field, whereas these two
 * leave the page. They sit above the Bot list so the menu offers them before a name is typed.
 */
const ACTION_ROW_CLASS =
  "flex h-10 w-full items-center gap-2 rounded-lg px-2 text-[15px] hover:bg-muted";
const ACTION_BADGE_CLASS =
  "flex size-6 items-center justify-center rounded-full bg-muted";

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

export const Route = createFileRoute("/_authed/_app/channel/new")({
  validateSearch: (search: Record<string, unknown>): { agent?: string } => ({
    ...(typeof search.agent === "string" ? { agent: search.agent } : {}),
  }),
  component: RouteComponent,
});

function RouteComponent() {
  const { agent } = Route.useSearch();
  const navigate = Route.useNavigate();
  const { startChosen, pending } = useStartChannel();
  const { data: profiles, isError: rosterError } = useQuery(
    agentListQueryOptions(),
  );

  const [error, setError] = useState<string | null>(null);
  // Optimistic seed shown before the first channel record exists.
  const [sent, setSent] = useState<Message | null>(null);
  // What the To: input holds, so the action rows can step aside once a name is being typed.
  const [typed, setTyped] = useState("");

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
  const chosen =
    listed ??
    (fetched?.id === agent ? fetched : undefined) ??
    (agent ? undefined : defaultAgentProfile(profiles));
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
  const recipients: Recipient[] = chosen
    ? [{ id: chosen.id, name: chosen.name }]
    : [];
  const skillCommands = useSkillCommands(chosen?.id ?? "");
  const showActions = !isFilteringBots(typed, chosen);

  if (profiles === undefined && !rosterError) return null;

  return (
    <div className="flex h-full flex-col">
      <div className="h-12 border-b border-border sticky top-0 flex flex-row px-2 items-center">
        <SidebarToggle className="mr-1" />
        <span className="text-sm text-muted-foreground">To:</span>
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
            // Recipient changes are not separate navigation history entries.
            void navigate({
              replace: true,
              search: next ? { agent: next.id } : {},
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
                <Link
                  className={ACTION_ROW_CLASS}
                  // The row is taken with the mouse. A mousedown would move focus off the input
                  // and close the menu before the click lands, so focus stays put until the link
                  // navigates.
                  onMouseDown={(event) => event.preventDefault()}
                  search={{ tab: "agents", new: true }}
                  to="/marketplace"
                >
                  <span className={ACTION_BADGE_CLASS}>
                    <IconPlus className="size-4" />
                  </span>
                  Create new Bot
                </Link>
                <Link
                  className={ACTION_ROW_CLASS}
                  onMouseDown={(event) => event.preventDefault()}
                  to="/group/new"
                >
                  <span className={ACTION_BADGE_CLASS}>
                    <IconUsersGroup className="size-4" />
                  </span>
                  Create group chat
                </Link>
              </div>
            ) : null}
            <ComboboxEmpty>No agents found.</ComboboxEmpty>
            <ComboboxList>
              {(item: AgentProfile) => (
                <ComboboxItem key={item.id} value={item} className="h-10">
                  <ChannelAvatar participantIds={[item.id]} size={24} />
                  {item.name}
                  <span className="truncate text-muted-foreground ml-1">
                    {item.title}
                  </span>
                </ComboboxItem>
              )}
            </ComboboxList>
          </ComboboxContent>
        </Combobox>
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
        messages={sent ? [sent] : []}
        notice={
          loadError || error ? (
            <p className="pb-2 text-sm text-destructive" role="alert">
              {loadError ?? error}
            </p>
          ) : null
        }
        onSubmit={async (draft) => {
          const recipient = recipients[0];
          if (!recipient || !canSend(recipients, draft.text)) return;

          setError(null);
          setSent(seedMessage(draft.text, newId()));

          try {
            // Recorded, then started: a coworker picked here is as much a choice as an `@` on the
            // home screen, and the trail has to say so for both.
            await startChosen(recipient.id, draft.text);
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
        pending={pending}
      />
    </div>
  );
}
