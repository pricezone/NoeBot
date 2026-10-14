import { useMutation, useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import {
  ProactiveResearchSettings,
  SuggestionsInbox,
} from "@/components/suggestions/proactive-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { i18n, useTranslation } from "@/lib/i18n";
import { intlLocale } from "@/lib/i18n/format";
import {
  addMemorySource,
  availableMemorySourcesQueryOptions,
  createMemory,
  deleteMemory,
  type MemoryRecord,
  memoriesQueryOptions,
  memoryKeys,
  memorySourceAction,
  memorySourcesQueryOptions,
  updateMemory,
} from "@/lib/memory";
import { queryClient } from "@/query-client";

// min-w-0 and w-full, or a select as wide as its longest option pushes its grid column off the card.
const field = "grid min-w-0 gap-1 text-sm";
const select =
  "h-9 w-full min-w-0 rounded-md border bg-background px-3 text-sm";
async function refresh() {
  await queryClient.invalidateQueries({ queryKey: memoryKeys.all });
}
/**
 * What the Bots remember, and which connected apps may add to it.
 *
 * The body of Settings › Memory (`/settings/memory`), which supplies the heading; this used to be
 * the `/memory` page.
 */
export function MemorySection() {
  const { t } = useTranslation("settings");
  const memories = useQuery(memoriesQueryOptions());
  const [content, setContent] = useState("");
  const formId = useId();
  const remember = useMutation({
    mutationFn: createMemory,
    onSuccess: async () => {
      setContent("");
      await refresh();
    },
  });
  return (
    <div className="grid gap-6">
      <SuggestionsInbox />
      <form
        className="grid gap-3 rounded-lg border p-4"
        onSubmit={(event) => {
          event.preventDefault();
          remember.mutate(content);
        }}
      >
        <h2 className="font-semibold">{t("Remember a fact")}</h2>
        <label className={field} htmlFor={formId}>
          {t("Something you want your Bots to know")}
        </label>
        <Textarea
          id={formId}
          required
          maxLength={6000}
          value={content}
          onChange={(event) => setContent(event.target.value)}
          placeholder={t("I prefer meetings in the morning.")}
        />
        <Button
          type="submit"
          disabled={remember.isPending || !content.trim()}
          className="justify-self-start"
        >
          {t("Remember")}
        </Button>
        {remember.error && (
          <p role="alert" className="text-destructive">
            {remember.error.message}
          </p>
        )}
      </form>
      <ProactiveResearchSettings />
      <Sources />
      <section className="grid gap-3">
        <h2 className="font-semibold">{t("Your memories")}</h2>
        {memories.isPending ? (
          <p>{t("Loading memories…")}</p>
        ) : memories.error ? (
          <p role="alert" className="text-destructive">
            {memories.error.message}
          </p>
        ) : memories.data?.length ? (
          memories.data.map((memory) => (
            <MemoryCard key={memory.id} memory={memory} />
          ))
        ) : (
          <p className="text-muted-foreground">
            {t("You have no memories yet.")}
          </p>
        )}
      </section>
    </div>
  );
}
function MemoryCard({ memory }: { memory: MemoryRecord }) {
  const { t } = useTranslation("settings");
  const [content, setContent] = useState(memory.content);
  const id = useId();
  const save = useMutation({
    mutationFn: (input: {
      content?: string;
      enabled?: boolean;
      reviewState?: "confirmed";
    }) => updateMemory(memory.id, input),
    onSuccess: refresh,
  });
  const forget = useMutation({
    mutationFn: () => deleteMemory(memory.id),
    onSuccess: refresh,
  });
  return (
    <article className="grid gap-3 rounded-lg border p-4">
      <div className="flex flex-wrap justify-between gap-2">
        <label htmlFor={id} className="text-sm text-muted-foreground">
          {memory.provenance}
        </label>
        <span className="text-xs text-muted-foreground">
          {!memory.enabled
            ? t("Disabled")
            : memory.reviewState === "unreviewed"
              ? memory.formedBy === "bot"
                ? t("Formed by your Bot · awaiting review")
                : t("Imported · awaiting review")
              : t("Reviewed")}
        </span>
      </div>
      {memory.formedBy === "bot" && (
        <p className="text-xs text-muted-foreground">
          {t("From")} {memory.sourceApp ?? t("a conversation")}
          {memory.observedAt
            ? t(", read {{value}}", {
                value: new Date(memory.observedAt).toLocaleString(intlLocale()),
              })
            : ""}
          {memory.sourceLink && (
            <>
              {" · "}
              <a
                className="underline"
                href={memory.sourceLink}
                target="_blank"
                rel="noreferrer"
              >
                {t("Open record")}
              </a>
            </>
          )}
        </p>
      )}
      <Textarea
        id={id}
        value={content}
        maxLength={6000}
        onChange={(event) => setContent(event.target.value)}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={save.isPending || !content.trim()}
          onClick={() => save.mutate({ content })}
        >
          {t("Save")}
        </Button>
        {memory.reviewState === "unreviewed" && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => save.mutate({ reviewState: "confirmed" })}
          >
            {t("Confirm")}
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          onClick={() => save.mutate({ enabled: !memory.enabled })}
        >
          {memory.enabled ? t("Disable") : t("Enable")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={forget.isPending}
          onClick={() => forget.mutate()}
        >
          {t("Forget")}
        </Button>
      </div>
      {(save.error || forget.error) && (
        <p role="alert" className="text-destructive">
          {save.error?.message || forget.error?.message}
        </p>
      )}
    </article>
  );
}
function Sources() {
  const { t } = useTranslation("settings");
  const sources = useQuery(memorySourcesQueryOptions());
  const bots = useQuery(agentListQueryOptions());
  const [agentId, setAgentId] = useState("");
  const [toolRef, setToolRef] = useState("");
  const [title, setTitle] = useState("");
  const [args, setArgs] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const id = useId();
  const tools = useQuery(availableMemorySourcesQueryOptions(agentId));
  const chosen = tools.data?.find((tool) => tool.ref === toolRef);
  const properties = chosen?.inputSchema.properties;
  const settings =
    properties && typeof properties === "object" && !Array.isArray(properties)
      ? Object.entries(properties).flatMap(([name, value]) =>
          value && typeof value === "object" && !Array.isArray(value)
            ? [
                {
                  name,
                  schema: value as {
                    type?: string;
                    title?: string;
                    description?: string;
                    enum?: unknown[];
                  },
                },
              ]
            : [],
        )
      : [];
  const required = Array.isArray(chosen?.inputSchema.required)
    ? chosen.inputSchema.required
    : [];
  const add = useMutation({
    mutationFn: addMemorySource,
    onSuccess: async () => {
      setTitle("");
      await refresh();
    },
  });
  const action = useMutation({
    mutationFn: ({
      sourceId,
      name,
    }: {
      sourceId: string;
      name: "sync" | "remove" | "enable" | "disable";
    }) => memorySourceAction(sourceId, name),
    onSuccess: refresh,
  });
  return (
    <section className="grid gap-3">
      <h2 className="font-semibold">{t("Connected app sources")}</h2>
      <p className="text-sm text-muted-foreground">
        {t(
          "Opt in to a read from an app your Bot can already access. Enabled sources refresh every 15 minutes. Their facts are available to the selected Bot.",
        )}
      </p>
      <form
        className="grid gap-3 rounded-lg border p-4"
        onSubmit={(event) => {
          event.preventDefault();
          try {
            const values: Record<string, unknown> = {};
            for (const setting of settings) {
              const value = args[setting.name];
              if (!value) continue;
              if (
                setting.schema.type === "number" ||
                setting.schema.type === "integer"
              ) {
                const number = Number(value);
                if (!Number.isFinite(number))
                  throw new Error(
                    i18n.t("Enter a number for {{name}}.", {
                      name: setting.name,
                    }),
                  );
                values[setting.name] = number;
              } else if (setting.schema.type === "boolean")
                values[setting.name] = value === "true";
              else if (setting.schema.type === "array")
                values[setting.name] = value
                  .split("\n")
                  .map((entry) => entry.trim())
                  .filter(Boolean);
              else if (setting.schema.type === "object")
                throw new Error(
                  i18n.t("Choose an action with simple search settings."),
                );
              else values[setting.name] = value;
            }
            setError("");
            add.mutate({
              agentId,
              toolRef,
              title,
              args: values,
            });
          } catch (cause) {
            setError(
              cause instanceof Error
                ? cause.message
                : t("Check the source settings."),
            );
          }
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <label className={field}>
            {t("Bot")}
            <select
              required
              className={select}
              value={agentId}
              onChange={(event) => {
                setAgentId(event.target.value);
                setToolRef("");
              }}
            >
              <option value="">{t("Choose a Bot")}</option>
              {bots.data?.map((bot) => (
                <option key={bot.id} value={bot.id}>
                  {bot.name}
                </option>
              ))}
            </select>
          </label>
          <label className={field}>
            {t("Connected app action")}
            <select
              required
              className={select}
              value={toolRef}
              onChange={(event) => {
                setToolRef(event.target.value);
                setArgs({});
              }}
            >
              <option value="">{t("Choose a read action")}</option>
              {tools.data?.map((tool) => (
                <option key={tool.ref} value={tool.ref}>
                  {tool.title}
                </option>
              ))}
            </select>
          </label>
        </div>
        {chosen && (
          <p className="text-sm text-muted-foreground">{chosen.description}</p>
        )}
        <label className={field} htmlFor={`${id}-name`}>
          {t("Source name")}
          <Input
            id={`${id}-name`}
            required
            maxLength={160}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={t("My project documents")}
          />
        </label>
        {settings.map(({ name, schema }) => (
          <label key={name} className={field} htmlFor={`${id}-${name}`}>
            {schema.title || name.replaceAll("_", " ")}
            {required.includes(name) ? " *" : ""}
            {schema.type === "boolean" || schema.enum ? (
              <select
                id={`${id}-${name}`}
                className={select}
                value={args[name] ?? ""}
                required={required.includes(name)}
                onChange={(event) =>
                  setArgs({ ...args, [name]: event.target.value })
                }
              >
                <option value="">{t("Choose a value")}</option>
                {(schema.enum ?? ["true", "false"]).map((value) => (
                  <option key={String(value)} value={String(value)}>
                    {String(value)}
                  </option>
                ))}
              </select>
            ) : (
              <Input
                id={`${id}-${name}`}
                type={
                  schema.type === "number" || schema.type === "integer"
                    ? "number"
                    : "text"
                }
                required={required.includes(name)}
                value={args[name] ?? ""}
                onChange={(event) =>
                  setArgs({ ...args, [name]: event.target.value })
                }
              />
            )}
            {schema.description && (
              <span className="text-xs text-muted-foreground">
                {schema.description}
              </span>
            )}
          </label>
        ))}
        <Button
          type="submit"
          className="justify-self-start"
          disabled={add.isPending || !toolRef}
        >
          {add.isPending ? t("Reading source…") : t("Add and sync source")}
        </Button>
        {(error || add.error || tools.error) && (
          <p role="alert" className="text-destructive">
            {error || add.error?.message || tools.error?.message}
          </p>
        )}
      </form>
      {sources.error && (
        <p role="alert" className="text-destructive">
          {sources.error.message}
        </p>
      )}
      {sources.data?.map((source) => (
        <article key={source.id} className="grid gap-2 rounded-lg border p-4">
          <div className="flex justify-between">
            <strong>{source.title}</strong>
            <span className="text-sm text-muted-foreground">
              {source.enabled
                ? source.syncStatus === "succeeded"
                  ? t("Up to date")
                  : source.syncStatus
                : t("Disabled")}
            </span>
          </div>
          {source.lastSyncAt && (
            <p className="text-xs text-muted-foreground">
              {t("Last read {{value}}", {
                value: new Date(source.lastSyncAt).toLocaleString(intlLocale()),
              })}
            </p>
          )}
          {source.syncError && (
            <p role="alert" className="text-destructive">
              {source.syncError}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={!source.enabled || action.isPending}
              onClick={() =>
                action.mutate({ sourceId: source.id, name: "sync" })
              }
            >
              {t("Sync now")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                action.mutate({
                  sourceId: source.id,
                  name: source.enabled ? "disable" : "enable",
                })
              }
            >
              {source.enabled ? t("Disable") : t("Enable")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                action.mutate({ sourceId: source.id, name: "remove" })
              }
            >
              {t("Remove")}
            </Button>
          </div>
        </article>
      ))}
      {action.error && (
        <p role="alert" className="text-destructive">
          {action.error.message}
        </p>
      )}
    </section>
  );
}
