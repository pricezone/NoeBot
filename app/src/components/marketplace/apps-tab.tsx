import { IconCheck } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type * as React from "react";
import { useState } from "react";
import { Pills } from "@/components/marketplace/pills";
import {
  ACTION_CLASS,
  PluginAction,
} from "@/components/marketplace/plugin-action";
import {
  MarketplaceGrid,
  MarketplaceSection,
  PluginRow,
} from "@/components/marketplace/plugin-row";
import type { SetMarketplaceSearch } from "@/components/marketplace/search";
import { VariablesDialog } from "@/components/marketplace/variables-dialog";
import { catalogueMarkFor } from "@/components/plugins/catalogue-marks";
import { ComposioAppList } from "@/components/plugins/composio-app-list";
import {
  type ConnectableApp,
  connectableApps,
  matchingConnectableApps,
} from "@/components/plugins/connectable-apps";
import {
  categoryLabel,
  categoryPills,
  listedPlugins,
  matchingPlugins,
  type PluginRowState,
  pluginRowState,
  pluginSections,
} from "@/components/plugins/marketplace-catalogue";
import { PluginLogo } from "@/components/plugins/plugin-logo";
import { Button, buttonVariants } from "@/components/ui/button";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { i18n, useTranslation } from "@/lib/i18n";
import { useContentText } from "@/lib/i18n/content";
import {
  enablePluginMutationOptions,
  installPluginMutationOptions,
} from "@/lib/plugins/mutations";
import {
  connectionsQueryOptions,
  type MarketplacePlugin,
  marketplaceQueryOptions,
  pluginsPageQueryOptions,
} from "@/lib/plugins/queries";
import { cn } from "@/lib/utils";

/**
 * The apps whose row carries a "Beta" tag.
 *
 * Google Drive's platform OAuth client is still in Google's verification queue, so the consent
 * screen warns that the app is unverified until that clears. The tag says so before the press
 * rather than after it, and comes off this list when Google is done — nothing else here has to
 * change.
 */
const BETA_KEYS = new Set(["google-drive"]);

/** How many category pills show before the rest fold into More, as Grok Bot's row does. */
const PILLS_BEFORE_MORE = 5;

function markFor(app: ConnectableApp): React.ReactNode {
  if (app.logo) return <PluginLogo logo={app.logo} />;
  const Mark = catalogueMarkFor(app.key);
  return <Mark />;
}

/** The row's title, with the small tag beside it for the apps that carry one. */
function titleFor(app: ConnectableApp): React.ReactNode {
  if (!BETA_KEYS.has(app.key)) return app.title;
  return (
    <>
      {app.title}
      <span className="ml-1.5 rounded-full bg-muted px-1.5 py-0.5 align-middle text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {i18n.t("Beta")}
      </span>
    </>
  );
}

/**
 * Every app the Marketplace offers, the way Grok Bot's own apps popup lays them out: what is
 * connected first, then one section per category with a few rows each and a "View all".
 *
 * TWO LISTS, ONE LAYOUT. The catalogue's own apps — Drive, Notion, Parallel, Routines — and the
 * brokered ones are the rows this tab always drew, each with Connect or Enable. The Marketplace
 * plugins are Cursor's, out of the vendored index the server serves: pressing Add installs one
 * for every Bot, and the row then says what, if anything, is still the person's to do — Connect
 * an OAuth server as themselves, Add key for a server that takes a token — or Added. Either way
 * the app reaches every Bot once it is green; an administrator narrows which Bots hold it
 * afterwards, on the Plugins screens.
 *
 * An administrator also sees Composio's directory under "Featured plugins", because adding an app
 * there is what puts it in the lists above for everybody. The server refuses that read to anybody
 * else (`/api/plugins/composio/apps` is admin-only), so the section is not drawn for them rather
 * than drawn and failing — and not for an administrator either when Composio is not configured.
 */
export function AppsTab({
  query,
  category,
  onSearchChange,
}: {
  query: string;
  /** One category shown in full, from `?category`; absent draws every category's preview. */
  category?: string;
  onSearchChange: SetMarketplaceSearch;
}) {
  const { t } = useTranslation();
  const content = useContentText();
  const queryClient = useQueryClient();
  const plugins = useQuery(pluginsPageQueryOptions());
  const connections = useQuery(connectionsQueryOptions());
  const marketplace = useQuery(marketplaceQueryOptions());
  const me = useQuery(currentUserQueryOptions());
  const [error, setError] = useState<string | null>(null);
  const [keyFor, setKeyFor] = useState<{
    plugin: MarketplacePlugin;
    serverId: string;
  } | null>(null);
  const enable = useMutation({
    ...enablePluginMutationOptions(queryClient),
    onError: (thrown: Error) => setError(thrown.message),
  });
  const install = useMutation({
    ...installPluginMutationOptions(queryClient),
    onError: (thrown: Error) => setError(thrown.message),
  });

  const heldConnections = connections.data?.connections ?? [];
  const connected = new Set(heldConnections.map((row) => row.serverId));
  /** Green: an account you hold, or an app the deployment has switched on for everybody. */
  const isOn = (app: ConnectableApp) =>
    app.kind === "account" ? connected.has(app.key) : app.enabled;
  const apps = plugins.data ? connectableApps(plugins.data) : [];
  const matchingApps = matchingConnectableApps(apps, query);

  const indexed = marketplace.data ? listedPlugins(marketplace.data) : [];
  const matchingIndexed = matchingPlugins(indexed, query);
  const stateOf = (plugin: MarketplacePlugin): PluginRowState =>
    marketplace.data
      ? pluginRowState(plugin, marketplace.data, heldConnections)
      : { kind: "add" };
  const installed = matchingIndexed.filter(
    (plugin) => stateOf(plugin).kind !== "add",
  );
  const notInstalled = matchingIndexed.filter(
    (plugin) => stateOf(plugin).kind === "add",
  );
  const sections = pluginSections(notInstalled, { category });

  const showFeatured =
    me.data?.role === "admin" && plugins.data?.composioConfigured === true;
  const nothingMatches =
    matchingApps.length === 0 && matchingIndexed.length === 0;

  const showCategory = (key: string | undefined) =>
    onSearchChange({
      tab: "apps",
      q: query === "" ? undefined : query,
      ...(key === undefined ? {} : { category: key }),
    });
  /* The plugin's page, in place of the list; the term and the category are kept for the way back. */
  const openPlugin = (plugin: MarketplacePlugin) =>
    onSearchChange({
      tab: "apps",
      q: query === "" ? undefined : query,
      ...(category === undefined ? {} : { category }),
      plugin: plugin.id,
    });

  /*
   * Only the Marketplace's plugins open a page here. The catalogue's own apps and the brokered
   * ones have theirs on `/settings/connected-accounts/$key`, which is where their row's Connect
   * already goes.
   */
  const pluginRow = (plugin: MarketplacePlugin) => (
    <PluginRow
      action={
        <PluginAction
          install={install}
          onAddKey={(serverId) => setKeyFor({ plugin, serverId })}
          onError={setError}
          plugin={plugin}
          state={stateOf(plugin)}
        />
      }
      data-testid={`plugin-${plugin.id}`}
      key={plugin.id}
      mark={<PluginLogo logo={plugin.logoUrl} />}
      onOpen={() => openPlugin(plugin)}
      openLabel={`About ${plugin.name}`}
      summary={plugin.description}
      title={plugin.name}
    />
  );

  const connectedRows = [
    ...matchingApps
      .filter(isOn)
      .map((app) => (
        <PluginRow
          action={
            app.kind === "account" ? (
              <ConnectLink app={app} isConnected />
            ) : (
              <EnabledMark app={app} />
            )
          }
          data-testid={`account-${app.key}`}
          key={app.key}
          mark={markFor(app)}
          summary={content(app.summary)}
          title={titleFor(app)}
        />
      )),
    ...installed.map(pluginRow),
  ];

  const availableRows = matchingApps
    .filter((app) => !isOn(app))
    .map((app) => (
      <PluginRow
        action={
          app.kind === "account" ? (
            <ConnectLink app={app} isConnected={false} />
          ) : (
            <Button
              aria-label={t("Enable {{title}}", { title: app.title })}
              className={ACTION_CLASS}
              disabled={enable.isPending && enable.variables === app.key}
              onClick={() => {
                setError(null);
                enable.mutate(app.key);
              }}
              size="sm"
              type="button"
              variant="secondary"
            >
              {enable.isPending && enable.variables === app.key
                ? t("Enabling…")
                : t("Enable")}
            </Button>
          )
        }
        data-testid={`account-${app.key}`}
        key={app.key}
        mark={markFor(app)}
        summary={content(app.summary)}
        title={titleFor(app)}
      />
    ));

  return (
    <div className="flex flex-col">
      {/*
       * The category pills, as Grok Bot's row under its search: All, the biggest categories, and
       * the rest behind More. The active one is `?category`, the same address "View all" sets, so
       * the pill and the link are two ways to the same place and All is the way back from either.
       */}
      {indexed.length > 0 ? (
        <Pills
          active={category}
          className="mb-6"
          items={categoryPills(indexed)}
          moreAfter={PILLS_BEFORE_MORE}
          onSelect={showCategory}
        />
      ) : null}
      {/* The one place a refused press is said, above the rows rather than inside the one pressed. */}
      {error ? (
        <p className="mb-3 text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}
      {/*
       * BOTH READS DECIDE THIS. A `/api/plugins` that succeeded beside a `/api/plugins/connections`
       * that failed would leave the `connected` set empty and every row asserting "Connect" over an
       * account somebody already holds, so the two failures are one sentence: the list could not
       * be loaded, and what it would otherwise draw is not shown rather than drawn wrong. The
       * index is the third read; failing on its own it costs the plugin sections and nothing else,
       * said once below them.
       */}
      {plugins.isPending || connections.isPending ? null : plugins.error ||
        connections.error ? (
        <p className="text-destructive text-sm" role="alert">
          {t(
            "Your apps could not be loaded, so nothing is listed here rather than a list that may be wrong. Reload the page, and tell an administrator if it persists.",
          )}
        </p>
      ) : apps.length === 0 &&
        indexed.length === 0 &&
        !marketplace.isPending ? (
        <p className="text-muted-foreground text-sm">
          {t(
            "Nothing to connect yet. Apps appear here as soon as this deployment's catalogue lists one.",
          )}
        </p>
      ) : nothingMatches && !marketplace.isPending ? (
        <p className="text-muted-foreground text-sm" role="status">
          {t("No apps match “{{query}}”.", { query: query.trim() })}
        </p>
      ) : (
        <>
          {category === undefined ? (
            <>
              {connectedRows.length > 0 ? (
                <MarketplaceSection title={t("Connected")}>
                  <MarketplaceGrid>{connectedRows}</MarketplaceGrid>
                </MarketplaceSection>
              ) : null}
              {availableRows.length > 0 ? (
                <MarketplaceSection title={t("Available")}>
                  <MarketplaceGrid>{availableRows}</MarketplaceGrid>
                </MarketplaceSection>
              ) : null}
            </>
          ) : null}
          {sections.map((section) => (
            <MarketplaceSection
              action={
                section.hasMore ? (
                  <button
                    className="text-[13px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                    onClick={() => showCategory(section.key)}
                    type="button"
                  >
                    {t("View all")}
                  </button>
                ) : undefined
              }
              key={section.key}
              title={section.label}
            >
              <MarketplaceGrid>
                {section.plugins.map(pluginRow)}
              </MarketplaceGrid>
            </MarketplaceSection>
          ))}
          {category !== undefined && sections.length === 0 ? (
            <p className="text-muted-foreground text-sm" role="status">
              {t("Nothing in {{value}} yet.", {
                value: categoryLabel(category),
              })}
            </p>
          ) : null}
          {marketplace.error ? (
            <p className="mt-6 text-destructive text-sm" role="alert">
              {t(
                "The Marketplace's plugins could not be loaded. Reload the page, and tell an administrator if it persists.",
              )}
            </p>
          ) : null}
        </>
      )}

      {showFeatured ? (
        <MarketplaceSection
          action={
            <Link
              className="text-[13px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
              to="/admin/plugins/composio"
            >
              {t("View all")}
            </Link>
          }
          title={t("Featured plugins")}
        >
          <ComposioAppList appearance="marketplace" search={query} />
        </MarketplaceSection>
      ) : null}

      {keyFor ? (
        <VariablesDialog
          onClose={() => setKeyFor(null)}
          onConnected={() => setKeyFor(null)}
          open
          serverId={keyFor.serverId}
          title={keyFor.plugin.name}
          variables={
            (plugins.data?.servers ?? []).find(
              (server) => server.id === keyFor.serverId,
            )?.connectVariables ??
            keyFor.plugin.servers
              .find((server) => server.serverId === keyFor.serverId)
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

/**
 * The action on an account row: a link with the app in its name.
 *
 * Every such row says "Connect", and a list of identically named controls tells a screen reader
 * nothing about which is which. Never disabled: the account's page adds the server row itself if
 * nobody has touched this vendor before, so there is no state in which pressing it is wrong.
 */
function ConnectLink({
  app,
  isConnected,
}: {
  app: ConnectableApp;
  isConnected: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Link
      aria-label={
        isConnected
          ? t("{{title}} connected, manage", { title: app.title })
          : t("Connect {{title}}", { title: app.title })
      }
      className={cn(
        buttonVariants({
          size: "sm",
          variant: isConnected ? "ghost" : "secondary",
        }),
        ACTION_CLASS,
      )}
      params={{ key: app.key }}
      to="/settings/connected-accounts/$key"
    >
      {isConnected ? (
        <>
          <IconCheck
            aria-hidden="true"
            className="size-3.5 text-emerald-600 dark:text-emerald-400"
          />
          {t("Connected")}
        </>
      ) : (
        "Connect"
      )}
    </Link>
  );
}

/**
 * The state of an enabled app, which is not a control: there is no page to open and nothing of
 * yours to withdraw. Switching it off again is an administrator's, on the Plugins screens.
 */
function EnabledMark({ app }: { app: ConnectableApp }) {
  const { t } = useTranslation();
  return (
    <span
      aria-label={t("{{title}} enabled", { title: app.title })}
      className="flex h-8 items-center gap-1 px-3 text-xs text-muted-foreground"
      role="status"
    >
      <IconCheck
        aria-hidden="true"
        className="size-3.5 text-emerald-600 dark:text-emerald-400"
      />
      {t("Enabled")}
    </span>
  );
}
