import { IconCheck, IconSearch } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import * as React from "react";
import { PageEmpty, PageSection } from "@/components/layout/page-shell";
import { SettingsPage } from "@/components/settings/settings-page";
import { RowMark } from "@/components/layout/row-mark";
import { catalogueMarkFor } from "@/components/plugins/catalogue-marks";
import { connectableAccounts } from "@/components/plugins/connectable-apps";
import { PluginLogo } from "@/components/plugins/plugin-logo";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import {
  connectionsQueryOptions,
  pluginsPageQueryOptions,
} from "@/lib/plugins/queries";

/**
 * The services a Bot reads as you.
 *
 * Yours, not the deployment's. Connecting an account is a decision nobody can make for you —
 * there is no endpoint for an administrator to connect one on somebody's behalf — and once you
 * have, every Bot can use it as you; an administrator narrows which Bots hold it on the Plugins
 * screens. A Bot calling one of these runs on your own grant, so it sees exactly what you can see
 * and nothing else.
 */
export const Route = createFileRoute(
  "/_authed/_app/settings/connected-accounts/",
)({
  component: RouteComponent,
  /*
   * `?connected=` is how the OAuth callback reports back, carrying a server key on success and
   * `failed` otherwise. It is the only channel available: the callback is a redirect from another
   * company's server, so there is no response body to read.
   *
   * The key is omitted rather than set to undefined. Present-but-undefined makes `search` a required
   * prop on every Link to this route, which is a lot of ripple for a parameter only the callback sets.
   */
  validateSearch: (search: Record<string, unknown>): { connected?: string } =>
    typeof search.connected === "string" ? { connected: search.connected } : {},
});

function RouteComponent() {
  const { connected: outcome } = Route.useSearch();
  const [search, setSearch] = React.useState("");
  const plugins = useQuery(pluginsPageQueryOptions());
  const connections = useQuery(connectionsQueryOptions());

  const connected = new Set(
    (connections.data?.connections ?? []).map((row) => row.serverId),
  );

  /*
   * Only the apps you connect as yourself: the catalogue's `user-oauth` vendors, whether or not
   * anybody has touched them yet, and the brokered apps that take an account. The rule is
   * `connectableAccounts`'s, shared with the Marketplace, so the two lists cannot disagree about
   * which apps are yours to connect — and an app enabled for everybody, which has no account of
   * yours behind it, is on the Marketplace and not here.
   */
  const accounts = connectableAccounts(
    plugins.data ?? { catalogue: [], servers: [] },
  ).map((account) => {
    const Mark = catalogueMarkFor(account.key);
    return {
      key: account.key,
      title: account.title,
      summary: account.summary,
      mark: account.logo ? (
        <PluginLogo logo={account.logo} />
      ) : (
        <Mark className="size-4" />
      ),
    };
  });
  const query = search.trim().toLocaleLowerCase();
  const matching = accounts.filter((account) =>
    `${account.title} ${account.summary}`.toLocaleLowerCase().includes(query),
  );
  const connectedCount = accounts.filter((account) =>
    connected.has(account.key),
  ).length;
  const sections = [
    {
      title: "Connected",
      accounts: matching.filter((account) => connected.has(account.key)),
    },
    {
      title: "Not connected",
      accounts: matching.filter((account) => !connected.has(account.key)),
    },
  ];

  return (
    <SettingsPage
      className="max-w-4xl @container"
      description="Connect your apps so your Bots can work with them."
      title="Connected accounts"
    >
      {/*
       * Only the failure is worth saying. A success needs no sentence: the row it came back to now
       * reads "Connected", which is the same news told by the thing it is news about.
       */}
      {outcome === "failed" ? (
        <p className="text-destructive text-sm" role="alert">
          That account could not be connected. Nothing was saved — try again.
        </p>
      ) : null}
      {/*
       * BOTH READS DECIDE THIS, AND ONLY ONE OF THEM USED TO. The waits were already paired here;
       * the errors were not — this branch tested `plugins.error` alone, so a `/api/plugins` that
       * succeeded beside a `/api/plugins/connections` that failed left the `connected` set empty and
       * every row below asserting "Not connected", with no error text anywhere on the page. Somebody
       * holding Gmail through Composio and Drive through OAuth was shown both as unconnected and
       * clicked through to reconnect accounts they already had. The brokered rows make it worse than
       * it was before they existed, because a brokered row's entire content is the connection state.
       *
       * ONE SENTENCE FOR BOTH, because the two failures are one fact from where the reader stands:
       * this page could not be loaded, and what it would otherwise draw is not shown rather than
       * drawn wrong.
       */}
      {plugins.isPending || connections.isPending ? null : plugins.error ||
        connections.error ? (
        <p className="mt-12 text-destructive text-sm" role="alert">
          Your connected accounts could not be loaded, so nothing is listed here
          rather than a list that may be wrong. Reload the page, and tell an
          administrator if it persists.
        </p>
      ) : accounts.length === 0 ? (
        <PageSection>
          <PageEmpty>
            Nothing to connect yet. These appear as soon as this deployment's
            catalogue lists a service that reads as the person asking.
          </PageEmpty>
        </PageSection>
      ) : (
        <>
          <p className="mt-5 text-xs text-muted-foreground">
            {connectedCount} connected · {accounts.length} available
          </p>
          <InputGroup className="mt-3 h-9 border-transparent bg-muted/60 shadow-none dark:bg-muted/60">
            <InputGroupAddon>
              <IconSearch aria-hidden="true" className="size-4" />
            </InputGroupAddon>
            <InputGroupInput
              aria-label="Search apps"
              placeholder="Search apps"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </InputGroup>
          {matching.length === 0 ? (
            <p className="mt-8 text-sm text-muted-foreground" role="status">
              No apps match “{search.trim()}”.
            </p>
          ) : (
            sections
              .filter((section) => section.accounts.length > 0)
              .map((section) => (
                <section
                  className="mt-8"
                  key={section.title}
                  aria-label={section.title}
                >
                  <h2 className="mb-3 px-2 text-xs font-medium text-muted-foreground">
                    {section.title}
                  </h2>
                  <div className="grid grid-cols-1 gap-x-6 gap-y-2 @min-[36rem]:grid-cols-2">
                    {section.accounts.map((account) => (
                      <Item
                        key={account.key}
                        className="min-w-0 flex-nowrap gap-3 px-2 py-3"
                        data-testid={`account-${account.key}`}
                        render={
                          <Link
                            params={{ key: account.key }}
                            to="/settings/connected-accounts/$key"
                          />
                        }
                        size="sm"
                      >
                        <RowMark className="size-9">{account.mark}</RowMark>
                        <ItemContent className="min-w-0 gap-0.5">
                          <ItemTitle className="block w-auto truncate">
                            {account.title}
                          </ItemTitle>
                          <ItemDescription
                            className="line-clamp-1 break-all text-xs"
                            title={account.summary}
                          >
                            {account.summary}
                          </ItemDescription>
                        </ItemContent>
                        <ItemActions className="shrink-0">
                          {connected.has(account.key) ? (
                            <span className="flex items-center gap-1 text-xs text-muted-foreground">
                              <IconCheck
                                aria-hidden="true"
                                className="size-3.5 text-emerald-600 dark:text-emerald-400"
                              />
                              Connected
                            </span>
                          ) : (
                            <span className="rounded-full bg-muted px-3 py-1 text-xs font-medium">
                              Connect
                            </span>
                          )}
                        </ItemActions>
                      </Item>
                    ))}
                  </div>
                </section>
              ))
          )}
        </>
      )}
    </SettingsPage>
  );
}
