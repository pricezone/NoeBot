import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useId, useState } from "react";
import { Streamdown } from "streamdown";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { conversationLabel } from "@/lib/channels/label";
import { channelListQueryOptions } from "@/lib/channels/queries";
import { msg, useTranslation } from "@/lib/i18n";
import { intlLocale } from "@/lib/i18n/format";
import { useStreamdownTranslations } from "@/lib/i18n/streamdown-translations";
import { markdownComponents } from "@/lib/markdown";
import {
  createGithubBinding,
  createResponsibility,
  createTrigger,
  githubBindingsQueryOptions,
  type ResponsibilityRecord,
  removeGithubBinding,
  removeTrigger,
  responsibilitiesQueryOptions,
  responsibilityAction,
  responsibilityKeys,
  responsibilityRunsQueryOptions,
  revealTriggerSecret,
  setTriggerEnabled,
  setTriggerSecret,
  type TriggerConfig,
  type TriggerKind,
  type TriggerRecord,
  triggersQueryOptions,
  updateResponsibility,
} from "@/lib/responsibilities";
import { queryClient } from "@/query-client";

const fieldClass = "grid gap-1 text-sm";
const selectClass = "h-9 rounded-md border bg-background px-3 text-sm";
async function refresh() {
  await queryClient.invalidateQueries({ queryKey: responsibilityKeys.all });
}

/**
 * A Bot's lasting goals: give one, follow its progress, decide when it works.
 *
 * A block of the Settings › Bots page (`/settings/bots#responsibilities`), which supplies the
 * heading; this is the body that used to be the `/responsibilities` page.
 */
export function ResponsibilitiesSection() {
  const { t } = useTranslation("settings");
  const goals = useQuery(responsibilitiesQueryOptions());
  return (
    <div className="grid gap-6">
      <NewResponsibility />
      {goals.isPending ? (
        <p>{t("Loading responsibilities…")}</p>
      ) : goals.error ? (
        <p role="alert" className="text-destructive">
          {goals.error.message}
        </p>
      ) : goals.data?.length ? (
        goals.data.map((goal) => <GoalCard key={goal.id} goal={goal} />)
      ) : (
        <p className="text-muted-foreground">
          {t("You have no responsibilities yet.")}
        </p>
      )}
      <GithubSources />
    </div>
  );
}

function NewResponsibility() {
  const { t } = useTranslation("settings");
  const formId = useId();
  const bots = useQuery(agentListQueryOptions());
  const channels = useInfiniteQuery(channelListQueryOptions());
  const [channelId, setChannelId] = useState("");
  const [agentId, setAgentId] = useState("");
  const [title, setTitle] = useState("");
  const [instruction, setInstruction] = useState("");
  const [successCriteria, setSuccessCriteria] = useState("");
  const [source, setSource] = useState<
    "none" | ResponsibilityRecord["subscriptions"][number]["source"]
  >("none");
  const [eventType, setEventType] = useState("");
  const selectedChannel = channels.data?.find(
    (channel) => channel.id === channelId,
  );
  const availableBots =
    bots.data?.filter((bot) => selectedChannel?.agentIds.includes(bot.id)) ??
    [];
  const create = useMutation({
    mutationFn: createResponsibility,
    onSuccess: async () => {
      setTitle("");
      setInstruction("");
      setSuccessCriteria("");
      await refresh();
    },
  });
  return (
    <form
      className="grid gap-3 rounded-lg border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        create.mutate({
          channelId,
          agentId,
          title,
          instruction,
          successCriteria,
          subscriptions: source === "none" ? [] : [{ source, eventType }],
        });
      }}
    >
      <h2 className="font-semibold">{t("New responsibility")}</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={fieldClass}>
          {t("Conversation")}
          <select
            className={selectClass}
            required
            value={channelId}
            onChange={(event) => {
              setChannelId(event.target.value);
              setAgentId("");
            }}
          >
            <option value="">{t("Choose a conversation")}</option>
            {channels.data
              ?.filter((channel) => channel.active)
              .map((channel) => (
                <option key={channel.id} value={channel.id}>
                  {conversationLabel(channel)}
                </option>
              ))}
          </select>
        </label>
        <label className={fieldClass}>
          {t("Bot")}
          <select
            className={selectClass}
            required
            value={agentId}
            onChange={(event) => setAgentId(event.target.value)}
          >
            <option value="">{t("Choose a Bot")}</option>
            {availableBots.map((bot) => (
              <option key={bot.id} value={bot.id}>
                {bot.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {channels.hasNextPage && (
        <Button
          type="button"
          variant="outline"
          onClick={() => channels.fetchNextPage()}
        >
          {t("Load more conversations")}
        </Button>
      )}
      {(channels.error || bots.error) && (
        <p role="alert" className="text-destructive">
          {channels.error?.message ?? bots.error?.message}
        </p>
      )}
      <label className={fieldClass} htmlFor={`${formId}-title`}>
        {t("Title")}
        <Input
          id={`${formId}-title`}
          required
          maxLength={160}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder={t("Keep the customer report up to date")}
        />
      </label>
      <label className={fieldClass} htmlFor={`${formId}-instruction`}>
        {t("Instruction")}
        <Textarea
          id={`${formId}-instruction`}
          required
          maxLength={6000}
          value={instruction}
          onChange={(event) => setInstruction(event.target.value)}
        />
      </label>
      <label className={fieldClass} htmlFor={`${formId}-criteria`}>
        {t("Success criteria")}
        <Textarea
          id={`${formId}-criteria`}
          required
          maxLength={3000}
          value={successCriteria}
          onChange={(event) => setSuccessCriteria(event.target.value)}
          placeholder={t(
            "The report contains the current quarter's graph and a source link.",
          )}
        />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={fieldClass}>
          {t("Event source")}
          <select
            className={selectClass}
            value={source}
            onChange={(event) => {
              const value = event.target.value;
              if (
                value === "none" ||
                value === "github" ||
                value === "slack" ||
                value === "connector" ||
                value === "schedule" ||
                value === "manual"
              )
                setSource(value);
            }}
          >
            <option value="none">{t("Run when asked")}</option>
            <option value="github">{t("GitHub")}</option>
            <option value="slack">{t("Slack")}</option>
            <option value="connector">{t("Connected app")}</option>
            <option value="schedule">{t("Schedule")}</option>
          </select>
        </label>
        {source !== "none" && (
          <label className={fieldClass} htmlFor={`${formId}-event`}>
            {t("Event type")}
            <Input
              id={`${formId}-event`}
              required
              maxLength={128}
              value={eventType}
              onChange={(event) => setEventType(event.target.value)}
              placeholder={
                source === "github"
                  ? "issues.opened" /* i18n-ignore */
                  : t("Event type")
              }
            />
          </label>
        )}
      </div>
      {create.error && (
        <p role="alert" className="text-destructive">
          {create.error.message}
        </p>
      )}
      <Button disabled={create.isPending} type="submit">
        {create.isPending ? t("Creating…") : t("Create responsibility")}
      </Button>
    </form>
  );
}

function GoalCard({ goal }: { goal: ResponsibilityRecord }) {
  const { t } = useTranslation("settings");
  const [editing, setEditing] = useState(false);
  const [showRuns, setShowRuns] = useState(false);
  const [title, setTitle] = useState(goal.title);
  const [instruction, setInstruction] = useState(goal.instruction);
  const [successCriteria, setSuccessCriteria] = useState(goal.successCriteria);
  const action = useMutation({
    mutationFn: (value: "pause" | "resume" | "complete" | "run") =>
      responsibilityAction(goal.id, value),
    onSuccess: refresh,
  });
  const edit = useMutation({
    mutationFn: () =>
      updateResponsibility(goal.id, { title, instruction, successCriteria }),
    onSuccess: async () => {
      setEditing(false);
      await refresh();
    },
  });
  const runs = useQuery({
    ...responsibilityRunsQueryOptions(goal.id),
    enabled: showRuns,
  });
  return (
    <article className="grid gap-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">{goal.title}</h2>
        <span className="rounded bg-muted px-2 py-1 text-xs capitalize">
          {goal.status}
        </span>
      </div>
      {editing ? (
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            edit.mutate();
          }}
        >
          <label className={fieldClass} htmlFor={`${goal.id}-title`}>
            {t("Title")}
            <Input
              id={`${goal.id}-title`}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              required
              maxLength={160}
            />
          </label>
          <label className={fieldClass} htmlFor={`${goal.id}-instruction`}>
            {t("Instruction")}
            <Textarea
              id={`${goal.id}-instruction`}
              value={instruction}
              onChange={(event) => setInstruction(event.target.value)}
              required
              maxLength={6000}
            />
          </label>
          <label className={fieldClass} htmlFor={`${goal.id}-criteria`}>
            {t("Success criteria")}
            <Textarea
              id={`${goal.id}-criteria`}
              value={successCriteria}
              onChange={(event) => setSuccessCriteria(event.target.value)}
              required
              maxLength={3000}
            />
          </label>
          <div className="flex gap-2">
            <Button type="submit" disabled={edit.isPending}>
              {t("Save")}
            </Button>
            <Button
              variant="outline"
              type="button"
              onClick={() => setEditing(false)}
            >
              {t("Cancel")}
            </Button>
          </div>
        </form>
      ) : (
        <>
          <p className="whitespace-pre-wrap text-sm">{goal.instruction}</p>
          <p className="text-sm text-muted-foreground">
            {t("Success: {{successCriteria}}", {
              successCriteria: goal.successCriteria,
            })}
          </p>
        </>
      )}
      {goal.progress && (
        <div className="text-sm">
          <span className="font-medium">{t("Progress:")}</span>
          <RunMarkdown>{goal.progress}</RunMarkdown>
        </div>
      )}
      {goal.lastResult && (
        <div className="rounded bg-muted p-3 text-sm">
          <RunMarkdown>{goal.lastResult}</RunMarkdown>
        </div>
      )}
      {goal.subscriptions.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {t("Events: {{subscriptions}}", {
            subscriptions: goal.subscriptions
              .map(
                (subscription) =>
                  `${subscription.source} · ${subscription.eventType}`,
              )
              .join(", "),
          })}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setEditing(!editing)}
        >
          {t("Edit")}
        </Button>
        {goal.status === "active" && (
          <>
            <Button
              size="sm"
              disabled={action.isPending}
              onClick={() => {
                setShowRuns(true);
                action.mutate("run");
              }}
              title={t(
                "Runs it for real, now: the Bot does the work and can post and act.",
              )}
            >
              {t("Run now (real run)")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={action.isPending}
              onClick={() => action.mutate("pause")}
            >
              {t("Pause")}
            </Button>
          </>
        )}
        {goal.status === "paused" && (
          <Button
            size="sm"
            disabled={action.isPending}
            onClick={() => action.mutate("resume")}
          >
            {t("Resume")}
          </Button>
        )}
        {goal.status !== "completed" && (
          <Button
            variant="outline"
            size="sm"
            disabled={action.isPending}
            onClick={() => action.mutate("complete")}
          >
            {t("Complete")}
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setShowRuns(!showRuns)}
        >
          {showRuns ? t("Hide runs") : t("View runs")}
        </Button>
        <Link
          to="/channel/$channelId"
          params={{ channelId: goal.channelId }}
          className="self-center text-sm underline"
        >
          {t("Open conversation")}
        </Link>
      </div>
      {(action.error || edit.error) && (
        <p role="alert" className="text-destructive">
          {action.error?.message ?? edit.error?.message}
        </p>
      )}
      <Triggers goal={goal} />
      {showRuns && (
        <div className="grid gap-2 border-t pt-3">
          {runs.isPending ? (
            <p>{t("Loading runs…")}</p>
          ) : runs.error ? (
            <p role="alert">{runs.error.message}</p>
          ) : runs.data?.length ? (
            runs.data.map((run) => (
              <div key={run.id} className="text-sm">
                <p>
                  <span className={runStatusClass(run.status)}>
                    {t(RUN_LABEL[run.status] ?? run.status)}
                  </span>{" "}
                  · {new Date(run.createdAt).toLocaleString(intlLocale())} ·{" "}
                  <Link
                    to="/channel/$channelId"
                    params={{ channelId: goal.channelId }}
                    className="underline"
                  >
                    {t("Open thread")}
                  </Link>
                </p>
                {run.waiting && (
                  <p>
                    {t(
                      "Waiting for {{kind}}. Respond through your approval inbox or conversation.",
                      { kind: run.waiting.kind },
                    )}
                  </p>
                )}
                {run.error && (
                  <p className="text-muted-foreground">{run.error}</p>
                )}
                {run.replyText && <RunMarkdown>{run.replyText}</RunMarkdown>}
              </div>
            ))
          ) : (
            <p>{t("No runs yet.")}</p>
          )}
        </div>
      )}
    </article>
  );
}

/**
 * A Bot's own words, drawn the way the conversation draws them.
 *
 * Progress, the last result and each run's reply are the Bot's markdown, and shown as plain text
 * they read as literal asterisks and backticks. Same renderer and components as the transcript, kept
 * to the row's size: no heading scale, tight paragraph and list spacing.
 */
function RunMarkdown({ children }: { children: string }) {
  const streamdownTranslations = useStreamdownTranslations();
  return (
    <Streamdown
      translations={streamdownTranslations}
      className="min-w-0 text-sm [&_h1]:text-sm [&_h2]:text-sm [&_h3]:text-sm [&_li]:my-0 [&_ol]:my-1 [&_p]:my-1 [&_ul]:my-1 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
      components={markdownComponents}
      mode="static"
    >
      {children}
    </Streamdown>
  );
}

function GithubSources() {
  const { t } = useTranslation("settings");
  const formId = useId();
  const bindings = useQuery(githubBindingsQueryOptions());
  const [repository, setRepository] = useState("");
  const [secret, setSecret] = useState("");
  const create = useMutation({
    mutationFn: () => createGithubBinding(repository, secret),
    onSuccess: async () => {
      setSecret("");
      setRepository("");
      await refresh();
    },
  });
  const remove = useMutation({
    mutationFn: removeGithubBinding,
    onSuccess: refresh,
  });
  return (
    <section className="grid gap-3 rounded-lg border p-4">
      <h2 className="font-semibold">{t("GitHub event sources")}</h2>
      <p className="text-sm text-muted-foreground">
        {t(
          "Register a repository, then add its webhook in GitHub using the endpoint below and the same secret. Subscribe a responsibility to an event such as issues.opened.",
        )}
      </p>
      <form
        className="grid gap-3 sm:grid-cols-3"
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate();
        }}
      >
        <label className={fieldClass} htmlFor={`${formId}-repository`}>
          {t("Repository")}
          <Input
            id={`${formId}-repository`}
            value={repository}
            onChange={(event) => setRepository(event.target.value)}
            placeholder="owner/repository" /* i18n-ignore: an example of the format, not prose */
            required
          />
        </label>
        <label className={fieldClass} htmlFor={`${formId}-secret`}>
          {t("Webhook secret")}
          <Input
            id={`${formId}-secret`}
            type="password"
            autoComplete="new-password"
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
            required
          />
        </label>
        <Button type="submit" className="self-end" disabled={create.isPending}>
          {t("Connect events")}
        </Button>
      </form>
      {(bindings.error || create.error || remove.error) && (
        <p role="alert" className="text-destructive">
          {bindings.error?.message ??
            create.error?.message ??
            remove.error?.message}
        </p>
      )}
      {bindings.data?.map((binding) => (
        <div
          key={binding.id}
          className="flex flex-wrap items-center justify-between gap-2 border-t pt-3"
        >
          <div>
            <p className="text-sm">{binding.repository}</p>
            <code className="break-all text-xs">
              {window.location.origin}/api/events/github/{binding.id}
            </code>
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={remove.isPending}
            onClick={() => remove.mutate(binding.id)}
          >
            {t("Disconnect")}
          </Button>
        </div>
      ))}
    </section>
  );
}

const RUN_LABEL: Record<string, string> = {
  queued: msg("Queued"),
  running: msg("Running"),
  waiting: msg("Waiting for you"),
  succeeded: msg("Succeeded"),
  failed: msg("Failed"),
  skipped: msg("Skipped"),
};
function runStatusClass(status: string) {
  return status === "failed"
    ? "text-destructive"
    : status === "succeeded"
      ? "text-emerald-600 dark:text-emerald-500"
      : "text-muted-foreground";
}

const KIND_LABEL: Record<TriggerKind, string> = {
  webhook: msg("Webhook"),
  github: "GitHub",
  linear: "Linear",
  sentry: "Sentry",
  pagerduty: "PagerDuty",
  email: msg("Email"),
  slack: "Slack",
};
const KIND_HELP: Record<TriggerKind, string> = {
  webhook: msg(
    "POST JSON to the URL with the authorization header (or Standard Webhooks signature headers). 200 means accepted and queued, not finished.",
  ),
  github: msg(
    "In the repository's Settings → Webhooks, set the payload URL to this URL, content type application/json, and the secret to the key.",
  ),
  linear: msg(
    "In Linear, Settings → API → Webhooks: set the URL, then paste the signing secret Linear shows here.",
  ),
  sentry: msg(
    "In a Sentry internal integration, set the webhook URL, then paste the integration's client secret here.",
  ),
  pagerduty: msg(
    "In PagerDuty, Integrations → Generic Webhooks (v3): set the URL, then paste the secret shown on creation here.",
  ),
  email: msg("Send or forward mail to this address to start a run."),
  slack: msg(
    "Fires from Slack events delivered through this Bot's Slack pairing. Messages from before the trigger existed are ignored.",
  ),
};
const VENDOR_SECRET: ReadonlySet<TriggerKind> = new Set([
  "linear",
  "sentry",
  "pagerduty",
]);
const list = (value: string) =>
  value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

function CopyButton({ value, label }: { value: string; label: string }) {
  const { t } = useTranslation("settings");
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      type="button"
      variant="outline"
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? t("Copied") : label}
    </Button>
  );
}

function describeFilter(config: TriggerConfig) {
  if (config.kind === "slack") {
    const where = config.channels.length
      ? `in ${config.channels.join(", ")}`
      : "in every channel the Bot is in";
    const what =
      config.mode === "mention"
        ? "when the Bot is mentioned"
        : config.mode === "message"
          ? "on any message"
          : config.mode === "phrase"
            ? `on messages containing ${config.phrases.map((phrase) => `"${phrase}"`).join(" or ")}`
            : `on reactions${config.reactions.length ? ` :${config.reactions.join(": :")}:` : ""}`;
    return `${what} ${where} (workspace ${config.teamId})`;
  }
  const parts = [
    config.filter.eventTypes.length
      ? `events ${config.filter.eventTypes.join(", ")}`
      : "every event",
  ];
  if (config.filter.field)
    parts.push(
      `where ${config.filter.field.path} = ${config.filter.field.equals}`,
    );
  if (config.kind === "github" && config.repository)
    parts.push(`from ${config.repository}`);
  if (config.kind === "email" && config.allowedSenders.length)
    parts.push(`from ${config.allowedSenders.join(", ")} (authenticated)`);
  return parts.join(" ");
}

function Triggers({ goal }: { goal: ResponsibilityRecord }) {
  const { t } = useTranslation("settings");
  const triggers = useQuery(triggersQueryOptions(goal.id));
  const [adding, setAdding] = useState(false);
  const [freshSecret, setFreshSecret] = useState<{
    id: string;
    secret: string;
  } | null>(null);
  const reload = () =>
    queryClient.invalidateQueries({
      queryKey: responsibilityKeys.triggers(goal.id),
    });
  return (
    <section className="grid gap-2 border-t pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium text-sm">{t("Triggers")}</h3>
        <Button
          size="sm"
          variant="outline"
          type="button"
          onClick={() => setAdding(!adding)}
        >
          {adding ? t("Cancel") : t("Add trigger")}
        </Button>
      </div>
      {goal.status !== "active" && (
        <p className="text-muted-foreground text-xs">
          {t(
            "This responsibility is {{status}}, so its triggers are acknowledged but never run it.",
            { status: goal.status },
          )}
        </p>
      )}
      {adding && (
        <NewTrigger
          goalId={goal.id}
          onCreated={async (created) => {
            setAdding(false);
            if (created.secret)
              setFreshSecret({
                id: created.trigger.id,
                secret: created.secret,
              });
            await reload();
          }}
        />
      )}
      {triggers.error && (
        <p role="alert" className="text-destructive text-sm">
          {triggers.error.message}
        </p>
      )}
      {triggers.data?.length === 0 && !adding && (
        <p className="text-muted-foreground text-xs">
          {t(
            "No triggers. It runs when you press Run now, or on the event subscriptions above.",
          )}
        </p>
      )}
      {triggers.data?.map((trigger) => (
        <TriggerRow
          key={trigger.id}
          trigger={trigger}
          freshSecret={
            freshSecret?.id === trigger.id ? freshSecret.secret : null
          }
          onChanged={async (secret) => {
            if (secret) setFreshSecret({ id: trigger.id, secret });
            await reload();
          }}
        />
      ))}
    </section>
  );
}

function TriggerRow({
  trigger,
  freshSecret,
  onChanged,
}: {
  trigger: TriggerRecord;
  freshSecret: string | null;
  onChanged: (secret: string | null) => Promise<void>;
}) {
  const { t } = useTranslation("settings");
  const [secret, setSecret] = useState<string | null>(freshSecret);
  const [pasted, setPasted] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const shown = freshSecret ?? secret;
  const reveal = useMutation({
    mutationFn: () => revealTriggerSecret(trigger.id),
    onSuccess: setSecret,
  });
  const rotate = useMutation({
    mutationFn: () =>
      setTriggerSecret(
        trigger.id,
        VENDOR_SECRET.has(trigger.kind) ? pasted : undefined,
      ),
    onSuccess: async (result) => {
      setPasted("");
      setSecret(result.secret);
      await onChanged(result.secret);
    },
  });
  const remove = useMutation({
    mutationFn: () => removeTrigger(trigger.id),
    onSuccess: () => onChanged(null),
  });
  const toggle = useMutation({
    mutationFn: () => setTriggerEnabled(trigger.id, !trigger.enabled),
    onSuccess: () => onChanged(null),
  });
  const url = trigger.path ? `${window.location.origin}${trigger.path}` : null;
  const generated = trigger.kind === "webhook" || trigger.kind === "github";
  return (
    <div className="grid gap-2 rounded-md bg-muted/50 p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p>
          <span className="font-medium">{t(KIND_LABEL[trigger.kind])}</span>{" "}
          <span className="text-muted-foreground">
            {describeFilter(trigger.config)}
          </span>
          {!trigger.enabled && (
            <span className="ml-2 rounded bg-background px-1.5 py-0.5 text-xs">
              {t("Paused")}
            </span>
          )}
        </p>
        <Button
          size="sm"
          variant="outline"
          disabled={toggle.isPending}
          onClick={() => toggle.mutate()}
        >
          {trigger.enabled ? t("Pause") : t("Resume")}
        </Button>
        {confirmRemove ? (
          <span className="flex gap-2">
            <Button
              size="sm"
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => remove.mutate()}
            >
              {t("Remove for good")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setConfirmRemove(false)}
            >
              {t("Keep")}
            </Button>
          </span>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setConfirmRemove(true)}
          >
            {t("Remove")}
          </Button>
        )}
      </div>
      <p className="text-muted-foreground text-xs">
        {t(KIND_HELP[trigger.kind])}
      </p>
      {url && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs">{t("POST to")}</span>
          <code className="break-all rounded bg-background px-2 py-1 text-xs">
            {url}
          </code>
          <CopyButton value={url} label={t("Copy URL")} />
        </div>
      )}
      {trigger.kind === "email" &&
        (trigger.address ? (
          <div className="flex flex-wrap items-center gap-2">
            <code className="break-all rounded bg-background px-2 py-1 text-xs">
              {trigger.address}
            </code>
            <CopyButton value={trigger.address} label={t("Copy address")} />
          </div>
        ) : (
          <p className="text-amber-600 text-xs dark:text-amber-500">
            {t(
              "Inbound email is not configured on this deployment (OPENBOT_INBOUND_EMAIL_DOMAIN and OPENBOT_INBOUND_EMAIL_SNS_TOPIC_ARNS), so this address cannot receive mail yet.",
            )}
          </p>
        ))}
      {generated && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs">{t("Key")}</span>
          {shown ? (
            <>
              <code className="break-all rounded bg-background px-2 py-1 text-xs">
                {shown}
              </code>
              <CopyButton value={shown} label={t("Copy key")} />
              {trigger.kind === "webhook" && (
                <CopyButton
                  value={`Authorization: Bearer ${shown}`}
                  label={t("Copy header")}
                />
              )}
            </>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={reveal.isPending}
              onClick={() => reveal.mutate()}
            >
              {t("Show key")}
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={rotate.isPending}
            onClick={() => rotate.mutate()}
          >
            {t("Rotate key")}
          </Button>
        </div>
      )}
      {trigger.kind === "webhook" && shown && (
        <code className="break-all rounded bg-background px-2 py-1 text-xs">
          Authorization: Bearer {shown}
        </code>
      )}
      {VENDOR_SECRET.has(trigger.kind) && (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            rotate.mutate();
          }}
        >
          <span
            className={
              trigger.hasSecret
                ? "text-xs"
                : "text-amber-600 text-xs dark:text-amber-500"
            }
          >
            {trigger.hasSecret
              ? t("Signing secret stored")
              : t("Waiting for the signing secret")}
          </span>
          <Input
            className="h-8 max-w-64"
            type="password"
            autoComplete="new-password"
            placeholder={
              trigger.hasSecret
                ? t("Paste a new secret to rotate")
                : t("Paste the signing secret")
            }
            value={pasted}
            onChange={(event) => setPasted(event.target.value)}
            required
          />
          <Button size="sm" type="submit" disabled={rotate.isPending}>
            {t("Save secret")}
          </Button>
        </form>
      )}
      {(reveal.error || rotate.error || remove.error || toggle.error) && (
        <p role="alert" className="text-destructive text-xs">
          {reveal.error?.message ??
            rotate.error?.message ??
            remove.error?.message ??
            toggle.error?.message}
        </p>
      )}
    </div>
  );
}

function NewTrigger({
  goalId,
  onCreated,
}: {
  goalId: string;
  onCreated: (created: {
    trigger: TriggerRecord;
    secret: string | null;
  }) => Promise<void>;
}) {
  const { t } = useTranslation("settings");
  const id = useId();
  const [kind, setKind] = useState<TriggerKind>("webhook");
  const [eventTypes, setEventTypes] = useState("");
  const [fieldPath, setFieldPath] = useState("");
  const [fieldEquals, setFieldEquals] = useState("");
  const [repository, setRepository] = useState("");
  const [senders, setSenders] = useState("");
  const [secret, setSecret] = useState("");
  const [teamId, setTeamId] = useState("");
  const [mode, setMode] = useState<
    "mention" | "phrase" | "reaction" | "message"
  >("mention");
  const [phrases, setPhrases] = useState("");
  const [reactions, setReactions] = useState("");
  const [channels, setChannels] = useState("");
  const config = (): TriggerConfig => {
    if (kind === "slack")
      return {
        kind,
        teamId: teamId.trim(),
        mode,
        phrases: list(phrases),
        reactions: list(reactions).map((reaction) =>
          reaction.replace(/:/g, ""),
        ),
        channels: list(channels),
      };
    const filter = {
      eventTypes: list(eventTypes),
      ...(fieldPath.trim() && fieldEquals.trim()
        ? { field: { path: fieldPath.trim(), equals: fieldEquals.trim() } }
        : {}),
    };
    if (kind === "github")
      return {
        kind,
        filter,
        ...(repository.trim() ? { repository: repository.trim() } : {}),
      };
    if (kind === "email")
      return { kind, filter, allowedSenders: list(senders) };
    return { kind, filter };
  };
  const create = useMutation({
    mutationFn: () =>
      createTrigger(goalId, {
        config: config(),
        ...(VENDOR_SECRET.has(kind) && secret ? { secret } : {}),
      }),
    onSuccess: onCreated,
  });
  const placeholder: Record<TriggerKind, string> = {
    webhook: "deploy.finished (blank: any)",
    github: "issues.opened, pull_request",
    linear: "Issue.create, Comment",
    sentry: "issue.created, event_alert.triggered",
    pagerduty: "incident.triggered",
    email: "received",
    slack: "",
  };
  return (
    <form
      className="grid gap-3 rounded-md border p-3"
      onSubmit={(event) => {
        event.preventDefault();
        create.mutate();
      }}
    >
      <label className={fieldClass}>
        {t("Trigger")}
        <select
          className={selectClass}
          value={kind}
          onChange={(event) => setKind(event.target.value as TriggerKind)}
        >
          {(Object.keys(KIND_LABEL) as TriggerKind[]).map((value) => (
            <option key={value} value={value}>
              {t(KIND_LABEL[value])}
            </option>
          ))}
        </select>
      </label>
      <p className="text-muted-foreground text-xs">{t(KIND_HELP[kind])}</p>
      {kind === "slack" ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <label className={fieldClass} htmlFor={`${id}-team`}>
            {t("Slack team ID")}
            <Input
              id={`${id}-team`}
              required
              placeholder="T0123ABCD" /* i18n-ignore: an example of the format, not prose */
              value={teamId}
              onChange={(event) => setTeamId(event.target.value)}
            />
          </label>
          <label className={fieldClass}>
            {t("Fire on")}
            <select
              className={selectClass}
              value={mode}
              onChange={(event) => setMode(event.target.value as typeof mode)}
            >
              <option value="mention">{t("The Bot is mentioned")}</option>
              <option value="phrase">{t("A message contains a phrase")}</option>
              <option value="reaction">{t("A reaction is added")}</option>
              <option value="message">{t("Any message")}</option>
            </select>
          </label>
          {mode === "phrase" && (
            <label className={fieldClass} htmlFor={`${id}-phrases`}>
              {t("Phrases (comma separated)")}
              <Input
                id={`${id}-phrases`}
                required
                value={phrases}
                onChange={(event) => setPhrases(event.target.value)}
              />
            </label>
          )}
          {mode === "reaction" && (
            <label className={fieldClass} htmlFor={`${id}-reactions`}>
              {t("Reactions (blank: any)")}
              <Input
                id={`${id}-reactions`}
                placeholder="eyes, rotating_light" /* i18n-ignore: an example of the format, not prose */
                value={reactions}
                onChange={(event) => setReactions(event.target.value)}
              />
            </label>
          )}
          <label className={fieldClass} htmlFor={`${id}-channels`}>
            {t("Channel IDs (blank: all the Bot is in)")}
            <Input
              id={`${id}-channels`}
              placeholder="C0123ABCD" /* i18n-ignore: an example of the format, not prose */
              value={channels}
              onChange={(event) => setChannels(event.target.value)}
            />
          </label>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-3">
          <label className={fieldClass} htmlFor={`${id}-types`}>
            {t("Event types")}
            <Input
              id={`${id}-types`}
              placeholder={placeholder[kind]}
              value={eventTypes}
              onChange={(event) => setEventTypes(event.target.value)}
            />
          </label>
          <label className={fieldClass} htmlFor={`${id}-path`}>
            {t("Only when field")}
            <Input
              id={`${id}-path`}
              placeholder="data.team.key" /* i18n-ignore: an example of the format, not prose */
              value={fieldPath}
              onChange={(event) => setFieldPath(event.target.value)}
            />
          </label>
          <label className={fieldClass} htmlFor={`${id}-equals`}>
            {t("equals")}
            <Input
              id={`${id}-equals`}
              placeholder="ENG" /* i18n-ignore: an example of the format, not prose */
              value={fieldEquals}
              onChange={(event) => setFieldEquals(event.target.value)}
            />
          </label>
          {kind === "github" && (
            <label className={fieldClass} htmlFor={`${id}-repo`}>
              {t("Repository (optional)")}
              <Input
                id={`${id}-repo`}
                placeholder="owner/name" /* i18n-ignore: an example of the format, not prose */
                value={repository}
                onChange={(event) => setRepository(event.target.value)}
              />
            </label>
          )}
          {kind === "email" && (
            <label className={fieldClass} htmlFor={`${id}-senders`}>
              {t("Allowed senders (blank: anyone)")}
              <Input
                id={`${id}-senders`}
                placeholder="ops@example.com, example.com" /* i18n-ignore: an example of the format, not prose */
                value={senders}
                onChange={(event) => setSenders(event.target.value)}
              />
            </label>
          )}
          {VENDOR_SECRET.has(kind) && (
            <label className={fieldClass} htmlFor={`${id}-secret`}>
              {t("Signing secret (can be added later)")}
              <Input
                id={`${id}-secret`}
                type="password"
                autoComplete="new-password"
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
              />
            </label>
          )}
        </div>
      )}
      {create.error && (
        <p role="alert" className="text-destructive text-sm">
          {create.error.message}
        </p>
      )}
      <Button type="submit" disabled={create.isPending}>
        {create.isPending
          ? t("Adding…")
          : t("Add {{value}} trigger", { value: t(KIND_LABEL[kind]) })}
      </Button>
    </form>
  );
}
