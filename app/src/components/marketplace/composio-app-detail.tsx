import {
  IconCheck,
  IconChevronLeft,
  IconLink,
  IconPlug,
  IconTool,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Fact, Group, Row } from "@/components/marketplace/detail-parts";
import {
  composioCategoryLabel,
  composioToolTitle,
} from "@/components/plugins/composio-catalogue";
import { Button, buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { i18n, useTranslation } from "@/lib/i18n";
import { enableComposioAppMutationOptions } from "@/lib/plugins/mutations";
import {
  type ComposioAppDetail as Detail,
  composioAppQueryOptions,
  connectionsQueryOptions,
  pluginsPageQueryOptions,
} from "@/lib/plugins/queries";
import { useShareLink } from "@/lib/share-link";
import { cn } from "@/lib/utils";

const PAGE_ACTION = "h-10 rounded-full px-5 text-sm";

/**
 * A Composio app's own page inside the Marketplace (`?app=<slug>`), laid out like a Cursor
 * plugin's (`plugin-detail.tsx`): back chevron, the mark at 92px, the name and its categories,
 * Share and the action on the right, the description, the tools it brings, and a few facts.
 *
 * The action is the directory row's, carried one step further: Add puts the app on the deployment
 * for everybody; once added, Connect goes to the person's own account page for it, unless it needs
 * no account, and Connected says the account is theirs already.
 */
export function ComposioAppDetail({
  slug,
  onBack,
}: {
  slug: string;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const detail = useQuery(composioAppQueryOptions(slug));
  const plugins = useQuery(pluginsPageQueryOptions());
  const connections = useQuery(connectionsQueryOptions());
  const shareLink = useShareLink();
  const [error, setError] = useState<string | null>(null);
  const [isCopied, setIsCopied] = useState(false);
  const enable = useMutation({
    ...enableComposioAppMutationOptions(queryClient),
    onMutate: () => setError(null),
    onError: (thrown: Error) => setError(thrown.message),
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

  const { app, tools } = detail.data;
  // The deployment's row for this app, once added: `composio://<slug>` is what it is keyed by.
  const server = (plugins.data?.servers ?? []).find(
    (candidate) => candidate.url === `composio://${app.slug}`,
  );
  const isConnected = (connections.data?.connections ?? []).some(
    (connection) => connection.serverId === server?.id,
  );

  const share = async () => {
    // Opens on the reader's own instance, through the platform where there is one.
    const address = shareLink(
      `/marketplace?tab=apps&app=${encodeURIComponent(app.slug)}`,
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
        <div className="flex size-[92px] shrink-0 items-center justify-center rounded-2xl bg-muted/60 [&_img]:size-12 [&_svg]:size-8">
          {app.logo ? (
            <img alt="" referrerPolicy="no-referrer" src={app.logo} />
          ) : (
            <IconPlug aria-hidden="true" />
          )}
        </div>
        <div className="flex min-w-0 flex-1 flex-col justify-center gap-2 self-stretch">
          <h1 className="text-balance break-words text-2xl font-medium">
            {app.name}
          </h1>
          {app.categories.length > 0 ? (
            <ul aria-label={t("Categories")} className="flex flex-wrap gap-1.5">
              {app.categories.map((category) => (
                <li
                  className="rounded-full bg-muted px-2.5 py-0.5 text-xs text-muted-foreground"
                  key={category}
                >
                  {composioCategoryLabel(category)}
                </li>
              ))}
            </ul>
          ) : null}
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
          <AppAction
            app={app}
            isAdding={enable.isPending}
            isConnected={isConnected}
            onAdd={() => enable.mutate({ slug: app.slug })}
            serverId={server?.id}
          />
        </div>
      </header>

      {app.description ? (
        <p className="mt-6 text-[15px] leading-6 text-foreground/90">
          {app.description}
        </p>
      ) : null}

      <Group count={tools?.length ?? 0} title={t("Tools")}>
        {(tools ?? []).map((tool) => (
          <Row
            key={tool.slug}
            mark={<IconTool aria-hidden="true" />}
            summary={tool.description || undefined}
            title={composioToolTitle(tool.slug, app.slug)}
          />
        ))}
      </Group>
      {tools === null ? (
        <p className="mt-8 text-muted-foreground text-sm">
          {t("Composio did not list this app's tools just now.")}
        </p>
      ) : null}

      <section aria-label={t("Information")} className="mt-8">
        <h2 className="mb-3 text-[15px] font-medium text-muted-foreground">
          {t("Information")}
        </h2>
        <dl className="rounded-2xl bg-muted/40 px-5">
          <Fact label={t("Capabilities")}>
            {t("{{actionCount}} actions", { actionCount: app.actionCount })}
          </Fact>
          <Fact label={t("Access")}>{accessOf(app.connection.kind)}</Fact>
          <Fact label={t("Source")}>
            {/* i18n-ignore: the vendor's name */}
            <span>Composio</span>
          </Fact>
        </dl>
      </section>
    </div>
  );
}

/** What connecting it asks of a person, for the Information rows. */
function accessOf(kind: string): string {
  if (kind === "no-auth") return i18n.t("No account needed");
  if (kind === "fields") return i18n.t("Your API key");
  return i18n.t("Connect your account");
}

/** Add, Adding…, Connect, Connected or Added: what pressing the page's action does next. */
function AppAction({
  app,
  serverId,
  isConnected,
  isAdding,
  onAdd,
}: {
  app: Detail["app"];
  serverId: string | undefined;
  isConnected: boolean;
  isAdding: boolean;
  onAdd: () => void;
}) {
  const { t } = useTranslation();
  if (!app.enabled || !serverId) {
    return (
      <Button
        className={PAGE_ACTION}
        disabled={isAdding || app.enabled}
        onClick={onAdd}
        type="button"
      >
        {isAdding ? t("Adding…") : app.enabled ? t("Added") : t("Add")}
      </Button>
    );
  }
  if (app.connection.kind === "no-auth") {
    return (
      <span
        className="flex h-10 items-center gap-1 px-3 text-sm text-muted-foreground"
        role="status"
      >
        <IconCheck aria-hidden="true" className="size-4 text-emerald-600" />
        {t("Added")}
      </span>
    );
  }
  return (
    <Link
      aria-label={
        isConnected
          ? t("{{title}} connected, manage", { title: app.name })
          : t("Connect {{title}}", { title: app.name })
      }
      className={cn(
        buttonVariants({ variant: isConnected ? "ghost" : "default" }),
        PAGE_ACTION,
      )}
      params={{ key: serverId }}
      to="/settings/connected-accounts/$key"
    >
      {isConnected ? (
        <>
          <IconCheck aria-hidden="true" className="size-4 text-emerald-600" />
          {t("Connected")}
        </>
      ) : (
        t("Connect")
      )}
    </Link>
  );
}
