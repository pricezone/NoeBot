import { IconCheck } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type * as React from "react";
import { useState } from "react";
import {
  MarketplaceGrid,
  MarketplaceSection,
  PluginRow,
} from "@/components/marketplace/plugin-row";
import { catalogueMarkFor } from "@/components/plugins/catalogue-marks";
import { ComposioAppList } from "@/components/plugins/composio-app-list";
import {
  type ConnectableApp,
  connectableApps,
  matchingConnectableApps,
} from "@/components/plugins/connectable-apps";
import { PluginLogo } from "@/components/plugins/plugin-logo";
import { Button, buttonVariants } from "@/components/ui/button";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { cn } from "@/lib/utils";
import { enablePluginMutationOptions } from "@/lib/plugins/mutations";
import {
  connectionsQueryOptions,
  pluginsPageQueryOptions,
} from "@/lib/plugins/queries";

/**
 * The apps whose row carries a "Beta" tag.
 *
 * Google Drive's platform OAuth client is still in Google's verification queue, so the consent
 * screen warns that the app is unverified until that clears. The tag says so before the press
 * rather than after it, and comes off this list when Google is done — nothing else here has to
 * change.
 */
const BETA_KEYS = new Set(["google-drive"]);

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
        Beta
      </span>
    </>
  );
}

/**
 * Every app this deployment's catalogue offers, and whether each is wired up.
 *
 * Two kinds of row, told apart by what pressing them does. An app reached as you — Drive, Notion,
 * anything brokered — has a Connect link to the account's own page under Settings, where the
 * consent flow already lives and where the OAuth return lands; it is under Connected once you
 * hold a connection. An app with no account to hold — a vendor reached anonymously, or a
 * capability built into this deployment — has an Enable button that works in place, for
 * everybody, and is under Connected once the deployment has it switched on.
 *
 * Either way the app reaches every Bot once it is green. There is no administrator step between a
 * person and the Marketplace; an administrator narrows which Bots hold an app afterwards, on the
 * Plugins screens.
 *
 * An administrator also sees Composio's directory under "Featured plugins", because adding an app
 * there is what puts it in the lists above for everybody. The server refuses that read to anybody
 * else (`/api/plugins/composio/apps` is admin-only), so the section is not drawn for them rather
 * than drawn and failing — and not for an administrator either when Composio is not configured,
 * because the only thing it could show is the sentence naming the missing key.
 */
export function AppsTab({ query }: { query: string }) {
  const queryClient = useQueryClient();
  const plugins = useQuery(pluginsPageQueryOptions());
  const connections = useQuery(connectionsQueryOptions());
  const me = useQuery(currentUserQueryOptions());
  const [error, setError] = useState<string | null>(null);
  const enable = useMutation({
    ...enablePluginMutationOptions(queryClient),
    onError: (thrown: Error) => setError(thrown.message),
  });

  const connected = new Set(
    (connections.data?.connections ?? []).map((row) => row.serverId),
  );
  /** Green: an account you hold, or an app the deployment has switched on for everybody. */
  const isOn = (app: ConnectableApp) =>
    app.kind === "account" ? connected.has(app.key) : app.enabled;
  const apps = plugins.data ? connectableApps(plugins.data) : [];
  const matching = matchingConnectableApps(apps, query);
  const sections = [
    { title: "Connected", apps: matching.filter(isOn) },
    { title: "Available", apps: matching.filter((app) => !isOn(app)) },
  ].filter((section) => section.apps.length > 0);

  const showFeatured =
    me.data?.role === "admin" && plugins.data?.composioConfigured === true;

  return (
    <div className="flex flex-col">
      {/* The one place a refused Enable is said, above the rows rather than inside the one pressed. */}
      {error ? (
        <p className="mb-3 text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}
      {/*
       * BOTH READS DECIDE THIS. A `/api/plugins` that succeeded beside a `/api/plugins/connections`
       * that failed would leave the `connected` set empty and every row asserting "Connect" over an
       * account somebody already holds, so the two failures are one sentence: the list could not
       * be loaded, and what it would otherwise draw is not shown rather than drawn wrong.
       */}
      {plugins.isPending || connections.isPending ? null : plugins.error ||
        connections.error ? (
        <p className="text-destructive text-sm" role="alert">
          Your apps could not be loaded, so nothing is listed here rather than a
          list that may be wrong. Reload the page, and tell an administrator if
          it persists.
        </p>
      ) : apps.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          Nothing to connect yet. Apps appear here as soon as this deployment's
          catalogue lists one.
        </p>
      ) : matching.length === 0 ? (
        <p className="text-muted-foreground text-sm" role="status">
          No apps match “{query.trim()}”.
        </p>
      ) : (
        sections.map((section) => (
          <MarketplaceSection key={section.title} title={section.title}>
            <MarketplaceGrid>
              {section.apps.map((app) => (
                <PluginRow
                  action={
                    app.kind === "account" ? (
                      <ConnectLink app={app} isConnected={isOn(app)} />
                    ) : app.enabled ? (
                      <EnabledMark app={app} />
                    ) : (
                      <Button
                        aria-label={`Enable ${app.title}`}
                        className="h-8 rounded-full px-3 text-xs"
                        disabled={
                          enable.isPending && enable.variables === app.key
                        }
                        onClick={() => {
                          setError(null);
                          enable.mutate(app.key);
                        }}
                        size="sm"
                        type="button"
                        variant="secondary"
                      >
                        {enable.isPending && enable.variables === app.key
                          ? "Enabling…"
                          : "Enable"}
                      </Button>
                    )
                  }
                  data-testid={`account-${app.key}`}
                  key={app.key}
                  mark={markFor(app)}
                  summary={app.summary}
                  title={titleFor(app)}
                />
              ))}
            </MarketplaceGrid>
          </MarketplaceSection>
        ))
      )}

      {showFeatured ? (
        <MarketplaceSection
          action={
            <Link
              className="text-[13px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
              to="/admin/plugins/composio"
            >
              View all
            </Link>
          }
          title="Featured plugins"
        >
          <ComposioAppList appearance="marketplace" search={query} />
        </MarketplaceSection>
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
  return (
    <Link
      aria-label={
        isConnected ? `${app.title} connected, manage` : `Connect ${app.title}`
      }
      className={cn(
        buttonVariants({
          size: "sm",
          variant: isConnected ? "ghost" : "secondary",
        }),
        "h-8 rounded-full px-3 text-xs",
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
          Connected
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
  return (
    <span
      aria-label={`${app.title} enabled`}
      className="flex h-8 items-center gap-1 px-3 text-xs text-muted-foreground"
      role="status"
    >
      <IconCheck
        aria-hidden="true"
        className="size-3.5 text-emerald-600 dark:text-emerald-400"
      />
      Enabled
    </span>
  );
}
