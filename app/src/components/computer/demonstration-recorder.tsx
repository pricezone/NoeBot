import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useEffect, useId, useState } from "react";
import { SkillFields } from "@/components/skills/skill-fields";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { channelListQueryOptions } from "@/lib/channels/queries";
import {
  type Demonstration,
  type DemonstrationDraft,
  type DemonstrationRoutine,
  deleteDemonstration,
  demonstrationKeys,
  demonstrationsQueryOptions,
  draftDemonstration,
  publishDemonstration,
  renameDemonstration,
  scheduleDemonstration,
  UNTITLED_WORKFLOW,
} from "@/lib/demonstrations";
import {
  grantPlugin,
  invalidatePlugins,
  saveSkillMutationOptions,
} from "@/lib/plugins/mutations";
import { routineKeys } from "@/lib/routines/queries";
import { queryClient } from "@/query-client";

/**
 * Recorded workflows: naming one, reviewing the skill drafted from it, and the list of them.
 *
 * Recording itself is `RecordStepsButton`, in the screen viewer's top bar. A recording starts
 * under a placeholder title and is named once it has stopped, in {@link WorkflowDialog}, which then
 * carries on into the skill review. The list lives in the bot panel's Library tab.
 */

/** Seconds left before the server stops a recording, ticking once a second. */
export function useSecondsLeft(expiresAt: string | undefined) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!expiresAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);
  if (!expiresAt) return null;
  return Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000));
}

export const clock = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

/** Re-read one Bot's recordings, which every surface showing them shares. */
export const refreshDemonstrations = (botId: string) =>
  queryClient.invalidateQueries({ queryKey: demonstrationKeys.bot(botId) });

const SCHEDULES = [
  { label: "Every weekday at 09:00", cron: "0 9 * * 1-5" },
  { label: "Every day at 09:00", cron: "0 9 * * *" },
  { label: "Every Monday at 09:00", cron: "0 9 * * 1" },
  { label: "Every hour", cron: "0 * * * *" },
] as const;

/** Save the demonstrated path as a routine that reruns the published skill. */
function ScheduleSkill({
  recording,
  onDone,
}: {
  recording: Demonstration;
  onDone: () => void;
}) {
  const id = useId();
  const [cron, setCron] = useState<string>(SCHEDULES[0].cron);
  const [custom, setCustom] = useState("");
  const [channelId, setChannelId] = useState("");
  const [inputs, setInputs] = useState("");
  const [scheduled, setScheduled] = useState<DemonstrationRoutine | null>(null);
  const channels = useInfiniteQuery(channelListQueryOptions());
  const botChannels = (channels.data ?? []).filter(
    (channel) => channel.active && channel.agentIds.includes(recording.botId),
  );
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const schedule = useMutation({
    mutationFn: () =>
      scheduleDemonstration(recording.id, {
        cron: cron === "custom" ? custom : cron,
        timezone,
        ...(channelId ? { channelId } : {}),
        ...(inputs.trim() ? { inputs } : {}),
      }),
    onSuccess: async (routine) => {
      setScheduled(routine);
      await queryClient.invalidateQueries({ queryKey: routineKeys.all });
    },
  });
  if (scheduled)
    return (
      <p className="w-full text-xs">
        Scheduled. /{recording.skillSlug} next runs{" "}
        {new Date(scheduled.nextRunAt).toLocaleString()}.{" "}
        <Link to="/settings/bots" hash="routines" className="underline">
          See routines
        </Link>{" "}
        <button type="button" className="underline" onClick={onDone}>
          Close
        </button>
      </p>
    );
  return (
    <form
      className="grid w-full gap-2 rounded-md border p-3 text-xs"
      onSubmit={(event) => {
        event.preventDefault();
        schedule.mutate();
      }}
    >
      <label htmlFor={`${id}-when`} className="grid gap-1">
        When it runs ({timezone})
        <select
          id={`${id}-when`}
          className="h-8 rounded-md border bg-background px-2"
          value={cron}
          onChange={(event) => setCron(event.target.value)}
        >
          {SCHEDULES.map((option) => (
            <option key={option.cron} value={option.cron}>
              {option.label}
            </option>
          ))}
          <option value="custom">Custom cron expression</option>
        </select>
      </label>
      {cron === "custom" && (
        <label htmlFor={`${id}-cron`} className="grid gap-1">
          Cron (minute hour day month weekday)
          <Input
            id={`${id}-cron`}
            required
            maxLength={120}
            value={custom}
            onChange={(event) => setCustom(event.target.value)}
            placeholder="30 8 * * 1-5"
          />
        </label>
      )}
      <label htmlFor={`${id}-channel`} className="grid gap-1">
        Report in
        <select
          id={`${id}-channel`}
          className="h-8 rounded-md border bg-background px-2"
          value={channelId}
          onChange={(event) => setChannelId(event.target.value)}
        >
          <option value="">This Bot's only conversation</option>
          {botChannels.map((channel) => (
            <option key={channel.id} value={channel.id}>
              {channel.name}
            </option>
          ))}
        </select>
      </label>
      <label htmlFor={`${id}-inputs`} className="grid gap-1">
        Inputs for each run (optional)
        <Input
          id={`${id}-inputs`}
          maxLength={1000}
          value={inputs}
          onChange={(event) => setInputs(event.target.value)}
          placeholder="input_1: last month's invoices"
        />
      </label>
      {schedule.error && (
        <p role="alert" className="text-destructive">
          {schedule.error.message}
        </p>
      )}
      <div className="flex gap-2">
        {/* Base UI's Button defaults to type="button", which never submits the form. */}
        <Button
          size="sm"
          type="submit"
          disabled={schedule.isPending || (cron === "custom" && !custom.trim())}
        >
          Schedule
        </Button>
        <Button size="sm" variant="ghost" type="button" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** The drafted skill, edited and saved for this Bot: save, grant, then link the recording. */
function SkillDraftReview({
  botId,
  draft,
  onCancel,
  onSaved,
}: {
  botId: string;
  draft: DemonstrationDraft;
  onCancel: () => void;
  onSaved: (slug: string) => void;
}) {
  const [saveError, setSaveError] = useState<Error | null>(null);
  const save = useMutation(saveSkillMutationOptions(queryClient));
  return (
    <>
      <DialogHeader>
        <DialogTitle>Review and edit the skill</DialogTitle>
        <DialogDescription>
          Replace parameter names and clarify the expected outcome. Saving uses
          the same skill permissions as Skills.
        </DialogDescription>
      </DialogHeader>
      <DialogBody>
        <SkillFields
          key={draft.sourceRecordingId}
          defaultValues={draft}
          submitLabel="Save and use with this Bot"
          error={saveError || save.error}
          onCancel={onCancel}
          onSubmit={async (values) => {
            setSaveError(null);
            try {
              await save.mutateAsync(values);
              await grantPlugin({
                kind: "skill",
                ref: values.slug,
                agentId: botId,
              });
              await publishDemonstration(draft.sourceRecordingId, values.slug);
              await invalidatePlugins(queryClient);
              await refreshDemonstrations(botId);
              onSaved(values.slug);
            } catch (error) {
              setSaveError(
                error instanceof Error
                  ? error
                  : new Error("The skill could not be saved."),
              );
              await refreshDemonstrations(botId);
            }
          }}
        />
      </DialogBody>
    </>
  );
}

/**
 * One recorded workflow, from its name to a skill this Bot uses.
 *
 * Opened when a recording stops — by hand or at the ten-minute limit — on "Name this workflow";
 * Save names it and carries straight on into the skill review, in the same dialog. Later closes it
 * and leaves the recording, unnamed, under Library › Recorded workflows. Given a `draft`, it opens
 * on the review instead, which is how the Library's Review skill draft uses it.
 */
export function WorkflowDialog({
  botId,
  recordingId,
  draft: reviewing,
  onClose,
}: {
  botId: string;
  recordingId: string;
  /** Opens on the review of this draft rather than on naming the workflow. */
  draft?: DemonstrationDraft;
  onClose: () => void;
}) {
  const id = useId();
  const recordings = useQuery(demonstrationsQueryOptions(botId));
  const recording = recordings.data?.find((value) => value.id === recordingId);
  const [title, setTitle] = useState(() =>
    recording && recording.title !== UNTITLED_WORKFLOW ? recording.title : "",
  );
  const [draft, setDraft] = useState<DemonstrationDraft | null>(
    reviewing ?? null,
  );
  const [savedSlug, setSavedSlug] = useState("");
  const name = useMutation({
    mutationFn: async (value: string) => {
      await renameDemonstration(recordingId, value);
      return draftDemonstration(recordingId);
    },
    onSuccess: async (value) => {
      setDraft(value);
      await refreshDemonstrations(botId);
    },
  });
  const remove = useMutation({
    mutationFn: () => deleteDemonstration(recordingId),
    onSuccess: async () => {
      await refreshDemonstrations(botId);
      onClose();
    },
  });

  let content: ReactNode;
  if (savedSlug)
    content = (
      <>
        <DialogHeader>
          <DialogTitle>/{savedSlug} is ready</DialogTitle>
          <DialogDescription>
            /{savedSlug} is ready on this Bot. Invoke it in the conversation
            with the inputs you want to use, or choose Run on a schedule under
            Library › Recorded workflows to rerun it as a routine.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button size="sm" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </>
    );
  else if (draft)
    content = (
      <SkillDraftReview
        botId={botId}
        draft={draft}
        onCancel={onClose}
        onSaved={setSavedSlug}
      />
    );
  else if (!recording)
    content = (
      <>
        <DialogHeader>
          <DialogTitle>Name this workflow</DialogTitle>
          <DialogDescription>
            {recordings.isPending
              ? "Loading the recording…"
              : "This recording is no longer here."}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </>
    );
  else if (!recording.actions.length)
    content = (
      <>
        <DialogHeader>
          <DialogTitle>Nothing was recorded</DialogTitle>
          <DialogDescription>
            No steps were recorded. Take control and click or type on the page
            while recording, then stop.
          </DialogDescription>
        </DialogHeader>
        {remove.error ? (
          <p role="alert" className="text-sm text-destructive">
            {remove.error.message}
          </p>
        ) : null}
        <DialogFooter>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Later
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={remove.isPending}
            onClick={() => remove.mutate()}
          >
            Delete
          </Button>
        </DialogFooter>
      </>
    );
  else
    content = (
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (title.trim()) name.mutate(title.trim());
        }}
      >
        <DialogHeader>
          <DialogTitle>Name this workflow</DialogTitle>
          <DialogDescription>
            {recording.actions.length}{" "}
            {recording.actions.length === 1 ? "step" : "steps"} recorded. Name
            it, then review the skill drafted from it.
          </DialogDescription>
        </DialogHeader>
        <Field>
          <FieldLabel htmlFor={id}>Workflow name</FieldLabel>
          <Input
            id={id}
            required
            maxLength={120}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Find an invoice"
            autoComplete="off"
          />
        </Field>
        {name.error ? (
          <p role="alert" className="text-sm text-destructive">
            {name.error.message}
          </p>
        ) : null}
        <DialogFooter>
          <Button size="sm" variant="ghost" type="button" onClick={onClose}>
            Later
          </Button>
          {/* Base UI's Button defaults to type="button", which never submits the form. */}
          <Button
            size="sm"
            type="submit"
            disabled={name.isPending || !title.trim()}
          >
            Save
          </Button>
        </DialogFooter>
      </form>
    );

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className={draft && !savedSlug ? "max-w-2xl" : undefined}
        showCloseButton={false}
      >
        {content}
      </DialogContent>
    </Dialog>
  );
}

/**
 * The Bot's past recordings, under Library › Recorded workflows.
 *
 * Each one is reviewed into a skill, or, once it is one, edited or put on a schedule. A recording
 * left unnamed (Later) is named first: reviewing it opens on "Name this workflow".
 */
export function RecordedWorkflows({ botId }: { botId: string }) {
  const recordings = useQuery(demonstrationsQueryOptions(botId));
  const [scheduling, setScheduling] = useState("");
  const [reviewing, setReviewing] = useState<{
    recordingId: string;
    draft?: DemonstrationDraft;
  } | null>(null);
  const generate = useMutation({
    mutationFn: draftDemonstration,
    onSuccess: async (draft) => {
      setReviewing({ recordingId: draft.sourceRecordingId, draft });
      await refreshDemonstrations(botId);
    },
  });
  const remove = useMutation({
    mutationFn: deleteDemonstration,
    onSuccess: () => refreshDemonstrations(botId),
  });
  const finished = (recordings.data ?? []).filter(
    (recording) => recording.status !== "recording",
  );
  const problem = generate.error || remove.error || recordings.error;
  return (
    <div className="grid gap-2 text-sm">
      {problem ? (
        <p role="alert" className="text-sm text-destructive">
          {problem.message}
        </p>
      ) : null}
      {recordings.isSuccess && !finished.length ? (
        <p className="text-[13px] text-muted-foreground">
          No recorded workflows yet. Open the Bot's screen and choose Record
          your steps.
        </p>
      ) : null}
      {finished.map((recording) => (
        <div
          key={recording.id}
          className="flex flex-wrap items-center justify-between gap-2 border-t pt-2 first:border-t-0 first:pt-0"
        >
          <span>
            {recording.title} · {recording.actions.length}{" "}
            {recording.actions.length === 1 ? "step" : "steps"}
            {recording.reachedTimeLimit && (
              <span className="text-xs text-muted-foreground">
                {" "}
                · stopped at the ten-minute limit
              </span>
            )}
          </span>
          <div className="flex flex-wrap gap-2">
            {recording.status === "published" && recording.skillSlug ? (
              <>
                <Link
                  to="/marketplace"
                  search={{ tab: "skills", edit: recording.skillSlug }}
                  className="text-xs underline"
                >
                  Edit /{recording.skillSlug}
                </Link>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    setScheduling((current) =>
                      current === recording.id ? "" : recording.id,
                    )
                  }
                >
                  Run on a schedule
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                variant="outline"
                disabled={!recording.actions.length || generate.isPending}
                onClick={() =>
                  recording.title === UNTITLED_WORKFLOW
                    ? setReviewing({ recordingId: recording.id })
                    : generate.mutate(recording.id)
                }
              >
                Review skill draft
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              disabled={remove.isPending}
              onClick={() => remove.mutate(recording.id)}
            >
              Delete
            </Button>
          </div>
          {scheduling === recording.id && (
            <ScheduleSkill
              recording={recording}
              onDone={() => setScheduling("")}
            />
          )}
        </div>
      ))}
      {reviewing ? (
        <WorkflowDialog
          botId={botId}
          recordingId={reviewing.recordingId}
          draft={reviewing.draft}
          onClose={() => setReviewing(null)}
        />
      ) : null}
    </div>
  );
}
