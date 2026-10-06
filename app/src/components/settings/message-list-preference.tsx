import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChannelItemContent } from "@/components/app-sidebar/channel-item-content";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SettingsRow } from "@/components/ui/settings-rows";
import {
  saveUserPreferencesMutationOptions,
  useUserPreferences,
} from "@/lib/settings/message-list";

/**
 * Which name the roster makes larger, as one row of the Appearance card plus a preview.
 *
 * Drawn as rows rather than as a card of its own, so it sits inside the same card as the theme
 * row: the caller supplies the card. The preview under the row is a real roster row, so what it
 * shows is what the sidebar will do, not a drawing of it.
 */
export function MessageListPreference() {
  const preferences = useUserPreferences();
  const queryClient = useQueryClient();
  const save = useMutation(
    saveUserPreferencesMutationOptions(queryClient, preferences.userId),
  );
  const emphasis =
    (save.isPending ? save.variables?.messageListEmphasis : undefined) ??
    preferences.data?.messageListEmphasis;

  return (
    <>
      <SettingsRow
        label="Message list emphasis"
        description="Choose which name appears larger in the sidebar."
        control={
          <Select
            value={emphasis ?? null}
            disabled={!preferences.data || save.isPending}
            onValueChange={(value) => {
              if (value === "agent" || value === "thread") {
                save.mutate({ messageListEmphasis: value });
              }
            }}
          >
            <SelectTrigger aria-label="Message list emphasis">
              <SelectValue>
                {emphasis
                  ? emphasis === "agent"
                    ? "Agent name"
                    : "Thread title"
                  : "Loading…"}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="thread">Thread title</SelectItem>
              <SelectItem value="agent">Agent name</SelectItem>
            </SelectContent>
          </Select>
        }
      />
      {preferences.isError ? (
        <div className="px-4 py-3">
          <p role="alert" className="text-sm text-destructive">
            {preferences.error.message}
          </p>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void preferences.refetch()}
          >
            Retry
          </Button>
        </div>
      ) : null}
      {save.isError ? (
        <p role="alert" className="px-4 py-3 text-sm text-destructive">
          {save.error.message}
        </p>
      ) : null}
      {save.isPending ? (
        <p role="status" className="px-4 py-3 text-sm text-muted-foreground">
          Saving…
        </p>
      ) : null}
      {emphasis ? (
        <div className="flex justify-center px-6 py-4">
          <figure
            aria-label="Message list preview"
            className="flex h-16 w-full max-w-xs items-center rounded-xl bg-sidebar px-3"
          >
            <ChannelItemContent
              participantIds={["message-list-preview"]}
              name="General Assistant"
              title="Plan next week"
              lastMessageAt="2h"
              emphasis={emphasis}
            />
          </figure>
        </div>
      ) : null}
    </>
  );
}
