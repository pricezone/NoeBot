import {
  IconBolt,
  IconChevronLeft,
  IconLink,
  IconRepeat,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  countOf,
  Fact,
  Group,
  Row,
} from "@/components/marketplace/detail-parts";
import { NoeBotAvatar } from "@/components/noe-bot/noe-bot-avatar";
import { PluginLogo } from "@/components/plugins/plugin-logo";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { addTemplateMutationOptions } from "@/lib/agents/mutations";
import {
  type BotTemplate,
  templateListQueryOptions,
} from "@/lib/agents/queries";
import { useTranslation } from "@/lib/i18n";

/**
 * A Bot template's own page inside the Marketplace, in place of the Agents tab, laid out the way a
 * plugin's page is: back chevron, the mascot at 92px, the name and creator, Share and Add Bot on
 * the right, the description, then how it should work, the playbooks it runs, the jobs that run
 * on their own, the apps it uses, and a few facts in rows.
 *
 * It used to be a dialog over the tab. A page is what Grok Bot opens, and it is what the Apps tab
 * already did for a plugin; a person moving between the two tabs should not meet a different
 * answer to the same click. The address is the same as before (`?tab=agents&template=<id>`), so a
 * shared link keeps working and Back returns to the list with the term and the category kept.
 *
 * Add here is the row's own Add: the same mutation, and the same landing — the new Bot's own
 * dialog over the tab, where it can be renamed or started.
 */
export function TemplateDetail({
  id,
  onBack,
  onAdded,
}: {
  id: string;
  onBack: () => void;
  onAdded: (agentId: string) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const templates = useQuery(templateListQueryOptions());
  const [error, setError] = useState<string | null>(null);
  const [isCopied, setIsCopied] = useState(false);
  const add = useMutation({
    ...addTemplateMutationOptions(queryClient),
    onError: (thrown: Error) => setError(thrown.message),
    onSuccess: (agent) => onAdded(agent.id),
  });

  useEffect(() => {
    if (!isCopied) return;
    const timer = setTimeout(() => setIsCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [isCopied]);

  const back = (
    <Button
      aria-label={t("Back to agents")}
      className="-ml-2 mb-4 self-start rounded-full"
      onClick={onBack}
      size="icon"
      type="button"
      variant="ghost"
    >
      <IconChevronLeft />
    </Button>
  );

  if (templates.isPending) {
    return (
      <div className="flex flex-col">
        {back}
        <Skeleton className="h-[92px] w-full max-w-md rounded-2xl" />
        <Skeleton className="mt-6 h-12 w-full" />
        <Skeleton className="mt-6 h-40 w-full rounded-2xl" />
      </div>
    );
  }
  const template: BotTemplate | undefined = templates.data?.find(
    (candidate) => candidate.id === id,
  );
  if (!template) {
    return (
      <div className="flex flex-col">
        {back}
        <p className="text-destructive text-sm" role="alert">
          {templates.data
            ? t("That template is not here any more.")
            : `${t("This template couldn't be loaded.")}${templates.error?.message ? ` ${templates.error.message}` : ""}`}
        </p>
      </div>
    );
  }

  const share = async () => {
    const address = `${window.location.origin}/marketplace?tab=agents&template=${encodeURIComponent(template.id)}`;
    try {
      await navigator.clipboard.writeText(address);
      setIsCopied(true);
    } catch {
      setError(t("The link couldn't be copied."));
    }
  };

  return (
    <div className="flex flex-col">
      {back}

      {error ? (
        <p className="mb-4 text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}

      <header className="flex flex-wrap items-start gap-4">
        <NoeBotAvatar
          color={template.avatar.color}
          expression={template.avatar.expression}
          name={template.name}
          seed={template.id}
          size={92}
        />
        <div className="flex min-w-0 flex-1 flex-col justify-center gap-1 self-stretch">
          <h1 className="truncate text-2xl font-medium">{template.name}</h1>
          <p className="text-[15px] text-muted-foreground">
            {t("By {{creator}}", { creator: template.creator })}
          </p>
        </div>
        <div className="flex items-center gap-2 self-center">
          <Button
            className="h-10 rounded-full px-4 text-sm"
            onClick={share}
            type="button"
            variant="secondary"
          >
            <IconLink aria-hidden="true" className="size-4" />
            {isCopied ? t("Copied") : t("Share")}
          </Button>
          <Button
            className="h-10 rounded-full px-5 text-sm"
            disabled={add.isPending}
            onClick={() => {
              setError(null);
              add.mutate(template.id);
            }}
            type="button"
          >
            {add.isPending ? t("Adding…") : t("Add Bot")}
          </Button>
        </div>
      </header>

      <p className="mt-6 text-[15px] leading-6 text-foreground/90">
        {template.description}
      </p>

      <section aria-label={t("Instructions")} className="mt-8">
        <h2 className="mb-1 text-[15px] font-medium">{t("Instructions")}</h2>
        <p className="mb-3 text-sm text-muted-foreground">
          {t("How this Bot should work")}
        </p>
        <pre className="whitespace-pre-wrap rounded-2xl bg-muted/40 px-5 py-4 text-sm">
          {template.instructions}
        </pre>
      </section>

      <Group count={template.skills.length} title={t("Skills")}>
        {template.skills.map((slug) => (
          <Row
            key={slug}
            mark={<IconBolt aria-hidden="true" />}
            title={`/${slug}`}
          />
        ))}
      </Group>

      <Group count={template.routines.length} title={t("Routines")}>
        {template.routines.map((routine) => (
          <Row
            key={routine.name}
            mark={<IconRepeat aria-hidden="true" />}
            summary={routine.summary}
            title={routine.name}
          />
        ))}
      </Group>

      <Group count={template.apps.length} title={t("Apps")}>
        {template.apps.map((app) => (
          <Row
            action={
              app.installed ? (
                <span className="text-xs text-muted-foreground">
                  {t("Here")}
                </span>
              ) : (
                <Link
                  className="text-xs text-muted-foreground underline-offset-4 hover:underline"
                  search={{ tab: "apps", q: app.title }}
                  to="/marketplace"
                >
                  {t("Add from Apps")}
                </Link>
              )
            }
            key={app.key}
            mark={<PluginLogo logo={app.logoUrl} />}
            title={app.title}
          />
        ))}
      </Group>

      <section aria-label={t("Information")} className="mt-8">
        <h2 className="mb-3 text-[15px] font-medium text-muted-foreground">
          {t("Information")}
        </h2>
        <dl className="rounded-2xl bg-muted/40 px-5">
          <Fact label={t("Capabilities")}>
            {countOf(template.skills.length, "skill")},{" "}
            {countOf(template.routines.length, "routine")},{" "}
            {countOf(template.apps.length, "app")}
          </Fact>
          <Fact label={t("Creator")}>{template.creator}</Fact>
          <Fact label={t("Category")}>{template.categories.join(", ")}</Fact>
        </dl>
      </section>
    </div>
  );
}
