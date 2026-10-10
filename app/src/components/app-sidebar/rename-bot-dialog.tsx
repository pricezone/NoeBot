import { useMutation, useQueryClient } from "@tanstack/react-query";
import { agentFormSchema, agentInputFrom } from "@/lib/agents/form";
import { updateAgentMutationOptions } from "@/lib/agents/mutations";
import { agentQueryOptions } from "@/lib/agents/queries";
import { channelKeys } from "@/lib/channels/queries";
import { NameDialog } from "./name-dialog";

/**
 * "Rename Bot" from a conversation's right-click menu: one field, the Bot's name.
 *
 * The update endpoint takes the whole profile, so the profile is read fresh at save time and every
 * other field rides along as it is, the way the Bot's own settings save one field at a time
 * (`GeneralSection` in agents/agent-dialog.tsx), down to leaving a built-in Bot's endpoint empty.
 * The server renames the conversations named after the Bot in the same write, so the roster and
 * the chat header are refetched with it.
 */
export function RenameBotDialog({
  agentId,
  currentName,
  onClose,
}: {
  agentId: string;
  currentName: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const update = useMutation(updateAgentMutationOptions(queryClient));

  return (
    <NameDialog
      initialName={currentName}
      label="Bot name"
      maxLength={80}
      onClose={onClose}
      onSubmit={async (name) => {
        const profile = await queryClient.fetchQuery(
          agentQueryOptions(agentId),
        );
        await update.mutateAsync({
          agentId,
          input: agentInputFrom({
            name,
            title: profile.title,
            roleDescription: profile.roleDescription,
            visibility: profile.visibility,
            endpoint: profile.builtIn ? "" : (profile.endpoint ?? ""),
            authValue: "",
          }),
        });
        void queryClient.invalidateQueries({ queryKey: channelKeys.all });
      }}
      submitLabel="Rename"
      title="Rename Bot"
      validate={(name) => {
        const parsed = agentFormSchema.shape.name.safeParse(name);
        return parsed.success
          ? null
          : (parsed.error.issues[0]?.message ?? "That name cannot be used.");
      }}
    />
  );
}
