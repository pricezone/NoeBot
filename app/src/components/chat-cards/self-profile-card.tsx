import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ToolLine } from "@/components/channels/tool-line";
import { Button } from "@/components/ui/button";
import { updateAgentMutationOptions } from "@/lib/agents/mutations";
import { agentKeys, agentQueryOptions } from "@/lib/agents/queries";
import { channelKeys } from "@/lib/channels/queries";
import { useUiStrings } from "@/lib/i18n/strings";
import { asText, REFUSAL_MARKER } from "@/lib/plugins/tool-result";
import {
  readSelfProfileChange,
  type SelfProfileChange,
} from "../../../../shared/self-profile";

/**
 * A Bot naming itself, in the conversation: "Named itself Quill · Researches and writes drafts",
 * with Undo.
 *
 * The rename is already made when this draws (`update_my_profile` runs on the server), so the card
 * is a receipt and a way back. Undo goes through the profile form's own route, with the name, role
 * and title the Bot had before and everything else as it is now.
 */

/**
 * Renames already announced to the rest of the app in this tab, so a transcript read again (or
 * scrolled past) does not refetch the roster each time it draws the card.
 */
const ANNOUNCED = new Set<string>();

/** The sidebar, the chat header and every conversation's name follow a Bot's name. */
function refreshNames(queryClient: ReturnType<typeof useQueryClient>) {
  void queryClient.invalidateQueries({ queryKey: agentKeys.all });
  void queryClient.invalidateQueries({ queryKey: channelKeys.all });
}

export function SelfProfileCard({
  toolCallId,
  name,
  result,
  running,
}: {
  toolCallId?: string;
  /** The name being written, while the call is still running. */
  name?: string;
  result: unknown;
  running: boolean;
}) {
  const ui = useUiStrings();
  const queryClient = useQueryClient();
  const update = useMutation(updateAgentMutationOptions(queryClient));
  const change = readSelfProfileChange(result);
  const [undone, setUndone] = useState(false);
  const [failed, setFailed] = useState(false);

  // Renamed: everything that shows the Bot's name reads it again, once per rename in this tab.
  const key = change ? (toolCallId ?? `${change.bot}:${change.name}`) : null;
  useEffect(() => {
    if (!key || ANNOUNCED.has(key)) return;
    ANNOUNCED.add(key);
    refreshNames(queryClient);
  }, [key, queryClient]);

  if (!change) {
    if (running)
      return <ToolLine detail={name} label={ui.namingItself} running />;
    const text = typeof result === "string" ? asText(result) : "";
    return (
      <ToolLine
        detail={text.replace(REFUSAL_MARKER, "").trim() || undefined}
        failed
        label={ui.namingItself}
      />
    );
  }

  const undo = async (previous: SelfProfileChange["previous"]) => {
    setFailed(false);
    try {
      // Name, role and title as they were; the rest as it is now, as the profile form sends it.
      const current = await queryClient.fetchQuery(
        agentQueryOptions(change.bot),
      );
      await update.mutateAsync({
        agentId: change.bot,
        input: {
          name: previous.name,
          title: previous.title,
          roleDescription: previous.role,
          visibility: current.visibility,
          ...(current.endpoint ? { endpoint: current.endpoint } : {}),
        },
      });
      setUndone(true);
      refreshNames(queryClient);
    } catch {
      setFailed(true);
    }
  };

  return (
    <div className="my-2 flex w-full max-w-2xl flex-col gap-1 rounded-xl border border-border bg-card px-3 py-2 text-sm">
      <div className="flex min-w-0 items-center gap-3">
        <p className="min-w-0 flex-1 truncate">
          <span className="font-medium">
            {undone
              ? ui.undone(change.previous.name)
              : ui.namedItself(change.name)}
          </span>
          {!undone && change.role ? (
            <span className="text-muted-foreground"> · {change.role}</span>
          ) : null}
        </p>
        {undone ? null : (
          <Button
            disabled={update.isPending}
            onClick={() => void undo(change.previous)}
            size="sm"
            variant="ghost"
          >
            {update.isPending ? ui.undoing : ui.undo}
          </Button>
        )}
      </div>
      {failed ? (
        <p className="text-destructive text-xs" role="alert">
          {ui.undoFailed}
        </p>
      ) : null}
    </div>
  );
}
