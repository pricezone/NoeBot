import { IconPencil } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type KeyboardEvent, type ReactNode, useState } from "react";
import type { ZodType } from "zod";
import { AgentDialog } from "@/components/agents/agent-dialog";
import { ForYouSection } from "@/components/bot-profile/for-you-section";
import { ChannelAvatar } from "@/components/channels/avatar";
import { RoutinesList } from "@/components/routines/routines-list";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  type AgentFormValues,
  agentFormSchema,
  agentPatchInput,
} from "@/lib/agents/form";
import { updateAgentMutationOptions } from "@/lib/agents/mutations";
import { agentQueryOptions } from "@/lib/agents/queries";
import { channelKeys } from "@/lib/channels/queries";
import { isComposing } from "@/lib/composing";
import { useTranslation } from "@/lib/i18n";
import type { BotPanelParticipant } from "./bot-panel";

const HEADING =
  "text-xs font-medium uppercase tracking-wide text-muted-foreground";

function Tag({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border border-border bg-muted/40 px-2 py-0.5 text-xs text-muted-foreground">
      {children}
    </span>
  );
}

function DetailsSkeleton() {
  return (
    <div className="flex w-full flex-col gap-4">
      <div className="flex gap-1.5">
        <Skeleton className="h-5 w-16 rounded-full" />
        <Skeleton className="h-5 w-24 rounded-full" />
      </div>
      <div className="grid gap-2">
        <Skeleton className="h-3 w-10" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-2/3" />
      </div>
      <Skeleton className="h-9 w-full" />
    </div>
  );
}

/**
 * One fact about the Bot, edited in place beside the conversation: its label, its value (wrapped,
 * never cut short), and a pencil for whoever may change it. The pencil shows on hover, on keyboard
 * focus, and always on a touch screen, which has no hover. Editing swaps the value for an input
 * validated against the server's limits; Save writes just this field back, Escape or Cancel drops it.
 * The same in-place pattern as the Bot dialog's General rows (`EditableTextItem`).
 */
function EditableField({
  label,
  value,
  canManage,
  multiline = false,
  schema,
  onSave,
}: {
  label: string;
  value: string;
  canManage: boolean;
  multiline?: boolean;
  schema: ZodType<string>;
  onSave: (draft: string) => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    setEditing(false);
    setError(null);
  };
  const submit = async () => {
    const parsed = schema.safeParse(draft);
    if (!parsed.success) {
      setError(
        parsed.error.issues[0]?.message ?? t("That value does not fit."),
      );
      return;
    }
    if (parsed.data === value) {
      close();
      return;
    }
    setSaving(true);
    try {
      await onSave(parsed.data);
      close();
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : t("Could not save."),
      );
    } finally {
      setSaving(false);
    }
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      // Leaves the field, not the panel or a dialog around it.
      event.stopPropagation();
      close();
      return;
    }
    // A multi-line value takes Enter as a new line; Cmd/Ctrl+Enter saves it.
    const saves = multiline
      ? event.key === "Enter" && (event.metaKey || event.ctrlKey)
      : event.key === "Enter";
    // Not the Enter that confirms a composed character.
    if (saves && !isComposing(event)) {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <section className="group/field grid gap-1.5">
      <div className="flex min-h-6 items-center justify-between gap-2">
        <h2 className={HEADING}>{label}</h2>
        {canManage && !editing ? (
          <Button
            aria-label={t("Edit {{label}}", { label: label.toLowerCase() })}
            className="opacity-0 transition-opacity group-hover/field:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
            onClick={() => {
              setDraft(value);
              setEditing(true);
            }}
            size="icon-xs"
            variant="ghost"
          >
            <IconPencil />
          </Button>
        ) : null}
      </div>
      {editing ? (
        <div className="grid gap-2">
          {multiline ? (
            <Textarea
              aria-label={label}
              autoFocus
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onKeyDown}
              rows={4}
              value={draft}
            />
          ) : (
            <Input
              aria-label={label}
              autoFocus
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onKeyDown}
              value={draft}
            />
          )}
          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          <div className="flex gap-2">
            <Button disabled={saving} onClick={() => void submit()} size="sm">
              {saving ? t("Saving…") : t("Save")}
            </Button>
            <Button
              disabled={saving}
              onClick={close}
              size="sm"
              variant="outline"
            >
              {t("Cancel")}
            </Button>
          </div>
        </div>
      ) : (
        <p className="whitespace-pre-wrap text-pretty break-words text-sm">
          {value}
        </p>
      )}
    </section>
  );
}

/**
 * Who this Bot is and what it does for you.
 *
 * Its name and role, each edited in place; then its routines and the lifecycle rows from the Bot's
 * own page — Pause, Notifications, Reset — and one button into the full dialog (Bot Settings) for
 * everything else that changes the Bot. A card beside a conversation, not a control panel.
 *
 * The routines lead "For you": what the Bot does on a schedule is what people come here to check.
 * `embedded` drops the list's own page-section top margin, which is somebody else's spacing here.
 */
export function DetailsTab({ agentId }: { agentId: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const updateAgent = useMutation(updateAgentMutationOptions(queryClient));
  /** The full dialog, opened over the chat rather than navigating away from it. */
  const [managing, setManaging] = useState(false);
  const agent = useQuery(agentQueryOptions(agentId));

  if (agent.isPending) return <DetailsSkeleton />;
  if (agent.error || !agent.data) {
    return (
      <p className="text-sm text-destructive" role="alert">
        {t("Could not load this coworker.")}
      </p>
    );
  }
  const profile = agent.data;
  const save = (patch: Partial<AgentFormValues>) =>
    updateAgent.mutateAsync({
      agentId,
      input: agentPatchInput(profile, patch),
    });

  return (
    <div className="flex w-full flex-col gap-5">
      <div className="flex flex-wrap gap-1.5">
        <Tag>
          {profile.visibility === "private" ? t("Private") : t("Public")}
        </Tag>
        {profile.systemOwned ? <Tag>{t("System owned")}</Tag> : null}
      </div>

      <EditableField
        canManage={profile.canManage}
        label={t("Name")}
        onSave={async (name) => {
          await save({ name });
          // The server renames the conversations named after the Bot in the same write.
          void queryClient.invalidateQueries({ queryKey: channelKeys.all });
        }}
        schema={agentFormSchema.shape.name}
        value={profile.name}
      />

      <EditableField
        canManage={profile.canManage}
        label={t("Role")}
        multiline
        onSave={(roleDescription) => save({ roleDescription })}
        schema={agentFormSchema.shape.roleDescription}
        value={profile.roleDescription}
      />

      <section className="grid gap-2">
        <h2 className={HEADING}>{t("Routines")}</h2>
        <RoutinesList agentId={agentId} embedded />
      </section>

      <section className="grid gap-2">
        <h2 className={HEADING}>{t("For you")}</h2>
        {/* The rows carry their own top margin for the page; none is wanted under a heading here. */}
        <div className="[&>div]:mt-0">
          <ForYouSection agent={profile} includeMessage={false} />
        </div>
      </section>

      <Button
        className="w-full text-sm!"
        onClick={() => setManaging(true)}
        variant="outline"
      >
        {t("Bot Settings")}
      </Button>

      <AgentDialog
        agentId={agentId}
        onClose={() => setManaging(false)}
        open={managing}
      />
    </div>
  );
}

/** The Bots in a group, one row each. A group has no single role to describe. */
export function ParticipantsTab({
  participants,
}: {
  participants: BotPanelParticipant[];
}) {
  const { t } = useTranslation();
  return (
    <section className="grid gap-2">
      <h2 className={HEADING}>{t("Bots")}</h2>
      <ul className="flex flex-col gap-1">
        {participants.map((participant) => (
          <li
            className="flex h-11 items-center gap-3 rounded-xl px-2 text-[15px]"
            key={participant.id}
          >
            <ChannelAvatar participantIds={[participant.id]} size={28} />
            <span className="min-w-0 truncate">{participant.name}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
