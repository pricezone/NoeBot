import { IconPlus, IconUsersGroup } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { ChannelAvatar } from "@/components/channels/avatar";
import {
  addRecipient,
  MAX_RECIPIENTS,
  type Recipient,
  removeRecipient,
} from "@/components/channels/compose-state";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { agentListQueryOptions } from "@/lib/agents/queries";

/**
 * Who a conversation that does not exist yet is with.
 *
 * Uses the same recipient list model as compose state, even while channels are capped at one
 * coworker.
 */
export function RecipientField({
  recipients,
  onChange,
}: {
  recipients: readonly Recipient[];
  onChange: (next: Recipient[]) => void;
}) {
  const { data: profiles } = useQuery(agentListQueryOptions());
  const [search, setSearch] = useState("");
  /*
   * The menu opens on focus, not only on typing: the first thing it offers is making a new Bot or
   * a group, which a person who has not typed a name yet is at least as likely to want.
   */
  const [focused, setFocused] = useState(false);

  const chosen = new Set(recipients.map((recipient) => recipient.id));
  const matches = (profiles ?? [])
    .filter((profile) => !chosen.has(profile.id))
    .filter((profile) =>
      profile.name.toLowerCase().includes(search.trim().toLowerCase()),
    );
  const isFull = recipients.length >= MAX_RECIPIENTS;

  return (
    <div className="border-b border-border px-4 py-2">
      <div className="mx-auto flex w-full max-w-2xl flex-wrap items-center gap-1.5">
        <span className="text-sm text-muted-foreground">To:</span>

        {recipients.map((recipient) => (
          <Button
            key={recipient.id}
            onClick={() => onChange(removeRecipient(recipients, recipient.id))}
            size="xs"
            variant="secondary"
          >
            <ChannelAvatar participantIds={[recipient.id]} size={16} />
            {recipient.name}
            <span aria-hidden>×</span>
            <span className="sr-only">Remove {recipient.name}</span>
          </Button>
        ))}

        {isFull ? null : (
          <InputGroup className="h-8 w-56 border-none bg-transparent">
            <InputGroupInput
              aria-label="Choose a coworker"
              onBlur={() => setFocused(false)}
              onChange={(event) => setSearch(event.target.value)}
              onFocus={() => setFocused(true)}
              placeholder="Start a chat with…"
              value={search}
            />
            <InputGroupAddon />
          </InputGroup>
        )}
      </div>

      {isFull || (!focused && search.trim().length === 0) ? null : (
        <ul
          className="mx-auto mt-1 w-full max-w-2xl rounded-2xl bg-card p-1.5"
          // Rows are taken with the mouse; the input blurs first, so the menu must not vanish on blur.
          onMouseDown={(event) => event.preventDefault()}
        >
          {search.trim().length === 0 ? (
            <>
              <li>
                <Link
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-[15px] hover:bg-muted"
                  search={{ tab: "agents", new: true }}
                  to="/marketplace"
                >
                  <span className="flex size-6 items-center justify-center rounded-full bg-muted">
                    <IconPlus className="size-4" />
                  </span>
                  Create new Bot
                </Link>
              </li>
              <li>
                <Link
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-[15px] hover:bg-muted"
                  to="/group/new"
                >
                  <span className="flex size-6 items-center justify-center rounded-full bg-muted">
                    <IconUsersGroup className="size-4" />
                  </span>
                  Create group chat
                </Link>
              </li>
            </>
          ) : null}
          {matches.map((profile) => (
            <li key={profile.id}>
              <button
                className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-[15px] hover:bg-muted"
                onClick={() => {
                  onChange(
                    addRecipient(recipients, {
                      id: profile.id,
                      name: profile.name,
                    }),
                  );
                  setSearch("");
                  setFocused(false);
                }}
                type="button"
              >
                <ChannelAvatar participantIds={[profile.id]} size={24} />
                <span>{profile.name}</span>
                <span className="text-muted-foreground">{profile.title}</span>
              </button>
            </li>
          ))}
          {matches.length === 0 ? (
            <li className="px-2 py-1.5 text-sm text-muted-foreground">
              No coworker by that name.
            </li>
          ) : null}
        </ul>
      )}
    </div>
  );
}
