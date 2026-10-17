import {
  IconArrowUpRight,
  IconBolt,
  IconChevronLeft,
  IconLink,
  IconPlug,
  IconRosetteDiscountCheck,
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
import { PluginAction } from "@/components/marketplace/plugin-action";
import { VariablesDialog } from "@/components/marketplace/variables-dialog";
import {
  categoryLabel,
  pluginRowState,
  primaryCategory,
} from "@/components/plugins/marketplace-catalogue";
import { PluginLogo } from "@/components/plugins/plugin-logo";
import { Button, buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { i18n, useTranslation } from "@/lib/i18n";
import { intlLocale } from "@/lib/i18n/format";
import {
  installPluginMutationOptions,
  uninstallPluginMutationOptions,
} from "@/lib/plugins/mutations";
import {
  connectionsQueryOptions,
  type MarketplacePluginDetail,
  pluginDetailQueryOptions,
  pluginsPageQueryOptions,
} from "@/lib/plugins/queries";
import { useShareLink } from "@/lib/share-link";

/**
 * A plugin's own page inside the Marketplace, laid out like Grok Bot's: back chevron, the mark at
 * 92px, the name with a link to the source, Share and Add on the right, the description, then the
 * connectors it adds, the skills it brings, and a few facts in rows.
 *
 * Its own read (`/api/plugins/marketplace/:id`) rather than the listing's, because the page says
 * things the list has no room for — where the source is pinned, what each skill does — and the
 * list should stay the size of a list. Add here is the row's own Add: the same state machine, the
 * same mutation, so the page and the row never disagree about what is left for the person to do.
 *
 * Remove lives here, for whoever installed it and for an administrator. A plugin whose servers
 * take no account has no connected-account page, so until now there was nowhere to take it off.
 */
export function PluginDetail({
  id,
  onBack,
}: {
  id: string;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const detail = useQuery(pluginDetailQueryOptions(id));
  const connections = useQuery(connectionsQueryOptions());
  const plugins = useQuery(pluginsPageQueryOptions());
  const me = useQuery(currentUserQueryOptions());
  const [error, setError] = useState<string | null>(null);
  const [keyFor, setKeyFor] = useState<string | null>(null);
  const [isCopied, setIsCopied] = useState(false);
  const shareLink = useShareLink();
  const install = useMutation({
    ...installPluginMutationOptions(queryClient),
    onError: (thrown: Error) => setError(thrown.message),
  });
  const uninstall = useMutation({
    ...uninstallPluginMutationOptions(queryClient),
    onError: (thrown: Error) => setError(thrown.message),
    onSuccess: onBack,
  });

  useEffect(() => {
    if (!isCopied) return;
    const timer = setTimeout(() => setIsCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [isCopied]);

  const back = (
    <Button
      aria-label={t("Back to apps")}
      className="-ml-2 mb-4 self-start rounded-full"
      onClick={onBack}
      size="icon"
      type="button"
      variant="ghost"
    >
      <IconChevronLeft />
    </Button>
  );

  if (detail.isPending) {
    return (
      <div className="flex flex-col">
        {back}
        <Skeleton className="h-[92px] w-full max-w-md rounded-2xl" />
        <Skeleton className="mt-6 h-12 w-full" />
        <Skeleton className="mt-6 h-40 w-full rounded-2xl" />
      </div>
    );
  }
  if (!detail.data) {
    return (
      <div className="flex flex-col">
        {back}
        <p className="text-destructive text-sm" role="alert">
          {t("This app couldn't be loaded.")}
          {detail.error?.message ? ` ${detail.error.message}` : ""}
        </p>
      </div>
    );
  }

  const { plugin, installed } = detail.data;
  const state = pluginRowState(
    plugin,
    { installed: installed ? { [plugin.id]: installed } : {} },
    connections.data?.connections ?? [],
  );
  const mayRemove =
    installed !== null && (installed.mine || me.data?.role === "admin");
  const source = sourceOf(plugin);

  const share = async () => {
    // Opens on the reader's own instance, through the platform where there is one.
    const address = shareLink(
      `/marketplace?tab=apps&plugin=${encodeURIComponent(plugin.id)}`,
    );
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
        <div className="flex size-[92px] shrink-0 items-center justify-center rounded-2xl bg-muted/60 [&_img]:size-12 [&_svg:not([class*='size-'])]:size-8">
          <PluginLogo logo={plugin.logoUrl} />
        </div>
        <div className="flex min-w-0 flex-1 flex-col justify-center gap-1 self-stretch">
          <h1 className="truncate text-2xl font-medium">{plugin.name}</h1>
          <a
            className="flex w-fit items-center gap-1 text-[15px] text-muted-foreground transition-colors hover:text-foreground"
            href={source.url}
            rel="noreferrer"
            target="_blank"
          >
            {t("View Source")}
            <IconArrowUpRight aria-hidden="true" className="size-4" />
          </a>
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
          <PluginAction
            appearance="page"
            install={install}
            onAddKey={setKeyFor}
            onError={setError}
            plugin={plugin}
            state={state}
          />
        </div>
      </header>

      {plugin.description ? (
        <p className="mt-6 text-[15px] leading-6 text-foreground/90">
          {plugin.description}
        </p>
      ) : null}

      <Group count={plugin.servers.length} title={t("Apps")}>
        {plugin.servers.map((server) => (
          <Row
            key={server.serverId}
            mark={<IconPlug aria-hidden="true" />}
            summary={`Connector${server.vendor ? ` · ${server.vendor}` : ""} · ${accessSentence(server.authKind)}`}
            title={server.name}
          />
        ))}
      </Group>

      <Group count={plugin.skills.length} title={t("Skills")}>
        {plugin.skills.map((skill) => (
          <Row
            key={skill.slug}
            mark={<IconBolt aria-hidden="true" />}
            summary={skill.description ?? `/${skill.slug}`}
            title={skill.name}
          />
        ))}
      </Group>

      <section aria-label={t("Information")} className="mt-8">
        <h2 className="mb-3 text-[15px] font-medium text-muted-foreground">
          {t("Information")}
        </h2>
        <dl className="rounded-2xl bg-muted/40 px-5">
          <Fact label={t("Capabilities")}>
            {countOf(plugin.servers.length, "app")},{" "}
            {countOf(plugin.skills.length, "skill")}
          </Fact>
          <Fact label={t("Developer")}>
            <span className="inline-flex items-center gap-1">
              {plugin.publisher}
              {plugin.verified ? (
                <IconRosetteDiscountCheck
                  aria-label={t("Verified")}
                  className="size-4 text-sky-500"
                />
              ) : null}
            </span>
          </Fact>
          <Fact label={t("Category")}>
            {categoryLabel(primaryCategory(plugin))}
          </Fact>
          <Fact label={t("Source")}>
            <a
              className="underline-offset-4 hover:underline"
              href={source.url}
              rel="noreferrer"
              target="_blank"
            >
              {source.label}
            </a>
          </Fact>
          <Fact label={t("Access")}>{accessSummary(plugin)}</Fact>
          {installed ? (
            <Fact label={t("Added by")}>
              {installed.mine
                ? t("You")
                : (installed.installedBy ?? t("Somebody"))}
              {" · "}
              {new Date(installed.installedAt).toLocaleDateString(intlLocale())}
            </Fact>
          ) : null}
        </dl>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {/* Where every key and account is managed in one place, for whoever asks "where do my keys live". */}
          <Link
            className={buttonVariants({ size: "sm", variant: "ghost" })}
            to="/settings/keys"
          >
            {t("Manage keys")}
          </Link>
          {mayRemove ? (
            <Button
              className="text-destructive hover:text-destructive"
              disabled={uninstall.isPending}
              onClick={() => {
                setError(null);
                uninstall.mutate(plugin.id);
              }}
              size="sm"
              type="button"
              variant="ghost"
            >
              {uninstall.isPending ? t("Removing…") : t("Remove plugin")}
            </Button>
          ) : null}
        </div>
      </section>

      {keyFor !== null ? (
        <VariablesDialog
          onClose={() => setKeyFor(null)}
          onConnected={() => setKeyFor(null)}
          open
          serverId={keyFor}
          title={plugin.name}
          variables={
            (plugins.data?.servers ?? []).find((server) => server.id === keyFor)
              ?.connectVariables ??
            plugin.servers
              .find((server) => server.serverId === keyFor)
              ?.variables.map((name) => ({
                name,
                description: null,
                writeOnly: true,
                required: true,
              })) ??
            []
          }
        />
      ) : null}
    </div>
  );
}

function accessSentence(
  authKind: MarketplacePluginDetail["servers"][number]["authKind"],
): string {
  switch (authKind) {
    case "none":
      return "no account needed";
    case "header":
      return "your API key";
    default:
      return "connect your account";
  }
}

/** What the plugin as a whole asks of the person, for the Information rows. */
function accessSummary(plugin: MarketplacePluginDetail): string {
  const kinds = new Set(plugin.servers.map((server) => server.authKind));
  if (kinds.has("oauth-discover") || kinds.has("static-client")) {
    return i18n.t("Connect your account");
  }
  if (kinds.has("header")) return i18n.t("Your API key");
  if (kinds.has("none")) return i18n.t("No account needed");
  return i18n.t("Skills only");
}

/** The repository at the pinned commit: a link, and "owner/repo" to show for it. */
function sourceOf(plugin: MarketplacePluginDetail): {
  url: string;
  label: string;
} {
  const repository = plugin.gitUrl.replace(/\.git$/, "");
  const path = plugin.gitPath.replace(/^\/+|\/+$/g, "");
  const url = `${repository}/tree/${plugin.gitRef}${path ? `/${path}` : ""}`;
  let label = repository;
  try {
    label = new URL(repository).pathname.replace(/^\/+/, "");
  } catch {
    // Not a URL the browser can parse: the whole string is the label.
  }
  return { url, label };
}
