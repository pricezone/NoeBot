import {
  IconBrandGoogleDrive,
  IconBrandNotion,
  IconCheck,
  IconPlug,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type * as React from "react";
import {
  MarketplaceGrid,
  MarketplaceSection,
  PluginRow,
} from "@/components/marketplace/plugin-row";
import { ComposioAppList } from "@/components/plugins/composio-app-list";
import {
  type ConnectableApp,
  connectableApps,
  matchingConnectableApps,
} from "@/components/plugins/connectable-apps";
import { PluginLogo } from "@/components/plugins/plugin-logo";
import { buttonVariants } from "@/components/ui/button";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { cn } from "@/lib/utils";
import {
  connectionsQueryOptions,
  pluginsPageQueryOptions,
} from "@/lib/plugins/queries";

/**
 * The same marks the Connected accounts page draws for the catalogue's OAuth vendors, which have no
 * logo of their own on the wire. Duplicated rather than imported: the route file that holds them is
 * mid-move into the modal shell, and two icons are cheaper than a dependency on a route module.
 */
const MARKS: Record<string, React.ComponentType<{ className?: string }>> = {
  "google-drive": IconBrandGoogleDrive,
  notion: IconBrandNotion,
};

function markFor(app: ConnectableApp): React.ReactNode {
  if (app.logo) return <PluginLogo logo={app.logo} />;
  const Mark = MARKS[app.key] ?? IconPlug;
  return <Mark />;
}

/**
 * The apps a Bot can reach as you, and whether each is connected.
 *
 * Yours, not the deployment's: an administrator decides which vendors this deployment may reach at
 * all, and connecting an account is the half of that decision nobody can make for you. "Connect"
 * opens the account's own page under Settings, where the consent flow already lives and where the
 * OAuth return lands; the Marketplace only lists.
 *
 * An administrator also sees Composio's directory under "Featured plugins", because adding an app
 * there is what puts it in the lists above for everybody. The server refuses that read to anybody
 * else (`/api/plugins/composio/apps` is admin-only), so the section is not drawn for them rather
 * than drawn and failing — and not for an administrator either when Composio is not configured,
 * because the only thing it could show is the sentence naming the missing key.
 */
export function AppsTab({ query }: { query: string }) {
  const plugins = useQuery(pluginsPageQueryOptions());
  const connections = useQuery(connectionsQueryOptions());
  const me = useQuery(currentUserQueryOptions());

  const connected = new Set(
    (connections.data?.connections ?? []).map((row) => row.serverId),
  );
  const accounts = plugins.data ? connectableApps(plugins.data) : [];
  const matching = matchingConnectableApps(accounts, query);
  const sections = [
    {
      title: "Connected",
      apps: matching.filter((app) => connected.has(app.key)),
    },
    {
      title: "Available",
      apps: matching.filter((app) => !connected.has(app.key)),
    },
  ].filter((section) => section.apps.length > 0);

  const showFeatured =
    me.data?.role === "admin" && plugins.data?.composioConfigured === true;

  return (
    <div className="flex flex-col">
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
      ) : accounts.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          Nothing to connect yet. Apps appear here once an administrator enables
          a connector that reads as the person asking.
        </p>
      ) : matching.length === 0 ? (
        <p className="text-muted-foreground text-sm" role="status">
          No apps match “{query.trim()}”.
        </p>
      ) : (
        sections.map((section) => (
          <MarketplaceSection key={section.title} title={section.title}>
            <MarketplaceGrid>
              {section.apps.map((app) => {
                const isConnected = connected.has(app.key);
                return (
                  <PluginRow
                    action={
                      // A link with the app in its name: every row says "Connect", and a list of
                      // identically named controls tells a screen reader nothing about which is which.
                      <Link
                        aria-label={
                          isConnected
                            ? `${app.title} connected, manage`
                            : `Connect ${app.title}`
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
                    }
                    data-testid={`account-${app.key}`}
                    key={app.key}
                    mark={markFor(app)}
                    summary={app.summary}
                    title={app.title}
                  />
                );
              })}
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
