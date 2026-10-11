import { IconChevronDown, IconPlus } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import type * as React from "react";
import { avatarSchemeOf, type AvatarColor } from "../../../../shared/avatar";
import { TEMPLATE_CATEGORIES } from "../../../../shared/templates";
import type {
  MarketplaceSearch,
  SetMarketplaceSearch,
} from "@/components/marketplace/search";
import { NoeBotAvatar } from "@/components/noe-bot/noe-bot-avatar";
import { edgeFor } from "@/components/noe-bot/pixel-art";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { addTemplateMutationOptions } from "@/lib/agents/mutations";
import {
  type AgentProfile,
  agentListQueryOptions,
  type BotTemplate,
  isSharedWithYou,
  matchingAgents,
  templateListQueryOptions,
} from "@/lib/agents/queries";
import { cn } from "@/lib/utils";

/**
 * The Agents tab, laid out like Grok Bot's Bot marketplace: category pills, a featured strip of
 * four, then rows per category — and the person's own Bots, in the same rows, with Open.
 *
 * Measured off x.ai/bot/marketplace: pills `rounded-full px-[18px] py-2.5 text-sm font-medium`,
 * a featured card `rounded-2xl px-3 pt-5 pb-4` with a 92px mark and the name in the Bot's own
 * colour, rows `px-3 py-1 rounded-xl` with a 44px mark, `text-[15px] leading-5 font-medium` and
 * " by Creator" in normal weight, a one-line summary and a round Add. The marks are Noë Bot's
 * own faces, each template with the colour and expression its author chose.
 *
 * WHICH CATEGORY IS THE ADDRESS (`?category`), so Back works and a category can be linked to. The
 * featured strip shows only on All with no search, as Grok Bot's does; the "Your Bots" pill shows
 * the person's own and the Bots shared with them, alone.
 *
 * THE ROSTER'S ERROR RULES CARRY OVER from the component this replaced: a stale roster beats an
 * error card, because TanStack Query keeps the last good `data` across a failed background
 * refetch, and only a query that has never once succeeded says it could not be loaded.
 */

const YOUR_BOTS = "your-bots";

/** How many rows a category shows before "View all". */
const PREVIEW_ROWS = 4;

/** The name's colour on a card: the Bot's own, except the two that vanish into a page. */
function nameColour(color: AvatarColor): React.CSSProperties | undefined {
  const scheme = avatarSchemeOf(color);
  if (!scheme || edgeFor(scheme.background) !== null) return undefined;
  return { color: scheme.background };
}

export function TemplateMarket({
  search,
  onSearchChange,
}: {
  search: MarketplaceSearch;
  onSearchChange: SetMarketplaceSearch;
}) {
  const queryClient = useQueryClient();
  const query = search.q ?? "";
  const category = search.category;
  const templates = useQuery(templateListQueryOptions());
  const agents = useQuery(agentListQueryOptions());
  const hidden = useQuery(agentListQueryOptions(true));
  const [error, setError] = useState<string | null>(null);
  const add = useMutation({
    ...addTemplateMutationOptions(queryClient),
    onError: (thrown: Error) => setError(thrown.message),
    onSuccess: (agent) =>
      onSearchChange({ tab: "agents", q: search.q, agent: agent.id }),
  });

  const show = (next: string | undefined) =>
    onSearchChange({
      tab: "agents",
      q: query === "" ? undefined : query,
      ...(next === undefined ? {} : { category: next }),
    });
  const open = (template: BotTemplate) =>
    onSearchChange({
      tab: "agents",
      q: query === "" ? undefined : query,
      ...(category === undefined ? {} : { category }),
      template: template.id,
    });

  const needle = query.trim().toLocaleLowerCase();
  const matching = (templates.data ?? []).filter(
    (template) =>
      needle === "" ||
      `${template.name} ${template.creator} ${template.summary}`
        .toLocaleLowerCase()
        .includes(needle),
  );
  const featured =
    category === undefined && needle === ""
      ? matching.filter((template) => template.featured).slice(0, 4)
      : [];
  const featuredIds = new Set(featured.map((template) => template.id));
  const categories = TEMPLATE_CATEGORIES.filter((name) =>
    (templates.data ?? []).some((template) =>
      template.categories.includes(name),
    ),
  );
  const sections = (
    category === undefined
      ? categories
      : categories.filter((name) => name === category)
  ).map((name) => {
    const all = matching.filter(
      (template) =>
        template.categories.includes(name) && !featuredIds.has(template.id),
    );
    const whole = category === name;
    return {
      name,
      templates: whole ? all : all.slice(0, PREVIEW_ROWS),
      hasMore: !whole && all.length > PREVIEW_ROWS,
    };
  });

  const roster = agents.data ? matchingAgents(agents.data, query) : undefined;
  const mine = roster
    ?.filter((agent) => agent.mine)
    .sort((left, right) => Number(right.pinned) - Number(left.pinned));
  const shared = roster?.filter(isSharedWithYou);
  const hiddenAgents = hidden.data ? matchingAgents(hidden.data, query) : [];
  const rosterFailed = agents.isError && roster === undefined;
  const showBots = category === undefined || category === YOUR_BOTS;
  const showTemplates = category !== YOUR_BOTS;

  const pill = (key: string | undefined, label: string) => (
    <button
      aria-pressed={category === key}
      className={cn(
        "rounded-full px-[18px] py-2.5 text-sm font-medium transition-colors",
        category === key
          ? "bg-foreground text-background hover:brightness-90"
          : "bg-foreground/[0.03] hover:bg-foreground/[0.07]",
      )}
      key={key ?? "all"}
      onClick={() => show(key)}
      type="button"
    >
      {label}
    </button>
  );

  const templateRow = (template: BotTemplate) => (
    <div
      className="flex items-center gap-3 rounded-xl px-3 py-1 transition-colors hover:bg-card"
      data-testid={`template-${template.id}`}
      key={template.id}
    >
      <button
        aria-label={`About ${template.name}`}
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
        onClick={() => open(template)}
        type="button"
      >
        <NoeBotAvatar
          color={template.avatar.color}
          expression={template.avatar.expression}
          seed={template.id}
          size={44}
        />
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-[15px] font-medium leading-5">
            {template.name}
            <span className="font-normal text-muted-foreground">
              {" "}
              by {template.creator}
            </span>
          </span>
          <span className="line-clamp-1 text-sm text-muted-foreground">
            {template.summary}
          </span>
        </span>
      </button>
      <Button
        aria-label={`Add ${template.name}`}
        className="h-8 shrink-0 rounded-full px-3.5 text-xs"
        disabled={add.isPending && add.variables === template.id}
        onClick={() => {
          setError(null);
          add.mutate(template.id);
        }}
        size="sm"
        type="button"
        variant="secondary"
      >
        {add.isPending && add.variables === template.id ? "Adding…" : "Add"}
      </Button>
    </div>
  );

  const agentRow = (agent: AgentProfile) => (
    <div
      className="flex items-center gap-3 rounded-xl px-3 py-1 transition-colors hover:bg-card"
      data-testid={`bot-${agent.id}`}
      key={agent.id}
    >
      <NoeBotAvatar
        color={agent.avatarColor}
        expression={agent.avatarExpression}
        seed={agent.avatarSeed}
        size={44}
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[15px] font-medium leading-5">
          {agent.name}
          <span className="font-normal text-muted-foreground">
            {" "}
            · {agent.title}
          </span>
        </span>
        <span className="line-clamp-1 text-sm text-muted-foreground">
          {agent.roleDescription}
        </span>
      </span>
      <Link
        aria-label={`Open ${agent.name}`}
        className="shrink-0 rounded-full bg-secondary px-3.5 py-1.5 text-xs font-medium text-secondary-foreground transition-colors hover:bg-secondary/80"
        search={{ tab: "agents", q: search.q, agent: agent.id }}
        to="/marketplace"
      >
        Open
      </Link>
    </div>
  );

  const grid = "grid grid-cols-1 gap-x-10 gap-y-2 sm:grid-cols-2";

  return (
    <div className="flex w-full flex-col">
      <div className="mt-1 flex flex-wrap gap-2">
        {pill(undefined, "All")}
        {pill(YOUR_BOTS, "Your Bots")}
        {categories.map((name) => pill(name, name))}
      </div>

      {error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}

      {showTemplates ? (
        templates.isPending ? (
          <Skeleton className="mt-6 h-[180px]" />
        ) : templates.isError && !templates.data ? (
          <p className="mt-6 text-destructive text-sm" role="alert">
            Bot templates couldn't be loaded.
          </p>
        ) : (
          <>
            {featured.length > 0 ? (
              <section aria-label="Featured" className="pt-6">
                <h2 className="mb-4 text-lg font-medium">Featured</h2>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 sm:gap-4">
                  {featured.map((template) => (
                    <button
                      className="flex flex-col items-center rounded-2xl bg-card px-3 pt-5 pb-4 text-center transition-colors duration-200 hover:bg-foreground/[0.05]"
                      data-testid={`featured-${template.id}`}
                      key={template.id}
                      onClick={() => open(template)}
                      type="button"
                    >
                      <NoeBotAvatar
                        color={template.avatar.color}
                        expression={template.avatar.expression}
                        name={template.name}
                        seed={template.id}
                        size={92}
                      />
                      <span
                        className="mt-3 text-sm font-medium"
                        style={nameColour(template.avatar.color)}
                      >
                        {template.name}
                      </span>
                      <span className="mt-1 text-xs text-muted-foreground">
                        by {template.creator}
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            ) : null}
            {sections.map((section) => (
              <section
                aria-label={section.name}
                className="pt-10 first:pt-6"
                key={section.name}
              >
                <div className="mb-3 flex items-baseline justify-between pr-3">
                  <h2 className="text-lg font-medium">{section.name}</h2>
                  {section.hasMore ? (
                    <button
                      className="text-sm text-muted-foreground transition-colors hover:text-foreground"
                      onClick={() => show(section.name)}
                      type="button"
                    >
                      View all
                    </button>
                  ) : null}
                </div>
                {section.templates.length > 0 ? (
                  <div className={grid}>
                    {section.templates.map(templateRow)}
                  </div>
                ) : (
                  <p
                    className="px-3 text-sm text-muted-foreground"
                    role="status"
                  >
                    {needle
                      ? `Nothing for “${query.trim()}”. Try another creator or Bot name.`
                      : `Nothing in ${section.name} yet.`}
                  </p>
                )}
              </section>
            ))}
          </>
        )
      ) : null}

      {showBots ? (
        <>
          <section aria-label="Your Bots" className="pt-10">
            <div className="mb-3 flex items-center justify-between pr-3">
              <h2 className="text-lg font-medium">Your Bots</h2>
              <Button
                render={(props) => (
                  <Link
                    search={{ tab: "agents", new: true }}
                    to="/marketplace"
                    {...props}
                  />
                )}
                size="sm"
                variant="secondary"
              >
                <IconPlus />
                Create new Bot
              </Button>
            </div>
            {agents.isPending ? (
              <Skeleton className="h-[120px]" />
            ) : mine?.length ? (
              <div className={grid}>{mine.map(agentRow)}</div>
            ) : rosterFailed ? (
              <p className="px-3 text-destructive text-sm" role="alert">
                Your Bots couldn't be loaded.
              </p>
            ) : (
              <p className="px-3 text-sm text-muted-foreground" role="status">
                {needle
                  ? `None of your Bots match “${query.trim()}”.`
                  : "You don't have any Bots yet. Add one above, or create your own."}
              </p>
            )}
          </section>
          <section aria-label="Shared with you" className="pt-10">
            <h2 className="mb-3 text-lg font-medium">Shared with you</h2>
            {agents.isPending ? (
              <Skeleton className="h-[120px]" />
            ) : shared?.length ? (
              <div className={grid}>{shared.map(agentRow)}</div>
            ) : rosterFailed ? (
              <p className="px-3 text-destructive text-sm" role="alert">
                Shared with you couldn't be loaded.
              </p>
            ) : (
              <p className="px-3 text-sm text-muted-foreground" role="status">
                {needle
                  ? `No shared Bots match “${query.trim()}”.`
                  : "Nobody has shared a Bot with you yet."}
              </p>
            )}
          </section>
          {hiddenAgents.length > 0 ? (
            <details className="group mt-8 w-full">
              <summary className="flex cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden">
                <h2 className="text-lg font-medium">Hidden</h2>
                <span className="text-sm text-muted-foreground">
                  {hiddenAgents.length}
                </span>
                <IconChevronDown
                  aria-hidden="true"
                  className="size-4 text-muted-foreground transition-transform group-open:rotate-180 motion-reduce:transition-none"
                />
              </summary>
              <div className={cn(grid, "mt-4")}>
                {hiddenAgents.map(agentRow)}
              </div>
            </details>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
